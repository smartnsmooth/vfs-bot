import dotenv from "dotenv";
dotenv.config({ override: true });
import { spawn, ChildProcess } from "node:child_process";
import { logger } from "./utils/logger";
import { runApplicantFormWithSubmitHandler, applicantUiPort } from "./ui/applicantDetailsFormServer";
import { setSessionLoginCredentials } from "./utils/sessionLogin.store";
import { setApplicantDetailsOverrides } from "./utils/applicantDetails.store";

const NUM_INSTANCES = parseInt(process.env.VFS_BOT_INSTANCES ?? "5", 10);
const BASE_DEBUGGING_PORT = 9222;
const BASE_PROFILE_DIR = process.env.CHROME_USER_DATA_DIR ?? "C:/vfs-bot-profile";

interface BotInstance {
  id: number;
  process: ChildProcess | null;
  debugPort: number;
  profileDir: string;
  queue: Promise<void>;
}

const instances: BotInstance[] = [];

function enqueueTaskForInstance(instanceId: number, task: () => Promise<void>): void {
  const inst = instances.find((i) => i.id === instanceId);
  if (!inst) {
    logger.warn({ instanceId }, "Instance not found for task");
    return;
  }

  if (!inst.process || inst.process.killed) {
    logger.warn({ instanceId }, "Instance process not available");
    return;
  }

  inst.queue = inst.queue.then(task).catch((err) => {
    logger.error({ err, instanceId }, "Instance task failed");
  });
}

async function startFormServer(): Promise<void> {
  await runApplicantFormWithSubmitHandler((formData) => {
    const instanceId = typeof formData.instanceId === "number" ? formData.instanceId : 1;

    // Accept credentials under either key name:
    //   multi-instance submit spreads store entries as {username, password}
    //   single-instance submit sends form fields as {vfsUsername, vfsPassword}
    const raw = formData as Record<string, unknown> & { instanceId?: number; firstSubmit?: boolean };
    const resolvedUsername =
      (typeof raw.vfsUsername === "string" ? raw.vfsUsername : undefined) ??
      (typeof raw.username === "string" ? raw.username : undefined);
    const resolvedPassword =
      (typeof raw.vfsPassword === "string" ? raw.vfsPassword : undefined) ??
      (typeof raw.password === "string" ? raw.password : undefined);
    const { vfsUsername: _vu, vfsPassword: _vp, username: _u, password: _p, instanceId: _, firstSubmit: _fs, ...applicantData } = raw;

    // Write credentials/details SYNCHRONOUSLY here, not inside the async task.
    // The submit handler calls onSubmit in a loop without await, so these writes
    // are naturally serialised — no concurrent file access, no JSON corruption.
    if (resolvedUsername && resolvedPassword) {
      setSessionLoginCredentials(resolvedUsername, resolvedPassword, instanceId);
    }
    setApplicantDetailsOverrides(applicantData, instanceId);

    // The async task only sends IPC — no disk writes, eliminating the race.
    enqueueTaskForInstance(instanceId, async () => {
      const inst = instances.find((i) => i.id === instanceId);
      if (inst?.process && !inst.process.killed) {
        inst.process.send({ type: "config-updated", instanceId });
        inst.process.send({ type: "run-bot-cycle", instanceId });
      } else {
        logger.warn({ instanceId }, "Cannot send message to instance process");
      }
    });
  }, { collectLogin: true });
}

function spawnBotInstance(instanceId: number): ChildProcess {
  const debugPort = BASE_DEBUGGING_PORT + instanceId - 1;
  const profileDir = `${BASE_PROFILE_DIR}-${instanceId}`;

  const env = {
    ...process.env,
    BOT_INSTANCE_ID: String(instanceId),
    BROWSER_CDP_URL: `http://127.0.0.1:${debugPort}`,
    CHROME_USER_DATA_DIR: profileDir,
    VFS_APPLICANT_UI: "false",
    BOT_CLUSTER_MODE: "true",
  };

  const child = spawn(process.execPath, ["dist/index.js"], {
    env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  child.on("exit", (code) => {
    logger.warn({ instanceId, code }, "Bot instance exited");
    const inst = instances.find((i) => i.id === instanceId);
    if (inst) inst.process = null;
  });

  child.on("message", (msg: any) => {
    if (msg?.type === "bot-cycle-complete") {
      logger.info({ instanceId }, "Bot cycle completed for instance");
    }
  });

  return child;
}

async function main(): Promise<void> {
  logger.info({ instances: NUM_INSTANCES }, "Starting VFS Bot Cluster");

  // Start shared form server (don't await - it runs indefinitely)
  startFormServer().catch((err) => {
    logger.error({ err }, "Form server failed");
    process.exit(1);
  });

  // Give the server a moment to start
  await new Promise(resolve => setTimeout(resolve, 100));

  // Spawn bot instances
  for (let i = 1; i <= NUM_INSTANCES; i++) {
    const child = spawnBotInstance(i);
    instances.push({
      id: i,
      process: child,
      debugPort: BASE_DEBUGGING_PORT + i - 1,
      profileDir: `${BASE_PROFILE_DIR}-${i}`,
      queue: Promise.resolve(),
    });
  }
}

function shutdown(): void {
  logger.info("Shutting down cluster");
  for (const inst of instances) {
    if (inst.process) {
      inst.process.kill("SIGTERM");
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  logger.error({ err }, "Cluster startup failed");
  process.exit(1);
});

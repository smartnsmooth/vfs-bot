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

    // Store form data and trigger task on the instance
    const { vfsUsername, vfsPassword, instanceId: _, firstSubmit, ...applicantData } = formData as Record<string, unknown> & { instanceId?: number; firstSubmit?: boolean };

    enqueueTaskForInstance(instanceId, async () => {
      if (typeof vfsUsername === "string" && typeof vfsPassword === "string") {
        setSessionLoginCredentials(vfsUsername, vfsPassword, instanceId);
      }
      setApplicantDetailsOverrides(applicantData, instanceId);

      // Send IPC message to the child process to trigger bot cycle
      const inst = instances.find((i) => i.id === instanceId);
      if (inst?.process && !inst.process.killed) {
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

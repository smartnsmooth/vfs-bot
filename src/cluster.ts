import dotenv from "dotenv";
dotenv.config({ override: true });
import { spawn, ChildProcess } from "node:child_process";
import { logger } from "./utils/logger";
import { runApplicantFormWithSubmitHandler, applicantUiPort } from "./ui/applicantDetailsFormServer";
import { setSessionLoginCredentials } from "./utils/sessionLogin.store";
import { setApplicantDetailsOverrides } from "./utils/applicantDetails.store";

/** How many bot instances are currently running. Set by ensureInstances(). */
let currentNumInstances = 0;
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

/**
 * Spawn or kill bot instances to reach `targetCount`.
 * Safe to call multiple times — only creates/kills the delta.
 */
function ensureInstances(targetCount: number): void {
  const count = Math.max(1, Math.min(50, targetCount));

  // Spawn new instances as needed
  for (let i = currentNumInstances + 1; i <= count; i++) {
    const child = spawnBotInstance(i, count);
    instances.push({
      id: i,
      process: child,
      debugPort: BASE_DEBUGGING_PORT + i - 1,
      profileDir: `${BASE_PROFILE_DIR}-${i}`,
      queue: Promise.resolve(),
    });
    logger.info({ instanceId: i }, "Spawned bot instance");
  }

  // Kill excess instances if count decreased
  for (let i = count + 1; i <= currentNumInstances; i++) {
    const inst = instances.find((ii) => ii.id === i);
    if (inst?.process) {
      inst.process.kill("SIGTERM");
    }
  }
  if (count < currentNumInstances) {
    instances.splice(count);
  }

  currentNumInstances = count;
  logger.info({ currentNumInstances }, "Instance count updated");
}

async function startFormServer(): Promise<void> {
  await runApplicantFormWithSubmitHandler((formData) => {
    // Spawn/adjust instances to the count chosen in the form UI.
    const submittedCount = typeof formData.numInstances === "number" && formData.numInstances > 0
      ? Math.floor(formData.numInstances)
      : currentNumInstances || 1;
    ensureInstances(submittedCount);

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
    const resolvedUsername2 =
      typeof raw.vfsUsername2 === "string" ? raw.vfsUsername2.trim() : typeof raw.username2 === "string" ? raw.username2.trim() : "";
    const resolvedPassword2 =
      typeof raw.vfsPassword2 === "string" ? raw.vfsPassword2 : typeof raw.password2 === "string" ? raw.password2 : "";
    const {
      vfsUsername: _vu,
      vfsPassword: _vp,
      vfsUsername2: _vu2f,
      vfsPassword2: _vp2f,
      username: _u,
      password: _p,
      username2: _u2,
      password2: _p2,
      numInstances: _ni,
      instanceId: _,
      firstSubmit: _fs,
      ...applicantData
    } = raw;

    // Write credentials/details SYNCHRONOUSLY here, not inside the async task.
    // The submit handler calls onSubmit in a loop without await, so these writes
    // are naturally serialised — no concurrent file access, no JSON corruption.
    if (resolvedUsername && resolvedPassword) {
      const hasSecondKeys =
        "vfsUsername2" in raw ||
        "vfsPassword2" in raw ||
        "username2" in raw ||
        "password2" in raw;
      const second =
        resolvedUsername2 && resolvedPassword2 !== ""
          ? { username2: resolvedUsername2, password2: resolvedPassword2 }
          : hasSecondKeys
            ? "clear"
            : "preserve";
      setSessionLoginCredentials(resolvedUsername, resolvedPassword, instanceId, second);
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

function spawnBotInstance(instanceId: number, totalInstances: number): ChildProcess {
  const debugPort = BASE_DEBUGGING_PORT + instanceId - 1;
  const profileDir = `${BASE_PROFILE_DIR}-${instanceId}`;

  const env = {
    ...process.env,
    BOT_INSTANCE_ID: String(instanceId),
    // Propagate the UI-chosen instance count into child processes so index.ts can derive
    // fixed polling + stagger settings from the runtime value (not just .env).
    VFS_BOT_INSTANCES: String(totalInstances),
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
  logger.info("Starting VFS Bot Cluster — open the setup form, set the number of instances, and click Submit to start");

  // Start the shared form server. Instances are spawned lazily on first Submit,
  // not at startup — so the user can choose the count from the UI.
  startFormServer().catch((err) => {
    logger.error({ err }, "Form server failed");
    process.exit(1);
  });
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

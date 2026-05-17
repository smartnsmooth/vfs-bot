import dotenv from "dotenv";
dotenv.config({ override: true });
import { spawn, ChildProcess } from "node:child_process";
import { logger } from "./utils/logger";
import {
  runApplicantFormWithSubmitHandler,
  closeApplicantFormServer,
  type TestApplicantsApiBatchResult,
  type TestApplicantsApiInstanceResult,
} from "./ui/applicantDetailsFormServer";
import { setSessionLoginCredentials } from "./utils/sessionLogin.store";
import { setApplicantDetailsOverrides } from "./utils/applicantDetails.store";
import { TelegramService } from "./services/telegram.service";
import {
  killChromeTreeByCdpPortRangeSync,
} from "./utils/killChromeByCdpPort";
import { clearSlotState } from "./utils/slotState";
import { clearPollReadyState, initPollReadyState } from "./utils/pollReadyState";

/** How many bot instances are currently running. Set by ensureInstances(). */
let currentNumInstances = 0;
let lastTelegramNotifyBatchTs = 0;
let pollReadyInitializedForBatch = false;
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

/** Parent waits for `test-applicants-result` from a child (same `requestId`). */
const pendingTestApplicants = new Map<string, (msg: Record<string, unknown>) => void>();

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

    // Initialize the synchronized polling gate on the very first submit batch
    // so child instances know how many peers to wait for before polling starts.
    // Guard with a flag to avoid re-initializing when the handler is called
    // once per instance in the same batch.
    const isFirstSubmit = formData.firstSubmit === true;
    if (isFirstSubmit && !pollReadyInitializedForBatch) {
      pollReadyInitializedForBatch = true;
      clearPollReadyState();
      initPollReadyState(submittedCount);
    }
    const now = Date.now();
    if (now - lastTelegramNotifyBatchTs > 2000) {
      lastTelegramNotifyBatchTs = now;
      const dt = new Date().toLocaleString();
      void new TelegramService().notify(`${dt} — ${submittedCount} bot${submittedCount > 1 ? "s are" : " is"} running...`, { raw: true }).catch(() => { });
    }

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
  }, {
    collectLogin: true,
    onTestApplicantsApi: async (): Promise<TestApplicantsApiBatchResult> => {
      const running = instances.filter((i) => i.process && !i.process.killed);
      if (running.length === 0) {
        return { results: [] };
      }
      const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const results = await Promise.all(
        running.map(
          (inst) =>
            new Promise<TestApplicantsApiInstanceResult>((resolve) => {
              const requestId = `${batchId}-i${inst.id}`;
              const timer = setTimeout(() => {
                if (pendingTestApplicants.delete(requestId)) {
                  resolve({
                    instanceId: inst.id,
                    ok: false,
                    error:
                      "Timeout (90s) waiting for applicants API test — ensure this instance is logged in (visa.vfsglobal.com tab open).",
                  });
                }
              }, 90_000);
              pendingTestApplicants.set(requestId, (msg) => {
                clearTimeout(timer);
                pendingTestApplicants.delete(requestId);
                if (msg.ok === true && typeof msg.status === "number" && typeof msg.bodyPreview === "string") {
                  resolve({ instanceId: inst.id, ok: true, status: msg.status, bodyPreview: msg.bodyPreview });
                } else {
                  resolve({
                    instanceId: inst.id,
                    ok: false,
                    error: typeof msg.error === "string" ? msg.error : "Test applicants API failed",
                  });
                }
              });
              inst.process!.send({ type: "test-applicants", instanceId: inst.id, requestId });
            })
        )
      );
      return { results };
    },
    onForceBook: () => {
      const eligible = instances.filter((i) => i.process && !i.process.killed);

      if (eligible.length === 0) {
        return { ok: false, error: "No active instances. Not yet started." };
      }
      clearSlotState();
      let queued = 0;
      for (const inst of eligible) {
        inst.process!.send({ type: "force-book", instanceId: inst.id });
        queued++;
      }
      logger.info({ queued }, "[ForceBook] Sent force-book IPC to ALL active instances — starting polling");
      return { ok: true, queued };
    },
  });
}

function spawnBotInstance(instanceId: number, totalInstances: number): ChildProcess {
  const debugPort = BASE_DEBUGGING_PORT + instanceId - 1;
  const profileDir = `${BASE_PROFILE_DIR}-${instanceId}`;

  const env = {
    ...process.env,
    BOT_INSTANCE_ID: String(instanceId),
    BOT_TOTAL_INSTANCES: String(totalInstances),
    BROWSER_CDP_URL: `http://127.0.0.1:${debugPort}`,
    CHROME_USER_DATA_DIR: profileDir,
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
      return;
    }
    if (msg?.type === "test-applicants-result" && typeof msg.requestId === "string") {
      const cb = pendingTestApplicants.get(msg.requestId);
      if (cb) {
        pendingTestApplicants.delete(msg.requestId);
        cb(msg as Record<string, unknown>);
      }
      return;
    }
  });

  return child;
}

async function main(): Promise<void> {
  logger.info("Starting VFS Bot Cluster — open the setup form, set the number of instances, and click Submit to start");

  // Wipe stale shared state from previous sessions so new instances start clean.
  clearSlotState();
  clearPollReadyState();

  // Start the shared form server. Instances are spawned lazily on first Submit,
  // not at startup — so the user can choose the count from the UI.
  startFormServer().catch((err) => {
    logger.error({ err }, "Form server failed");
    process.exit(1);
  });
}

let isClusterShuttingDown = false;

function getInstancePortRangeCount(): number {
  // Cover every instance we might have spawned — at minimum what we track,
  // and at least 1 so SIGHUP-before-Submit still cleans up a pre-launched Chrome.
  return Math.max(1, instances.length, currentNumInstances);
}

function shutdown(): void {
  if (isClusterShuttingDown) return;
  isClusterShuttingDown = true;
  const portCount = getInstancePortRangeCount();
  logger.info({ instances: portCount, basePort: BASE_DEBUGGING_PORT }, "Shutting down cluster — closing Chrome windows and child processes");

  // Kill child processes first so they don't spawn new async PowerShell kill commands.
  for (const inst of instances) {
    if (inst.process && !inst.process.killed) {
      inst.process.kill("SIGTERM");
    }
  }

  // Synchronous Chrome kill — completes before exit, no lingering PowerShell processes.
  killChromeTreeByCdpPortRangeSync(BASE_DEBUGGING_PORT, portCount);

  void closeApplicantFormServer().finally(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
if (process.platform === "win32") {
  process.on("SIGBREAK", shutdown);
}

// Last-chance SYNCHRONOUS cleanup. Guarantees Chrome is killed even if the
// async shutdown above is cut short (abrupt terminal close on Windows).
process.on("exit", () => {
  try {
    killChromeTreeByCdpPortRangeSync(BASE_DEBUGGING_PORT, getInstancePortRangeCount());
  } catch {
    /* best effort */
  }
});

main().catch((err) => {
  logger.error({ err }, "Cluster startup failed");
  process.exit(1);
});

import dotenv from "dotenv";
dotenv.config({ override: true });
import { spawn, ChildProcess } from "node:child_process";
import {
  runApplicantFormWithSubmitHandler,
  closeApplicantFormServer,
} from "./ui/applicantDetailsFormServer";
import { setSessionLoginCredentials, getAllInstanceCredentials } from "./utils/sessionLogin.store";
import { setApplicantDetailsOverrides, getAllInstanceApplicantDetails, getApplicantDetailsOverrides } from "./utils/applicantDetails.store";
import { TelegramService } from "./services/telegram.service";
import {
  killChromeTreeByCdpPortRangeSync,
  killChromeTreeByCdpPortSync,
} from "./utils/killChromeByCdpPort";
import { clearSlotState } from "./utils/slotState";
import { clearSlotCenterOverride } from "./utils/slotCenterOverride.store";
import { clearPollReadyState, initPollReadyState } from "./utils/pollReadyState";
import { clearFleetPollCoord, ensureFleetPollEarliest } from "./utils/fleetPollCoord";
import { computeFleetPollAnchorAt, getFleetPollStepMs, getFleetPollIntervalSec, resolveApologiesIntervalSec, resolveApplicantsJoinStaggerSec } from "./utils/fleetPollSchedule";
import { registry } from "./monitoring/statusRegistry";
import { startChromeStatusProbe } from "./monitoring/chromeProbe";
import { focusChromeByPort, getDevtoolsInfo, warmupWindowHelper } from "./utils/chromeWindow";
import { makeInitialStatus, type MonitorHooks, type InstanceStatus } from "./monitoring/status.types";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clearChromeSessionDataBeforeLaunch } from "./utils/chromeProfileSessionClean";

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

// ── Staggered launch controller (dashboard-controlled) ──────────────────────
let staggerIntervalMs = Math.max(0, parseInt(process.env.STAGGER_INTERVAL_MS ?? "6000", 10) || 6000);
let pendingStarts: number[] = [];
let rolloutActive = false;
let rolloutPaused = false;
/**
 * Fleet-wide poll-start timestamp (ms). Computed once per first-submit batch as
 * rolloutStart + startInterval×instances + 60s buffer. Every instance waits until
 * this time + its own (id-1)×pollInterval offset before its first poll, so polling
 * begins evenly spaced only after the whole fleet has had time to log in.
 */
let rolloutPollStartAt: number | null = null;
/** Fleet-wide pause for slot polling (Monitor tab Stop/Resume). */
let fleetPollingPaused = false;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function getFleetPollIntervalMs(): number {
  return getFleetPollStepMs();
}

function broadcastToActiveChildren(msg: Record<string, unknown>): number {
  let n = 0;
  for (const inst of instances) {
    if (inst.process && !inst.process.killed) {
      try {
        inst.process.send({ ...msg, instanceId: inst.id });
        n++;
      } catch {
        /* child gone */
      }
    }
  }
  return n;
}

function profileDirForInstance(id: number): string {
  return `${BASE_PROFILE_DIR}-${id}`;
}

/** Advance sticky/proxy rotation so a Monitor Restart gets a new egress IP. */
function bumpProxyRotationOnDisk(profileDir: string): void {
  const file = path.join(profileDir, ".proxy-rotation-offset");
  let cur = 0;
  try {
    if (existsSync(file)) {
      const n = parseInt(readFileSync(file, "utf8").trim(), 10);
      if (Number.isFinite(n) && n >= 0) cur = n;
    }
  } catch {
    /* ignore */
  }
  try {
    writeFileSync(file, String(cur + 1), "utf8");
  } catch {
    /* ignore */
  }
}

function debugPortForInstance(id: number): number {
  return BASE_DEBUGGING_PORT + id - 1;
}

/** Ensure a placeholder tile exists so the dashboard shows every instance immediately. */
function seedRegistry(id: number): void {
  if (!registry.get(id)) {
    registry.applyStatus({
      ...makeInitialStatus(id, debugPortForInstance(id)),
      processAlive: false,
    });
  }
}

/** Send the run-bot-cycle now (spawns Chrome for this instance). */
function sendStartNow(id: number): void {
  const inst = instances.find((i) => i.id === id);
  if (!inst || !inst.process || inst.process.killed) {
        return;
  }
  seedRegistry(id);
  const cur = registry.get(id);
  if (cur) {
    registry.applyStatus({ ...cur, phase: "launching", detail: "starting…", heartbeatAt: Date.now(), updatedAt: Date.now() });
  }
  inst.process.send({ type: "config-updated", instanceId: id });
  inst.process.send({ type: "run-bot-cycle", instanceId: id, pollStartAt: rolloutPollStartAt });
}

async function runScheduler(): Promise<void> {
  if (rolloutActive) return;
  rolloutActive = true;
  try {
    while (pendingStarts.length) {
      if (rolloutPaused) {
        await sleep(400);
        continue;
      }
      const id = pendingStarts.shift()!;
      sendStartNow(id);
      // Always wait the full interval after a send. The form enqueues instances
      // synchronously one-by-one, so without an unconditional sleep the queue is
      // momentarily empty after each shift and every bot would start in the same
      // tick. Sleeping here also lets later enqueues (same tick) accumulate.
      await sleep(staggerIntervalMs);
    }
  } finally {
    rolloutActive = false;
  }
}

/** Queue an instance for staggered start (one every `staggerIntervalMs`). */
function enqueueStart(id: number): void {
  seedRegistry(id);
  const cur = registry.get(id);
  if (cur) registry.applyStatus({ ...cur, detail: "queued to start", updatedAt: Date.now() });
  if (!pendingStarts.includes(id)) pendingStarts.push(id);
  void runScheduler();
}

function sendToChild(id: number, msg: Record<string, unknown>): boolean {
  const inst = instances.find((i) => i.id === id);
  if (!inst?.process || inst.process.killed) return false;
  try {
    inst.process.send({ ...msg, instanceId: id });
    return true;
  } catch {
    return false;
  }
}

function buildMonitorHooks(): MonitorHooks {
  return {
    snapshot: () => registry.snapshot(),
    subscribe: (cb) => registry.subscribe(cb),
    focus: async (id) => {
      const port = debugPortForInstance(id);
      const ok = await focusChromeByPort(port);
      return ok ? { ok: true } : { ok: false, error: `No Chrome window found on port ${port}` };
    },
    devtools: async (id) => getDevtoolsInfo(debugPortForInstance(id)),
    start: ({ count, intervalMs }) => {
      if (intervalMs != null && intervalMs >= 0) staggerIntervalMs = Math.floor(intervalMs);
      const creds = getAllInstanceCredentials();
      const details = getAllInstanceApplicantDetails();
      const ids: number[] = [];
      for (let id = 1; id <= count; id++) {
        if (creds.get(id) && details.get(id)) ids.push(id);
      }
      if (ids.length === 0) {
        return { ok: false, error: "No saved instances with credentials + details. Configure & Save first." };
      }
      ensureInstances(Math.max(...ids));
      rolloutPaused = false;
      for (const id of ids) enqueueStart(id);
      return { ok: true };
    },
    pauseRollout: () => { rolloutPaused = true; return { ok: true }; },
    resumeRollout: () => { rolloutPaused = false; void runScheduler(); return { ok: true }; },
    pausePolling: (instanceId) => {
      const pollIntervalMs = getFleetPollIntervalMs();
      if (typeof instanceId === "number" && Number.isFinite(instanceId) && instanceId >= 1) {
        const id = Math.floor(instanceId);
        const ok = sendToChild(id, { type: "pause-polling" });
                return ok ? { ok: true } : { ok: false, error: `Bot #${id} is not running.` };
      }
      fleetPollingPaused = true;
      const n = broadcastToActiveChildren({ type: "pause-polling" });
            return n > 0 ? { ok: true } : { ok: false, error: "No active bot processes to pause." };
    },
    resumePolling: (instanceId) => {
      const pollIntervalMs = getFleetPollIntervalMs();
      const resumeAt = Date.now();
      if (typeof instanceId === "number" && Number.isFinite(instanceId) && instanceId >= 1) {
        const id = Math.floor(instanceId);
        const ok = sendToChild(id, { type: "resume-polling", resumeAt, pollIntervalMs });
                return ok ? { ok: true } : { ok: false, error: `Bot #${id} is not running.` };
      }
      fleetPollingPaused = false;
      const n = broadcastToActiveChildren({ type: "resume-polling", resumeAt, pollIntervalMs });
            return n > 0 ? { ok: true } : { ok: false, error: "No active bot processes to resume." };
    },
    stopInstance: (id) => {
      const inst = instances.find((i) => i.id === id);
      if (inst?.process && !inst.process.killed) inst.process.kill("SIGTERM");
      pendingStarts = pendingStarts.filter((x) => x !== id);
      registry.setProcessAlive(id, false);
      registry.markStopped(id, "stopped by operator");
      return { ok: true };
    },
    restartInstance: (id) => {
      const cur = registry.get(id);
      if (cur?.alreadyBooked || cur?.phase === "already_booked") {
        return { ok: false, error: `Bot #${id} is already booked — restart disabled.` };
      }
      const idx = instances.findIndex((i) => i.id === id);
      if (idx >= 0) {
        const inst = instances[idx]!;
        if (inst.process && !inst.process.killed) inst.process.kill("SIGTERM");
      }
      // Close this instance's Chrome so we can wipe cookies/session and rotate IP.
      try {
        killChromeTreeByCdpPortSync(debugPortForInstance(id));
      } catch {
        /* ignore */
      }
      const profileDir = profileDirForInstance(id);
      bumpProxyRotationOnDisk(profileDir);
      registry.applyStatus({
        ...makeInitialStatus(id, debugPortForInstance(id)),
        phase: "launching",
        detail: "restarting…",
        processAlive: true,
        chromeAlive: null,
        heartbeatAt: Date.now(),
        updatedAt: Date.now(),
      });
      const total = Math.max(currentNumInstances, id);
      void (async () => {
        try {
          await clearChromeSessionDataBeforeLaunch(profileDir);
        } catch {
          /* ignore */
        }
        const child = spawnBotInstance(id, total);
        if (idx >= 0) {
          instances[idx]!.process = child;
          instances[idx]!.profileDir = profileDir;
        } else {
          instances.push({
            id,
            process: child,
            debugPort: debugPortForInstance(id),
            profileDir,
            queue: Promise.resolve(),
          });
        }
        setTimeout(() => sendStartNow(id), 1500);
      })();
      return { ok: true };
    },
    setStaggerInterval: (ms) => { if (ms >= 0) staggerIntervalMs = Math.floor(ms); return { ok: true }; },
    setApologiesIntervalSec: (sec) => {
      if (!Number.isFinite(sec) || sec < 1) {
        return { ok: false, error: "Apologies interval must be at least 1 second." };
      }
      const global0 = getApplicantDetailsOverrides(0) ?? {};
      global0.apologiesIntervalSec = Math.floor(sec);
      delete global0.applicantsIntervalSec;
      setApplicantDetailsOverrides(global0, 0);
      broadcastToActiveChildren({ type: "global-settings-updated" });
      return { ok: true };
    },
    setPollIntervalSec: (sec) => {
      if (!Number.isFinite(sec) || sec < 1) {
        return { ok: false, error: "Poll interval must be at least 1 second." };
      }
      const global0 = getApplicantDetailsOverrides(0) ?? {};
      global0.userPollInterval = Math.floor(sec);
      setApplicantDetailsOverrides(global0, 0);
      broadcastToActiveChildren({ type: "global-settings-updated" });
      return { ok: true };
    },
    setApplicantsJoinStaggerSec: (sec) => {
      if (!Number.isFinite(sec) || sec < 0.1) {
        return { ok: false, error: "Applicants join stagger must be at least 0.1 seconds." };
      }
      const global0 = getApplicantDetailsOverrides(0) ?? {};
      global0.applicantsJoinStaggerSec = sec;
      setApplicantDetailsOverrides(global0, 0);
      broadcastToActiveChildren({ type: "global-settings-updated" });
      return { ok: true };
    },
    setCalendarPollingIntervalSec: (sec) => {
      if (!Number.isFinite(sec) || sec < 1) {
        return { ok: false, error: "Calendar polling interval must be at least 1 second." };
      }
      const global0 = getApplicantDetailsOverrides(0) ?? {};
      global0.calendarPollingInterval = Math.floor(sec);
      setApplicantDetailsOverrides(global0, 0);
      broadcastToActiveChildren({ type: "global-settings-updated" });
      return { ok: true };
    },
    reloadGlobalSettings: () => {
      broadcastToActiveChildren({ type: "config-updated" });
      return { ok: true };
    },
    getControl: () => {
      const global0 = getApplicantDetailsOverrides(0);
      return {
        intervalMs: staggerIntervalMs,
        rolloutActive,
        total: currentNumInstances,
        pollingPaused: fleetPollingPaused,
        pollIntervalMs: getFleetPollIntervalMs(),
        apologiesIntervalSec: resolveApologiesIntervalSec(global0),
        pollIntervalSec: getFleetPollIntervalSec(),
        applicantsJoinStaggerSec: resolveApplicantsJoinStaggerSec(global0),
        calendarPollingIntervalSec: global0 && typeof global0.calendarPollingInterval === "number" && global0.calendarPollingInterval >= 1
          ? Math.floor(global0.calendarPollingInterval) : 60,
      };
    },
  };
}

/**
 * Spawn or kill bot instances to reach `targetCount`.
 * Safe to call multiple times — only creates/kills the delta.
 */
function ensureInstances(targetCount: number): void {
  const count = Math.max(1, Math.min(100, targetCount));

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
    seedRegistry(i);
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
  }

async function startFormServer(): Promise<void> {
  await runApplicantFormWithSubmitHandler((formData) => {
    // Spawn/adjust instances to the count chosen in the form UI.
    const submittedCount = typeof formData.numInstances === "number" && formData.numInstances > 0
      ? Math.floor(formData.numInstances)
      : currentNumInstances || 1;
    ensureInstances(submittedCount);

    // Staggered start interval set on the Configure tab (seconds → ms).
    const sis = formData.staggerIntervalSec;
    if (typeof sis === "number" && Number.isFinite(sis) && sis >= 0) {
      staggerIntervalMs = Math.floor(sis) * 1000;
    }

    // Compute the fleet-wide poll-start gate once, on the first submit batch:
    //   rolloutStart + startInterval × instances + 60s buffer.
    // After that gate, bots claim CheckIsSlotAvailable slots every pollInterval
    // (shared rate limiter — missing bots don't leave dead air).
    if (formData.firstSubmit && rolloutPollStartAt == null) {
      const rolloutStartedAt = Date.now();
      rolloutPollStartAt = computeFleetPollAnchorAt(rolloutStartedAt, staggerIntervalMs, submittedCount);
    }

    // Initialize the synchronized polling gate on the very first submit batch
    // so child instances know how many peers to wait for before polling starts.
    // Guard with a flag to avoid re-initializing when the handler is called
    // once per instance in the same batch.
    const isFirstSubmit = formData.firstSubmit === true;
    if (isFirstSubmit) {
      clearSlotState();
      clearSlotCenterOverride();
    }
    if (isFirstSubmit && !pollReadyInitializedForBatch) {
      pollReadyInitializedForBatch = true;
      clearPollReadyState();
      initPollReadyState(submittedCount);
      clearFleetPollCoord();
      if (typeof rolloutPollStartAt === "number" && rolloutPollStartAt > 0) {
        ensureFleetPollEarliest(rolloutPollStartAt);
      }
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

    // Queue this instance for staggered start (one every `staggerIntervalMs`, default 6s).
    // config-updated + run-bot-cycle are sent by the scheduler when this instance's turn comes.
    enqueueStart(instanceId);
  }, {
    collectLogin: true,
    monitor: buildMonitorHooks(),
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

  seedRegistry(instanceId);
  registry.setProcessAlive(instanceId, true);

  child.on("exit", (code) => {
        const inst = instances.find((i) => i.id === instanceId);
    // Only clear if this exit is still the active process (restart replaces the child).
    if (inst && inst.process === child) {
      inst.process = null;
      registry.setProcessAlive(instanceId, false);
      registry.markStopped(instanceId, code != null && code !== 0 ? `exited (code ${code})` : "process exited");
    }
  });

  child.on("message", (msg: any) => {
    if (msg?.type === "bot-cycle-complete") {
            return;
    }
    if (msg?.type === "instance-retired" && typeof msg.instanceId === "number") {
      const id = Math.floor(msg.instanceId);
      const inst = instances.find((i) => i.id === id);
      if (inst) {
        inst.process = null;
        pendingStarts = pendingStarts.filter((x) => x !== id);
        registry.setProcessAlive(id, false);
        if (msg.reason === "already-booked") {
          registry.markAlreadyBooked(id, "already booked");
        } else {
          registry.markStopped(id, "retired");
        }
      }
      try {
        killChromeTreeByCdpPortSync(debugPortForInstance(id));
      } catch {
        /* ignore */
      }
      return;
    }
    // ── Monitoring: status push from child ──
    if (msg?.type === "status-update" && msg.status) {
      registry.applyStatus(msg.status as InstanceStatus);
      return;
    }
    // ── Monitoring: child asks to bring its Chrome window forward (e.g. captcha stuck) ──
    if (msg?.type === "request-focus" && typeof msg.instanceId === "number") {
      const id = msg.instanceId as number;
      const port = debugPortForInstance(id);
      void (async () => {
        // Status-update is sent just before request-focus; give it a moment to apply.
        await sleep(80);
        const before = registry.get(id);
        // Skip if attention already cleared (captcha solved) or bot prefers minimized (post-dashboard).
        if (!before?.attention || before.preferMinimized) {
                    return;
        }
        const ok = await focusChromeByPort(port, {
          shouldAbort: () => {
            const s = registry.get(id);
            return !s?.attention || !!s.preferMinimized;
          },
        });
              })();
      return;
    }
  });

  return child;
}

async function main(): Promise<void> {
  
  // Wipe stale shared state from previous sessions so new instances start clean.
  clearSlotState();
  clearPollReadyState();
  clearFleetPollCoord();

  // Start the monitoring registry (staleness sweep + subscriber notifications).
  registry.start();

  // Parent-side read-only DevTools probe (page URL + Chrome alive) — no Playwright attach.
  startChromeStatusProbe({ intervalMs: 2000 });

  // Pre-compile the window-activation helper so the first Focus click is instant.
  warmupWindowHelper();

  // Start the shared form server. Instances are spawned lazily on first Submit,
  // not at startup — so the user can choose the count from the UI.
  startFormServer().catch((err) => {
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
    process.exit(1);
});

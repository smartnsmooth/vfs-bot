import dotenv from "dotenv";
// Don't override env vars set by parent process (cluster mode)
dotenv.config({ override: false });
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import path from "node:path";
import { config, setCurrentInstanceId } from "./config/config";
import { classifyVfsFirstTabUrl } from "./flows/vfsTabUrl";
import { logger } from "./utils/logger";
import { PollingService } from "./services/polling.service";
import { BrowserService, VfsForbiddenError, VfsGatewayTimeoutError, VfsRateLimitedError } from "./services/browser.service";
import { TelegramService } from "./services/telegram.service";
import {
  runApplicantFormWithSubmitHandler,
  closeApplicantFormServer,
} from "./ui/applicantDetailsFormServer";
import { getSessionLoginCredentials, reloadSessionCredentialsFromDisk } from "./utils/sessionLogin.store";
import { reloadApplicantDetailsFromDisk, getApplicantDetailsOverrides } from "./utils/applicantDetails.store";
import {
  createSlotFoundWatcher,
  isSlotFoundByAnyInstance,
  markSlotFound,
  clearSlotState,
  type SlotFoundState,
} from "./utils/slotState";
import { setSlotCenterOverride, clearSlotCenterOverride } from "./utils/slotCenterOverride.store";
import { setSlotDate, clearSlotDate } from "./utils/slotDate.store";
import { getApplicationUrn } from "./utils/applicationUrn.store";
import { getAllocationId } from "./utils/allocationId.store";
import {
  isPollingSlotInConstraint,
  NoDatesInScheduleRangeError,
  resolveScheduleDateConstraint,
  scheduleConstraintIsActive,
  scheduleConstraintLogValue,
} from "./utils/scheduleAllowedDates.js";
import { clearApplicantIpCache, getApplicantIpForPayload } from "./utils/applicantIp";
import { clearChromeSessionDataBeforeLaunch, resolveChromeProfileFolderName } from "./utils/chromeProfileSessionClean";
import { killChromeTreeByCdpPortSync } from "./utils/killChromeByCdpPort";
import {
  markInstanceReady,
  waitForAllReady,
  getReadyInstanceOffset,
  getReadyInstancePollInterval,
  clearPollReadyState,
  stampGateOpened,
} from "./utils/pollReadyState";
import { reporter } from "./monitoring/statusReporter";
import { registry } from "./monitoring/statusRegistry";
import { startChromeStatusProbe } from "./monitoring/chromeProbe";
import { focusChromeByPort, getDevtoolsInfo } from "./utils/chromeWindow";
import type { MonitorHooks } from "./monitoring/status.types";
import { isPageNotFoundUrl } from "./flows/pageNotFound";
import { PageNotFoundRestartError } from "./services/browser.errors";

const polling = new PollingService();
const browser = new BrowserService();
const telegram = new TelegramService();

const MAX_PAGE_NOT_FOUND_RESTARTS = 12;
let pageNotFoundRestartRequested = false;

/** Passive URL sampler — defined after page-not-found helpers (see below). */
function startPageSampler(_instanceId?: number): void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const u = await browser.peekFirstTabUrl();
        if (!u) return;
        reporter.setPage(u);
        if (isPageNotFoundUrl(u)) {
          schedulePageNotFoundRestart(_instanceId);
        }
      } catch {
        /* ignore — monitoring must never affect the bot */
      }
    })();
  }, 3000);
  timer.unref?.();
}

async function resolveAndReportEgressIp(): Promise<void> {
  await browser.resolveApplicantIpForPayload().catch(() => { });
  reporter.setEgressIp(getApplicantIpForPayload());
}

const DEFAULT_POST_LOGIN_POLL_DELAY_SEC = 30;
const FAST_SKIP_CALENDAR_UP_TO_INSTANCE = Math.max(
  0,
  parseInt(process.env.FAST_SKIP_CALENDAR_UP_TO_INSTANCE ?? "5", 10) || 5
);
const DEFAULT_POLL_INTERVAL_SEC = 60;

type ProxyChainModule = {
  anonymizeProxy(proxyUrl: string): Promise<string>;
  closeAnonymizedProxy(url: string, closeConnections?: boolean): Promise<void>;
};
let proxyChainModule: ProxyChainModule | null = null;
let activeAnonymizedProxyUrl: string | null = null;

/** Shifts `PROXY_URLS` index for this Chrome profile on each credential-swap browser restart. */
const proxyRotationOffsetByProfileId = new Map<string, number>();

function bumpProxyRotationForProfile(profileId: string): void {
  proxyRotationOffsetByProfileId.set(profileId, (proxyRotationOffsetByProfileId.get(profileId) ?? 0) + 1);
}

async function closeActiveAnonymizedProxyTunnel(): Promise<void> {
  if (!activeAnonymizedProxyUrl) return;
  try {
    const proxyChain = await getProxyChainModule();
    await proxyChain.closeAnonymizedProxy(activeAnonymizedProxyUrl, true);
  } catch {
    /* ignore */
  }
  activeAnonymizedProxyUrl = null;
}

async function killChromeOnPort(port: number): Promise<void> {
  const execAsync = promisify(exec);
  try {
    if (process.platform === "win32") {
      const { stdout } = await execAsync("netstat -ano", { timeout: 8_000 });
      const pids = new Set<string>();
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.includes("LISTENING")) continue;
        if (!new RegExp(`\\.${port}\\s|:${port}\\s`).test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== "0") pids.add(pid);
      }
      for (const pid of pids) {
        logger.info({ pid, port }, "[Chrome] Killing process listening on CDP port (credential swap)");
        await execAsync(`taskkill /F /PID ${pid}`, { timeout: 6_000 }).catch(() => {
          /* already gone */
        });
      }
    } else {
      try {
        const { stdout } = await execAsync(`lsof -ti :${port}`, { timeout: 6_000 });
        const pids = stdout
          .trim()
          .split(/\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        for (const pid of pids) {
          await execAsync(`kill -9 ${pid}`, { timeout: 4_000 }).catch(() => {
            /* ignore */
          });
        }
      } catch {
        /* no listener */
      }
    }
    await new Promise((r) => setTimeout(r, 1_500));
  } catch (err) {
    logger.warn({ err, port }, "[Chrome] killChromeOnPort failed — continuing");
  }
}

/**
 * After logout when alternating two accounts: kill Chrome and respawn.
 * `PROXY_URLS` index advances on every new Chrome launch inside {@link ensureChromeWithDevTools}.
 */
async function relaunchChromeAfterCredentialSwapLogout(): Promise<void> {
  const profileId = getBotInstanceId(resolveChromeUserDataDir());
  const rawList = (process.env.PROXY_URLS ?? "").trim();
  const slots = rawList.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean).length;
  logger.info(
    { profileId, proxyUrlSlots: Math.max(1, slots) },
    "[Relogin] Credential swap: closing proxy tunnel + Chrome; respawning (proxy rotates on launch)"
  );
  await closeActiveAnonymizedProxyTunnel();
  await browser.disconnectCdp();
  await killChromeOnPort(getRemoteDebuggingPort());
  await ensureChromeWithDevTools();
}

/**
 * After a soft (4292XX) IP rotate, the next 429 of any kind triggers full relogin + cache clear.
 * Cleared on successful recovery escalations and on account-block stop.
 */
let softIpRotateAwaitingSecond429 = false;

function clearSoftIpRotateFlag(): void {
  softIpRotateAwaitingSecond429 = false;
}

/**
 * Rotate proxy / Chrome without VFS logout or session wipe.
 * Used for first 4292XX. Returns false if session could not be restored (caller should escalate).
 */
async function rotateIpWithoutRelogin(context: string): Promise<boolean> {
  logger.info({ context }, "[429 IP] Rotating IP without logout/relogin (preserve Chrome auth session)");
  let snap: { pageUrl: string; authorize: string | null; clientsource: string | null } | null = null;
  try {
    snap = await browser.snapshotVfsAuthForIpRotate();
  } catch (err) {
    logger.warn({ err, context }, "[429 IP] Could not snapshot VFS auth before rotate");
  }

  await closeActiveAnonymizedProxyTunnel();
  await browser.disconnectCdp();
  await killChromeOnPort(getRemoteDebuggingPort());
  await ensureChromeWithDevTools({ preserveSession: true });

  try {
    if (snap) {
      await browser.restoreVfsSessionAfterIpRotate(snap);
    } else {
      // Reconnect only — cookies may still restore a logged-in tab on goto login URL.
      await browser.restoreVfsSessionAfterIpRotate({
        pageUrl: config.loginPageUrl,
        authorize: null,
        clientsource: null,
      });
    }
    await resolveAndReportEgressIp();
    softIpRotateAwaitingSecond429 = true;
    return true;
  } catch (err) {
    logger.warn(
      { err, context },
      "[429 IP] Session restore after IP rotate failed — escalating to full relogin"
    );
    clearSoftIpRotateFlag();
    return false;
  }
}

/**
 * Handle 4292XX / soft IP rate-limit.
 * First hit → rotate IP only. Second hit (or failed soft restore) → full relogin with cache clear.
 */
async function handleIpRateLimitRecovery(
  instanceId: number | undefined,
  context: string,
  code?: string
): Promise<"soft_rotated" | "full_relogin"> {
  const label = code ?? "4292xx";
  reporter.setPhase("recovering", `IP rate-limit ${label} — rotating IP`);
  reporter.setPoll({ code: label });
  if (!softIpRotateAwaitingSecond429) {
    await telegram
      .alert(
        "error",
        `Bot ${instanceId ?? "?"} got IP rate-limit ${label} (${context}). Rotating IP without relogin...`
      )
      .catch(() => { });
    const ok = await rotateIpWithoutRelogin(context);
    if (ok) {
      logger.info({ instanceId, context, code: label }, "[429 IP] Soft rotate done — resuming without relogin");
      await telegram
        .alert("info", `Bot ${instanceId ?? "?"} IP rotated (no relogin) after ${label} — resuming.`)
        .catch(() => { });
      return "soft_rotated";
    }
  } else {
    logger.warn(
      { instanceId, context, code: label },
      "[429 IP] Second 429 after soft IP rotate — full relogin + clear caches"
    );
    await telegram
      .alert(
        "error",
        `Bot ${instanceId ?? "?"} still rate-limited (${label}) after IP rotate. Full relogin + cache clear...`
      )
      .catch(() => { });
  }

  clearSoftIpRotateFlag();
  await performPollStyleRelogin(instanceId, `${context}-escalate`);
  logger.info({ instanceId, context, code: label }, "[429 IP] Full relogin after escalate complete");
  await telegram
    .alert("info", `Bot ${instanceId ?? "?"} recovered from ${label} via full relogin — resuming.`)
    .catch(() => { });
  return "full_relogin";
}

async function stopForAccountRateLimit(
  instanceId: number | undefined,
  context: string,
  code?: string
): Promise<void> {
  clearSoftIpRotateFlag();
  const label = code ?? "4290xx";
  reporter.setAttention("blocked", `account rate-limit ${label} — stopped`);
  reporter.setPhase("stopped", `account rate-limit ${label}`);
  reporter.setPoll({ code: label });
  logger.error(
    { instanceId, context, code: label },
    "4290XX account/User ID rate-limit — stopping bot"
  );
  await telegram
    .alert(
      "error",
      `Bot ${instanceId ?? "?"} account blocked (${label}) during ${context}. Stopping — User ID / account rate-limit.`
    )
    .catch(() => { });
}

async function getProxyChainModule(): Promise<ProxyChainModule> {
  if (proxyChainModule) return proxyChainModule;
  proxyChainModule = (await import("proxy-chain")) as unknown as ProxyChainModule;
  return proxyChainModule;
}

/** Serialize submit-driven runs so two clicks do not overlap. */
let submitChain: Promise<void> = Promise.resolve();
function enqueueSubmitTask(task: () => Promise<void>): void {
  submitChain = submitChain.then(task).catch((err) => {
    logger.error({ err }, "Submit-driven run failed");
  });
}

/**
 * Cluster-mode: allow UI Submit to abort polling immediately.
 * We can't cancel an in-flight network request, but we can:
 * - stop sleeping between polls immediately
 * - stop the poll loop ASAP
 * - let the queued next cycle start with updated config
 */
let pollingAbortSeq = 0;
let pollingAbortWaiters: Array<() => void> = [];
function requestPollingAbort(reason: string, instanceId?: number): void {
  pollingAbortSeq += 1;
  const waiters = pollingAbortWaiters;
  pollingAbortWaiters = [];
  for (const w of waiters) {
    try {
      w();
    } catch {
      /* ignore */
    }
  }
  logger.info({ instanceId, reason, pollingAbortSeq }, "[poll] Abort requested");
}

/** Fleet-wide pause from Monitor tab — bots keep Chrome/session, skip slot checks. */
let pollingPaused = false;
let pollingPauseWaiters: Array<() => void> = [];
/** After resume, wait until this timestamp before the next slot check (staggered per instance). */
let pollingResumeGateUntil = 0;

function setPollingPaused(paused: boolean): void {
  const was = pollingPaused;
  pollingPaused = paused;
  reporter.setPollingPaused(paused);
  if (was && !paused) {
    const waiters = pollingPauseWaiters;
    pollingPauseWaiters = [];
    for (const w of waiters) {
      try {
        w();
      } catch {
        /* ignore */
      }
    }
  }
}

function waitForPollingResume(): Promise<void> {
  if (!pollingPaused) return Promise.resolve();
  return new Promise<void>((resolve) => {
    pollingPauseWaiters.push(resolve);
  });
}

/**
 * Hold the poll loop while fleet polling is paused; after resume, honour the
 * staggered gate (bot N waits (N-1)×pollInterval from resumeAt).
 */
async function holdIfPollingPaused(
  instanceId?: number,
  abortSeq?: number
): Promise<"ok" | "abort"> {
  while (pollingPaused) {
    if (instanceBookingActive || instanceOnPaymentPage) return "ok";
    reporter.setPhase("polling", "paused — click Resume polling");
    const raced = await Promise.race([
      waitForPollingResume().then(() => "resume" as const),
      abortSeq != null
        ? waitForPollingAbort(abortSeq).then(() => "abort" as const)
        : new Promise<"never">(() => { }),
    ]);
    if (raced === "abort" || (abortSeq != null && pollingAbortSeq !== abortSeq)) {
      await throwIfAbortedForPageNotFound(abortSeq!, "pause-hold-abort");
      return "abort";
    }
  }

  const gate = pollingResumeGateUntil;
  if (gate > Date.now() && !instanceBookingActive && !instanceOnPaymentPage) {
    const remaining = gate - Date.now();
    reporter.setPhase("polling", `resuming in ${Math.round(remaining / 1000)}s (fleet stagger)`);
    logger.info({ instanceId, remaining, gate }, "[poll] Staggered resume wait");
    await Promise.race([
      new Promise<void>((r) => setTimeout(r, remaining)),
      abortSeq != null ? waitForPollingAbort(abortSeq) : new Promise<void>(() => { }),
    ]);
    if (abortSeq != null && pollingAbortSeq !== abortSeq) {
      await throwIfAbortedForPageNotFound(abortSeq, "resume-gate-abort");
      return "abort";
    }
    pollingResumeGateUntil = 0;
  }
  return "ok";
}

function applyResumePollingGate(instanceId: number | undefined, resumeAt: number, pollIntervalMs: number): void {
  const id = typeof instanceId === "number" && instanceId >= 1 ? Math.floor(instanceId) : 1;
  const step = Math.max(1000, Math.floor(pollIntervalMs) || 60_000);
  pollingResumeGateUntil = resumeAt + (id - 1) * step;
  setPollingPaused(false);
  logger.info(
    { instanceId: id, resumeAt, pollIntervalMs: step, gateUntil: pollingResumeGateUntil },
    "[poll] Resume — applying fleet stagger gate"
  );
}

function schedulePageNotFoundRestart(instanceId?: number): void {
  if (pageNotFoundRestartRequested) return;
  pageNotFoundRestartRequested = true;
  requestPollingAbort("page-not-found", instanceId);
}

async function throwIfPageNotFoundRestartRequested(context: string): Promise<void> {
  if (!pageNotFoundRestartRequested) return;
  pageNotFoundRestartRequested = false;
  throw new PageNotFoundRestartError(context);
}

/** When the page sampler aborts a wait, restart the bot if the abort was for page-not-found. */
async function throwIfAbortedForPageNotFound(abortSeq: number, context: string): Promise<void> {
  if (pollingAbortSeq !== abortSeq) {
    await throwIfPageNotFoundRestartRequested(context);
  }
}

async function checkUrlForPageNotFound(url: string, context: string): Promise<void> {
  if (isPageNotFoundUrl(url)) {
    throw new PageNotFoundRestartError(`${context}: ${url}`);
  }
}

async function rotateIpForPageNotFound(instanceId?: number, context?: string): Promise<void> {
  logger.error({ instanceId, context }, "[page-not-found] Rotating IP and restarting bot cycle");
  reporter.setPhase("recovering", "page-not-found — rotating IP + restart");
  reporter.setAttention("blocked", "page-not-found — restarting bot");
  await telegram
    .alert("error", `Bot ${instanceId ?? "?"} page-not-found — rotating IP + restart`)
    .catch(() => { });
  clearApplicantIpCache();
  await browser.disconnectCdp().catch(() => { });
  await relaunchChromeAfterCredentialSwapLogout();
}
function waitForPollingAbort(currentSeq: number): Promise<void> {
  if (pollingAbortSeq !== currentSeq) return Promise.resolve();
  return new Promise<void>((resolve) => {
    pollingAbortWaiters.push(resolve);
  });
}

/** Cluster mode: queues for each instance, indexed by instanceId. */
const instanceQueues = new Map<number, Promise<void>>();

/**
 * Per-process booking state flags.
 * `instanceBookingActive` — set just before saveApplicants; cleared on booking failure.
 *   Prevents this instance from abandoning an in-progress booking to chase a new slot.
 * `instanceOnPaymentPage` — set after postSchedule succeeds; never cleared.
 *   Causes runOneBotCycle to return immediately so Chrome stays on the payment page.
 */
let instanceBookingActive = false;
let instanceOnPaymentPage = false;
let instanceStopped = false;

/** Which credential slot (0 = primary, 1 = secondary) to use for the *next* login. Rotates after each successful login when a second pair is configured. */
const pendingCredentialSlotByInstance = new Map<number, 0 | 1>();

function hasSecondCredentials(instanceId?: number): boolean {
  const c = getSessionLoginCredentials(instanceId);
  return !!(c?.username2?.trim() && c.password2 != null && String(c.password2) !== "");
}

function getPendingCredentialSlot(instanceId?: number): 0 | 1 {
  const id = instanceId ?? 0;
  return pendingCredentialSlotByInstance.get(id) ?? 0;
}

function advanceCredentialSlotAfterSuccessfulLogin(instanceId?: number): void {
  const id = instanceId ?? 0;
  if (!hasSecondCredentials(id)) return;
  const cur = pendingCredentialSlotByInstance.get(id) ?? 0;
  pendingCredentialSlotByInstance.set(id, cur === 0 ? 1 : 0);
}

function resolveLoginUsername(instanceId?: number): string {
  const slot = getPendingCredentialSlot(instanceId);
  const creds = getSessionLoginCredentials(instanceId);
  if (creds) {
    if (slot === 1 && creds.username2?.trim()) return creds.username2.trim();
    const u = creds.username?.trim();
    if (u) return u;
  }
  return (config.vfsUsername || process.env.VFS_USERNAME || "").trim();
}

function resolveLoginPassword(instanceId?: number): string {
  const slot = getPendingCredentialSlot(instanceId);
  const creds = getSessionLoginCredentials(instanceId);
  if (creds) {
    if (slot === 1 && creds.password2 != null && String(creds.password2) !== "") return creds.password2;
    if (creds.password != null && creds.password !== "") return creds.password;
  }
  return config.vfsPassword || process.env.VFS_PASSWORD || "";
}

function getChromeDevToolsCheckUrls(): string[] {
  const base = (config.browserCdpUrl || "http://localhost:9222").replace(/\/$/, "");
  let port = "9222";
  try {
    const u = new URL(base.startsWith("http") ? base : `http://${base}`);
    if (u.port) port = u.port;
  } catch {
    /* keep default */
  }
  return [...new Set([base, `http://127.0.0.1:${port}`, `http://localhost:${port}`])];
}

function getRemoteDebuggingPort(): number {
  const raw = config.browserCdpUrl || "http://localhost:9222";
  try {
    const u = new URL(raw.startsWith("http") ? raw : `http://${raw}`);
    if (u.port) return parseInt(u.port, 10);
  } catch {
    /* fall through */
  }
  return 9222;
}

function resolveChromeExecutablePath(): string {
  const envChromePath = (process.env.CHROME_PATH ?? "").trim();
  if (envChromePath) {
    // Allow passing either chrome.exe or a parent folder.
    const fromEnv = envChromePath.toLowerCase().endsWith(".exe")
      ? envChromePath
      : path.join(envChromePath, "chrome.exe");
    if (existsSync(fromEnv)) return fromEnv;
  }

  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const candidates = [
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(localAppData, "Google", "Chrome", "Bin", "chrome.exe"),
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  // Final fallback for PATH-based resolution.
  return "chrome.exe";
}

function resolveChromeUserDataDir(): string {
  const envUserDataDir = (process.env.CHROME_USER_DATA_DIR ?? "").trim();
  if (envUserDataDir) return envUserDataDir;
  return "C:/vfs-bot-profile";
}

function getBotInstanceId(userDataDir: string): string {
  const fromEnv = (process.env.BOT_INSTANCE_ID ?? "").trim();
  if (fromEnv) return fromEnv;
  const base = path.basename(userDataDir).trim();
  return base || "instance-default";
}

/**
 * Patch Chrome Preferences before launch:
 * - drop saved window placement (off-screen / wrong size from prior runs)
 * - mark clean exit so "Restore pages?" / crash bubble does not appear
 * - disable password manager so "Save password?" never pops up
 * Must run while Chrome for this profile is not running.
 */
function patchChromeProfilePrefsBeforeLaunch(userDataDir: string): void {
  try {
    const profile = resolveChromeProfileFolderName();
    const profileDir = path.join(userDataDir, profile);
    mkdirSync(profileDir, { recursive: true });
    const prefsPath = path.join(profileDir, "Preferences");
    let prefs: Record<string, unknown> = {};
    if (existsSync(prefsPath)) {
      try {
        prefs = JSON.parse(readFileSync(prefsPath, "utf-8")) as Record<string, unknown>;
      } catch {
        prefs = {};
      }
    }

    const browser = (prefs.browser ?? {}) as Record<string, unknown>;
    delete browser.window_placement;
    prefs.browser = browser;

    const profilePrefs = (prefs.profile ?? {}) as Record<string, unknown>;
    profilePrefs.exit_type = "Normal";
    profilePrefs.exited_cleanly = true;
    profilePrefs.password_manager_enabled = false;
    prefs.profile = profilePrefs;

    prefs.credentials_enable_service = false;
    prefs.credentials_enable_autosignin = false;

    const passwordManager = (prefs.password_manager ?? {}) as Record<string, unknown>;
    passwordManager.saving_and_filling_passwords_enabled = false;
    prefs.password_manager = passwordManager;

    writeFileSync(prefsPath, JSON.stringify(prefs), "utf-8");
  } catch {
    // Non-critical — flags below still suppress most dialogs
  }
}

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Sticky proxy session string embedded in `PROXY_URLS` via `{session}` or `{instance}`.
 * - **`PROXY_STICKY_SESSION_ID`**: same string for every launch (fixed sticky pool entry).
 * - **Default**: `vfs-<profileInstanceId>` — stable for that Chrome user-data-dir / bot instance across runs,
 *   so cluster instance `1` keeps one session id and instance `2` another (per-instance sticky).
 * Pair with your vendor’s session-sticky URL format (e.g. `-session-{session}` in the username).
 * New Chrome launch still uses the same token unless you change env or profile id — for a **new** egress per
 * launch, change `PROXY_STICKY_SESSION_ID` or rotate `PROXY_URLS` index (`bumpProxyRotationForProfile`).
 */
function stableSessionToken(instanceId: string): string {
  const raw = (process.env.PROXY_STICKY_SESSION_ID ?? "").trim();
  if (raw) return raw;
  const base = (instanceId || "instance").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `vfs-${base}`.slice(0, 40);
}

function resolveProxyForInstance(instanceId: string): string | null {
  const rawList = (process.env.PROXY_URLS ?? "").trim();
  if (!rawList) return null;
  const list = rawList
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return null;
  const base = hashString(instanceId) % list.length;
  const rot = proxyRotationOffsetByProfileId.get(instanceId) ?? 0;
  const idx = (base + rot) % list.length;
  const selected = list[idx];
  const session = stableSessionToken(instanceId);
  return selected.replace(/\{session\}/gi, session).replace(/\{instance\}/gi, instanceId);
}

type ParsedProxy = {
  scheme: "http" | "https" | "socks4" | "socks5";
  host: string;
  port: number;
  username: string;
  password: string;
};

function parseProxy(proxyValue: string): ParsedProxy | null {
  const raw = proxyValue.trim();
  if (!raw) return null;

  // Normalize common form "host:port" to "http://host:port".
  const looksLikeHostPort = /^[^:/?#\s]+:\d+$/.test(raw);
  const candidate = looksLikeHostPort ? `http://${raw}` : raw;

  try {
    const u = new URL(candidate);
    const scheme = (u.protocol || "http:").replace(":", "").toLowerCase();
    const allowed = scheme === "http" || scheme === "https" || scheme === "socks4" || scheme === "socks5";
    const proto = (allowed ? scheme : "http") as ParsedProxy["scheme"];
    const port = u.port ? Number.parseInt(u.port, 10) : (proto === "https" ? 443 : 80);
    if (!u.hostname || !Number.isFinite(port) || port <= 0) return null;
    return {
      scheme: proto,
      host: u.hostname,
      port,
      username: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
    };
  } catch {
    return null;
  }
}

function toChromeProxyServer(proxy: ParsedProxy): string {
  return `${proxy.scheme}://${proxy.host}:${proxy.port}`;
}

async function resolveLaunchProxyServer(selectedProxy: string | null): Promise<{
  launchProxy: string | null;
  proxyHasAuth: boolean;
  viaLocalTunnel: boolean;
}> {
  if (!selectedProxy) return { launchProxy: null, proxyHasAuth: false, viaLocalTunnel: false };
  const parsedProxy = parseProxy(selectedProxy);
  if (!parsedProxy) return { launchProxy: null, proxyHasAuth: false, viaLocalTunnel: false };

  const hasAuth = Boolean(parsedProxy.username || parsedProxy.password);
  if (!hasAuth) {
    if (activeAnonymizedProxyUrl) {
      try {
        const proxyChain = await getProxyChainModule();
        await proxyChain.closeAnonymizedProxy(activeAnonymizedProxyUrl, true);
      } catch {
        /* ignore */
      }
      activeAnonymizedProxyUrl = null;
    }
    return { launchProxy: toChromeProxyServer(parsedProxy), proxyHasAuth: false, viaLocalTunnel: false };
  }

  const proxyChain = await getProxyChainModule();
  if (activeAnonymizedProxyUrl) {
    try {
      await proxyChain.closeAnonymizedProxy(activeAnonymizedProxyUrl, true);
    } catch {
      /* ignore */
    }
    activeAnonymizedProxyUrl = null;
  }
  activeAnonymizedProxyUrl = await proxyChain.anonymizeProxy(selectedProxy);
  return { launchProxy: activeAnonymizedProxyUrl, proxyHasAuth: true, viaLocalTunnel: true };
}

function checkDevToolsEndpoint(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const versionUrl = `${url.replace(/\/$/, "")}/json/version`;
    const get = versionUrl.startsWith("https") ? httpsGet : httpGet;
    const req = get(versionUrl, (res) => {
      resolve(res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300);
      res.destroy();
    });
    req.on("error", () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

let cachedScreenSize: { width: number; height: number } | null = null;

/**
 * Detect the primary monitor's working area (excludes taskbar) via PowerShell.
 * Result is cached. Falls back to 1920x1040 if detection fails.
 */
function detectScreenWorkingArea(): Promise<{ width: number; height: number }> {
  if (cachedScreenSize) return Promise.resolve(cachedScreenSize);
  return new Promise((resolve) => {
    const ps = spawn("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; $a=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; Write-Host \"$($a.Width)x$($a.Height)\"",
    ], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    ps.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    const timer = setTimeout(() => { try { ps.kill(); } catch { } finish(); }, 3000);
    ps.on("exit", () => { clearTimeout(timer); finish(); });
    ps.on("error", () => { clearTimeout(timer); finish(); });
    function finish() {
      const m = out.trim().match(/^(\d+)x(\d+)$/);
      if (m) {
        cachedScreenSize = { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
      } else {
        cachedScreenSize = { width: 1920, height: 1040 };
      }
      logger.info({ screen: cachedScreenSize }, "[Chrome] Detected screen working area");
      resolve(cachedScreenSize);
    }
  });
}

/**
 * Compute Chrome window size and position for a tiled grid layout.
 * Instance IDs are 1-based; returns {width, height, x, y} in pixels.
 */
async function computeChromeGridPosition(instanceIdx: number, totalInstances: number): Promise<{ width: number; height: number; x: number; y: number }> {
  const total = Math.max(1, totalInstances);
  const idx = Math.max(0, instanceIdx - 1); // 0-based

  // Auto layout targets a ~5:2 column-to-row ratio (wider than tall).
  // 10 instances → 5 cols × 2 rows; 40 → 10 cols × 4 rows.
  const cols = config.chromeGridColumns > 0
    ? config.chromeGridColumns
    : Math.max(1, Math.ceil(Math.sqrt(total * 2.5)));
  const rows = Math.max(1, Math.ceil(total / cols));

  const screen = await detectScreenWorkingArea();
  const screenW = config.screenWidth > 0 ? config.screenWidth : screen.width;
  const screenH = config.screenHeight > 0 ? config.screenHeight : screen.height;

  const w = config.chromeWindowWidth > 0 ? config.chromeWindowWidth : Math.floor(screenW / cols);
  const h = config.chromeWindowHeight > 0 ? config.chromeWindowHeight : Math.floor(screenH / rows);

  const col = idx % cols;
  const row = Math.floor(idx / cols);

  return { width: w, height: h, x: col * w, y: row * h };
}

async function ensureChromeWithDevTools(opts?: { preserveSession?: boolean }): Promise<void> {
  const userDataDir = resolveChromeUserDataDir();
  const instanceId = getBotInstanceId(userDataDir);
  const debugPort = getRemoteDebuggingPort();

  // If Chrome DevTools is already reachable on the target port, skip spawning.
  // But still reposition the window in case it's off-screen or wrong size.
  for (const url of getChromeDevToolsCheckUrls()) {
    if (await checkDevToolsEndpoint(url)) {
      logger.info({ url, instanceId }, "[Chrome] DevTools already running — reusing existing Chrome");
      const numId = parseInt(process.env.BOT_INSTANCE_ID ?? "1", 10) || 1;
      const total = parseInt(process.env.BOT_TOTAL_INSTANCES ?? "1", 10) || 1;
      if (total > 1) {
        const grid = await computeChromeGridPosition(numId, total);
        await moveWindowByDebugPort(debugPort, grid);
      }
      return;
    }
  }

  await clearChromeSessionDataBeforeLaunch(userDataDir, {
    preserveAuthSession: opts?.preserveSession === true,
  });

  const selectedProxy = resolveProxyForInstance(instanceId);
  bumpProxyRotationForProfile(instanceId);
  if (selectedProxy) {
    logger.info(
      {
        instanceId,
        proxyRotationStep: proxyRotationOffsetByProfileId.get(instanceId) ?? 0,
        preserveSession: opts?.preserveSession === true,
      },
      "[Chrome] New launch — using next PROXY_URLS entry (per-instance cyclic rotation)"
    );
  }
  clearApplicantIpCache();

  const chromePath = resolveChromeExecutablePath();
  const resolvedProxy = await resolveLaunchProxyServer(selectedProxy);

  const numericInstanceId = parseInt(process.env.BOT_INSTANCE_ID ?? "1", 10) || 1;
  const totalInstances = parseInt(process.env.BOT_TOTAL_INSTANCES ?? "1", 10) || 1;
  const grid = await computeChromeGridPosition(numericInstanceId, totalInstances);

  patchChromeProfilePrefsBeforeLaunch(userDataDir);

  const chromeArgs = [
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Suppress "Save password?" and "Restore pages?" / crash-restore bubbles
    "--disable-save-password-bubble",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--disable-features=PasswordManagerOnboarding,PasswordLeakDetection",
    "--password-store=basic",
  ];
  const profileDirectory = process.env.CHROME_PROFILE_DIRECTORY?.trim();
  if (profileDirectory) {
    chromeArgs.push(`--profile-directory=${profileDirectory}`);
  }
  if (resolvedProxy.launchProxy) {
    chromeArgs.push(`--proxy-server=${resolvedProxy.launchProxy}`);
  }
  chromeArgs.push(config.loginPageUrl);

  logger.info(
    { instanceId, grid, totalInstances },
    `[Chrome] Launching at grid position col=${grid.x / grid.width}, row=${grid.y / grid.height} (${grid.width}x${grid.height})`
  );

  const child = spawn(chromePath, chromeArgs, { detached: true, stdio: "ignore" });
  child.unref();
  if (selectedProxy && !resolvedProxy.launchProxy) {
    logger.warn({ selectedProxy }, "Proxy parse failed; starting without proxy. Use format: http://user:pass@host:port");
  }

  const delayMs = 400;
  const maxWaitMs = 60_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    for (const url of getChromeDevToolsCheckUrls()) {
      if (await checkDevToolsEndpoint(url)) {
        // Small delay for Chrome window to fully render before moving it
        await new Promise((r) => setTimeout(r, 500));
        await moveWindowByDebugPort(debugPort, grid);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Chrome DevTools did not become ready. Start Chrome manually with --remote-debugging-port=9222");
}

/**
 * Move and resize the Chrome window that owns the given debugging port.
 * Writes a .ps1 temp script (avoids quoting hell) that uses Win32 MoveWindow.
 */
function moveWindowByDebugPort(
  debugPort: number,
  bounds: { width: number; height: number; x: number; y: number },
): Promise<void> {
  const scriptContent = `
Add-Type -Name "WM" -Namespace "Win32Move" -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int h2,bool r);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
'@ -ErrorAction SilentlyContinue

$roots = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
  $_.CommandLine -match '--remote-debugging-port=${debugPort}\\b'
} | Select-Object -ExpandProperty ProcessId)
Write-Host "MOVE port=${debugPort} bounds=${bounds.x},${bounds.y},${bounds.width},${bounds.height} roots=$($roots.Count)"
if ($roots.Count -eq 0) { Write-Host "MOVE no Chrome found for port ${debugPort}"; exit 0 }

$all = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object ProcessId,ParentProcessId)
$set = [System.Collections.Generic.HashSet[int]]::new()
foreach ($r in $roots) { $set.Add($r) | Out-Null }
$go = $true
while ($go) {
  $go = $false
  foreach ($p in $all) {
    if ($set.Contains($p.ParentProcessId) -and -not $set.Contains($p.ProcessId)) {
      $set.Add($p.ProcessId) | Out-Null
      $go = $true
    }
  }
}
Write-Host "MOVE tree PIDs: $($set.Count)"

$moved = $false
foreach ($procId in $set) {
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
    $h = $proc.MainWindowHandle
    Write-Host "MOVE found window PID=$procId handle=$h title=$($proc.MainWindowTitle)"
    # Place window without stealing focus (no SetForegroundWindow — that undid dashboard minimize)
    if ([Win32Move.WM]::IsIconic($h)) {
      [Win32Move.WM]::ShowWindow($h, 9) | Out-Null
    }
    $result = [Win32Move.WM]::MoveWindow($h, ${bounds.x}, ${bounds.y}, ${bounds.width}, ${bounds.height}, $true)
    Write-Host "MOVE result=$result"
    $moved = $true
    break
  }
}
if (-not $moved) { Write-Host "MOVE no window handle found in tree" }
`.trim();

  const tmpDir = process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
  const scriptPath = path.join(tmpDir, `vfs-move-chrome-${debugPort}.ps1`);

  writeFileSync(scriptPath, scriptContent, "utf-8");

  return new Promise((resolve) => {
    const ps = spawn("powershell", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    ps.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
    ps.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { ps.kill(); } catch { } done(); }, 8000);
    ps.on("exit", (code) => {
      clearTimeout(timer);
      if (stdout.trim()) {
        logger.info({ debugPort }, `[Chrome] MoveWindow: ${stdout.trim()}`);
      }
      if (code !== 0 && stderr.trim()) {
        logger.warn({ debugPort, code, stderr: stderr.trim() }, "[Chrome] MoveWindow script error");
      }
      done();
    });
    ps.on("error", (err) => {
      clearTimeout(timer);
      logger.warn({ err, debugPort }, "[Chrome] Failed to spawn PowerShell for MoveWindow");
      done();
    });
    let resolved = false;
    function done() {
      if (!resolved) {
        resolved = true;
        try { unlinkSync(scriptPath); } catch { }
        resolve();
      }
    }
  });
}

/**
 * Minimize or restore the Chrome window identified by its remote-debugging port.
 * Uses Win32 ShowWindow via PowerShell: SW_MINIMIZE=6, SW_RESTORE=9.
 */
function chromeWindowShowCommand(debugPort: number, swCommand: number, label: string): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  const scriptContent = `
Add-Type -Name "WC" -Namespace "Win32Chrome" -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
'@ -ErrorAction SilentlyContinue

$roots = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
  $_.CommandLine -match '--remote-debugging-port=${debugPort}\\b'
} | Select-Object -ExpandProperty ProcessId)
if ($roots.Count -eq 0) { Write-Host "${label} no Chrome for port ${debugPort}"; exit 0 }

$all = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object ProcessId,ParentProcessId)
$set = [System.Collections.Generic.HashSet[int]]::new()
foreach ($r in $roots) { $set.Add($r) | Out-Null }
$go = $true
while ($go) {
  $go = $false
  foreach ($p in $all) {
    if ($set.Contains($p.ParentProcessId) -and -not $set.Contains($p.ProcessId)) {
      $set.Add($p.ProcessId) | Out-Null; $go = $true
    }
  }
}
$done = $false
foreach ($procId in $set) {
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
    [Win32Chrome.WC]::ShowWindow($proc.MainWindowHandle, ${swCommand}) | Out-Null
    Write-Host "${label} OK PID=$procId"
    $done = $true; break
  }
}
if (-not $done) { Write-Host "${label} no window handle found" }
`.trim();

  const tmpDir = process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
  const scriptPath = path.join(tmpDir, `vfs-chrome-${label.toLowerCase().replace(/\W+/g, "-")}-${debugPort}.ps1`);
  writeFileSync(scriptPath, scriptContent, "utf-8");

  return new Promise((resolve) => {
    const ps = spawn("powershell", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    ps.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
    ps.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { ps.kill(); } catch { } finish(); }, 6000);
    ps.on("exit", (code) => {
      clearTimeout(timer);
      if (stdout.trim()) logger.info({ debugPort }, `[Chrome] ${label}: ${stdout.trim()}`);
      if (code !== 0 && stderr.trim()) logger.warn({ debugPort, code }, `[Chrome] ${label} error: ${stderr.trim()}`);
      finish();
    });
    ps.on("error", (err) => {
      clearTimeout(timer);
      logger.warn({ err, debugPort }, `[Chrome] ${label} spawn failed`);
      finish();
    });
    let resolved = false;
    function finish() {
      if (!resolved) { resolved = true; try { unlinkSync(scriptPath); } catch { } resolve(); }
    }
  });
}

function minimizeChromeWindow(): Promise<void> {
  return chromeWindowShowCommand(getRemoteDebuggingPort(), 6, "MINIMIZE");
}

function restoreChromeWindow(): Promise<void> {
  return chromeWindowShowCommand(getRemoteDebuggingPort(), 9, "RESTORE");
}

/** Fixed settle time on dashboard after a mid-workflow restart/relogin. */
const RESTART_DASHBOARD_WAIT_MS = 30_000;

/**
 * After a successful dashboard landing: minimize Chrome (operator doesn't need it
 * while polling). Optionally wait (restart/relogin settle) before continuing.
 */
async function settleOnDashboard(opts: {
  instanceId?: number;
  waitMs?: number;
  abortSeq?: number;
  reason?: string;
}): Promise<"ok" | "abort"> {
  // Stop monitor blink + tell parent to ignore late captcha auto-focus.
  reporter.setAttention(null);
  reporter.setPreferMinimized(true);
  await minimizeChromeWindow().catch((err) => {
    logger.warn({ err, instanceId: opts.instanceId }, "[Chrome] Minimize after dashboard failed");
  });
  // Re-assert minimize after settle wait (and once mid-wait) — late captcha
  // focus / any accidental restore should not leave Chrome visible during polling.
  const remimize = async () => {
    if (!instanceOnPaymentPage) {
      await minimizeChromeWindow().catch(() => { });
    }
  };
  void (async () => {
    await new Promise((r) => setTimeout(r, 800));
    await remimize();
  })();
  logger.info({ instanceId: opts.instanceId, reason: opts.reason }, "[Chrome] Minimized after dashboard");

  const waitMs = opts.waitMs ?? 0;
  if (waitMs <= 0) {
    await remimize();
    return "ok";
  }

  reporter.setPhase("polling", `on dashboard — waiting ${Math.round(waitMs / 1000)}s`);
  logger.info(
    { instanceId: opts.instanceId, waitMs, reason: opts.reason },
    "[Dashboard] Waiting before next step after restart/relogin"
  );

  const abortSeq = opts.abortSeq;
  if (abortSeq == null) {
    await new Promise((r) => setTimeout(r, waitMs));
    await remimize();
    return "ok";
  }
  await Promise.race([
    new Promise((r) => setTimeout(r, waitMs)),
    waitForPollingAbort(abortSeq),
  ]);
  if (pollingAbortSeq !== abortSeq) {
    await throwIfAbortedForPageNotFound(abortSeq, "dashboard-settle-abort");
    return "abort";
  }
  await remimize();
  return "ok";
}

/** Mark payment page reached and bring Chrome forward so the operator can pay. */
async function enterPaymentPageMode(instanceId?: number): Promise<void> {
  instanceOnPaymentPage = true;
  reporter.setPreferMinimized(false);
  reporter.setPhase("payment", "on payment page — pay manually");
  reporter.setAttention(null);
  const focused = await focusChromeByPort(getRemoteDebuggingPort()).catch(() => false);
  if (!focused) {
    await restoreChromeWindow().catch(() => { });
  }
  logger.info(
    { instanceId, focused },
    "[Booking] Complete — Chrome focused on payment page and will stay there permanently"
  );
}

/**
 * If another instance wrote `slot-state.json`, adopt their center/category and treat polling as a hit.
 * Must run after each slot check (and between centers): peers can mark the file while this instance is in-flight.
 *
 * `watcherCache` — optional cached state from the slot-found watcher.  The file may already
 * be deleted (peer cleared it after a failed booking) but the watcher captured the state
 * before deletion.  We check the file first; if empty, fall back to the cache.
 */
async function checkPeerFoundSlotAndJoinBooking(instanceId?: number, watcherCache?: SlotFoundState | null): Promise<boolean> {
  // Never interrupt this instance if it is already booking or has reached the payment page.
  if (instanceBookingActive || instanceOnPaymentPage) {
    return false;
  }
  let sharedState = isSlotFoundByAnyInstance();
  if (!sharedState.found && watcherCache?.found) {
    sharedState = watcherCache;
  }
  if (!sharedState.found || sharedState.foundBy === instanceId) {
    return false;
  }
  if (sharedState.centerCode && sharedState.visaCategoryCode) {
    setSlotCenterOverride(sharedState.centerCode, sharedState.visaCategoryCode);
    logger.info(
      {
        foundBy: sharedState.foundBy,
        thisInstance: instanceId,
        centerCode: sharedState.centerCode,
        visaCategoryCode: sharedState.visaCategoryCode,
        slot: sharedState.slot,
      },
      "Slot found by another instance — using their centerCode/visaCategoryCode and proceeding to booking"
    );
  } else {
    logger.info(
      { foundBy: sharedState.foundBy, thisInstance: instanceId, slot: sharedState.slot },
      "Slot found by another instance — stopping poll loop and proceeding to booking"
    );
  }
  return true;
}

/** `true` if at least one slot was seen (polling stops after the first hit). */
async function runPollLoop(
  instanceId?: number,
  opts?: {
    /** After every N completed poll rounds, call onRelogin() to refresh the VFS session. */
    reloginAfter?: number;
    /** Async callback that performs logout → login → preparePolling. */
    onRelogin?: () => Promise<void>;
  }
): Promise<boolean> {
  const limit = config.pollLimit;
  let completed = 0;
  let slotFound = false;
  const slotWatcher = createSlotFoundWatcher(instanceId);
  const myAbortSeq = pollingAbortSeq;

  try {
    while (limit === 0 || completed < limit) {
      if (pollingAbortSeq !== myAbortSeq) {
        await throwIfAbortedForPageNotFound(myAbortSeq, "polling-loop-abort");
        logger.info({ instanceId }, "[poll] Aborting poll loop (config updated)");
        return false;
      }

      if ((await holdIfPollingPaused(instanceId, myAbortSeq)) === "abort") {
        logger.info({ instanceId }, "[poll] Aborting poll loop during pause/resume");
        return false;
      }

      // Instant wake: if any other instance already marked slot found, stop immediately.
      if (await checkPeerFoundSlotAndJoinBooking(instanceId, slotWatcher.cachedState())) {
        return true;
      }

      try {
        // Get all configured centers for this instance
        const { getConfiguredCenters } = await import("./utils/centerConfig.js");
        const centers = getConfiguredCenters(instanceId);

        if (centers.length === 0) {
          logger.warn({ instanceId }, "No centers configured for this instance - check form setup");
          break;
        }

        // Round-robin: check one center per poll round, alternating each iteration.
        const center = centers[completed % centers.length]!;

        if (await checkPeerFoundSlotAndJoinBooking(instanceId, slotWatcher.cachedState())) {
          return true;
        }

        const currentUrl = await browser.getFirstTabUrl();
        reporter.setPage(currentUrl);
        await throwIfPageNotFoundRestartRequested("polling-loop");
        if (!/\/(applications|dashboard|home|application-detail|your-details)/i.test(currentUrl)) {
          // Not on a normal VFS page. If it's a block/error page (403201 "Access
          // Restricted", page-not-found, session-expired, or a 429 body), recover
          // instead of silently stopping — this is the post-login block case.
          if (isPageNotFoundUrl(currentUrl)) {
            throw new PageNotFoundRestartError(`polling: ${currentUrl}`);
          }
          const blockKind = await browser.detectPageBlockKind();
          if (blockKind === "account_429") {
            await stopForAccountRateLimit(instanceId, "polling-page-block", "4290xx");
            return false;
          }
          if (blockKind === "ip_429") {
            await handleIpRateLimitRecovery(instanceId, "polling-page-block", "4292xx");
            continue;
          }
          if (blockKind === "forbidden") {
            logger.error({ instanceId, currentUrl }, "Block/error page during polling — restarting browser + rotating IP + relogin");
            reporter.setAttention("blocked", "block page after login — rotating IP + relogin");
            await telegram.alert("error", `Bot ${instanceId ?? "?"} hit a block page during polling (${currentUrl || "unknown"}). Restarting browser + rotating IP + relogin...`).catch(() => { });
            await performPollStyleRelogin(instanceId, "polling-block-page");
            continue;
          }
          logger.error({ instanceId, currentUrl }, "Browser is not on a supported VFS page for polling. Stopping polling.");
          await telegram.alert("error", `Not on a supported VFS page for polling (${currentUrl || "unknown"}). Polling stopped.`).catch(() => { });
          return false;
        }

        logger.info(
          { instanceId, centerNumber: center.centerNumber, vacCode: center.vacCode, visaCategoryCode: center.visaCategoryCode, poll: completed + 1 },
          `Checking Center ${center.centerNumber}`
        );
        reporter.setPhase("polling", `checking center ${center.centerNumber} (${center.vacCode})`);
        reporter.setPoll({ center: `${center.centerNumber}:${center.vacCode}`, pollCount: completed + 1 });

        const { slot, response, centerNumber, centerCode, visaCategoryCode, unauthorized, accountBlocked, rateLimitedIp, rateLimitCode, forbidden, gatewayTimeout } = await polling.checkSlotsInBrowser(browser, {
          centerCode: center.vacCode,
          visaCategoryCode: center.visaCategoryCode,
          centerNumber: center.centerNumber,
        });

        console.log(`[Poll Center ${center.centerNumber}]`, JSON.stringify(response, null, 2));

        if (gatewayTimeout) {
          logger.error({ instanceId }, "504 Gateway Timeout — restarting browser with IP rotation and re-login...");
          await telegram.alert("error", `Bot ${instanceId ?? "?"} got 504 Gateway Timeout during polling. Restarting browser + rotating IP + re-login...`).catch(() => { });
          await performPollStyleRelogin(instanceId, "504-gateway-timeout-recovery");
          logger.info({ instanceId }, "[504 Recovery] Browser restarted, IP rotated, re-logged in — resuming polling");
          await telegram.alert("info", `Bot ${instanceId ?? "?"} recovered from 504 — polling resumed.`).catch(() => { });
          continue;
        }

        if (forbidden) {
          logger.error({ instanceId }, "403 Forbidden — IP/session blocked. Restarting browser with IP rotation...");
          await telegram.alert("error", `Bot ${instanceId ?? "?"} got 403 Forbidden during polling. Restarting browser + rotating IP...`).catch(() => { });
          await performPollStyleRelogin(instanceId, "403-forbidden-recovery");
          logger.info({ instanceId }, "[403 Recovery] Browser restarted, IP rotated, re-logged in — resuming polling");
          await telegram.alert("info", `Bot ${instanceId ?? "?"} recovered from 403 — polling resumed.`).catch(() => { });
          continue;
        }

        if (unauthorized) {
          logger.error({ instanceId }, "401 Unauthorized — session expired or invalid. Stopping polling. Please re-login on the VFS tab.");
          await telegram.alert("error", "401 Unauthorized — session expired. Polling stopped. Please re-login.").catch(() => { });
          return false;
        }

        if (accountBlocked) {
          await stopForAccountRateLimit(instanceId, "polling", rateLimitCode);
          return false;
        }

        if (rateLimitedIp) {
          await handleIpRateLimitRecovery(instanceId, "polling", rateLimitCode);
          continue;
        }

        // A non-429 poll result means soft IP rotate (if any) succeeded — allow soft rotate again later.
        clearSoftIpRotateFlag();

        if (slot) {
          slotFound = true;
          reporter.setPoll({ slotFound: true, code: "slot" });
          reporter.setDetail(`slot found in center ${centerNumber}`);

          markSlotFound(instanceId ?? 0, centerCode!, visaCategoryCode!, slot);
          setSlotCenterOverride(centerCode!, visaCategoryCode!);

          await telegram.alert("slot_found", `Slot (Center ${centerNumber}): ${slot.center || "—"} ${slot.date} ${slot.time}`, { slotId: slot.id, centerNumber }).catch(() => { });
          logger.info(
            { instanceId, centerNumber, centerCode, visaCategoryCode, slot },
            `Slot found by this instance in Center ${centerNumber} — broadcasting center/category to all instances`
          );
          break;
        }

        if (await checkPeerFoundSlotAndJoinBooking(instanceId, slotWatcher.cachedState())) {
          return true;
        }

        await telegram.alert("no_slot_found", `No slot in Center ${center.centerNumber} (${center.vacCode})`).catch(() => { });
        logger.info({ instanceId, centerNumber: center.centerNumber, vacCode: center.vacCode }, `No slot found in Center ${center.centerNumber}`);
      } catch (err) {
        logger.error({ err, instanceId }, "Poll error");
        await telegram.alert("error", err instanceof Error ? err.message : "Poll error").catch(() => { });
      }
      completed += 1;
      if (limit > 0 && completed >= limit) {
        logger.info({ completed, limit, instanceId }, "Polling finished (POLL_LIMIT reached)");
        break;
      }

      // Periodic session refresh: every N polls call the relogin callback so a fresh
      // VFS session is obtained, resetting the server-side 429 rate-limit counter.
      const reloginAfter = opts?.reloginAfter;
      if (reloginAfter && reloginAfter > 0 && completed % reloginAfter === 0 && opts?.onRelogin) {
        logger.info(
          { instanceId, completed, reloginAfter },
          "[Relogin] Poll relogin interval reached — refreshing VFS session"
        );
        try {
          await opts.onRelogin();
          logger.info({ instanceId }, "[Relogin] Session refreshed — resuming polling");
        } catch (err) {
          logger.error({ err, instanceId }, "[Relogin] Re-login failed — stopping polling (no valid session)");
          await telegram.alert("error", "Re-login failed — polling stopped. Please check the browser and re-login manually.").catch(() => { });
          return false;
        }
      }

      // Fixed polling interval for all instances (no random MIN/MAX).
      const fixedTiming = getFixedTimingForInstance(instanceId);
      const delayMs = fixedTiming.pollIntervalMs;
      logger.info(
        { delayMs, instanceId, mode: "fixed_interval" },
        "Waiting before next poll"
      );

      // Keep a handle to the timer so we can still honour the full delay even if the
      // slot-watcher fires first (prevents busy-spinning when slot-state.json is already
      // present at watcher-creation time because another instance is actively booking).
      const timerPromise = new Promise<void>((r) => setTimeout(r, delayMs));

      const woke = await Promise.race([
        timerPromise.then(() => "timer" as const),
        slotWatcher.wait().then(() => "slot" as const),
        waitForPollingAbort(myAbortSeq).then(() => "abort" as const),
      ]);

      if (woke === "abort") {
        logger.info({ instanceId }, "[poll] Aborted during sleep (config updated)");
        return false;
      }

      if (woke === "slot" && (await checkPeerFoundSlotAndJoinBooking(instanceId, slotWatcher.cachedState()))) {
        logger.info({ instanceId }, "Woken by slot-state file change — stopping poll loop immediately");
        return true;
      }

      // Slot-watcher fired but this instance cannot join right now (already booking /
      // already on payment page).  Wait for the full timer so the loop doesn't spin at
      // full speed — without this guard, slotWatcher.wait() resolves immediately on
      // every iteration (resolved=true stays set) and the 6-second delay is never honoured.
      if (woke === "slot") {
        await timerPromise;
      }
    }
    return slotFound;
  } finally {
    slotWatcher.dispose();
  }
}

const MAX_SAVE_APPLICANTS_RETRIES = 8;

function isSaveApplicants422(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Save applicants API error:") && err.message.includes("422");
}

/** Save applicants returned VFS "no slots" (code 10673) — separate from HTTP 422 invalid request. */
function isSaveApplicants10673(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const prefix = "Save applicants API error: ";
  const m = err.message;
  if (!m.startsWith(prefix)) return false;
  try {
    const j = JSON.parse(m.slice(prefix.length)) as { code?: number | string };
    return j.code === 10673 || String(j.code) === "10673";
  } catch {
    return m.includes("10673");
  }
}

/** Save-applicants API / HTTP failure (excluding 10673, which has its own retry loop). */
function isSaveApplicantsFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes("Save applicants API error:") ||
    m.includes("Save applicants failed HTTP") ||
    m.includes("Save applicants failed after retry HTTP") ||
    m.includes("Save applicants failed: no URN") ||
    m.includes("Save applicants did not set URN") ||
    m.startsWith("Save applicants: response is not JSON")
  );
}

function getFixedTimingForInstance(instanceId?: number): { postLoginOffsetMs: number; pollIntervalMs: number } {
  const id = typeof instanceId === "number" && Number.isFinite(instanceId) && instanceId >= 1 ? Math.floor(instanceId) : 1;

  const globalDet = getApplicantDetailsOverrides(0);
  const userPollIntervalSec =
    globalDet && typeof globalDet.userPollInterval === "number" && globalDet.userPollInterval >= 1
      ? globalDet.userPollInterval
      : DEFAULT_POLL_INTERVAL_SEC;

  const numInstancesRaw = parseInt(process.env.BOT_TOTAL_INSTANCES ?? "1", 10);
  const numInstances = Number.isFinite(numInstancesRaw) && numInstancesRaw > 0 ? numInstancesRaw : 1;

  const stepMs = Math.max(1000, userPollIntervalSec * 1000);

  const scaled = (process.env.POLL_INTERVAL_SCALED ?? "true").trim().toLowerCase();
  const isScaled = scaled !== "false" && scaled !== "0";

  // Use ready-instance count when available (after the "wait for all ready" gate),
  // otherwise fall back to the total configured instance count.
  const readyInterval = isScaled ? getReadyInstancePollInterval(stepMs) : 0;
  const fallbackInterval = isScaled ? stepMs * numInstances : stepMs;
  const pollIntervalMs = isScaled && readyInterval > 0 ? readyInterval : fallbackInterval;

  return {
    postLoginOffsetMs: isScaled ? (id - 1) * stepMs : 0,
    pollIntervalMs,
  };
}

function deriveCalendarDateFromPollingRaw(raw?: string): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  // Expected from polling: MM/DD/YYYY [time...]
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${mm}/${dd}/${yyyy}`;
  }
  // Fallback: YYYY-MM-DD -> MM/DD/YYYY
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, yyyy, mm, dd] = iso;
    return `${mm}/${dd}/${yyyy}`;
  }
  return null;
}

/**
 * Same session refresh as periodic poll relogin: logout, optional Chrome restart + proxy rotation, login, prepare polling.
 * Save-applicants 10673 recovery always kills Chrome and respawns so `ensureChromeWithDevTools` runs session clean + proxy bump (same as two-account hard swap), even with a single VFS account.
 */
async function performPollStyleRelogin(instanceId?: number, context?: string): Promise<void> {
  const pollReloginInterval = config.pollReloginInterval;
  const ctx = context ?? "poll-relogin";
  clearSoftIpRotateFlag();
  reporter.setPhase("recovering", `relogin (${ctx})`);

  logger.info(
    { instanceId, pollReloginInterval, ctx },
    "[Relogin] Logout → close Chrome → clear cache/cookies → rotate IP → new Chrome → login"
  );
  await browser.logoutVfsAndOpenLoginFirstTab().catch(() => {
    /* tab may already be gone */
  });
  clearApplicantIpCache();
  await relaunchChromeAfterCredentialSwapLogout();
  await performVfsLoginFromStore(instanceId);
  await resolveAndReportEgressIp();
  // Mid-workflow restart/relogin: settle on dashboard (minimize + 30s) before polling again.
  await settleOnDashboard({
    instanceId,
    waitMs: RESTART_DASHBOARD_WAIT_MS,
    reason: ctx,
  });
  await browser.preparePollingAfterLogin({ skipDashboardNavigate: true });
}

/**
 * Full session recovery after save-applicants failure:
 * logout, close Chrome, clear cache/cookies, rotate IP, login, prepare polling, poll again.
 * Only clears this instance's in-memory overrides — does NOT delete slot-state.json
 * because other instances may still be booking based on that shared signal.
 * Returns whether a slot was found (self or peer) and polling should resume booking.
 */
async function recoverFromSaveApplicantsFailure(
  instanceId: number | undefined,
  context: string,
  err: unknown
): Promise<boolean> {
  const msg = err instanceof Error ? err.message : String(err);
  logger.warn(
    { err, instanceId, context },
    "Save applicants failed — full relogin (clear cache, rotate IP) and resuming poll"
  );
  await telegram
    .alert("error", `Save applicants failed (instance ${instanceId ?? 1}), full relogin: ${msg}`)
    .catch(() => { });
  clearSlotCenterOverride();
  clearSlotDate();
  await performPollStyleRelogin(instanceId, context);
  return runPollLoop(instanceId);
}

/** 504 on any booking API: close browser, clear caches, rotate IP, re-login, poll, restart booking chain. */
async function recoverBookingChainFromGatewayTimeout(
  instanceId: number | undefined,
  context: string,
  err: unknown,
  slotStateCache?: SlotFoundState
): Promise<boolean> {
  logger.warn(
    { instanceId, context, err: err instanceof Error ? err.message : String(err) },
    "504 Gateway Timeout — full relogin and restarting booking chain"
  );
  if (!(await recoverFromSaveApplicantsFailure(instanceId, context, err))) {
    return false;
  }
  return runBookingChainWithRetry(instanceId, slotStateCache);
}

/** 4292XX on booking APIs: soft IP rotate first, else full relogin; then restart booking chain. */
async function recoverBookingChainFromIpRateLimit(
  instanceId: number | undefined,
  context: string,
  err: VfsRateLimitedError,
  slotStateCache?: SlotFoundState
): Promise<boolean> {
  const outcome = await handleIpRateLimitRecovery(instanceId, context, err.code);
  if (outcome === "soft_rotated") {
    // Session preserved — retry booking without re-poll if we still have slot cache.
    return runBookingChainWithRetry(instanceId, slotStateCache);
  }
  // Full relogin already completed inside handleIpRateLimitRecovery — poll for a fresh slot, then book.
  clearSlotCenterOverride();
  clearSlotDate();
  if (!(await runPollLoop(instanceId))) {
    return false;
  }
  return runBookingChainWithRetry(instanceId, slotStateCache);
}

const MAX_FORBIDDEN_RETRIES = 3;

function isOtpRelatedLoginFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("otp") ||
    msg.includes("mail.tm") ||
    msg.includes("login did not complete")
  );
}

/**
 * Open login page with 403 recovery: if the page returns 403 Forbidden, close browser,
 * clear cache/cookies, rotate IP, open a new browser and retry.
 */
async function openLoginWithForbiddenRecovery(instanceId?: number): Promise<void> {
  for (let attempt = 1; attempt <= MAX_FORBIDDEN_RETRIES; attempt++) {
    try {
      await browser.openLoginInFirstTab();
      return;
    } catch (err) {
      if (err instanceof VfsForbiddenError) {
        logger.error({ instanceId, attempt, maxRetries: MAX_FORBIDDEN_RETRIES }, "403 Forbidden on login page — restarting browser + rotating IP");
        await telegram.alert("error", `Bot ${instanceId ?? "?"} got 403 on login page (attempt ${attempt}/${MAX_FORBIDDEN_RETRIES}). Restarting browser + rotating IP...`).catch(() => { });
        clearApplicantIpCache();
        await relaunchChromeAfterCredentialSwapLogout();
        if (attempt === MAX_FORBIDDEN_RETRIES) {
          throw new Error(`Login page still 403 after ${MAX_FORBIDDEN_RETRIES} browser restarts — giving up.`);
        }
        continue;
      }
      if (err instanceof VfsGatewayTimeoutError) {
        logger.error({ instanceId, attempt, maxRetries: MAX_FORBIDDEN_RETRIES }, "504 Gateway Timeout on login page — restarting browser + rotating IP");
        await telegram.alert("error", `Bot ${instanceId ?? "?"} got 504 on login page (attempt ${attempt}/${MAX_FORBIDDEN_RETRIES}). Restarting browser + rotating IP...`).catch(() => { });
        clearApplicantIpCache();
        await relaunchChromeAfterCredentialSwapLogout();
        if (attempt === MAX_FORBIDDEN_RETRIES) {
          throw new Error(`Login page still 504 after ${MAX_FORBIDDEN_RETRIES} browser restarts — giving up.`);
        }
        continue;
      }
      if (err instanceof VfsRateLimitedError) {
        if (err.isAccountBlock) {
          await stopForAccountRateLimit(instanceId, "open-login", err.code);
          throw new Error(`Login page account rate-limit ${err.code} — stopping.`);
        }
        logger.error(
          { instanceId, attempt, maxRetries: MAX_FORBIDDEN_RETRIES, code: err.code, escalate: softIpRotateAwaitingSecond429 },
          "4292XX IP rate-limit on login page — rotating IP"
        );
        await telegram
          .alert(
            "error",
            `Bot ${instanceId ?? "?"} got IP rate-limit ${err.code} on login page (attempt ${attempt}/${MAX_FORBIDDEN_RETRIES}). Rotating IP...`
          )
          .catch(() => { });
        if (softIpRotateAwaitingSecond429) {
          clearSoftIpRotateFlag();
        } else {
          softIpRotateAwaitingSecond429 = true;
        }
        clearApplicantIpCache();
        await relaunchChromeAfterCredentialSwapLogout();
        if (attempt === MAX_FORBIDDEN_RETRIES) {
          throw new Error(`Login page still 429 after ${MAX_FORBIDDEN_RETRIES} recoveries — giving up.`);
        }
        continue;
      }
      throw err;
    }
  }
}

/**
 * Login with recovery for 403 Forbidden (max 3 retries) and OTP/mail.tm failures (retry forever).
 * On OTP failure: close browser, clear cache/cookies/storage, rotate IP, open new browser, retry.
 */
async function loginWithForbiddenRecovery(instanceId?: number): Promise<void> {
  let forbiddenAttempts = 0;
  let otpAttempts = 0;

  while (true) {
    try {
      await performVfsLoginFromStore(instanceId);
      return;
    } catch (err) {
      if (err instanceof PageNotFoundRestartError) {
        throw err;
      }
      if (err instanceof VfsForbiddenError) {
        forbiddenAttempts++;
        reporter.setPhase("recovering", `403 block — rotating IP + relogin (attempt ${forbiddenAttempts})`);
        logger.error({ instanceId, forbiddenAttempts, maxRetries: MAX_FORBIDDEN_RETRIES }, "403 Forbidden during login — restarting browser + rotating IP");
        await telegram.alert("error", `Bot ${instanceId ?? "?"} got 403 during login (attempt ${forbiddenAttempts}/${MAX_FORBIDDEN_RETRIES}). Restarting browser + rotating IP...`).catch(() => { });
        clearApplicantIpCache();
        await relaunchChromeAfterCredentialSwapLogout();
        if (forbiddenAttempts >= MAX_FORBIDDEN_RETRIES) {
          throw new Error(`Login still 403 after ${MAX_FORBIDDEN_RETRIES} browser restarts — giving up.`);
        }
        await browser.openLoginInFirstTab();
        continue;
      }

      if (err instanceof VfsGatewayTimeoutError) {
        logger.error(
          { instanceId, reason: err.message },
          "[Login] 504 Gateway Timeout — closing browser, clearing cache, rotating IP, retrying from login"
        );
        await telegram.alert(
          "error",
          `Bot ${instanceId ?? "?"} got 504 Gateway Timeout during login. Restarting browser + rotating IP...`
        ).catch(() => { });
        clearApplicantIpCache();
        await relaunchChromeAfterCredentialSwapLogout();
        await browser.openLoginInFirstTab();
        continue;
      }

      if (err instanceof VfsRateLimitedError) {
        if (err.isAccountBlock) {
          await stopForAccountRateLimit(instanceId, "login", err.code);
          throw new Error(`Login account rate-limit ${err.code} — stopping.`);
        }
        const escalate = softIpRotateAwaitingSecond429;
        logger.error(
          { instanceId, reason: err.message, code: err.code, escalate },
          "[Login] 4292XX IP rate-limit — rotating IP" + (escalate ? " (second hit / clear caches)" : " (soft)")
        );
        await telegram
          .alert(
            "error",
            escalate
              ? `Bot ${instanceId ?? "?"} still rate-limited (${err.code}) during login after IP rotate. Clearing caches + rotating IP again...`
              : `Bot ${instanceId ?? "?"} got IP rate-limit ${err.code} during login. Rotating IP...`
          )
          .catch(() => { });
        if (escalate) {
          clearSoftIpRotateFlag();
        } else {
          softIpRotateAwaitingSecond429 = true;
        }
        clearApplicantIpCache();
        await relaunchChromeAfterCredentialSwapLogout();
        await browser.openLoginInFirstTab();
        continue;
      }

      if (isOtpRelatedLoginFailure(err)) {
        otpAttempts++;
        const reason = err instanceof Error ? err.message : String(err);
        logger.error(
          { instanceId, otpAttempts, reason },
          "[Login/OTP] OTP step failed — closing browser, clearing cache, rotating IP, retrying"
        );
        await telegram.alert(
          "error",
          `Bot ${instanceId ?? "?"} OTP/login failed (attempt ${otpAttempts}): ${reason}\nRestarting browser + rotating IP...`
        ).catch(() => { });
        clearApplicantIpCache();
        await relaunchChromeAfterCredentialSwapLogout();
        await browser.openLoginInFirstTab();
        continue;
      }

      throw err;
    }
  }
}

/**
 * Try save-applicants with a unified retry strategy:
 *
 * - **10673** ("no appointment slots"): retry up to `pollReloginInterval` times at poll interval,
 *   then poll-style relogin + slot poll, forever until save succeeds.
 *
 * - **Any other error** (422, HTTP non-2xx, bad JSON, no URN, etc.): retry up to
 *   MAX_SAVE_APPLICANTS_RETRIES (8) times with poll interval delay between attempts.
 *   After 8 failures → full relogin (clear cache, rotate IP) + poll, then retry the whole
 *   cycle from attempt 1.  Never stops the bot.
 */
async function runBookingChainWithRetry(instanceId?: number, slotStateCache?: SlotFoundState): Promise<boolean> {
  const pollIntervalMs = getFixedTimingForInstance(instanceId).pollIntervalMs;
  const phase1Attempts = Math.max(1, config.pollReloginInterval);
  const chainAbortSeq = pollingAbortSeq;

  // If a newer force-book arrived before this chain even started, exit immediately.
  if (pollingAbortSeq !== chainAbortSeq) {
    await throwIfAbortedForPageNotFound(chainAbortSeq, "booking-chain-abort");
    logger.info({ instanceId }, "[ForceBook] Booking chain superseded before start — skipping");
    return false;
  }

  let nonRecoverableAttempts = 0; // tracks consecutive non-10673 failures across the retry loop

  applicants10673Recovery: while (true) {
    // Check abort before each Applicants API attempt so superseded chains don't waste a request.
    if (pollingAbortSeq !== chainAbortSeq) {
      await throwIfAbortedForPageNotFound(chainAbortSeq, "booking-save-abort");
      logger.info({ instanceId }, "[ForceBook] Booking chain superseded — exiting before save-applicants");
      return false;
    }
    for (let phase1Idx = 0; phase1Idx < phase1Attempts; phase1Idx++) {
      let saw10673ThisPhase = false;
      try {
        reporter.setBookingStep("save applicants");
        await browser.saveApplicantsViaLiftApi();

        // Verify URN was set; if not, treat as a retryable failure.
        const urnAfterSave = getApplicationUrn();
        if (!urnAfterSave?.trim()) {
          throw new Error("Save applicants did not set URN");
        }

        break applicants10673Recovery;
      } catch (err) {
        if (err instanceof VfsRateLimitedError) {
          if (err.isAccountBlock) {
            await stopForAccountRateLimit(instanceId, "save-applicants", err.code);
            return false;
          }
          return recoverBookingChainFromIpRateLimit(instanceId, "429-ip-save-applicants", err, slotStateCache);
        }
        if (err instanceof VfsGatewayTimeoutError) {
          return recoverBookingChainFromGatewayTimeout(instanceId, "504-gateway-timeout-save-applicants", err, slotStateCache);
        }
        if (isSaveApplicants10673(err)) {
          saw10673ThisPhase = true;
          logger.warn(
            {
              instanceId,
              phase1Round: phase1Idx + 1,
              phase1Attempts,
              err: err instanceof Error ? err.message : String(err),
            },
            "Save applicants returned 10673 (no appointment slots in response) — phase-1 retry or relogin"
          );
        } else {
          nonRecoverableAttempts += 1;
          const errMsg = err instanceof Error ? err.message : String(err);

          if (nonRecoverableAttempts >= MAX_SAVE_APPLICANTS_RETRIES) {
            logger.warn(
              { instanceId, attempt: nonRecoverableAttempts, maxRetries: MAX_SAVE_APPLICANTS_RETRIES, err: errMsg },
              "Save applicants failed after max retries — full relogin and resuming poll"
            );
            nonRecoverableAttempts = 0;
            if (!(await recoverFromSaveApplicantsFailure(instanceId, "save-applicants-max-retries", err))) {
              return false;
            }
            continue applicants10673Recovery;
          }

          logger.warn(
            { instanceId, attempt: nonRecoverableAttempts, maxRetries: MAX_SAVE_APPLICANTS_RETRIES, err: errMsg },
            "Save applicants failed — waiting poll interval before retry"
          );
        }
      }

      // Delay before next attempt (shared by both 10673 phase-1 retries and non-10673 retries).
      if (saw10673ThisPhase && phase1Idx >= phase1Attempts - 1) {
        // 10673 exhausted phase-1 — skip delay, fall through to relogin below.
        continue;
      }
      await Promise.race([
        new Promise<void>((r) => setTimeout(r, pollIntervalMs)),
        waitForPollingAbort(chainAbortSeq),
      ]);
      if (pollingAbortSeq !== chainAbortSeq) {
        await throwIfAbortedForPageNotFound(chainAbortSeq, "booking-retry-delay-abort");
        logger.info({ instanceId }, "[ForceBook] Save-applicants retry delay interrupted — exiting booking chain");
        return false;
      }
    }

    logger.info(
      { instanceId, phase1Attempts },
      "Save applicants still 10673 after phase-1 retries — poll-style relogin, slot poll, then retry save applicants"
    );
    await performPollStyleRelogin(instanceId, "save-applicants-10673");
    await runPollLoop(instanceId);
  }

  const fastSkipCalendar = (instanceId ?? 1) <= FAST_SKIP_CALENDAR_UP_TO_INSTANCE;
  const scheduleConstraint = resolveScheduleDateConstraint(instanceId);
  const hasScheduleFilter = scheduleConstraintIsActive(scheduleConstraint);
  const calendarOpts = hasScheduleFilter ? { scheduleConstraint } : undefined;
  // Use the live slot state; fall back to the snapshot taken when booking started in case
  // a failing sibling instance deleted slot-state.json while this booking is in progress.
  const liveState = isSlotFoundByAnyInstance();
  const shared = liveState.found ? liveState : (slotStateCache ?? liveState);
  const pollingHitAllowed = hasScheduleFilter ? isPollingSlotInConstraint(shared.slot, scheduleConstraint) : false;

  let usedCalendarForTimeslot = false;

  try {
  if (!hasScheduleFilter) {
    if (fastSkipCalendar) {
      const derived = deriveCalendarDateFromPollingRaw(shared.slot?.rawDate ?? shared.slot?.date);
      if (derived) {
        setSlotDate(derived);
        logger.info(
          { instanceId, derivedSlotDate: derived, source: "polling.earliestSlotLists" },
          "Fast mode: skipping calendar API and using polling date for timeslot"
        );
      } else {
        logger.warn(
          { instanceId, raw: shared.slot?.rawDate, date: shared.slot?.date },
          "Fast mode: could not derive slotDate from polling; falling back to calendar API"
        );
        await browser.postCalendarLiftApi();
        usedCalendarForTimeslot = true;
      }
    } else {
      await browser.postCalendarLiftApi();
      usedCalendarForTimeslot = true;
    }
  } else if (pollingHitAllowed && fastSkipCalendar) {
    const derived = deriveCalendarDateFromPollingRaw(shared.slot?.rawDate ?? shared.slot?.date);
    if (derived) {
      setSlotDate(derived);
      logger.info(
        {
          instanceId,
          derivedSlotDate: derived,
          source: "polling.earliestSlotLists",
          ...scheduleConstraintLogValue(scheduleConstraint),
        },
        "Fast mode (date on allow-list): skipping calendar API and using polling date for timeslot"
      );
    } else {
      logger.warn(
        { instanceId, raw: shared.slot?.rawDate, date: shared.slot?.date, ...scheduleConstraintLogValue(scheduleConstraint) },
        "Fast mode: could not derive slotDate from polling; falling back to filtered calendar API"
      );
      await browser.postCalendarLiftApi(calendarOpts);
      usedCalendarForTimeslot = true;
    }
  } else {
    await browser.postCalendarLiftApi(calendarOpts);
    usedCalendarForTimeslot = true;
  }

  try {
    reporter.setBookingStep("timeslot");
    await browser.postTimeslotLiftApi();
  } catch (err) {
    if (err instanceof VfsRateLimitedError) {
      if (err.isAccountBlock) {
        await stopForAccountRateLimit(instanceId, "timeslot", err.code);
        return false;
      }
      return recoverBookingChainFromIpRateLimit(instanceId, "429-ip-timeslot", err, slotStateCache);
    }
    if (err instanceof VfsGatewayTimeoutError) {
      return recoverBookingChainFromGatewayTimeout(instanceId, "504-gateway-timeout-timeslot", err, slotStateCache);
    }
    // Requested fallback: if fast mode skipped calendar and timeslot fails, call calendar then retry once.
    if (fastSkipCalendar && !usedCalendarForTimeslot) {
      logger.warn({ err, instanceId }, "Timeslot failed in fast mode - calling calendar and retrying timeslot once");
      await browser.postCalendarLiftApi(calendarOpts);
      usedCalendarForTimeslot = true;
      await browser.postTimeslotLiftApi();
    } else {
      throw err;
    }
  }

  const isEgyptPortugal =
    config.slotPayload.countryCode === "egy" && config.slotPayload.missionCode === "prt";
  if (isEgyptPortugal) {
    await browser.postMapVasLiftApi();
  }

  reporter.setBookingStep("fees");
  await browser.postFeesLiftApi();

  const MAX_SCHEDULE_RETRIES_FROM_CALENDAR = 3;
  for (let schedAttempt = 1; schedAttempt <= MAX_SCHEDULE_RETRIES_FROM_CALENDAR; schedAttempt++) {
    try {
      reporter.setBookingStep("schedule");
      await browser.postScheduleLiftApi();
      break;
    } catch (schedErr) {
      if (schedErr instanceof VfsRateLimitedError) {
        if (schedErr.isAccountBlock) {
          await stopForAccountRateLimit(instanceId, "schedule", schedErr.code);
          return false;
        }
        return recoverBookingChainFromIpRateLimit(instanceId, "429-ip-schedule", schedErr, slotStateCache);
      }
      if (schedErr instanceof VfsGatewayTimeoutError) {
        return recoverBookingChainFromGatewayTimeout(instanceId, "504-gateway-timeout-schedule", schedErr, slotStateCache);
      }
      if (schedAttempt === MAX_SCHEDULE_RETRIES_FROM_CALENDAR) throw schedErr;
      logger.warn(
        { err: schedErr, attempt: schedAttempt, maxRetries: MAX_SCHEDULE_RETRIES_FROM_CALENDAR, instanceId },
        "Schedule failed — retrying from calendar"
      );
      await telegram
        .alert("error", `Schedule failed (attempt ${schedAttempt}/${MAX_SCHEDULE_RETRIES_FROM_CALENDAR}), retrying from calendar`)
        .catch(() => { });
      await browser.postCalendarLiftApi(calendarOpts);
      await browser.postTimeslotLiftApi();
      await browser.postFeesLiftApi();
    }
  }

  if (!getAllocationId()?.trim()) {
    throw new Error(
      "Booking chain incomplete: schedule did not run (missing allocationId — save applicants or earlier APIs may have failed)"
    );
  }
  return true;
  } catch (err) {
    if (err instanceof VfsRateLimitedError) {
      if (err.isAccountBlock) {
        await stopForAccountRateLimit(instanceId, "booking-chain", err.code);
        return false;
      }
      return recoverBookingChainFromIpRateLimit(instanceId, "429-ip-booking", err, slotStateCache);
    }
    if (err instanceof VfsGatewayTimeoutError) {
      return recoverBookingChainFromGatewayTimeout(instanceId, "504-gateway-timeout-booking", err, slotStateCache);
    }
    throw err;
  }
}

type SubmitMeta = { firstSubmit: boolean; instanceId?: number; pollStartAt?: number | null; skipPollGate?: boolean };

async function runOneBotCycle(meta: SubmitMeta): Promise<void> {
  let m = meta;
  for (let attempt = 0; attempt < MAX_PAGE_NOT_FOUND_RESTARTS; attempt++) {
    try {
      await runOneBotCycleCore(m);
      return;
    } catch (err) {
      if (err instanceof PageNotFoundRestartError) {
        pageNotFoundRestartRequested = false;
        await rotateIpForPageNotFound(m.instanceId, err.message);
        m = { ...m, firstSubmit: false, skipPollGate: true };
        continue;
      }
      throw err;
    }
  }
  throw new Error(`page-not-found persisted after ${MAX_PAGE_NOT_FOUND_RESTARTS} restarts`);
}

async function performVfsLoginFromStore(instanceId?: number): Promise<void> {
  const u = resolveLoginUsername(instanceId);
  const p = resolveLoginPassword(instanceId);
  if (!u || !p) {
    throw new Error(
      "VFS login missing: fill username/password on the setup form, or set VFS_USERNAME / VFS_PASSWORD in .env."
    );
  }
  if (hasSecondCredentials(instanceId)) {
    logger.info(
      { instanceId, credentialSlot: getPendingCredentialSlot(instanceId) },
      "[Login] Credential pair for this login (0=primary, 1=secondary)"
    );
  }
  await browser.loginOnFirstTab(u, p);
  advanceCredentialSlotAfterSuccessfulLogin(instanceId);
}

/**
 * One full run after setup form Submit (or headless single run): CDP refresh → tab URL branch → poll → optional booking.
 *
 * **Cycle (this codebase):** a single invocation of this function for one cluster child (or one local run).
 * Cluster: parent sends `run-bot-cycle` after each Submit; on failure the child retries after 15s (`firstSubmit` is
 * only true on the first attempt). **Instance:** `instanceId` / `BOT_INSTANCE_ID` / `vfs-bot-profile-N` — each
 * instance uses its own `PROXY_URLS` slot and default sticky token `vfs-<instanceId>` (see `stableSessionToken`).
 *
 * **Different public IP per instance:** use multiple `PROXY_URLS` lines and/or `{session}` / `{instance}`; each
 * instance hashes to a different base index.
 *
 * **Different public IP per cycle:** today the proxy index advances and applicant IP cache clears only when
 * **Chrome is spawned** (`ensureChromeWithDevTools` does not early-return). If DevTools already runs, the same
 * Chrome+proxy is reused — same egress for that profile until you restart Chrome or use credential-swap restart.
 * Optional: `VFS_CLEAR_APPLICANT_IP_CACHE_EACH_CYCLE=true` re-resolves IP every cycle (only safe if you also get a
 * fresh VFS session that cycle, e.g. relogin or new browser).
 */

async function runOneBotCycleCore(meta: SubmitMeta): Promise<void> {
  // Reload .env changes for submit-driven runs (so toggles like TURNSTILE_DEMO_MODE take effect
  // without restarting). In cluster mode the parent sets instance-specific env vars
  // (BROWSER_CDP_URL, CHROME_USER_DATA_DIR, BOT_INSTANCE_ID) via spawn — never let dotenv
  // override those or every instance would connect to the same Chrome (port 9222).
  const isClusterChild = process.env.BOT_CLUSTER_MODE === "true";
  if (!isClusterChild) {
    dotenv.config({ override: true });
  }

  const instanceId = meta.instanceId;

  // If this instance already completed booking and reached the payment page, do not restart it.
  // The Chrome tab stays on the payment page indefinitely.
  if (instanceOnPaymentPage) {
    logger.info({ instanceId }, "[Booking] Instance on payment page — not restarting cycle, staying on payment page");
    return;
  }

  // Set current instance ID for config getters (e.g., loginUser)
  setCurrentInstanceId(instanceId);

  reporter.setPhase("launching", "starting cycle");
  reporter.setAccount(resolveLoginUsername(instanceId), getPendingCredentialSlot(instanceId));

  if (
    /^true|1|yes$/i.test((process.env.VFS_CLEAR_APPLICANT_IP_CACHE_EACH_CYCLE ?? "").trim())
  ) {
    clearApplicantIpCache();
    logger.info(
      { instanceId },
      "Applicant IP cache cleared at cycle start (VFS_CLEAR_APPLICANT_IP_CACHE_EACH_CYCLE) — safe mainly when each cycle uses new Chrome or full relogin so VFS session matches the new reading"
    );
  }

  // Clear shared slot state once per batch (single-instance). Cluster parent clears on first Submit.
  if (meta.firstSubmit && !isClusterChild) {
    clearSlotState();
    clearSlotCenterOverride();
  }

  await throwIfPageNotFoundRestartRequested("cycle-start");

  // 1) Drop old Playwright CDP attachment; 2) ensure Chrome + DevTools; 3) reconnect
  await browser.disconnectCdp();
  await ensureChromeWithDevTools();

  // Log outbound IP as soon as CDP can attach (Chrome proxy egress). A later call reuses cache; if this fails
  // (no tab yet), the post-login resolve retries.
  await resolveAndReportEgressIp();

  let firstUrl = await browser.getFirstTabUrl();
  reporter.setPage(firstUrl);
  await checkUrlForPageNotFound(firstUrl, "after-chrome-launch");

  let kind = classifyVfsFirstTabUrl(firstUrl);

  if (kind === "page_not_found") {
    throw new PageNotFoundRestartError(`startup tab: ${firstUrl}`);
  }

  if (kind === "blank") {
    await openLoginWithForbiddenRecovery(instanceId);
    console.log("[Chrome] Opened login page (was blank)");
    firstUrl = await browser.getFirstTabUrl();
    kind = classifyVfsFirstTabUrl(firstUrl);
  }

  // Detect block pages on any URL — WAF JSON, "Access Restricted", "Session Expired", or "User ID Restricted".
  // The URL may look normal (/login, /dashboard) but the body is a block/error page.
  if (kind === "login" || kind === "dashboard" || kind === "vfs_other") {
    const blockKind = await browser.detectPageBlockKind();
    if (blockKind === "account_429") {
      await stopForAccountRateLimit(instanceId, "startup-page-block", "4290xx");
      return;
    }
    if (blockKind === "ip_429") {
      await handleIpRateLimitRecovery(instanceId, "startup-page-block", "4292xx");
      firstUrl = await browser.getFirstTabUrl();
      kind = classifyVfsFirstTabUrl(firstUrl);
    } else if (blockKind === "forbidden") {
      logger.error({ instanceId, url: firstUrl }, "[Chrome] Page shows block/error page — closing browser, clearing caches, rotating IP, reopening...");
      await telegram.alert("error", `Bot ${instanceId ?? "?"} blocked page detected — restarting browser + rotating IP`).catch(() => { });
      clearApplicantIpCache();
      await relaunchChromeAfterCredentialSwapLogout();
      firstUrl = await browser.getFirstTabUrl();
      kind = classifyVfsFirstTabUrl(firstUrl);
    }
  }

  let didLoginThisCycle = false;
  if (kind === "login") {
    try {
      reporter.setPhase("login", "logging in");
      await loginWithForbiddenRecovery(instanceId);
      firstUrl = await browser.getFirstTabUrl();
      reporter.setPage(firstUrl);
      kind = classifyVfsFirstTabUrl(firstUrl);
      await checkUrlForPageNotFound(firstUrl, "after-login");
      didLoginThisCycle = true;
    } catch (loginErr) {
      if (loginErr instanceof PageNotFoundRestartError) {
        throw loginErr;
      }
      const reason = loginErr instanceof Error ? loginErr.message : String(loginErr);
      logger.error({ err: loginErr, instanceId }, "[Login] Login failed — instance stopping");
      instanceStopped = true;
      reporter.setError(reason);
      reporter.setAttention("login_failed", "login failed — handle in Chrome");
      reporter.setPhase("stopped", "login failed");
      await telegram
        .alert("error", `Bot ${instanceId ?? "?"} login failed — stopped.\nReason: ${reason}`)
        .catch(() => { });
      return;
    }
  } else if (kind === "dashboard") {
    logger.info({ instanceId }, "On dashboard — skipping automated login");
  } else if (kind === "vfs_other") {
    logger.info({ url: firstUrl, instanceId }, "On post-login VFS page — skipping automated login; polling from here");
  }

  /** Retry or confirm IP after navigation/login (cached if early resolve already succeeded). */
  await resolveAndReportEgressIp();

  const skipDashboardNavigate = !meta.firstSubmit || kind === "vfs_other";

  if (config.loginOnly) {
    logger.info({ instanceId }, "[LoginOnly] VFS_LOGIN_ONLY=true — stopping after login, no polling or booking");
    return;
  }

  const cycleAbortSeq = pollingAbortSeq;
  let slotFoundDuringPoll = false;
  const isWorkflowRestart = !meta.firstSubmit || meta.skipPollGate === true;

  // After a successful dashboard landing (login or already on dashboard), minimize Chrome.
  // Mid-workflow restarts also wait 30s on the dashboard before continuing.
  if (kind === "dashboard" || didLoginThisCycle) {
    let waitMs = 0;
    if (didLoginThisCycle) {
      const globalDet0 = getApplicantDetailsOverrides(0);
      const postLoginDelaySec =
        globalDet0 && typeof globalDet0.postLoginPollDelay === "number" && globalDet0.postLoginPollDelay >= 0
          ? globalDet0.postLoginPollDelay
          : DEFAULT_POST_LOGIN_POLL_DELAY_SEC;
      waitMs = postLoginDelaySec * 1000;
    }
    if (isWorkflowRestart && didLoginThisCycle) {
      waitMs = Math.max(waitMs, RESTART_DASHBOARD_WAIT_MS);
    } else if (isWorkflowRestart && kind === "dashboard") {
      waitMs = RESTART_DASHBOARD_WAIT_MS;
    }
    const settled = await settleOnDashboard({
      instanceId,
      waitMs,
      abortSeq: cycleAbortSeq,
      reason: isWorkflowRestart ? "workflow-restart" : "post-login",
    });
    if (settled === "abort") {
      logger.info({ instanceId }, "[poll] Dashboard settle aborted (force-book or config update)");
      return;
    }
  }

  await browser.preparePollingAfterLogin({ skipDashboardNavigate });
  // preparePolling used to call page.bringToFront() via getVfsPage — re-minimize
  // in case anything else restored the window during settle → prepare.
  if ((kind === "dashboard" || didLoginThisCycle) && !instanceOnPaymentPage) {
    await minimizeChromeWindow().catch(() => { });
  }

  // Check if force-book or config-update fired during preparePolling — exit early so the
  // queued attack cycle can start immediately.
  if (pollingAbortSeq !== cycleAbortSeq) {
    await throwIfAbortedForPageNotFound(cycleAbortSeq, "pre-poll-abort");
    logger.info({ instanceId }, "[poll] Cycle aborted before entering poll loop (force-book or config update)");
    return;
  }

  // --- Coordinated poll-start gate (first submit only, cluster mode) ---
  // The parent computed one fleet-wide poll-start time = rolloutStart +
  // startInterval×instances + 60s buffer. This instance waits until
  //   pollStartAt + (instanceId-1) × pollInterval
  // before its first poll. Net effect: every bot logs in during the staggered
  // ramp, then — once the whole fleet is up — polling begins evenly spaced
  // (bot 1, then bot 2 one poll-interval later, …), i.e. the tuned round-robin
  // schedule with all bots present. A bot that logs in late (remainingMs ≤ 0)
  // simply polls immediately, so the schedule is self-correcting.
  if (meta.firstSubmit && !meta.skipPollGate && isClusterChild && instanceId != null && typeof meta.pollStartAt === "number") {
    const globalDet = getApplicantDetailsOverrides(0);
    const userPollIntervalSec =
      globalDet && typeof globalDet.userPollInterval === "number" && globalDet.userPollInterval >= 1
        ? globalDet.userPollInterval
        : DEFAULT_POLL_INTERVAL_SEC;
    const stepMs = Math.max(1000, userPollIntervalSec * 1000);
    const offsetMs = (instanceId - 1) * stepMs;
    const targetPollAt = meta.pollStartAt + offsetMs;
    const remainingMs = Math.max(0, targetPollAt - Date.now());

    reporter.setPhase(
      "polling",
      remainingMs > 0 ? `ready — fleet polls in ${Math.round(remainingMs / 1000)}s` : "starting poll"
    );
    logger.info(
      { instanceId, pollStartAt: meta.pollStartAt, offsetMs, remainingMs },
      "[PollGate] Waiting for fleet poll-start + sequential offset before first poll"
    );

    if (remainingMs > 0) {
      const pollGateSlotWatcher = createSlotFoundWatcher(instanceId);
      try {
        const timerPromise = new Promise<void>((r) => setTimeout(r, remainingMs));
        const woke = await Promise.race([
          timerPromise.then(() => "timer" as const),
          pollGateSlotWatcher.wait().then(() => "slot" as const),
          waitForPollingAbort(cycleAbortSeq).then(() => "abort" as const),
        ]);

        if (woke === "abort" || pollingAbortSeq !== cycleAbortSeq) {
          await throwIfAbortedForPageNotFound(cycleAbortSeq, "poll-gate-abort");
          logger.info({ instanceId }, "[PollGate] Wait aborted (force-book or config update)");
          return;
        }

        if (woke === "slot" && (await checkPeerFoundSlotAndJoinBooking(instanceId, pollGateSlotWatcher.cachedState()))) {
          logger.info({ instanceId }, "[PollGate] Woken by peer slot during wait — proceeding to booking");
          slotFoundDuringPoll = true;
        } else if (woke === "slot") {
          await timerPromise;
        }
      } finally {
        pollGateSlotWatcher.dispose();
      }
    }
  }

  if (!slotFoundDuringPoll) {
    // All instances poll actively after login.
    reporter.setPhase("polling", "polling for slots");
    await telegram.notify("VFS bot run: polling for slots.").catch(() => { });
    logger.info({ skipDashboardNavigate, instanceId }, "Starting slot polling");

    const pollReloginInterval = config.pollReloginInterval;
    const onPollRelogin =
      pollReloginInterval > 0 ? () => performPollStyleRelogin(instanceId, "poll-interval") : undefined;

    slotFoundDuringPoll = await runPollLoop(instanceId, {
      reloginAfter: pollReloginInterval > 0 ? pollReloginInterval : undefined,
      onRelogin: onPollRelogin,
    });
  }

  if (slotFoundDuringPoll) {
    let pollHits: boolean = slotFoundDuringPoll;
    while (true) {
      // Snapshot slot state before booking starts so sibling failures that delete
      // slot-state.json do not break this instance's calendar / timeslot lookup.
      const slotStateSnapshot = isSlotFoundByAnyInstance();
      instanceBookingActive = true;
      reporter.setPhase("booking", "booking chain");
      logger.info({ instanceId }, "[Booking] Started — this instance will not be interrupted by new slot finds");
      try {
        const bookingCompleted = await runBookingChainWithRetry(instanceId, slotStateSnapshot);
        instanceBookingActive = false;
        if (!bookingCompleted) break; // Aborted/superseded — do not mark payment page
        // Booking chain completed (schedule API called) — payment page is now open.
        await enterPaymentPageMode(instanceId);
        return; // Leave Chrome on the payment page; do not fall through to cycle end.
      } catch (err) {
        instanceBookingActive = false; // Release booking lock so new slot finds can reach this instance again.
        if (isSaveApplicantsFailure(err)) {
          if (!(await recoverFromSaveApplicantsFailure(instanceId, "save-applicants-failure", err))) {
            logger.info({ instanceId }, "Save applicants recovery poll ended without slot — stopping booking chain");
            break;
          }
          continue;
        }
        const noDates =
          err instanceof NoDatesInScheduleRangeError ||
          (err instanceof Error && (err as Error & { code?: string }).code === "NO_DATES_IN_RANGE");
        if (noDates) {
          const range = resolveScheduleDateConstraint(instanceId);
          const startDate = range.kind === "range" ? (range.start ?? "…") : "…";
          const endDate = range.kind === "range" ? (range.end ?? "…") : "…";
          const msg = `no slot from ${startDate} to ${endDate}`;
          logger.warn(
            { instanceId, ...scheduleConstraintLogValue(range) },
            "No calendar dates match schedule date range — clearing local state and stopping bot cycle"
          );
          await telegram.alert("no_slot_found", msg).catch(() => { });
          clearSlotCenterOverride();
          clearSlotDate();
          break;
        }

        // Any other booking error: log, notify, clear local state, restart polling instead of stopping.
        logger.error({ err, instanceId }, "Booking chain error — clearing local state and restarting poll");
        await telegram
          .alert("error", `Booking error (instance ${instanceId ?? 1}), restarting poll: ${err instanceof Error ? err.message : String(err)}`)
          .catch(() => { });
        clearSlotCenterOverride();
        clearSlotDate();
        await browser.preparePollingAfterLogin({ skipDashboardNavigate: true });
        pollHits = await runPollLoop(instanceId);
        if (!pollHits) {
          logger.info({ instanceId }, "No slot after booking error restart poll — stopping booking chain");
          break;
        }
        // Found a new slot — loop back; instanceBookingActive will be set to true at the top.
      }
    }
  } else {
    logger.info({ instanceId }, "No slot found this run — skipping save applicants, fees, calendar, timeslot, schedule");
  }
}

function syncInstanceStoresFromDisk(): void {
  reloadSessionCredentialsFromDisk();
  reloadApplicantDetailsFromDisk();
}

async function start(): Promise<void> {
  // In cluster mode, instances don't start their own server
  const isClusterMode = process.env.BOT_CLUSTER_MODE === "true";

  if (isClusterMode) {
    const myInstanceId = parseInt(process.env.BOT_INSTANCE_ID ?? "1", 10);

    // Monitoring: start reporting status to the parent (fire-and-forget IPC).
    reporter.init(myInstanceId, { debugPort: getRemoteDebuggingPort() });
    startPageSampler(myInstanceId);

    // Listen for IPC messages from parent process
    if (process.send) {
      let ipcChain: Promise<void> = Promise.resolve();
      process.on("message", (msg: any) => {
        if (msg?.instanceId !== myInstanceId) return;

        if (msg?.type === "test-applicants") {
          // Stop slot polling immediately (same knobs as force-book), then run the test on the chain.
          instanceBookingActive = false;
          clearSlotState();
          clearSlotCenterOverride();
          clearSlotDate();
          requestPollingAbort("test-applicants", myInstanceId);
          logger.info({ instanceId: myInstanceId }, "[TestApplicants] Polling aborted — calling applicants API");
          ipcChain = ipcChain.then(async () => {
            syncInstanceStoresFromDisk();
            setCurrentInstanceId(myInstanceId);
            try {
              const result = await browser.testSaveApplicantsViaLiftApi();
              const preview =
                result.body.length > 12_000 ? result.body.slice(0, 12_000) + "…" : result.body;
              process.send?.({
                type: "test-applicants-result",
                requestId: msg.requestId,
                instanceId: myInstanceId,
                ok: true,
                status: result.status,
                bodyPreview: preview,
              });
            } catch (err) {
              process.send?.({
                type: "test-applicants-result",
                requestId: msg.requestId,
                instanceId: myInstanceId,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          });
          return;
        }

        if (msg?.type === "force-book") {
          if (instanceStopped) {
            logger.info({ instanceId: myInstanceId }, "[ForceBook] Ignored — instance is stopped (login failed)");
            return;
          }
          if (instanceOnPaymentPage) {
            logger.info({ instanceId: myInstanceId }, "[ForceBook] Ignored — already on payment page");
            return;
          }
          // Abort any in-progress polling so the new poll cycle can start.
          instanceBookingActive = false;
          clearSlotState();
          clearSlotCenterOverride();
          clearSlotDate();
          requestPollingAbort("force-book-poll", myInstanceId);
          logger.info({ instanceId: myInstanceId }, "[ForceBook] All-instance polling mode — clearing state and starting poll loop");
          ipcChain = ipcChain.then(async () => {
            try {
              await browser.preparePollingAfterLogin({ skipDashboardNavigate: true });

              const pollReloginInterval = config.pollReloginInterval;
              const onPollRelogin =
                pollReloginInterval > 0 ? () => performPollStyleRelogin(myInstanceId, "force-book-poll") : undefined;

              const slotFound = await runPollLoop(myInstanceId, {
                reloginAfter: pollReloginInterval > 0 ? pollReloginInterval : undefined,
                onRelogin: onPollRelogin,
              });

              if (slotFound) {
                const slotStateSnapshot = isSlotFoundByAnyInstance();
                instanceBookingActive = true;
                logger.info({ instanceId: myInstanceId }, "[ForceBook] Slot found during polling — starting booking chain");
                try {
                  const bookingCompleted = await runBookingChainWithRetry(myInstanceId, slotStateSnapshot);
                  instanceBookingActive = false;
                  if (bookingCompleted) {
                    await enterPaymentPageMode(myInstanceId);
                  } else {
                    logger.info({ instanceId: myInstanceId }, "[ForceBook] Booking chain superseded/aborted — not marking payment page");
                  }
                } catch (err) {
                  instanceBookingActive = false;
                  logger.error({ err, instanceId: myInstanceId }, "[ForceBook] Booking chain failed");
                  await telegram.alert("error", `Bot ${myInstanceId} force-book booking failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => { });
                  clearSlotCenterOverride();
                  clearSlotDate();
                }
              } else {
                logger.info({ instanceId: myInstanceId }, "[ForceBook] No slot found during polling");
              }
            } catch (err) {
              logger.error({ err, instanceId: myInstanceId }, "[ForceBook] Poll cycle failed");
              await telegram.alert("error", `Bot ${myInstanceId} force-book poll error: ${err instanceof Error ? err.message : String(err)}`).catch(() => { });
            }
          });
          telegram.alert("info", `Bot ${myInstanceId} — starting polling...`).catch(() => { });
          return;
        }

        // config-updated should also run immediately to abort polling without waiting for the chain.
        if (msg?.type === "config-updated") {
          syncInstanceStoresFromDisk();
          requestPollingAbort("config-updated", myInstanceId);
          return;
        }

        if (msg?.type === "pause-polling") {
          setPollingPaused(true);
          logger.info({ instanceId: myInstanceId }, "[poll] Fleet pause received");
          return;
        }

        if (msg?.type === "resume-polling") {
          const resumeAt = typeof msg.resumeAt === "number" ? msg.resumeAt : Date.now();
          const pollIntervalMs = typeof msg.pollIntervalMs === "number" ? msg.pollIntervalMs : 60_000;
          applyResumePollingGate(myInstanceId, resumeAt, pollIntervalMs);
          return;
        }

        ipcChain = ipcChain.then(async () => {
          if (msg?.type === "run-bot-cycle") {
            syncInstanceStoresFromDisk();
            try {
              await runOneBotCycle({ firstSubmit: true, instanceId: myInstanceId, pollStartAt: msg.pollStartAt });
              process.send?.({ type: "bot-cycle-complete", instanceId: myInstanceId });
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              logger.error({ err, instanceId: myInstanceId }, "Bot cycle failed — stopped");
              await telegram
                .alert("error", `Bot ${myInstanceId} is stopped.\nReason: ${reason}`)
                .catch(() => { });
            }
          }
        });
      });
    }

    // Keep process alive, don't launch Chrome until submit
    return;
  }

  // Single-instance monitoring: feed status into a local registry so the
  // Monitor tab works without a cluster parent, and let the reporter focus
  // this process's own Chrome window on captcha attention.
  reporter.init(1, { debugPort: getRemoteDebuggingPort() });
  startPageSampler();
  registry.start();
  startChromeStatusProbe({ intervalMs: 2000 });
  reporter.setLocalSink((s) => registry.applyStatus(s));
  registry.setProcessAlive(1, true);
  reporter.setLocalFocus(() => { void focusChromeByPort(getRemoteDebuggingPort()); });

  let singlePollingPaused = false;
  const singleMonitor: MonitorHooks = {
    snapshot: () => registry.snapshot(),
    subscribe: (cb) => registry.subscribe(cb),
    focus: async () => {
      const ok = await focusChromeByPort(getRemoteDebuggingPort());
      return ok ? { ok: true } : { ok: false, error: "No Chrome window found" };
    },
    devtools: async () => getDevtoolsInfo(getRemoteDebuggingPort()),
    start: () => ({ ok: false, error: "Single-instance mode — use Submit & Run to start." }),
    pauseRollout: () => ({ ok: true }),
    resumeRollout: () => ({ ok: true }),
    pausePolling: (instanceId) => {
      singlePollingPaused = true;
      setPollingPaused(true);
      return { ok: true };
    },
    resumePolling: (instanceId) => {
      singlePollingPaused = false;
      const globalDet = getApplicantDetailsOverrides(0);
      const sec =
        globalDet && typeof globalDet.userPollInterval === "number" && globalDet.userPollInterval >= 1
          ? globalDet.userPollInterval
          : DEFAULT_POLL_INTERVAL_SEC;
      applyResumePollingGate(1, Date.now(), Math.max(1000, sec * 1000));
      return { ok: true };
    },
    stopInstance: () => ({ ok: false, error: "Not available in single-instance mode." }),
    restartInstance: () => ({ ok: false, error: "Not available in single-instance mode." }),
    setStaggerInterval: () => ({ ok: true }),
    getControl: () => {
      const globalDet = getApplicantDetailsOverrides(0);
      const sec =
        globalDet && typeof globalDet.userPollInterval === "number" && globalDet.userPollInterval >= 1
          ? globalDet.userPollInterval
          : DEFAULT_POLL_INTERVAL_SEC;
      return {
        intervalMs: 0,
        rolloutActive: false,
        total: 1,
        pollingPaused: singlePollingPaused,
        pollIntervalMs: Math.max(1000, sec * 1000),
      };
    },
  };

  await ensureChromeWithDevTools();

  await runApplicantFormWithSubmitHandler((info) => {
    const instanceId = typeof info.instanceId === "number" ? info.instanceId : undefined;
    enqueueSubmitTask(() => runOneBotCycle({ firstSubmit: info.firstSubmit, instanceId }));
  }, {
    monitor: singleMonitor,
    onForceBook: () => {
      if (instanceStopped) {
        return { ok: false, error: "Instance is stopped (login failed). Cannot book." };
      }
      if (instanceOnPaymentPage) {
        return { ok: false, error: "Already on payment page." };
      }
      instanceBookingActive = false;
      clearSlotState();
      clearSlotCenterOverride();
      clearSlotDate();
      requestPollingAbort("force-book-poll");
      logger.info("[ForceBook] Starting polling (single-instance)");
      enqueueSubmitTask(async () => {
        try {
          await browser.preparePollingAfterLogin({ skipDashboardNavigate: true });

          const pollReloginInterval = config.pollReloginInterval;
          const onPollRelogin =
            pollReloginInterval > 0 ? () => performPollStyleRelogin(undefined, "force-book-poll") : undefined;

          const slotFound = await runPollLoop(undefined, {
            reloginAfter: pollReloginInterval > 0 ? pollReloginInterval : undefined,
            onRelogin: onPollRelogin,
          });

          if (slotFound) {
            const slotStateSnapshot = isSlotFoundByAnyInstance();
            instanceBookingActive = true;
            logger.info("[ForceBook] Slot found during polling — starting booking chain");
            try {
              const bookingCompleted = await runBookingChainWithRetry(undefined, slotStateSnapshot);
              instanceBookingActive = false;
              if (bookingCompleted) {
                await enterPaymentPageMode(undefined);
              } else {
                logger.info("[ForceBook] Booking chain superseded/aborted — not marking payment page");
              }
            } catch (err) {
              instanceBookingActive = false;
              logger.error({ err }, "[ForceBook] Booking chain failed");
              await telegram.alert("error", `Force-book failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => { });
              clearSlotCenterOverride();
              clearSlotDate();
            }
          } else {
            logger.info("[ForceBook] No slot found during polling");
          }
        } catch (err) {
          logger.error({ err }, "[ForceBook] Poll cycle failed");
          await telegram.alert("error", `Force-book poll error: ${err instanceof Error ? err.message : String(err)}`).catch(() => { });
        }
      });
      return { ok: true, queued: 1 };
    },
    onTestApplicantsApi: async () => {
      instanceBookingActive = false;
      clearSlotState();
      clearSlotCenterOverride();
      clearSlotDate();
      requestPollingAbort("test-applicants");
      logger.info("[TestApplicants] Polling aborted — calling applicants API");
      reloadApplicantDetailsFromDisk();
      const instanceId = parseInt(process.env.BOT_INSTANCE_ID ?? "1", 10);
      setCurrentInstanceId(instanceId);
      try {
        const res = await browser.testSaveApplicantsViaLiftApi();
        const preview = res.body.length > 12_000 ? res.body.slice(0, 12_000) + "…" : res.body;
        return { results: [{ instanceId, ok: true, status: res.status, bodyPreview: preview }] };
      } catch (err) {
        return {
          results: [{ instanceId, ok: false, error: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  });
}

let isShuttingDown = false;

function shutdown(): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  const debugPort = getRemoteDebuggingPort();
  logger.info({ debugPort }, "Shutting down — closing Chrome and setup form");

  // Synchronous Chrome kill — completes immediately, no lingering PowerShell processes
  // that could kill newly launched Chrome on restart.
  killChromeTreeByCdpPortSync(debugPort);

  const closeTunnel = async () => {
    if (!activeAnonymizedProxyUrl) return;
    try {
      const proxyChain = await getProxyChainModule();
      await proxyChain.closeAnonymizedProxy(activeAnonymizedProxyUrl, true);
    } catch {
      /* ignore */
    }
    activeAnonymizedProxyUrl = null;
  };
  void Promise.resolve()
    .then(async () => {
      await closeTunnel();
      await closeApplicantFormServer();
      await browser.close();
    })
    .finally(() => {
      process.exit(0);
    });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Windows: console window close is surfaced as SIGHUP (short window to clean up before hard kill).
process.on("SIGHUP", shutdown);
if (process.platform === "win32") {
  process.on("SIGBREAK", shutdown);
}

// Last-chance SYNCHRONOUS cleanup. Runs even on abrupt exits. Chrome is
// spawned detached so async shutdown is not guaranteed to complete — this
// guarantees the Chrome tree is killed before Node leaves.
process.on("exit", () => {
  try {
    killChromeTreeByCdpPortSync(getRemoteDebuggingPort());
  } catch {
    /* best effort */
  }
});

start().catch((err) => {
  logger.fatal({ err }, "Start failed");
  process.exit(1);
});

import dotenv from "dotenv";
// Don't override env vars set by parent process (cluster mode)
dotenv.config({ override: false });
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, watchFile, unwatchFile } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import path from "node:path";
import { config, setCurrentInstanceId, getCurrentInstanceId } from "./config/config";
import { classifyVfsFirstTabUrl, isVfsDashboardUrl } from "./flows/vfsTabUrl";
import { PollingService } from "./services/polling.service";
import { BrowserService, VfsForbiddenError, VfsGatewayTimeoutError, VfsRateLimitedError, VfsUnauthorizedError, VfsAlreadyLoggedInError, IndDeuAccountRecreateError, AlreadyBookedError, MissingUrnError, isFailedToFetchError } from "./services/browser.service";
import { TelegramService } from "./services/telegram.service";
import {
  runApplicantFormWithSubmitHandler,
  closeApplicantFormServer,
} from "./ui/applicantDetailsFormServer";
import { getSessionLoginCredentials, reloadSessionCredentialsFromDisk } from "./utils/sessionLogin.store";
import { isAreLvaRoute, isIndDeuRoute } from "./utils/vfsRoute";
import { reloadApplicantDetailsFromDisk, getApplicantDetailsOverrides, setApplicantDetailsOverrides } from "./utils/applicantDetails.store";
import {
  assertProxyProviderReady,
  getActiveProxyProvider,
  listProxyUrlsForProvider,
  parseProxyProviderId,
  persistProxyProvider,
  pickProxyUrlFromList,
  PROXY_PROVIDER_PARSE_ERROR,
  proxyProviderLabel,
  setMemoryProxyProvider,
  type ProxyProviderId,
} from "./utils/proxyProvider";
import { buildWebshareProxyUrl, isWebshareConfigured, webshareStickySessionId, webshareStickySessionKeys } from "./utils/webshareProxy";
import {
  getProxyListFilePath,
  isProxyListConfigured,
  listProxyListEntries,
  proxyListUrlForKey,
} from "./utils/proxyList";
import {
  claimProxyForInstance,
  getClaimedProxyKey,
  heartbeatProxyClaim,
  releaseProxyClaim,
} from "./utils/proxyClaims";
import {
  claimEgressIpForInstance,
  heartbeatEgressClaim,
  isClaimableEgressIp,
  releaseEgressClaim,
} from "./utils/egressIpClaims";
import {
  createSlotFoundWatcher,
  isSlotFoundByAnyInstance,
  markSlotFound,
  clearSlotState,
  type SlotFoundState,
} from "./utils/slotState";
import { setSlotCenterOverride, clearSlotCenterOverride } from "./utils/slotCenterOverride.store";
import { clearSlotDate } from "./utils/slotDate.store";
import { getApplicationUrn, clearApplicationUrn } from "./utils/applicationUrn.store";
import { clearApplicantIpCache, getApplicantIpForPayload } from "./utils/applicantIp";
import { logInstanceIp, type InstanceIpLogReason } from "./utils/apiCallLog";
import { clearChromeSessionDataBeforeLaunch, resolveChromeProfileFolderName } from "./utils/chromeProfileSessionClean";
import { killChromeTreeByCdpPortSync } from "./utils/killChromeByCdpPort";
import {
  markInstanceReady,
} from "./utils/pollReadyState";
import {
  ensureFleetPollEarliest,
  registerFleetPoller,
  unregisterFleetPoller,
  waitAndClaimFleetPollSlot,
} from "./utils/fleetPollCoord";
import {
  getApologiesIntervalMs,
  getFleetPollCycleMs,
  getFleetPollIntervalSec,
  getFleetPollStepMs,
  getFleetWorkerIds,
  isPreparedForFleetPolling,
  normalizeFleetInstanceId,
  resolveApologiesIntervalSec,
  resolveApplicantsJoinStaggerSec,
  resolveApiDelaySec,
  resolveRepeatedDelaySec,
} from "./utils/fleetPollSchedule";
import {
  applicantsAttemptTargetMs,
  createApplicantsUrnUnlockWatcher,
  ensureApplicantsWave,
  isApplicantsUrnUnlocked,
  markApplicantsUrnUnlocked,
  resetApplicantsWave,
} from "./utils/applicantsCoord";
import {
  registerFleetUrn,
  retireFromFleet,
} from "./utils/calendarBookingCoord";
import { runFleetCalendarBooking } from "./flows/fleetCalendarBooking";
import { runAreLvaBooking } from "./flows/areLvaBooking";
import { saveAlreadyBookedAccountFile } from "./utils/alreadyBookedAccountFile";
import { reporter } from "./monitoring/statusReporter";
import { registry } from "./monitoring/statusRegistry";
import { startChromeStatusProbe } from "./monitoring/chromeProbe";
import { focusChromeByPort, getDevtoolsInfo } from "./utils/chromeWindow";
import type { MonitorHooks } from "./monitoring/status.types";
import { isPageNotFoundUrl } from "./flows/pageNotFound";
import { PageNotFoundRestartError } from "./services/browser.errors";
import { beginIndDeuProcessSession } from "./utils/indDeuProcessSession";
import { ensureIndDeuAccountReady } from "./flows/indDeuAccount/createAccount";
import { isIndDeuPhoneExpiredForRelogin, shouldReuseIndDeuAccount } from "./utils/indDeuAccountState";
import { extractIndDeu4030xxFromUnknown } from "./utils/vfs4030";

const polling = new PollingService();
const browser = new BrowserService();
const telegram = new TelegramService();
const PROCESS_SLOT_RESULTS_UNTIL_MS = new Date(2026, 9, 1).getTime();

/**
 * page-not-found is retried forever (the instance must land a slot), but once this many
 * restarts have not helped, each further attempt waits so the bot stops hammering VFS.
 */
const PAGE_NOT_FOUND_BACKOFF_AFTER = 12;
const PAGE_NOT_FOUND_BACKOFF_MS = 30_000;
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

async function resolveAndReportEgressIp(opts?: {
  logAs?: InstanceIpLogReason;
  instanceId?: number;
}): Promise<void> {
  await ensureUniqueEgressIp(opts);
}

const DEFAULT_POST_LOGIN_POLL_DELAY_SEC = 30;
const DEFAULT_POLL_INTERVAL_SEC = 60;

type ProxyChainModule = {
  anonymizeProxy(proxyUrl: string | { url: string; port?: number }): Promise<string>;
  closeAnonymizedProxy(url: string, closeConnections?: boolean): Promise<void>;
};
let proxyChainModule: ProxyChainModule | null = null;
let activeAnonymizedProxyUrl: string | null = null;
/** Stable local tunnel port so Chrome `--proxy-server` keeps working after a vendor switch. */
let localTunnelPort: number | null = null;

/** Shifts `PROXY_URLS` index for this Chrome profile on each credential-swap browser restart. */
const proxyRotationOffsetByProfileId = new Map<string, number>();

function proxyRotationOffsetPath(): string {
  return path.join(resolveChromeUserDataDir(), ".proxy-rotation-offset");
}

function loadProxyRotationOffset(): number {
  try {
    const raw = readFileSync(proxyRotationOffsetPath(), "utf8").trim();
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  } catch {
    /* missing / unreadable */
  }
  return 0;
}

function saveProxyRotationOffset(offset: number): void {
  try {
    writeFileSync(proxyRotationOffsetPath(), String(Math.max(0, Math.floor(offset))), "utf8");
  } catch {
    /* ignore */
  }
}

function getProxyRotationOffset(profileId: string): number {
  if (!proxyRotationOffsetByProfileId.has(profileId)) {
    proxyRotationOffsetByProfileId.set(profileId, loadProxyRotationOffset());
  }
  return proxyRotationOffsetByProfileId.get(profileId) ?? 0;
}

function bumpProxyRotationForProfile(profileId: string): void {
  const next = getProxyRotationOffset(profileId) + 1;
  proxyRotationOffsetByProfileId.set(profileId, next);
  saveProxyRotationOffset(next);
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
  await closeActiveAnonymizedProxyTunnel();
  await browser.disconnectCdp();
  await killChromeOnPort(getRemoteDebuggingPort());
  await ensureChromeWithDevTools();
}

/**
 * Cloudflare challenge recovery during polling:
 * skip VFS logout (CF interstitial can hang logout), hard relogin
 * (kill Chrome, clear cache/cookies, rotate IP, new Chrome, login).
 */
async function recoverFromCloudflareChallenge(
  instanceId?: number,
  context?: string
): Promise<void> {
  // Do not call logout — CF interstitial / poisoned session can hang logout.
  await performHardRelogin(instanceId, context ?? "cloudflare-challenge");
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
 * CheckIsSlotAvailable rounds completed on the current VFS session. Drives the Monitor
 * `poll #` value and the `VFS_POLL_RELOGIN_INTERVAL` trigger; every login resets it to 0,
 * so the interval always counts from a fresh session.
 */
let pollRoundsOnSession = 0;

function resetPollRoundsOnSession(): void {
  pollRoundsOnSession = 0;
  reporter.setPoll({ pollCount: 0 });
}

const DEFAULT_EGRESS_UNIQUE_MAX_ATTEMPTS = 15;

function maxEgressUniqueAttempts(): number {
  const n = Number.parseInt((process.env.EGRESS_UNIQUE_MAX_ATTEMPTS ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_EGRESS_UNIQUE_MAX_ATTEMPTS;
  return Math.min(50, Math.floor(n));
}

/**
 * Point the local proxy-chain tunnel at a new vendor session / list entry without
 * restarting Chrome. Returns false when there is no tunnel or the sticky port moved.
 */
async function rebindToNewUpstream(): Promise<boolean> {
  const portBefore = localTunnelPort;
  if (portBefore == null) return false;

  const profileId = getBotInstanceId(resolveChromeUserDataDir());
  bumpProxyRotationForProfile(profileId);
  const selected = resolveProxyForInstance(profileId, { takeNew: true });
  if (!selected) return false;
  const parsed = parseProxy(selected);
  if (!parsed || !(parsed.username || parsed.password)) return false;

  try {
    await recreateAuthProxyTunnel(selected);
  } catch {
    return false;
  }
  // The sticky port was busy and proxy-chain fell back to another one — Chrome still points at
  // the old port, so this instance now has no working proxy until Chrome restarts.
  if (localTunnelPort !== portBefore) return false;
  clearApplicantIpCache();
  return true;
}

async function rotateUpstreamForUniqueIp(): Promise<void> {
  if (await rebindToNewUpstream()) return;
  clearApplicantIpCache();
  await relaunchChromeAfterCredentialSwapLogout();
}

/**
 * Resolve the current public egress and claim it fleet-wide. If another live bot
 * already holds that IP, rotate the upstream and retry until the address is unique.
 * After `EGRESS_UNIQUE_MAX_ATTEMPTS` the last IP is used even if it is shared —
 * the instance must keep running.
 */
async function ensureUniqueEgressIp(opts?: {
  logAs?: InstanceIpLogReason;
  instanceId?: number;
}): Promise<void> {
  const id = opts?.instanceId ?? numericBotInstanceId();
  const max = maxEgressUniqueAttempts();
  let lastIp = "";
  let lastHolder: number | null = null;

  for (let attempt = 1; attempt <= max; attempt++) {
    await browser.resolveApplicantIpForPayload().catch(() => { });
    const ip = getApplicantIpForPayload();
    lastIp = ip;
    reporter.setEgressIp(ip);

    if (!isClaimableEgressIp(ip)) {
      if (opts?.logAs) logInstanceIp(opts.logAs, ip, opts.instanceId);
      return;
    }

    const result = claimEgressIpForInstance(id, ip);
    if (result?.ok) {
      ensureProxyClaimHeartbeat();
      if (opts?.logAs) logInstanceIp(opts.logAs, result.ip, opts.instanceId);
      return;
    }
    if (result && !result.ok) {
      lastHolder = result.heldBy;
      logInstanceIp(
        "rotate-ip",
        result.ip,
        opts?.instanceId ?? id,
        `duplicate of instance ${result.heldBy}`
      );
    }

    if (attempt === max) break;
    await rotateUpstreamForUniqueIp();
    await sleepMsAsync(250);
  }

  claimEgressIpForInstance(id, lastIp, { allowShare: true });
  ensureProxyClaimHeartbeat();
  reporter.setEgressIp(lastIp);
  const shareNote =
    lastHolder != null
      ? `shared with instance ${lastHolder} after ${max} unique-ip rotates`
      : `used after ${max} unique-ip rotates`;
  logInstanceIp(opts?.logAs ?? "rotate-ip", lastIp || "(unknown)", opts?.instanceId ?? id, shareNote);
}

/**
 * Swap the exit IP without touching Chrome.
 *
 * Chrome is pointed at a fixed local proxy-chain port (`--proxy-server=http://127.0.0.1:<port>`),
 * never at the vendor directly, so rebinding that port to a new upstream is enough: the browser,
 * the VFS session, the cookies and the URN all keep running untouched.
 *
 * Returns false when the setup cannot support it — no local tunnel, an unauthenticated proxy
 * (Chrome talks to the vendor directly), the rebind landed on another port, or the egress IP did
 * not actually change. The caller then falls back to relaunching Chrome.
 */
async function rotateIpInPlace(): Promise<boolean> {
  const ipBefore = getApplicantIpForPayload();
  if (!(await rebindToNewUpstream())) return false;
  try {
    await resolveAndReportEgressIp({ logAs: "rotate-ip" });
  } catch {
    return false;
  }
  return getApplicantIpForPayload() !== ipBefore;
}

/**
 * Rotate proxy / Chrome without VFS logout or session wipe.
 * Used for first 4292XX. Returns false if session could not be restored (caller should escalate).
 */
async function rotateIpWithoutRelogin(context: string): Promise<boolean> {
  // Cheapest path: rebind the tunnel and keep the browser alive. Costs ~1s instead of a relaunch.
  if (await rotateIpInPlace()) {
    softIpRotateAwaitingSecond429 = true;
    return true;
  }

  let snap: { pageUrl: string; authorize: string | null; clientsource: string | null } | null = null;
  try {
    snap = await browser.snapshotVfsAuthForIpRotate();
  } catch (err) {
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
    await resolveAndReportEgressIp({ logAs: "rotate-ip" });
    softIpRotateAwaitingSecond429 = true;
    return true;
  } catch (err) {
    clearSoftIpRotateFlag();
    return false;
  }
}

/**
 * Handle 4292XX / IP rate-limit after login via hard relogin
 * (kill Chrome, clear cache/cookies, rotate IP, new Chrome, login).
 */
async function handleIpRateLimitRecovery(
  instanceId: number | undefined,
  context: string,
  code?: string
): Promise<"soft_rotate" | "full_relogin"> {
  const label = code ?? "4292xx";
  reporter.setPoll({ code: label });

  // 4292xx restricts the exit IP, not the account. Swap the IP while keeping the logged-in
  // session (and the URN) first; only escalate when that already failed once.
  if (!softIpRotateAwaitingSecond429) {
    reporter.setPhase("recovering", `IP rate-limit ${label} — rotating IP`);
    await telegram
      .alert(
        "error",
        `Bot ${instanceId ?? "?"} got IP rate-limit ${label} (${context}). Rotating IP, keeping session...`
      )
      .catch(() => { });
    if (await rotateIpWithoutRelogin(`${context}-ip-rate-limit`)) {
      await telegram
        .alert("info", `Bot ${instanceId ?? "?"} rotated IP after ${label} — session kept, resuming.`)
        .catch(() => { });
      return "soft_rotate";
    }
  }

  clearSoftIpRotateFlag();
  reporter.setPhase("recovering", `IP rate-limit ${label} — hard relogin`);
  await telegram
    .alert(
      "error",
      `Bot ${instanceId ?? "?"} got IP rate-limit ${label} (${context}). Hard relogin (kill Chrome + clear session + rotate IP)...`
    )
    .catch(() => { });
  await performHardRelogin(instanceId, `${context}-ip-rate-limit`);
  await telegram
    .alert("info", `Bot ${instanceId ?? "?"} recovered from ${label} via hard relogin — resuming.`)
    .catch(() => { });
  return "full_relogin";
}

async function stopForAccountRateLimit(
  instanceId: number | undefined,
  context: string,
  code?: string
): Promise<void> {
  clearSoftIpRotateFlag();
  // The only failure the bot never retries: the User ID itself is restricted.
  instanceStopped = true;
  const label = code ?? "4290xx";
  reporter.setAttention("blocked", `account rate-limit ${label} — stopped`);
  reporter.setPhase("stopped", `account rate-limit ${label}`);
  reporter.setPoll({ code: label });
  await telegram
    .alert(
      "error",
      `Bot ${instanceId ?? "?"} account blocked (${label}) during ${context}. Stopping — User ID / account rate-limit.`
    )
    .catch(() => { });
}

async function retireInstanceForAlreadyBooked(instanceId: number | undefined, reason?: string): Promise<never> {
  instanceStopped = true;
  const label = "already booked";
  reporter.setAttention(null);
  reporter.setPhase("already_booked", label);

  saveAlreadyBookedAccountFile({}, { error: reason ?? label }, instanceId);

  const id = typeof instanceId === "number" && Number.isFinite(instanceId) && instanceId >= 1
    ? Math.floor(instanceId)
    : parseInt(process.env.BOT_INSTANCE_ID ?? "1", 10) || 1;

  try { retireFromFleet(id); } catch { /* ignore */ }

  await telegram
    .alert("info", `Bot ${instanceId ?? "?"} ${label} — account archived and instance shutting down.`)
    .catch(() => { });

  if (typeof process.send === "function") {
    try {
      process.send({ type: "instance-retired", reason: "already-booked", instanceId: id });
    } catch {
      /* ignore */
    }
  }

  await browser.disconnectCdp().catch(() => { });
  killChromeTreeByCdpPortSync(getRemoteDebuggingPort());
  process.exit(0);
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

function applyResumePollingGate(instanceId: number | undefined, resumeAt: number, _pollIntervalMs: number): void {
  const id = normalizeFleetInstanceId(instanceId);
  const step = getFleetPollStepMs();
  pollingResumeGateUntil = resumeAt + (id - 1) * step;
  setPollingPaused(false);
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
  await telegram
    .alert("error", `Bot ${instanceId ?? "?"} page-not-found — hard relogin (kill Chrome + clear session + rotate IP)`)
    .catch(() => { });
  await performHardRelogin(instanceId, context ?? "page-not-found");
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
  const details = getApplicantDetailsOverrides(instanceId);
  if (isIndDeuRoute(details?.countryCode, details?.missionCode)) return false;
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

    // Default Chrome page zoom = 75% (zoom_factor = 1.2 ^ level).
    const zoom75 = Math.log(0.75) / Math.log(1.2);
    const partition = (prefs.partition ?? {}) as Record<string, unknown>;
    const defaultZoom = (partition.default_zoom_level ?? {}) as Record<string, unknown>;
    defaultZoom.x = zoom75;
    partition.default_zoom_level = defaultZoom;
    prefs.partition = partition;

    writeFileSync(prefsPath, JSON.stringify(prefs), "utf-8");
  } catch {
    // Non-critical — flags below still suppress most dialogs
  }
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
  const base = raw
    ? raw
    : `vfs-${(instanceId || "instance").toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
  const rot = getProxyRotationOffset(instanceId);
  // Append rotation so sticky proxies get a new egress on each Chrome relaunch / IP rotate.
  return `${base}-r${rot}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
}

const PROXY_CLAIM_HEARTBEAT_MS = 30_000;
const PROXY_LIST_WATCH_INTERVAL_MS = 5_000;
const PROXY_LIST_WATCH_DEBOUNCE_MS = 800;

function numericBotInstanceId(): number {
  const n = Number.parseInt(process.env.BOT_INSTANCE_ID ?? "1", 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

let proxyClaimHeartbeatTimer: NodeJS.Timeout | null = null;

/** Keeps this bot's IP/session claim alive; a silent claim is handed back to the fleet after 2 min. */
function ensureProxyClaimHeartbeat(): void {
  if (proxyClaimHeartbeatTimer) return;
  proxyClaimHeartbeatTimer = setInterval(() => {
    const id = numericBotInstanceId();
    const provider = getActiveProxyProvider();
    if (provider === "iplist" || provider === "webshare") {
      heartbeatProxyClaim(id);
    }
    heartbeatEgressClaim(id);
  }, PROXY_CLAIM_HEARTBEAT_MS);
  proxyClaimHeartbeatTimer.unref();
}

/**
 * Bright Data: hash this instance onto `PROXY_URLS` + rotation offset.
 * Webshare: exclusive sticky sessions 1–N (`WEBSHARE_MAX_STICKY_SESSION`).
 * `takeNew` (Chrome launch / IP rotate) releases the current session into cooldown
 * and takes an idle one — not a session another live bot already holds.
 * Only wraps onto a live session when the whole pool is in use.
 * IP list: an exclusive claim from `proxies.txt`, same `takeNew` / cooldown rules.
 */
function resolveProxyForInstance(instanceId: string, opts?: { takeNew?: boolean }): string | null {
  const provider = getActiveProxyProvider();
  if (provider === "iplist") {
    const keys = listProxyListEntries().map((entry) => entry.key);
    if (keys.length === 0) return null;
    const key = claimProxyForInstance(numericBotInstanceId(), keys, { takeNew: opts?.takeNew === true });
    if (!key) return null;
    ensureProxyClaimHeartbeat();
    startProxyListFileWatcher();
    return proxyListUrlForKey(key);
  }
  const rot = getProxyRotationOffset(instanceId);
  if (provider === "webshare") {
    const claimed = claimProxyForInstance(numericBotInstanceId(), webshareStickySessionKeys(), {
      takeNew: opts?.takeNew === true,
    });
    if (claimed) {
      ensureProxyClaimHeartbeat();
      return buildWebshareProxyUrl(claimed);
    }
    return buildWebshareProxyUrl(webshareStickySessionId(instanceId, rot));
  }
  const list = listProxyUrlsForProvider(provider);
  if (list.length === 0) return null;
  const session = stableSessionToken(instanceId);
  return pickProxyUrlFromList(list, instanceId, rot, session);
}

let proxyListWatchPath: string | null = null;
let proxyListWatchTimer: NodeJS.Timeout | null = null;

/**
 * Live reload of `proxies.txt`. `watchFile` (stat polling) rather than `fs.watch` because
 * editors replace the file on save, which leaves `fs.watch` bound to the old handle on Windows.
 */
function startProxyListFileWatcher(): void {
  const file = getProxyListFilePath();
  if (proxyListWatchPath === file) return;
  if (proxyListWatchPath) unwatchFile(proxyListWatchPath);
  proxyListWatchPath = file;
  watchFile(file, { interval: PROXY_LIST_WATCH_INTERVAL_MS }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    if (proxyListWatchTimer) clearTimeout(proxyListWatchTimer);
    proxyListWatchTimer = setTimeout(() => {
      void onProxyListFileChanged();
    }, PROXY_LIST_WATCH_DEBOUNCE_MS);
    proxyListWatchTimer.unref();
  });
}

/**
 * Only bots whose IP was removed from the file move; the rest keep the IP they are on, so
 * appending IPs never disturbs a live session. The swap reuses the local tunnel port, so
 * Chrome is not restarted.
 */
async function onProxyListFileChanged(): Promise<void> {
  if (getActiveProxyProvider() !== "iplist") return;
  const entries = listProxyListEntries();
  if (entries.length === 0) return;

  const current = getClaimedProxyKey(numericBotInstanceId());
  if (current && entries.some((entry) => entry.key === current)) return;

  const selected = resolveProxyForInstance(getBotInstanceId(resolveChromeUserDataDir()));
  if (!selected) return;
  if (!activeAnonymizedProxyUrl && localTunnelPort == null) return;
  try {
    await recreateAuthProxyTunnel(selected);
    clearApplicantIpCache();
    await resolveAndReportEgressIp({ logAs: "rotate-ip" });
  } catch {
    /* keep the current tunnel; the next Chrome launch picks up the new list */
  }
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
    await closeActiveAnonymizedProxyTunnel();
    return { launchProxy: toChromeProxyServer(parsedProxy), proxyHasAuth: false, viaLocalTunnel: false };
  }

  const launchProxy = await recreateAuthProxyTunnel(selectedProxy);
  return { launchProxy, proxyHasAuth: true, viaLocalTunnel: true };
}

/**
 * proxy-chain defaults to port 8000 when `port` is omitted. In cluster mode every child
 * would fight for 8000 — bot 1 wins, bots 2+ hang in anonymizeProxy and never spawn Chrome.
 * Pin a per-instance port (sticky for vendor switches within this process).
 */
function preferredLocalTunnelPort(): number {
  if (localTunnelPort != null && localTunnelPort > 0) return localTunnelPort;
  const id = Math.max(1, parseInt(process.env.BOT_INSTANCE_ID ?? "1", 10) || 1);
  return 28000 + id;
}

/**
 * Local proxy-chain listener Chrome uses (`--proxy-server=http://127.0.0.1:port`).
 * Rebinding the same port with a new upstream makes the next CONNECT use the new vendor
 * without restarting Chrome.
 */
async function recreateAuthProxyTunnel(selectedProxy: string): Promise<string> {
  const proxyChain = await getProxyChainModule();
  if (activeAnonymizedProxyUrl) {
    try {
      await proxyChain.closeAnonymizedProxy(activeAnonymizedProxyUrl, true);
    } catch {
      /* ignore */
    }
    activeAnonymizedProxyUrl = null;
  }

  const basePort = preferredLocalTunnelPort();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      // Always pass an explicit port — never let proxy-chain fall back to shared 8000.
      const port = basePort + attempt;
      const url = await proxyChain.anonymizeProxy({ url: selectedProxy, port });
      activeAnonymizedProxyUrl = url;
      try {
        const p = Number.parseInt(new URL(url).port, 10);
        if (Number.isFinite(p) && p > 0) localTunnelPort = p;
      } catch {
        /* ignore */
      }
      return url;
    } catch (err) {
      lastErr = err;
      // Sticky port was busy/stale — allow the next attempt to pick basePort+attempt.
      if (attempt === 0) localTunnelPort = null;
      await new Promise((r) => setTimeout(r, 40 + attempt * 30));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "proxy-chain bind failed"));
}

/**
 * Swap Bright Data / Webshare / IP list for this process. Chrome keeps the same local tunnel port;
 * existing CONNECT sockets are dropped so the next page `fetch()` uses the new upstream.
 */
async function applyProxyProviderSwitch(provider: ProxyProviderId): Promise<{ ok: boolean; error?: string }> {
  const ready = assertProxyProviderReady(provider);
  if (!ready.ok) return ready;
  setMemoryProxyProvider(provider);
  const instanceId = getBotInstanceId(resolveChromeUserDataDir());
  const selected = resolveProxyForInstance(instanceId);
  if (!selected) {
    return { ok: false, error: `No proxy URL configured for ${proxyProviderLabel(provider)}.` };
  }
  const parsed = parseProxy(selected);
  if (!parsed) {
    return { ok: false, error: `Invalid ${proxyProviderLabel(provider)} proxy URL.` };
  }
  const hasAuth = Boolean(parsed.username || parsed.password);
  if (!hasAuth) {
    return { ok: false, error: "Unauthenticated proxies cannot be switched without a Chrome restart." };
  }
  if (!activeAnonymizedProxyUrl && localTunnelPort == null) {
    // Chrome not launched yet — next spawn picks up the new provider.
    return { ok: true };
  }
  try {
    await recreateAuthProxyTunnel(selected);
    clearApplicantIpCache();
    await resolveAndReportEgressIp({ logAs: "rotate-ip" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function commitProxyProvider(provider: ProxyProviderId): { ok: boolean; error?: string } {
  const ready = assertProxyProviderReady(provider);
  if (!ready.ok) return ready;
  persistProxyProvider(provider);
  void applyProxyProviderSwitch(provider);
  return { ok: true };
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

/** Compact bottom-right size used for Chrome's first paint (and grid tiles when fleet is large). */
const CHROME_FIRST_OPEN_WIDTH = 480;
const CHROME_FIRST_OPEN_HEIGHT = 360;
/** Above this instance count, grid tiles keep the first-open size instead of shrinking to fit the screen. */
const CHROME_COMPACT_GRID_THRESHOLD = 12;

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
      resolve(cachedScreenSize);
    }
  });
}

/**
 * Compact bottom-right placement used only for Chrome's first paint
 * (so it does not flash huge on the left). After DevTools is ready we
 * move to the tiled grid via {@link computeChromeGridPosition}.
 */
async function computeChromeFirstOpenPosition(): Promise<{ width: number; height: number; x: number; y: number }> {
  const screen = await detectScreenWorkingArea();
  const screenW = config.screenWidth > 0 ? config.screenWidth : screen.width;
  const screenH = config.screenHeight > 0 ? config.screenHeight : screen.height;
  const margin = 12;
  return {
    width: CHROME_FIRST_OPEN_WIDTH,
    height: CHROME_FIRST_OPEN_HEIGHT,
    x: Math.max(0, screenW - CHROME_FIRST_OPEN_WIDTH - margin),
    y: Math.max(0, screenH - CHROME_FIRST_OPEN_HEIGHT - margin),
  };
}

/**
 * Tiled grid layout for all bot Chrome windows (instance IDs are 1-based).
 */
async function computeChromeGridPosition(instanceIdx: number, totalInstances: number): Promise<{ width: number; height: number; x: number; y: number }> {
  const total = Math.max(1, totalInstances);
  const idx = Math.max(0, instanceIdx - 1); // 0-based

  // Auto layout targets a ~5:2 column-to-row ratio (wider than tall).
  const cols = config.chromeGridColumns > 0
    ? config.chromeGridColumns
    : Math.max(1, Math.ceil(Math.sqrt(total * 2.5)));
  const rows = Math.max(1, Math.ceil(total / cols));

  const screen = await detectScreenWorkingArea();
  const screenW = config.screenWidth > 0 ? config.screenWidth : screen.width;
  const screenH = config.screenHeight > 0 ? config.screenHeight : screen.height;

  const useFirstOpenTileSize = total > CHROME_COMPACT_GRID_THRESHOLD;
  const w = config.chromeWindowWidth > 0
    ? config.chromeWindowWidth
    : useFirstOpenTileSize
      ? CHROME_FIRST_OPEN_WIDTH
      : Math.floor(screenW / cols);
  const h = config.chromeWindowHeight > 0
    ? config.chromeWindowHeight
    : useFirstOpenTileSize
      ? CHROME_FIRST_OPEN_HEIGHT
      : Math.floor(screenH / rows);

  const col = idx % cols;
  const row = Math.floor(idx / cols);

  // Keep window size; compress step between tiles so every window stays on screen.
  // When tiles are larger than the grid cell, windows overlap (intentional).
  const stepX = cols > 1 ? Math.max(1, Math.floor((screenW - w) / (cols - 1))) : 0;
  const stepY = rows > 1 ? Math.max(1, Math.floor((screenH - h) / (rows - 1))) : 0;
  const x = col * stepX;
  const y = row * stepY;

  return { width: w, height: h, x, y };
}

async function ensureChromeWithDevTools(opts?: { preserveSession?: boolean }): Promise<void> {
  const userDataDir = resolveChromeUserDataDir();
  const instanceId = getBotInstanceId(userDataDir);
  const debugPort = getRemoteDebuggingPort();

  // If Chrome DevTools is already reachable on the target port, skip spawning.
  // Reposition into the tiled grid (not bottom-right).
  for (const url of getChromeDevToolsCheckUrls()) {
    if (await checkDevToolsEndpoint(url)) {
      const numId = parseInt(process.env.BOT_INSTANCE_ID ?? "1", 10) || 1;
      const total = parseInt(process.env.BOT_TOTAL_INSTANCES ?? "1", 10) || 1;
      const grid = await computeChromeGridPosition(numId, total);
      await moveWindowByDebugPort(debugPort, grid);
      return;
    }
  }

  await clearChromeSessionDataBeforeLaunch(userDataDir, {
    preserveAuthSession: opts?.preserveSession === true,
  });

  // Every real Chrome spawn is an IP rotate: take the next unused entry from the list.
  const selectedProxy = resolveProxyForInstance(instanceId, { takeNew: true });
  bumpProxyRotationForProfile(instanceId);
  clearApplicantIpCache();

  const chromePath = resolveChromeExecutablePath();
  const resolvedProxy = await resolveLaunchProxyServer(selectedProxy);

  const numericInstanceId = parseInt(process.env.BOT_INSTANCE_ID ?? "1", 10) || 1;
  const totalInstances = parseInt(process.env.BOT_TOTAL_INSTANCES ?? "1", 10) || 1;
  const firstOpen = await computeChromeFirstOpenPosition();
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
  // First paint: compact bottom-right (avoids a huge left-side flash).
  chromeArgs.push(`--window-size=${firstOpen.width},${firstOpen.height}`);
  chromeArgs.push(`--window-position=${firstOpen.x},${firstOpen.y}`);
  const launchInstanceId = getCurrentInstanceId() ?? numericInstanceId;
  const startOnRegister =
    isIndDeuRoute(config.slotPayload.countryCode, config.slotPayload.missionCode) &&
    !shouldReuseIndDeuAccount(launchInstanceId);
  chromeArgs.push(startOnRegister ? config.registerPageUrl : config.loginPageUrl);

  const child = spawn(chromePath, chromeArgs, { detached: true, stdio: "ignore" });
  child.unref();

  const delayMs = 400;
  const maxWaitMs = 60_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    for (const url of getChromeDevToolsCheckUrls()) {
      if (await checkDevToolsEndpoint(url)) {
        // Small delay for Chrome window to fully render, then move into the fleet tile grid.
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
    let resolved = false;
    function done() {
      if (!resolved) {
        resolved = true;
        try { unlinkSync(scriptPath); } catch { }
        resolve();
      }
    }
    const timer = setTimeout(() => { try { ps.kill(); } catch { } done(); }, 8000);
    ps.on("exit", () => {
      clearTimeout(timer);
      done();
    });
    ps.on("error", () => {
      clearTimeout(timer);
      done();
    });
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
      finish();
    });
    ps.on("error", (err) => {
      clearTimeout(timer);
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

  const waitMs = opts.waitMs ?? 0;
  if (waitMs <= 0) {
    await remimize();
    if (typeof opts.instanceId === "number" && opts.instanceId >= 1) {
      markInstanceReady(Math.floor(opts.instanceId));
    }
    return "ok";
  }

  reporter.setPhase("polling", `on dashboard — waiting ${Math.round(waitMs / 1000)}s`);

  const abortSeq = opts.abortSeq;
  if (abortSeq == null) {
    await new Promise((r) => setTimeout(r, waitMs));
    await remimize();
    if (typeof opts.instanceId === "number" && opts.instanceId >= 1) {
      markInstanceReady(Math.floor(opts.instanceId));
    }
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
  if (typeof opts.instanceId === "number" && opts.instanceId >= 1) {
    markInstanceReady(Math.floor(opts.instanceId));
  }
  return "ok";
}

async function waitUntilScheduledPoll(
  targetAtMs: number,
  instanceId: number | undefined,
  abortSeq: number,
  slotWatcher: ReturnType<typeof createSlotFoundWatcher>
): Promise<"timer" | "slot" | "abort"> {
  const waitMs = Math.max(0, targetAtMs - Date.now());
  if (waitMs <= 0) return "timer";

  const timerPromise = new Promise<"timer">((r) => setTimeout(() => r("timer"), waitMs));
  return Promise.race([
    timerPromise,
    slotWatcher.wait().then(() => "slot" as const),
    waitForPollingAbort(abortSeq).then(() => "abort" as const),
  ]);
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
  if (Date.now() >= PROCESS_SLOT_RESULTS_UNTIL_MS) return false;
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
  } else {
  }
  return true;
}

/** `true` if at least one slot was seen (polling stops after the first hit). */
function pollLoopReloginOpts(instanceId?: number, context = "poll-interval"): {
  reloginAfter?: number;
  onRelogin?: () => Promise<void>;
} {
  const n = config.pollReloginInterval;
  if (!(n > 0)) return {};
  return {
    reloginAfter: n,
    onRelogin: () => performHardRelogin(instanceId, context),
  };
}

function isAreLvaCurrent(): boolean {
  return isAreLvaRoute(config.slotPayload.countryCode, config.slotPayload.missionCode);
}

/** Apply this instance's setup-form centre so applicants/calendar skip CheckIsSlotAvailable. */
function applyAreLvaFormCenter(instanceId?: number): void {
  const details = getApplicantDetailsOverrides(instanceId);
  const vac = typeof details?.vacCode === "string" ? details.vacCode.trim() : "";
  const cat = typeof details?.selectedSubvisaCategory === "string" ? details.selectedSubvisaCategory.trim() : "";
  if (vac && cat) setSlotCenterOverride(vac, cat);
}

/**
 * Other portals poll CheckIsSlotAvailable. are-lva goes straight to applicants after login wait.
 */
async function runSlotPollUnlessAreLva(
  instanceId?: number,
  opts?: {
    pollStartAt?: number;
    reloginAfter?: number;
    onRelogin?: () => Promise<void>;
  }
): Promise<boolean> {
  if (isAreLvaCurrent()) return true;
  return runPollLoop(instanceId, opts);
}

async function runPollLoop(
  instanceId?: number,
  opts?: {
    /** Fleet earliest-poll timestamp (ms). Shared gate; spacing uses fleet claim. */
    pollStartAt?: number;
    /** After every N completed poll rounds, call onRelogin() to refresh the VFS session. */
    reloginAfter?: number;
    /** Hard relogin (kill Chrome, clear session, rotate IP, login). */
    onRelogin?: () => Promise<void>;
  }
): Promise<boolean> {
  let slotFound = false;
  const slotWatcher = createSlotFoundWatcher(instanceId);
  const myAbortSeq = pollingAbortSeq;
  const pollAnchorAt = typeof opts?.pollStartAt === "number" ? opts.pollStartAt : Date.now();
  const id = normalizeFleetInstanceId(instanceId);
  ensureFleetPollEarliest(pollAnchorAt);
  registerFleetPoller(id);

  try {
    while (true) {
      if (pollingAbortSeq !== myAbortSeq) {
        await throwIfAbortedForPageNotFound(myAbortSeq, "polling-loop-abort");
        return false;
      }

      if ((await holdIfPollingPaused(instanceId, myAbortSeq)) === "abort") {
        return false;
      }

      if (await checkPeerFoundSlotAndJoinBooking(instanceId, slotWatcher.cachedState())) {
        return true;
      }

      try {
        const { getConfiguredCenters, pickPollingCenterForInstance } = await import("./utils/centerConfig.js");
        const centers = getConfiguredCenters(instanceId);

        if (centers.length === 0) {
          break;
        }

        const currentUrl = await browser.getFirstTabUrl();
        reporter.setPage(currentUrl);
        await throwIfPageNotFoundRestartRequested("polling-loop");

        // Not on dashboard yet — don't burn a fleet poll slot.
        if (!isPreparedForFleetPolling(currentUrl)) {
          const wokePrep = await waitUntilScheduledPoll(Date.now() + 1000, instanceId, myAbortSeq, slotWatcher);
          if (wokePrep === "abort") return false;
          if (wokePrep === "slot" && (await checkPeerFoundSlotAndJoinBooking(instanceId, slotWatcher.cachedState()))) {
            return true;
          }
          continue;
        }

        const claim = await waitAndClaimFleetPollSlot({
          instanceId: id,
          waitUntil: (targetAtMs) => waitUntilScheduledPoll(targetAtMs, instanceId, myAbortSeq, slotWatcher),
        });
        if (claim === "abort") {
          return false;
        }
        if (claim === "slot" && (await checkPeerFoundSlotAndJoinBooking(instanceId, slotWatcher.cachedState()))) {
          return true;
        }

        // Re-check URL after waiting for the claim — may have navigated away.
        const urlAfterClaim = await browser.getFirstTabUrl();
        reporter.setPage(urlAfterClaim);
        if (!isPreparedForFleetPolling(urlAfterClaim)) {
          continue;
        }

        const center = pickPollingCenterForInstance(instanceId, centers);
        if (!center) {
          break;
        }

        if (await checkPeerFoundSlotAndJoinBooking(instanceId, slotWatcher.cachedState())) {
          return true;
        }

        if (!/\/(applications|dashboard|home|application-detail|your-details)/i.test(urlAfterClaim)) {
          // Not on a normal VFS page. If it's a block/error page (403201 "Access
          // Restricted", page-not-found, session-expired, or a 429 body), recover
          // instead of silently stopping — this is the post-login block case.
          if (isPageNotFoundUrl(urlAfterClaim)) {
            throw new PageNotFoundRestartError(`polling: ${urlAfterClaim}`);
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
          if (blockKind === "cloudflare") {
            reporter.setPhase("recovering", "Cloudflare challenge page — recovering");
            await telegram
              .alert(
                "error",
                `Bot ${instanceId ?? "?"} hit Cloudflare challenge page during polling (${urlAfterClaim || "unknown"}). Clearing cookies/session + rotating IP + restarting Chrome...`
              )
              .catch(() => { });
            await recoverFromCloudflareChallenge(instanceId, "polling-cloudflare-page");
            await telegram
              .alert("info", `Bot ${instanceId ?? "?"} recovered from Cloudflare challenge page — polling resumed.`)
              .catch(() => { });
            continue;
          }
          if (blockKind === "forbidden") {
            reporter.setPhase("recovering", "block page after login — rotating IP + relogin");
            await telegram.alert("error", `Bot ${instanceId ?? "?"} hit a block page during polling (${urlAfterClaim || "unknown"}). Restarting browser + rotating IP + relogin...`).catch(() => { });
            await performHardRelogin(instanceId, "polling-block-page");
            continue;
          }
          await telegram.alert("error", `Not on a supported VFS page for polling (${urlAfterClaim || "unknown"}). Polling stopped.`).catch(() => { });
          return false;
        }

        reporter.setPhase("polling", `checking center ${center.centerNumber} (${center.vacCode})`);
        reporter.setPoll({ center: `${center.centerNumber}:${center.vacCode}`, pollCount: pollRoundsOnSession + 1 });

        const { slot, response, centerNumber, centerCode, visaCategoryCode, unauthorized, accountBlocked, rateLimitedIp, rateLimitCode, forbidden, accountRecreate, forbiddenCode, gatewayTimeout, cloudflareChallenge, fetchFailed } = await polling.checkSlotsInBrowser(browser, {
          centerCode: center.vacCode,
          visaCategoryCode: center.visaCategoryCode,
          centerNumber: center.centerNumber,
        });


        if (gatewayTimeout) {
          reporter.setPhase("recovering", "504 Gateway Timeout — continuing");
          await telegram.alert("error", `Bot ${instanceId ?? "?"} got 504 Gateway Timeout during polling — continuing.`).catch(() => { });
          continue;
        }

        if (fetchFailed) {
          reporter.setRecoveringError("fetch fail", "Failed to fetch — hard relogin (proxy/network)");
          await telegram
            .alert(
              "error",
              `Bot ${instanceId ?? "?"} got Failed to fetch during polling (proxy/network). Clearing session + rotating IP + restarting Chrome...`
            )
            .catch(() => { });
          await performHardRelogin(instanceId, "failed-to-fetch-polling");
          await telegram
            .alert("info", `Bot ${instanceId ?? "?"} recovered from Failed to fetch — polling resumed.`)
            .catch(() => { });
          continue;
        }

        if (cloudflareChallenge) {
          reporter.setPhase("recovering", "Cloudflare challenge — recovering");
          await telegram
            .alert(
              "error",
              `Bot ${instanceId ?? "?"} got Cloudflare challenge on CheckIsSlotAvailable. Clearing cookies/session + rotating IP + restarting Chrome...`
            )
            .catch(() => { });
          await recoverFromCloudflareChallenge(instanceId, "cloudflare-challenge-polling");
          await telegram
            .alert("info", `Bot ${instanceId ?? "?"} recovered from Cloudflare challenge — polling resumed.`)
            .catch(() => { });
          continue;
        }

        if (forbidden) {
          if (
            accountRecreate &&
            isIndDeuRoute(config.slotPayload.countryCode, config.slotPayload.missionCode)
          ) {
            await recreateIndDeuAccountAndRelogin(instanceId, forbiddenCode ?? "4030xx");
            continue;
          }
          reporter.setPhase("recovering", "403 Forbidden — rotating IP + relogin");
          await telegram.alert("error", `Bot ${instanceId ?? "?"} got 403 Forbidden during polling. Restarting browser + rotating IP...`).catch(() => { });
          await performHardRelogin(instanceId, "403-forbidden-recovery");
          await telegram.alert("info", `Bot ${instanceId ?? "?"} recovered from 403 — polling resumed.`).catch(() => { });
          continue;
        }

        if (unauthorized) {
          reporter.setRecoveringError("401", "401 Unauthorized — hard relogin");
          await telegram
            .alert(
              "error",
              `Bot ${instanceId ?? "?"} got 401 Unauthorized during polling (VFS session expired). Restarting browser + rotating IP + relogin...`
            )
            .catch(() => { });
          await performHardRelogin(instanceId, "401-unauthorized-recovery");
          await telegram
            .alert("info", `Bot ${instanceId ?? "?"} recovered from 401 — polling resumed.`)
            .catch(() => { });
          continue;
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
        reporter.setAttention(null);

        if (slot && Date.now() < PROCESS_SLOT_RESULTS_UNTIL_MS) {
          slotFound = true;
          reporter.setPoll({ slotFound: true, code: "slot" });
          reporter.setDetail(`slot found in center ${centerNumber}`);

          markSlotFound(instanceId ?? 0, centerCode!, visaCategoryCode!, slot);
          setSlotCenterOverride(centerCode!, visaCategoryCode!);

          // Do not await — Telegram latency must not delay applicants.
          void telegram
            .alert("slot_found", `Slot (Center ${centerNumber}): ${slot.center || "—"} ${slot.date} ${slot.time}`, {
              slotId: slot.id,
              centerNumber,
            })
            .catch(() => { });
          break;
        }

        if (await checkPeerFoundSlotAndJoinBooking(instanceId, slotWatcher.cachedState())) {
          return true;
        }

        await telegram.alert("no_slot_found", `No slot in Center ${center.centerNumber} (${center.vacCode})`).catch(() => { });
      } catch (err) {
        if (isFailedToFetchError(err)) {
          reporter.setRecoveringError("fetch fail", "Failed to fetch — hard relogin (proxy/network)");
          await telegram
            .alert(
              "error",
              `Bot ${instanceId ?? "?"} got Failed to fetch during polling (proxy/network). Clearing session + rotating IP + restarting Chrome...`
            )
            .catch(() => { });
          try {
            await performHardRelogin(instanceId, "failed-to-fetch-polling");
            await telegram
              .alert("info", `Bot ${instanceId ?? "?"} recovered from Failed to fetch — polling resumed.`)
              .catch(() => { });
          } catch (recoverErr) {
            await telegram
              .alert("error", recoverErr instanceof Error ? recoverErr.message : "Failed to fetch recovery failed")
              .catch(() => { });
          }
        } else {
          await telegram.alert("error", err instanceof Error ? err.message : "Poll error").catch(() => { });
        }
      }
      pollRoundsOnSession += 1;

      // Every N CheckIsSlotAvailable calls: hard relogin so the 429 counter resets.
      const reloginAfter = opts?.reloginAfter;
      if (reloginAfter && reloginAfter > 0 && pollRoundsOnSession >= reloginAfter && opts?.onRelogin) {
        try {
          unregisterFleetPoller(id);
          await opts.onRelogin();
          registerFleetPoller(id);
        } catch (err) {
          await telegram.alert("error", "Re-login failed — polling stopped. Please check the browser and re-login manually.").catch(() => { });
          return false;
        } finally {
          // Without this the threshold stays met and every later poll would relogin.
          resetPollRoundsOnSession();
        }
      }
    }
    return slotFound;
  } finally {
    unregisterFleetPoller(id);
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

/** Save applicants returned HTTP 401 Unauthorized — session dead; hard relogin. */
function isSaveApplicants401(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    /Save applicants failed HTTP 401\b/i.test(err.message) ||
    (/Save applicants failed HTTP/i.test(err.message) && /Unauthorized/i.test(err.message))
  );
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
  const id = normalizeFleetInstanceId(instanceId);
  const stepMs = getFleetPollStepMs();
  const pollIntervalMs = getFleetPollCycleMs();

  return {
    postLoginOffsetMs: (id - 1) * stepMs,
    pollIntervalMs,
  };
}

/**
 * Hard relogin: kill Chrome, clear cache/cookies/session, rotate proxy IP,
 * open a new Chrome, login, settle on dashboard, prepare polling.
 */
async function ensureIndDeuAccountIfNeeded(
  instanceId?: number,
  forceNew = false,
): Promise<void> {
  if (!isIndDeuRoute(config.slotPayload.countryCode, config.slotPayload.missionCode)) return;
  reporter.setPhase("launching", forceNew ? "creating new ind-deu account" : "ensuring ind-deu account");
  await ensureIndDeuAccountReady(browser, instanceId, {
    forceNew,
    hardRestartChrome: async () => {
      clearApplicantIpCache();
      await relaunchChromeAfterCredentialSwapLogout();
      await resolveAndReportEgressIp({ logAs: "rotate-ip", instanceId });
    },
  });
  reporter.setAccount(resolveLoginUsername(instanceId), getPendingCredentialSlot(instanceId));
}

async function recreateIndDeuAccountAndRelogin(
  instanceId: number | undefined,
  code?: string,
): Promise<void> {
  const label = code ?? "4030xx";
  resetPollRoundsOnSession();
  reporter.setPhase("recovering", `${label} — new account + IP rotate`);
  await telegram
    .alert("error", `Bot ${instanceId ?? "?"} got ${label} — creating a new ind-deu account...`)
    .catch(() => { });
  clearApplicationUrn();
  clearApplicantIpCache();
  await relaunchChromeAfterCredentialSwapLogout();
  await resolveAndReportEgressIp({ logAs: "rotate-ip", instanceId });
  await ensureIndDeuAccountIfNeeded(instanceId, true);
  await browser.openLoginInFirstTab();
  await performVfsLoginFromStore(instanceId);
  await resolveAndReportEgressIp({ logAs: "recover", instanceId });
  await settleOnDashboard({
    instanceId,
    waitMs: RESTART_DASHBOARD_WAIT_MS,
    reason: `ind-deu-recreate-${label}`,
  });
  await browser.preparePollingAfterLogin({ skipDashboardNavigate: true });
  await telegram
    .alert("info", `Bot ${instanceId ?? "?"} new ind-deu account ready after ${label} — resuming.`)
    .catch(() => { });
}

async function performHardRelogin(instanceId?: number, context?: string): Promise<void> {
  if (
    isIndDeuRoute(config.slotPayload.countryCode, config.slotPayload.missionCode) &&
    isIndDeuPhoneExpiredForRelogin(instanceId)
  ) {
    await recreateIndDeuAccountAndRelogin(instanceId, "phone-ttl");
    return;
  }
  const ctx = context ?? "hard-relogin";
  clearSoftIpRotateFlag();
  resetPollRoundsOnSession();
  if (/failed-to-fetch|fetch/i.test(ctx)) {
    reporter.setRecoveringError("fetch fail", `hard relogin — ${ctx}`);
  } else if (/401|unauthorized/i.test(ctx)) {
    reporter.setRecoveringError("401", `hard relogin — ${ctx}`);
  } else {
    reporter.setPhase("recovering", `hard relogin — kill Chrome + clear session + rotate IP (${ctx})`);
  }
  clearApplicationUrn();
  clearApplicantIpCache();
  await relaunchChromeAfterCredentialSwapLogout();
  await resolveAndReportEgressIp({ instanceId });
  await performVfsLoginFromStore(instanceId);
  await resolveAndReportEgressIp({ logAs: "recover", instanceId });
  await settleOnDashboard({
    instanceId,
    waitMs: RESTART_DASHBOARD_WAIT_MS,
    reason: ctx,
  });
  await browser.preparePollingAfterLogin({ skipDashboardNavigate: true });
}

/**
 * Session recovery after save-applicants failure:
 * hard relogin, then poll again.
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
  await telegram
    .alert("error", `Save applicants failed (instance ${instanceId ?? 1}), hard relogin: ${msg}`)
    .catch(() => { });
  clearSlotCenterOverride();
  clearSlotDate();
  await performHardRelogin(instanceId, context);
  return runSlotPollUnlessAreLva(instanceId, pollLoopReloginOpts(instanceId));
}

/** Pause before the next booking attempt so a fast-failing poll loop cannot hot-spin. */
const BOOKING_SETBACK_RETRY_MS = 5_000;

function sleepMsAsync(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * A booking attempt fell through without a confirmed appointment. Drop this instance's local
 * slot overrides and poll again; the caller keeps looping until a schedule succeeds.
 */
async function repollAfterBookingSetback(
  instanceId: number | undefined,
  context: string
): Promise<void> {
  clearSlotCenterOverride();
  clearSlotDate();
  await browser.preparePollingAfterLogin({ skipDashboardNavigate: true }).catch(() => { });
  if (!(await runSlotPollUnlessAreLva(instanceId, pollLoopReloginOpts(instanceId)))) {
    // Poll loop bailed out immediately (abort / no centers configured) — wait it out.
    reporter.setPhase("polling", `retrying after ${context}`);
    await sleepMsAsync(BOOKING_SETBACK_RETRY_MS);
  }
}

/** 504 / Cloudflare / forbidden on booking APIs: hard relogin, poll, restart booking chain. */
async function recoverBookingChainFromGatewayTimeout(
  instanceId: number | undefined,
  context: string,
  err: unknown,
  slotStateCache?: SlotFoundState
): Promise<boolean> {
  if (!(await recoverFromSaveApplicantsFailure(instanceId, context, err))) {
    return false;
  }
  return runBookingChainWithRetry(instanceId, slotStateCache);
}

/** 4292XX on booking APIs: hard relogin, poll for a fresh slot, then restart booking chain. */
async function recoverBookingChainFromIpRateLimit(
  instanceId: number | undefined,
  context: string,
  err: VfsRateLimitedError,
  slotStateCache?: SlotFoundState
): Promise<boolean> {
  const mode = await handleIpRateLimitRecovery(instanceId, context, err.code);
  if (mode === "soft_rotate") {
    // Session and URN survived the IP swap — resume booking without re-polling.
    return runBookingChainWithRetry(instanceId, slotStateCache);
  }
  clearSlotCenterOverride();
  clearSlotDate();
  if (!(await runSlotPollUnlessAreLva(instanceId, pollLoopReloginOpts(instanceId)))) {
    return false;
  }
  return runBookingChainWithRetry(instanceId, slotStateCache);
}

/**
 * Proxy / network drop on a booking API. The VFS session is usually fine, so swap the exit IP
 * and keep going; a repeat (soft rotate already pending) escalates to a full relogin.
 */
async function recoverBookingChainFromFetchFailure(
  instanceId: number | undefined,
  context: string,
  err: unknown,
  slotStateCache?: SlotFoundState
): Promise<boolean> {
  if (!softIpRotateAwaitingSecond429 && (await rotateIpWithoutRelogin(context))) {
    return runBookingChainWithRetry(instanceId, slotStateCache);
  }
  clearSoftIpRotateFlag();
  return recoverBookingChainFromGatewayTimeout(instanceId, context, err, slotStateCache);
}

/** ind-deu 4030xx on booking APIs: new account + IP rotate, poll for a fresh slot, then restart the chain. */
async function recoverBookingChainFromAccountRecreate(
  instanceId: number | undefined,
  err: IndDeuAccountRecreateError,
  slotStateCache?: SlotFoundState
): Promise<boolean> {
  await recreateIndDeuAccountAndRelogin(instanceId, err.code);
  clearSlotCenterOverride();
  clearSlotDate();
  if (!(await runSlotPollUnlessAreLva(instanceId, pollLoopReloginOpts(instanceId)))) {
    return false;
  }
  return runBookingChainWithRetry(instanceId, slotStateCache);
}

/**
 * 403 / 504 / 429 on the login page are IP-level blocks that clear on a fresh exit IP, so the
 * bot keeps restarting Chrome and rotating instead of giving up after a few tries.
 */
const MAX_FORBIDDEN_RETRIES = 50;

function isOtpRelatedLoginFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("otp") ||
    msg.includes("mail.tm") ||
    msg.includes("login did not complete")
  );
}

function isOtpNotReceivedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("no otp within") || msg.includes("timed out waiting for otp field");
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
      // Session still valid — the tab is on the dashboard, which the caller handles.
      if (err instanceof VfsAlreadyLoggedInError) {
        return;
      }
      if (err instanceof IndDeuAccountRecreateError) {
        await recreateIndDeuAccountAndRelogin(instanceId, err.code);
        return;
      }
      if (err instanceof VfsForbiddenError) {
        const recreate = extractIndDeu4030xxFromUnknown(err);
        if (recreate && isIndDeuRoute(config.slotPayload.countryCode, config.slotPayload.missionCode)) {
          await recreateIndDeuAccountAndRelogin(instanceId, recreate);
          return;
        }
        await telegram.alert("error", `Bot ${instanceId ?? "?"} got 403 on login page (attempt ${attempt}/${MAX_FORBIDDEN_RETRIES}). Restarting browser + rotating IP...`).catch(() => { });
        clearApplicantIpCache();
        await relaunchChromeAfterCredentialSwapLogout();
        await resolveAndReportEgressIp({ logAs: "rotate-ip", instanceId });
        if (attempt === MAX_FORBIDDEN_RETRIES) {
          throw new Error(`Login page still 403 after ${MAX_FORBIDDEN_RETRIES} browser restarts — giving up.`);
        }
        continue;
      }
      if (err instanceof VfsGatewayTimeoutError) {
        await telegram.alert("error", `Bot ${instanceId ?? "?"} got 504 on login page (attempt ${attempt}/${MAX_FORBIDDEN_RETRIES}). Restarting browser + rotating IP...`).catch(() => { });
        clearApplicantIpCache();
        await relaunchChromeAfterCredentialSwapLogout();
        await resolveAndReportEgressIp({ logAs: "rotate-ip", instanceId });
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
        await resolveAndReportEgressIp({ logAs: "rotate-ip", instanceId });
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
  let otpNotReceivedRetries = 0;

  while (true) {
    try {
      await performVfsLoginFromStore(instanceId);
      return;
    } catch (err) {
      // Chrome is already past login (valid session) — nothing left to retry.
      if (err instanceof VfsAlreadyLoggedInError) {
        reporter.setPhase("login", "already logged in — skipping login");
        return;
      }
      if (err instanceof PageNotFoundRestartError) {
        throw err;
      }
      if (err instanceof IndDeuAccountRecreateError) {
        await recreateIndDeuAccountAndRelogin(instanceId, err.code);
        return;
      }
      if (err instanceof VfsForbiddenError) {
        const recreate = extractIndDeu4030xxFromUnknown(err);
        if (recreate && isIndDeuRoute(config.slotPayload.countryCode, config.slotPayload.missionCode)) {
          await recreateIndDeuAccountAndRelogin(instanceId, recreate);
          return;
        }
        forbiddenAttempts++;
        reporter.setPhase("recovering", `403 block — rotating IP + relogin (attempt ${forbiddenAttempts})`);
        await telegram.alert("error", `Bot ${instanceId ?? "?"} got 403 during login (attempt ${forbiddenAttempts}/${MAX_FORBIDDEN_RETRIES}). Restarting browser + rotating IP...`).catch(() => { });
        clearApplicantIpCache();
        await relaunchChromeAfterCredentialSwapLogout();
        await resolveAndReportEgressIp({ logAs: "rotate-ip", instanceId });
        if (forbiddenAttempts >= MAX_FORBIDDEN_RETRIES) {
          throw new Error(`Login still 403 after ${MAX_FORBIDDEN_RETRIES} browser restarts — giving up.`);
        }
        await browser.openLoginInFirstTab();
        continue;
      }

      if (err instanceof VfsGatewayTimeoutError) {
        await telegram.alert(
          "error",
          `Bot ${instanceId ?? "?"} got 504 Gateway Timeout during login. Restarting browser + rotating IP...`
        ).catch(() => { });
        clearApplicantIpCache();
        await relaunchChromeAfterCredentialSwapLogout();
        await resolveAndReportEgressIp({ logAs: "rotate-ip", instanceId });
        await browser.openLoginInFirstTab();
        continue;
      }

      if (err instanceof VfsRateLimitedError) {
        if (err.isAccountBlock) {
          await stopForAccountRateLimit(instanceId, "login", err.code);
          throw new Error(`Login account rate-limit ${err.code} — stopping.`);
        }
        const escalate = softIpRotateAwaitingSecond429;
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
        await resolveAndReportEgressIp({ logAs: "rotate-ip", instanceId });
        await browser.openLoginInFirstTab();
        continue;
      }

      if (isOtpNotReceivedError(err)) {
        if (otpNotReceivedRetries < 1) {
          otpNotReceivedRetries++;
          reporter.setPhase("login", "OTP not received — refreshing login page");
          await browser.logoutVfsAndOpenLoginFirstTab().catch(() => browser.openLoginInFirstTab());
          continue;
        }
      }

      if (isOtpRelatedLoginFailure(err)) {
        otpAttempts++;
        const reason = err instanceof Error ? err.message : String(err);
        // This branch retries forever — keep the Monitor phase moving so a card
        // can never freeze on the stale captcha/turnstile status of attempt 1.
        reporter.setPhase("recovering", `login retry ${otpAttempts} — rotating IP + relogin`);
        await telegram.alert(
          "error",
          `Bot ${instanceId ?? "?"} OTP/login failed (attempt ${otpAttempts}): ${reason}\nRestarting browser + rotating IP...`
        ).catch(() => { });
        clearApplicantIpCache();
        await relaunchChromeAfterCredentialSwapLogout();
        await resolveAndReportEgressIp({ logAs: "rotate-ip", instanceId });
        await browser.openLoginInFirstTab();
        continue;
      }

      throw err;
    }
  }
}

function patchApologiesIntervalSec(sec: number): { ok: boolean; error?: string } {
  if (!Number.isFinite(sec) || sec < 1) {
    return { ok: false, error: "Apologies interval must be at least 1 second." };
  }
  const global0 = getApplicantDetailsOverrides(0) ?? {};
  global0.apologiesIntervalSec = Math.floor(sec);
  delete global0.applicantsIntervalSec;
  setApplicantDetailsOverrides(global0, 0);
  return { ok: true };
}

function readApologiesIntervalSecControl(): number {
  return resolveApologiesIntervalSec(getApplicantDetailsOverrides(0));
}

function isApologies1036SlotState(cache?: SlotFoundState | null): boolean {
  if (cache?.apologies1036 === true) return true;
  if (cache?.slot?.id?.startsWith("svc-unavailable-1036_")) return true;
  const live = isSlotFoundByAnyInstance();
  if (live.apologies1036 === true) return true;
  if (live.slot?.id?.startsWith("svc-unavailable-1036_")) return true;
  return false;
}

/**
 * Wait until this bot's round-robin applicants slot (1036 only), or until a peer
 * unlocks URN (immediate wake), or abort. Real slot hits skip round-robin wait.
 */
async function waitForApplicantsStaggerGate(opts: {
  instanceId?: number;
  attemptIndex: number;
  abortSeq: number;
  useApologiesInterval: boolean;
}): Promise<"ready" | "urn_unlocked" | "abort"> {
  if (isApplicantsUrnUnlocked()) return "urn_unlocked";
  if (!opts.useApologiesInterval) return "ready";

  const id =
    typeof opts.instanceId === "number" && Number.isFinite(opts.instanceId) && opts.instanceId >= 1
      ? Math.floor(opts.instanceId)
      : 1;
  const workers = getFleetWorkerIds();
  const rank = workers.indexOf(id);
  const stepMs = getApologiesIntervalMs();
  const targetAt = applicantsAttemptTargetMs(
    rank >= 0 ? rank + 1 : id,
    opts.attemptIndex,
    stepMs,
    workers.length
  );
  const remainingMs = Math.max(0, targetAt - Date.now());

  if (remainingMs <= 0) return "ready";

  reporter.setBookingStep(
    isApplicantsUrnUnlocked()
      ? "applicants · peer URN"
      : `applicants · turn in ${Math.round(remainingMs / 1000)}s`
  );

  const unlockWatcher = createApplicantsUrnUnlockWatcher();
  try {
    const woke = await Promise.race([
      new Promise<"ready">((r) => setTimeout(() => r("ready"), remainingMs)),
      unlockWatcher.wait().then(() => "urn_unlocked" as const),
      waitForPollingAbort(opts.abortSeq).then(() => "abort" as const),
    ]);
    return woke;
  } finally {
    unlockWatcher.dispose();
  }
}

/**
 * Try save-applicants with fleet round-robin on poll 1036 (apologiesIntervalSec from setup form):
 * bot 1, then bot 2 after interval, … Real slot hits go to applicants immediately.
 * During apologies round-robin, when any bot gets a URN, peers wake and call
 * save-applicants immediately (no join stagger).
 *
 * - **10673**: up to `pollReloginInterval` staggered tries, then hard relogin + slot poll, forever.
 * - **Other errors**: up to MAX_SAVE_APPLICANTS_RETRIES (8), then hard relogin + poll.
 */
/**
 * Result of the save-applicants stage: either a URN is cached now, or a recovery path
 * already ran the rest of the booking chain and produced its final answer.
 */
type SaveApplicantsOutcome = { kind: "urn" } | { kind: "chain_done"; result: boolean };

async function runSaveApplicantsUntilUrn(opts: {
  instanceId?: number;
  slotStateCache?: SlotFoundState;
  chainAbortSeq: number;
  useApologiesInterval: boolean;
}): Promise<SaveApplicantsOutcome> {
  const { instanceId, slotStateCache, chainAbortSeq, useApologiesInterval } = opts;
  const phase1Attempts = Math.max(1, config.pollReloginInterval);
  const done = (result: boolean): SaveApplicantsOutcome => ({ kind: "chain_done", result });

  let nonRecoverableAttempts = 0;
  let attemptIndex = 0; // round-robin slot index for this bot
  let consecutive10673 = 0;

  applicants10673Recovery: while (true) {
    if (pollingAbortSeq !== chainAbortSeq) {
      await throwIfAbortedForPageNotFound(chainAbortSeq, "booking-save-abort");
      return done(false);
    }

    const gate = await waitForApplicantsStaggerGate({
      instanceId,
      attemptIndex,
      abortSeq: chainAbortSeq,
      useApologiesInterval,
    });
    if (gate === "abort" || pollingAbortSeq !== chainAbortSeq) {
      await throwIfAbortedForPageNotFound(chainAbortSeq, "booking-applicants-gate-abort");
      return done(false);
    }
    // urn_unlocked: peer got a URN — call applicants immediately (no join stagger).

    try {
      reporter.setBookingStep("applicants");
      await browser.saveApplicantsViaLiftApi();

      const urnAfterSave = getApplicationUrn();
      if (!urnAfterSave?.trim()) {
        throw new Error("Save applicants did not set URN");
      }

      markApplicantsUrnUnlocked(
        typeof instanceId === "number" && instanceId >= 1 ? Math.floor(instanceId) : 1
      );
      registerFleetUrn(
        typeof instanceId === "number" && instanceId >= 1 ? Math.floor(instanceId) : 1
      );
      return { kind: "urn" };
    } catch (err) {
      attemptIndex += 1;

      if (err instanceof AlreadyBookedError) {
        await retireInstanceForAlreadyBooked(instanceId, err.message);
      }
      if (err instanceof VfsRateLimitedError) {
        if (err.isAccountBlock) {
          await stopForAccountRateLimit(instanceId, "save-applicants", err.code);
          return done(false);
        }
        return done(
          await recoverBookingChainFromIpRateLimit(instanceId, "429-ip-save-applicants", err, slotStateCache)
        );
      }
      if (err instanceof IndDeuAccountRecreateError) {
        return done(await recoverBookingChainFromAccountRecreate(instanceId, err, slotStateCache));
      }
      if (err instanceof VfsUnauthorizedError) {
        return done(
          await recoverBookingChainFromGatewayTimeout(
            instanceId,
            "401-unauthorized-save-applicants",
            err,
            slotStateCache
          )
        );
      }
      if (err instanceof VfsGatewayTimeoutError) {
        continue applicants10673Recovery;
      }
      if (isFailedToFetchError(err)) {
        return done(
          await recoverBookingChainFromFetchFailure(
            instanceId,
            "failed-to-fetch-save-applicants",
            err,
            slotStateCache
          )
        );
      }
      if (isSaveApplicants401(err)) {
        return done(
          await recoverBookingChainFromGatewayTimeout(
            instanceId,
            "401-unauthorized-save-applicants",
            err,
            slotStateCache
          )
        );
      }
      if (err instanceof VfsForbiddenError) {
        return done(
          await recoverBookingChainFromGatewayTimeout(
            instanceId,
            "cloudflare-or-forbidden-save-applicants",
            err,
            slotStateCache
          )
        );
      }
      if (isSaveApplicants10673(err)) {
        consecutive10673 += 1;
        if (consecutive10673 >= phase1Attempts) {
          consecutive10673 = 0;
          if (isAreLvaCurrent()) {
            continue applicants10673Recovery;
          }
          await performHardRelogin(instanceId, "save-applicants-10673");
          await runSlotPollUnlessAreLva(instanceId, pollLoopReloginOpts(instanceId));
          // New wave after re-hit so fleet re-syncs applicants stagger.
          const again = isSlotFoundByAnyInstance();
          resetApplicantsWave(again.timestamp ?? Date.now());
          attemptIndex = 0;
          continue applicants10673Recovery;
        }
      } else {
        consecutive10673 = 0;
        nonRecoverableAttempts += 1;

        if (nonRecoverableAttempts >= MAX_SAVE_APPLICANTS_RETRIES) {
          nonRecoverableAttempts = 0;
          if (isAreLvaCurrent()) {
            continue applicants10673Recovery;
          }
          if (!(await recoverFromSaveApplicantsFailure(instanceId, "save-applicants-max-retries", err))) {
            return done(false);
          }
          const again = isSlotFoundByAnyInstance();
          resetApplicantsWave(again.timestamp ?? Date.now());
          attemptIndex = 0;
          continue applicants10673Recovery;
        }
      }
    }
  }
}

async function runBookingChainWithRetry(instanceId?: number, slotStateCache?: SlotFoundState): Promise<boolean> {
  const chainAbortSeq = pollingAbortSeq;

  // If a newer force-book arrived before this chain even started, exit immediately.
  if (pollingAbortSeq !== chainAbortSeq) {
    await throwIfAbortedForPageNotFound(chainAbortSeq, "booking-chain-abort");
    return false;
  }

  if (isAreLvaCurrent()) applyAreLvaFormCenter(instanceId);

  const waveSeed =
    (slotStateCache?.timestamp && slotStateCache.timestamp > 0
      ? slotStateCache.timestamp
      : isSlotFoundByAnyInstance().timestamp) ?? Date.now();
  ensureApplicantsWave(waveSeed);

  const useApologiesInterval = isAreLvaCurrent() ? false : isApologies1036SlotState(slotStateCache);

  // Real slot hits: every bot goes to save-applicants immediately (no join stagger).
  // Poll 1036: apologies round-robin below spaces applicants instead.
  // are-lva: no slot poll — all bots call applicants at once after post-login delay.

  for (; ;) {
    const saved = await runSaveApplicantsUntilUrn({
      instanceId,
      slotStateCache,
      chainAbortSeq,
      useApologiesInterval,
    });
    if (saved.kind === "chain_done") return saved.result;

    try {
      const fleetId =
        typeof instanceId === "number" && Number.isFinite(instanceId) && instanceId >= 1
          ? Math.floor(instanceId)
          : 1;
      const bookingOpts = {
        browser,
        instanceId: fleetId,
        abortSeq: chainAbortSeq,
        isAbort: (seq: number) => pollingAbortSeq !== seq,
        waitForAbort: waitForPollingAbort,
        ...(isAreLvaCurrent() ? pollLoopReloginOpts(instanceId, "calendar-poll-interval") : {}),
      };
      return isAreLvaCurrent()
        ? await runAreLvaBooking(bookingOpts)
        : await runFleetCalendarBooking(bookingOpts);
    } catch (err) {
      if (err instanceof MissingUrnError) {
        // Relogin / account swap / calendar-poll interval cleared the URN — applicants then calendar again.
        reporter.setBookingStep(
          /calendar.?poll/i.test(err.message) ? "applicants" : "applicants · urn lost"
        );
        continue;
      }
      if (err instanceof AlreadyBookedError) {
        await retireInstanceForAlreadyBooked(instanceId, err.message);
      }
      if (err instanceof VfsRateLimitedError) {
        if (err.isAccountBlock) {
          await stopForAccountRateLimit(instanceId, "booking-chain", err.code);
          return false;
        }
        return recoverBookingChainFromIpRateLimit(instanceId, "429-ip-booking", err, slotStateCache);
      }
      if (err instanceof IndDeuAccountRecreateError) {
        return recoverBookingChainFromAccountRecreate(instanceId, err, slotStateCache);
      }
      if (err instanceof VfsUnauthorizedError) {
        return recoverBookingChainFromGatewayTimeout(
          instanceId,
          "401-unauthorized-booking",
          err,
          slotStateCache
        );
      }
      if (isFailedToFetchError(err)) {
        return recoverBookingChainFromFetchFailure(
          instanceId,
          "failed-to-fetch-booking",
          err,
          slotStateCache
        );
      }
      if (err instanceof VfsForbiddenError) {
        return recoverBookingChainFromGatewayTimeout(
          instanceId,
          "cloudflare-or-forbidden-booking",
          err,
          slotStateCache
        );
      }
      throw err;
    }
  }
}

type SubmitMeta = { firstSubmit: boolean; instanceId?: number; pollStartAt?: number | null; skipPollGate?: boolean };

async function runOneBotCycle(meta: SubmitMeta): Promise<void> {
  let m = meta;
  for (let attempt = 1; ; attempt++) {
    try {
      await runOneBotCycleCore(m);
      return;
    } catch (err) {
      if (err instanceof PageNotFoundRestartError) {
        pageNotFoundRestartRequested = false;
        await rotateIpForPageNotFound(m.instanceId, err.message);
        m = { ...m, firstSubmit: false, skipPollGate: true };
        if (attempt >= PAGE_NOT_FOUND_BACKOFF_AFTER) {
          reporter.setPhase("recovering", `page-not-found ×${attempt} — backing off`);
          await sleepMsAsync(PAGE_NOT_FOUND_BACKOFF_MS);
        }
        continue;
      }
      throw err;
    }
  }
}

async function performVfsLoginFromStore(instanceId?: number): Promise<void> {
  const u = resolveLoginUsername(instanceId);
  const p = resolveLoginPassword(instanceId);
  if (!u || !p) {
    throw new Error(
      "VFS login missing: fill username/password on the setup form, or set VFS_USERNAME / VFS_PASSWORD in .env."
    );
  }
  await browser.loginOnFirstTab(u, p);
  advanceCredentialSlotAfterSuccessfulLogin(instanceId);
  // Fresh session — the relogin interval must count from zero again.
  resetPollRoundsOnSession();
}

/**
 * One full run after setup form Submit (or headless single run): CDP refresh → tab URL branch → poll → optional booking.
 *
 * **Cycle (this codebase):** a single invocation of this function for one cluster child (or one local run).
 * Cluster: parent sends `run-bot-cycle` after each Submit; on failure the child retries after 15s (`firstSubmit` is
 * only true on the first attempt). **Instance:** `instanceId` / `BOT_INSTANCE_ID` / `vfs-bot-profile-N` — each
 * instance uses its own `PROXY_URLS` slot and default sticky token `vfs-<instanceId>` (see `stableSessionToken`),
 * or in IP-list mode its own exclusively claimed IP from `proxies.txt` (see `proxyClaims.ts`).
 *
 * **Different public IP per instance:** Bright Data — use multiple `PROXY_URLS` lines and/or `{session}` /
 * `{instance}`; each instance hashes to a different base index. IP list — exclusive `host:port` claim.
 * Webshare — exclusive sticky session, then a second pass claims the *observed* public egress
 * (`egressIpClaims.ts`) and rotates until no other live bot holds that IP.
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

  if (isIndDeuRoute(config.slotPayload.countryCode, config.slotPayload.missionCode)) {
    await ensureIndDeuAccountIfNeeded(instanceId);
  }

  let firstUrl = await browser.getFirstTabUrl();
  reporter.setPage(firstUrl);
  await checkUrlForPageNotFound(firstUrl, "after-chrome-launch");

  let kind = classifyVfsFirstTabUrl(firstUrl);

  if (kind === "page_not_found") {
    throw new PageNotFoundRestartError(`startup tab: ${firstUrl}`);
  }

  if (kind === "blank") {
    await openLoginWithForbiddenRecovery(instanceId);
    firstUrl = await browser.getFirstTabUrl();
    kind = classifyVfsFirstTabUrl(firstUrl);
  }

  // Detect block pages on any URL — WAF JSON, "Access Restricted", "Session Expired", or "User ID Restricted".
  // The URL may look normal (/login, /dashboard) but the body is a block/error page.
  if (kind === "login" || kind === "dashboard" || kind === "vfs_other") {
    const blockKind = await browser.detectPageBlockKind();
    if (blockKind === "account_recreate") {
      await recreateIndDeuAccountAndRelogin(instanceId, "4030xx");
      firstUrl = await browser.getFirstTabUrl();
      kind = classifyVfsFirstTabUrl(firstUrl);
    } else if (blockKind === "account_429") {
      await stopForAccountRateLimit(instanceId, "startup-page-block", "4290xx");
      return;
    }
    if (blockKind === "ip_429") {
      await handleIpRateLimitRecovery(instanceId, "startup-page-block", "4292xx");
      firstUrl = await browser.getFirstTabUrl();
      kind = classifyVfsFirstTabUrl(firstUrl);
    } else if (blockKind === "forbidden") {
      await telegram.alert("error", `Bot ${instanceId ?? "?"} blocked page detected — hard relogin`).catch(() => { });
      await performHardRelogin(instanceId, "startup-page-block");
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
      // Last-resort guard: a login stage can fail on a form/captcha that vanished
      // only because VFS already let us in. A dashboard tab means the session is
      // live — continue to polling instead of stopping a perfectly good bot.
      const urlAfterLoginErr = await browser.getFirstTabUrl().catch(() => "");
      if (isVfsDashboardUrl(urlAfterLoginErr)) {
        firstUrl = urlAfterLoginErr;
        reporter.setPage(firstUrl);
        reporter.setAttention(null);
        reporter.setPhase("login", "already logged in — skipping login");
        kind = classifyVfsFirstTabUrl(firstUrl);
        didLoginThisCycle = true;
      } else {
        const reason = loginErr instanceof Error ? loginErr.message : String(loginErr);
        instanceStopped = true;
        reporter.setError(reason);
        reporter.setAttention("login_failed", "login failed — handle in Chrome");
        reporter.setPhase("stopped", "login failed");
        await telegram
          .alert("error", `Bot ${instanceId ?? "?"} login failed — stopped.\nReason: ${reason}`)
          .catch(() => { });
        return;
      }
    }
  } else if (kind === "dashboard") {
  } else if (kind === "vfs_other") {
  }

  /** Retry or confirm IP after navigation/login (cached if early resolve already succeeded). */
  await resolveAndReportEgressIp(
    didLoginThisCycle ? { logAs: "login", instanceId } : undefined
  );

  const skipDashboardNavigate = !meta.firstSubmit || kind === "vfs_other";

  if (config.loginOnly) {
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
    return;
  }

  // --- Coordinated poll-start gate (first submit only, cluster mode) ---
  // Wait until the shared fleet pollStartAt. After that, bots claim the next
  // poll slot every userPollInterval (gap-filling when peers are absent).
  // are-lva: skip this wall-clock sync so each bot calls applicants after its
  // own post-login delay (staggered starts stay staggered).
  if (
    !isAreLvaCurrent() &&
    meta.firstSubmit &&
    !meta.skipPollGate &&
    isClusterChild &&
    instanceId != null &&
    typeof meta.pollStartAt === "number"
  ) {
    ensureFleetPollEarliest(meta.pollStartAt);
    const remainingMs = Math.max(0, meta.pollStartAt - Date.now());

    reporter.setPhase(
      "polling",
      remainingMs > 0 ? `ready — fleet polls in ${Math.round(remainingMs / 1000)}s` : "starting poll"
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
          return;
        }

        if (woke === "slot" && (await checkPeerFoundSlotAndJoinBooking(instanceId, pollGateSlotWatcher.cachedState()))) {
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
    if (isAreLvaCurrent()) {
      applyAreLvaFormCenter(instanceId);
      reporter.setPhase("polling", "are-lva — applicants (no slot poll)");
      slotFoundDuringPoll = true;
    } else {
      // All instances poll actively after login.
      reporter.setPhase("polling", "polling for slots");
      await telegram.notify("VFS bot run: polling for slots.").catch(() => { });

      slotFoundDuringPoll = await runPollLoop(instanceId, {
        pollStartAt: typeof meta.pollStartAt === "number" ? meta.pollStartAt : undefined,
        ...pollLoopReloginOpts(instanceId),
      });
    }
  }

  if (slotFoundDuringPoll) {
    // Every instance must land one slot. Only an account/ID block or an already-booked
    // account ends this loop — every other failure goes back to polling and tries again.
    while (!instanceStopped) {
      // Snapshot slot state before booking starts so sibling failures that delete
      // slot-state.json do not break this instance's calendar / timeslot lookup.
      const slotStateSnapshot = isSlotFoundByAnyInstance();
      instanceBookingActive = true;
      reporter.setBookingStep("applicants");
      try {
        const bookingCompleted = await runBookingChainWithRetry(instanceId, slotStateSnapshot);
        instanceBookingActive = false;
        if (bookingCompleted) {
          // Booking chain completed (schedule API called) — payment page is now open.
          await enterPaymentPageMode(instanceId);
          return; // Leave Chrome on the payment page; do not fall through to cycle end.
        }
        // Aborted / superseded / recovery gave up — poll again rather than end the cycle.
        await repollAfterBookingSetback(instanceId, "booking-chain-incomplete");
      } catch (err) {
        instanceBookingActive = false;
        if (err instanceof AlreadyBookedError) {
          await retireInstanceForAlreadyBooked(instanceId, err.message);
        }
        if (isSaveApplicantsFailure(err)) {
          if (!(await recoverFromSaveApplicantsFailure(instanceId, "save-applicants-failure", err))) {
            await sleepMsAsync(BOOKING_SETBACK_RETRY_MS);
          }
          continue;
        }

        await telegram
          .alert("error", `Booking error (instance ${instanceId ?? 1}), restarting poll: ${err instanceof Error ? err.message : String(err)}`)
          .catch(() => { });
        await repollAfterBookingSetback(instanceId, "booking-error");
      }
    }
  }
}

function syncInstanceStoresFromDisk(): void {
  reloadSessionCredentialsFromDisk();
  reloadApplicantDetailsFromDisk();
}

async function start(): Promise<void> {
  // In cluster mode, instances don't start their own server
  const isClusterMode = process.env.BOT_CLUSTER_MODE === "true";
  if (!isClusterMode) {
    beginIndDeuProcessSession();
  }

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

        if (msg?.type === "force-book") {
          if (instanceStopped) {
            return;
          }
          if (instanceOnPaymentPage) {
            return;
          }
          // Abort any in-progress polling so the new poll cycle can start.
          instanceBookingActive = false;
          clearSlotState();
          clearSlotCenterOverride();
          clearSlotDate();
          requestPollingAbort("force-book-poll", myInstanceId);
          ipcChain = ipcChain.then(async () => {
            try {
              await browser.preparePollingAfterLogin({ skipDashboardNavigate: true });

              const slotFound = await runSlotPollUnlessAreLva(myInstanceId, pollLoopReloginOpts(myInstanceId));

              if (slotFound) {
                const slotStateSnapshot = isSlotFoundByAnyInstance();
                instanceBookingActive = true;
                try {
                  const bookingCompleted = await runBookingChainWithRetry(myInstanceId, slotStateSnapshot);
                  instanceBookingActive = false;
                  if (bookingCompleted) {
                    await enterPaymentPageMode(myInstanceId);
                  } else {
                  }
                } catch (err) {
                  instanceBookingActive = false;
                  await telegram.alert("error", `Bot ${myInstanceId} force-book booking failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => { });
                  clearSlotCenterOverride();
                  clearSlotDate();
                }
              } else {
              }
            } catch (err) {
              await telegram.alert("error", `Bot ${myInstanceId} force-book poll error: ${err instanceof Error ? err.message : String(err)}`).catch(() => { });
            }
          });
          telegram.alert("info", `Bot ${myInstanceId} — starting polling...`).catch(() => { });
          return;
        }

        if (msg?.type === "global-settings-updated") {
          syncInstanceStoresFromDisk();
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
          return;
        }

        if (msg?.type === "resume-polling") {
          const resumeAt = typeof msg.resumeAt === "number" ? msg.resumeAt : Date.now();
          const pollIntervalMs = typeof msg.pollIntervalMs === "number" ? msg.pollIntervalMs : 60_000;
          applyResumePollingGate(myInstanceId, resumeAt, pollIntervalMs);
          return;
        }

        if (msg?.type === "proxy-provider") {
          const id = parseProxyProviderId(msg.provider);
          if (id) void applyProxyProviderSwitch(id);
          return;
        }

        ipcChain = ipcChain.then(async () => {
          if (msg?.type === "run-bot-cycle") {
            syncInstanceStoresFromDisk();
            try {
              await runOneBotCycle({ firstSubmit: true, instanceId: myInstanceId, pollStartAt: msg.pollStartAt });
              // `settled` tells the parent whether this instance is finished for good; anything
              // else means the cycle fell through without a booking and must be restarted.
              process.send?.({
                type: "bot-cycle-complete",
                instanceId: myInstanceId,
                settled: instanceOnPaymentPage || instanceStopped,
              });
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              await telegram
                .alert("error", `Bot ${myInstanceId} cycle failed.\nReason: ${reason}`)
                .catch(() => { });
              process.send?.({
                type: "bot-cycle-complete",
                instanceId: myInstanceId,
                settled: instanceOnPaymentPage || instanceStopped,
                reason,
              });
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
    setApologiesIntervalSec: patchApologiesIntervalSec,
    setPollIntervalSec: (sec) => {
      if (!Number.isFinite(sec) || sec < 1) {
        return { ok: false, error: "Poll interval must be at least 1 second." };
      }
      const global0 = getApplicantDetailsOverrides(0) ?? {};
      global0.userPollInterval = Math.floor(sec);
      setApplicantDetailsOverrides(global0, 0);
      return { ok: true };
    },
    setApplicantsJoinStaggerSec: (sec) => {
      if (!Number.isFinite(sec) || sec < 0.1) {
        return { ok: false, error: "Applicants join stagger must be at least 0.1 seconds." };
      }
      const global0 = getApplicantDetailsOverrides(0) ?? {};
      global0.applicantsJoinStaggerSec = sec;
      setApplicantDetailsOverrides(global0, 0);
      return { ok: true };
    },
    setCalendarPollingIntervalSec: (sec) => {
      if (!Number.isFinite(sec) || sec < 1) {
        return { ok: false, error: "Calendar polling interval must be at least 1 second." };
      }
      const global0 = getApplicantDetailsOverrides(0) ?? {};
      global0.calendarPollingInterval = Math.floor(sec);
      setApplicantDetailsOverrides(global0, 0);
      return { ok: true };
    },
    setApiDelaySec: (sec) => {
      if (!Number.isFinite(sec) || sec < 0) {
        return { ok: false, error: "API delay must be at least 0 seconds." };
      }
      const global0 = getApplicantDetailsOverrides(0) ?? {};
      global0.apiDelaySec = sec;
      setApplicantDetailsOverrides(global0, 0);
      return { ok: true };
    },
    setRepeatedDelaySec: (sec) => {
      if (!Number.isFinite(sec) || sec < 1) {
        return { ok: false, error: "409 delay must be at least 1 second." };
      }
      const global0 = getApplicantDetailsOverrides(0) ?? {};
      global0.repeatedDelaySec = Math.floor(sec);
      setApplicantDetailsOverrides(global0, 0);
      return { ok: true };
    },
    setProxyProvider: (provider) => {
      const id = parseProxyProviderId(provider);
      if (!id) return { ok: false, error: PROXY_PROVIDER_PARSE_ERROR };
      return commitProxyProvider(id);
    },
    reloadGlobalSettings: () => {
      syncInstanceStoresFromDisk();
      return { ok: true };
    },
    getControl: () => {
      const globalDet = getApplicantDetailsOverrides(0);
      const sec = getFleetPollIntervalSec();
      return {
        intervalMs: 0,
        rolloutActive: false,
        total: 1,
        pollingPaused: singlePollingPaused,
        pollIntervalMs: Math.max(1000, sec * 1000),
        apologiesIntervalSec: readApologiesIntervalSecControl(),
        pollIntervalSec: sec,
        applicantsJoinStaggerSec: resolveApplicantsJoinStaggerSec(globalDet),
        calendarPollingIntervalSec: globalDet && typeof globalDet.calendarPollingInterval === "number" && globalDet.calendarPollingInterval >= 1
          ? Math.floor(globalDet.calendarPollingInterval) : 60,
        apiDelaySec: resolveApiDelaySec(globalDet),
        repeatedDelaySec: resolveRepeatedDelaySec(globalDet),
        proxyProvider: getActiveProxyProvider(),
        proxyListReady: isProxyListConfigured().ok,
        webshareReady: isWebshareConfigured().ok,
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
      enqueueSubmitTask(async () => {
        try {
          await browser.preparePollingAfterLogin({ skipDashboardNavigate: true });

          const slotFound = await runSlotPollUnlessAreLva(undefined, pollLoopReloginOpts(undefined));

          if (slotFound) {
            const slotStateSnapshot = isSlotFoundByAnyInstance();
            instanceBookingActive = true;
            try {
              const bookingCompleted = await runBookingChainWithRetry(undefined, slotStateSnapshot);
              instanceBookingActive = false;
              if (bookingCompleted) {
                await enterPaymentPageMode(undefined);
              } else {
              }
            } catch (err) {
              instanceBookingActive = false;
              await telegram.alert("error", `Force-book failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => { });
              clearSlotCenterOverride();
              clearSlotDate();
            }
          } else {
          }
        } catch (err) {
          await telegram.alert("error", `Force-book poll error: ${err instanceof Error ? err.message : String(err)}`).catch(() => { });
        }
      });
      return { ok: true, queued: 1 };
    },
  });
}

let isShuttingDown = false;

function shutdown(): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  const debugPort = getRemoteDebuggingPort();

  // Hand this bot's IP / Webshare session back to the pool (into its cooldown)
  // instead of waiting for the heartbeat to go stale.
  const shuttingDownProvider = getActiveProxyProvider();
  if (shuttingDownProvider === "iplist" || shuttingDownProvider === "webshare") {
    try {
      releaseProxyClaim(numericBotInstanceId());
    } catch {
      /* best effort */
    }
  }
  try {
    releaseEgressClaim(numericBotInstanceId());
  } catch {
    /* best effort */
  }

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
  process.exit(1);
});

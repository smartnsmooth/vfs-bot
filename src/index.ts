import dotenv from "dotenv";
// Don't override env vars set by parent process (cluster mode)
dotenv.config({ override: false });
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import path from "node:path";
import { config, setCurrentInstanceId } from "./config/config";
import { classifyVfsFirstTabUrl } from "./flows/vfsTabUrl";
import { logger } from "./utils/logger";
import { PollingService } from "./services/polling.service";
import { BrowserService } from "./services/browser.service";
import { TelegramService } from "./services/telegram.service";
import {
  isApplicantFormUiDisabled,
  runApplicantFormWithSubmitHandler,
} from "./ui/applicantDetailsFormServer";
import { getSessionLoginCredentials, reloadSessionCredentialsFromDisk } from "./utils/sessionLogin.store";
import { reloadApplicantDetailsFromDisk } from "./utils/applicantDetails.store";
import {
  createSlotFoundWatcher,
  isSlotFoundByAnyInstance,
  markSlotFound,
  clearSlotState,
  type SlotFoundState,
} from "./utils/slotState";
import { setSlotCenterOverride, clearSlotCenterOverride } from "./utils/slotCenterOverride.store";
import { setSlotDate, clearSlotDate } from "./utils/slotDate.store";
import {
  getScheduleAllowedDates,
  isPollingSlotInAllowedSet,
  NoDatesInScheduleRangeError,
} from "./utils/scheduleAllowedDates.js";

const polling = new PollingService();
const browser = new BrowserService();
const telegram = new TelegramService();

const POLL_INTERVAL_MS = config.pollingIntervalMs;
const POST_LOGIN_POLL_DELAY_MS = 20_000;
const FAST_SKIP_CALENDAR_UP_TO_INSTANCE = Math.max(
  0,
  parseInt(process.env.FAST_SKIP_CALENDAR_UP_TO_INSTANCE ?? "5", 10) || 5
);
const FIXED_POLL_INTERVAL_MS = Math.max(
  1000,
  parseInt(process.env.FIXED_POLL_INTERVAL_MS ?? "60000", 10) || 60_000
);
type ProxyChainModule = {
  anonymizeProxy(proxyUrl: string): Promise<string>;
  closeAnonymizedProxy(url: string, closeConnections?: boolean): Promise<void>;
};
let proxyChainModule: ProxyChainModule | null = null;
let activeAnonymizedProxyUrl: string | null = null;

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

function resolveLoginUsername(instanceId?: number): string {
  const fromUi = getSessionLoginCredentials(instanceId)?.username?.trim();
  if (fromUi) return fromUi;
  return (config.vfsUsername || process.env.VFS_USERNAME || "").trim();
}

function resolveLoginPassword(instanceId?: number): string {
  const fromUi = getSessionLoginCredentials(instanceId)?.password;
  if (fromUi != null && fromUi !== "") return fromUi;
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

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

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
  const idx = hashString(instanceId) % list.length;
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

async function ensureChromeWithDevTools(): Promise<void> {
  const userDataDir = resolveChromeUserDataDir();
  const instanceId = getBotInstanceId(userDataDir);
  const selectedProxy = resolveProxyForInstance(instanceId);

  // If Chrome DevTools is already reachable on the target port, skip spawning entirely.
  // On Windows, Chrome is a single-instance app per profile: re-launching it when it is
  // already running opens a NEW TAB in the existing window rather than reusing the first tab.
  for (const url of getChromeDevToolsCheckUrls()) {
    if (await checkDevToolsEndpoint(url)) {
      logger.info({ url, instanceId }, "[Chrome] DevTools already running — reusing existing Chrome");
      return;
    }
  }

  const chromePath = resolveChromeExecutablePath();
  const resolvedProxy = await resolveLaunchProxyServer(selectedProxy);
  const debugPort = getRemoteDebuggingPort();

  const chromeArgs = [
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  const profileDirectory = process.env.CHROME_PROFILE_DIRECTORY?.trim();
  if (profileDirectory) {
    chromeArgs.push(`--profile-directory=${profileDirectory}`);
  }
  if (resolvedProxy.launchProxy) {
    chromeArgs.push(`--proxy-server=${resolvedProxy.launchProxy}`);
  }
  chromeArgs.push(config.loginPageUrl);

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
        return;
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Chrome DevTools did not become ready. Start Chrome manually with --remote-debugging-port=9222");
}

/**
 * If another instance wrote `slot-state.json`, adopt their center/category and treat polling as a hit.
 * Must run after each slot check (and between centers): peers can mark the file while this instance is in-flight.
 */
async function checkPeerFoundSlotAndJoinBooking(instanceId?: number): Promise<boolean> {
  // Never interrupt this instance if it is already booking or has reached the payment page.
  if (instanceBookingActive || instanceOnPaymentPage) {
    return false;
  }
  const sharedState = isSlotFoundByAnyInstance();
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
        logger.info({ instanceId }, "[poll] Aborting poll loop (config updated)");
        return false;
      }

      // Instant wake: if any other instance already marked slot found, stop immediately.
      if (await checkPeerFoundSlotAndJoinBooking(instanceId)) {
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

        let foundInThisPoll = false;

        // Check each center sequentially
        for (const center of centers) {
          if (await checkPeerFoundSlotAndJoinBooking(instanceId)) {
            return true;
          }

          logger.info(
            { instanceId, centerNumber: center.centerNumber, vacCode: center.vacCode, visaCategoryCode: center.visaCategoryCode },
            `Checking Center ${center.centerNumber}`
          );

          const { slot, response, centerNumber, centerCode, visaCategoryCode } = await polling.checkSlotsInBrowser(browser, {
            centerCode: center.vacCode,
            visaCategoryCode: center.visaCategoryCode,
            centerNumber: center.centerNumber,
          });

          console.log(`[Poll Center ${center.centerNumber}]`, JSON.stringify(response, null, 2));

          if (slot) {
            slotFound = true;
            foundInThisPoll = true;

            // Mark slot as found for ALL instances with this instance's center/category
            markSlotFound(instanceId ?? 0, centerCode!, visaCategoryCode!, slot);

            // Set override for this instance too (in case it's used later)
            setSlotCenterOverride(centerCode!, visaCategoryCode!);

            await telegram.alert("slot_found", `Slot (Center ${centerNumber}): ${slot.center || "—"} ${slot.date} ${slot.time}`, { slotId: slot.id, centerNumber }).catch(() => { });
            logger.info(
              { instanceId, centerNumber, centerCode, visaCategoryCode, slot },
              `Slot found by this instance in Center ${centerNumber} — broadcasting center/category to all instances`
            );
            break; // Stop checking other centers once a slot is found
          }

          if (await checkPeerFoundSlotAndJoinBooking(instanceId)) {
            return true;
          }
        }

        if (foundInThisPoll) {
          break; // Exit poll loop if slot found
        } else {
          await telegram.alert("no_slot_found", `No slot found in ${centers.map((c) => c.vacCode).join("+")}`, { instanceId }).catch(() => { });
          logger.info({ instanceId }, `No slot found in ${centers.map((c) => c.vacCode).join("+")}`);
        }
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
          logger.error({ err, instanceId }, "[Relogin] Re-login failed — continuing poll without session refresh");
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

      if (woke === "slot" && (await checkPeerFoundSlotAndJoinBooking(instanceId))) {
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

const MAX_SAVE_APPLICANTS_RETRIES = 3;

function isSaveApplicants422(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Save applicants API error:") && err.message.includes("422");
}

function getFixedTimingForInstance(instanceId?: number): { postLoginOffsetMs: number; pollIntervalMs: number } {
  const id = typeof instanceId === "number" && Number.isFinite(instanceId) && instanceId >= 1 ? Math.floor(instanceId) : 1;
  const numInstancesRaw = parseInt(process.env.VFS_BOT_INSTANCES ?? "1", 10);
  const numInstances = Number.isFinite(numInstancesRaw) && numInstancesRaw > 0 ? numInstancesRaw : 1;

  // Spread instance start times evenly across one poll interval:
  // stepMs = pollInterval / numInstances
  // offsetMs(instance i) = (i-1) * stepMs
  const stepMsUnclamped = Math.floor(FIXED_POLL_INTERVAL_MS / numInstances);
  const stepMs = Math.max(250, Math.min(FIXED_POLL_INTERVAL_MS, stepMsUnclamped));

  return {
    postLoginOffsetMs: (id - 1) * stepMs,
    pollIntervalMs: FIXED_POLL_INTERVAL_MS,
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
 * Try save-applicants; on 422 "Invalid request", retry by re-polling then re-calling save.
 * This mimics the manual re-submit flow (which consistently succeeds).
 */
async function runBookingChainWithRetry(instanceId?: number, slotStateCache?: SlotFoundState): Promise<void> {
  for (let attempt = 1; attempt <= MAX_SAVE_APPLICANTS_RETRIES; attempt++) {
    try {
      await browser.saveApplicantsViaLiftApi();
      break;
    } catch (err) {
      if (!isSaveApplicants422(err) || attempt === MAX_SAVE_APPLICANTS_RETRIES) throw err;
      logger.warn(
        { attempt, maxRetries: MAX_SAVE_APPLICANTS_RETRIES, instanceId },
        "Save applicants returned 422 — retrying after fresh CDP + poll (mimics manual re-submit)"
      );
      await browser.disconnectCdp();
      await browser.getFirstTabUrl();
      await browser.preparePollingAfterLogin({ skipDashboardNavigate: true });
      const stillAvailable = await runPollLoop(instanceId);
      if (!stillAvailable) {
        logger.warn({ instanceId }, "Slot no longer available on retry poll — aborting booking chain");
        return;
      }
    }
  }
  const fastSkipCalendar = (instanceId ?? 1) <= FAST_SKIP_CALENDAR_UP_TO_INSTANCE;
  const allowed = getScheduleAllowedDates();
  const calendarOpts =
    allowed && allowed.size > 0 ? { allowedDates: allowed } : undefined;
  // Use the live slot state; fall back to the snapshot taken when booking started in case
  // a failing sibling instance deleted slot-state.json while this booking is in progress.
  const liveState = isSlotFoundByAnyInstance();
  const shared = liveState.found ? liveState : (slotStateCache ?? liveState);
  const pollingHitAllowed =
    allowed && allowed.size > 0 ? isPollingSlotInAllowedSet(shared.slot, allowed) : false;

  let usedCalendarForTimeslot = false;

  if (!allowed || allowed.size === 0) {
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
          allowedDates: [...allowed],
        },
        "Fast mode (date on allow-list): skipping calendar API and using polling date for timeslot"
      );
    } else {
      logger.warn(
        { instanceId, raw: shared.slot?.rawDate, date: shared.slot?.date, allowedDates: [...allowed] },
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
    await browser.postTimeslotLiftApi();
  } catch (err) {
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

  await browser.postFeesLiftApi();
  await browser.postScheduleLiftApi();
}

type SubmitMeta = { firstSubmit: boolean; instanceId?: number };

/**
 * One full run after setup form Submit (or headless single run): CDP refresh → tab URL branch → poll → optional booking.
 */
async function runOneBotCycle(meta: SubmitMeta): Promise<void> {
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

  // Clear shared slot state at the start of a new cycle
  if (meta.firstSubmit) {
    clearSlotState();
    clearSlotCenterOverride();
  }

  // 1) Drop old Playwright CDP attachment; 2) ensure Chrome + DevTools; 3) reconnect
  await browser.disconnectCdp();
  await ensureChromeWithDevTools();

  if (config.turnstileDemoMode) {
    await browser.openUrlInFirstTab(config.turnstileDemoUrl);
    await browser.solveTurnstileOnFirstTabDemoPage();
    logger.info("[Demo] Done (TURNSTILE_DEMO_MODE=true).");
    return;
  }

  let firstUrl = await browser.getFirstTabUrl();

  let kind = classifyVfsFirstTabUrl(firstUrl);

  if (kind === "blank") {
    await browser.openLoginInFirstTab();
    console.log("[Chrome] Opened login page (was blank)");
    firstUrl = await browser.getFirstTabUrl();
    kind = classifyVfsFirstTabUrl(firstUrl);
  }

  // Resolve credentials once here so the relogin callback (below) can reuse them.
  const loginUsername = resolveLoginUsername(instanceId);
  const loginPassword = resolveLoginPassword(instanceId);

  let didLoginThisCycle = false;
  if (kind === "login") {
    if (!loginUsername || !loginPassword) {
      throw new Error(
        "VFS login missing: fill username/password on the setup form, or set VFS_USERNAME / VFS_PASSWORD in .env (or disable UI with VFS_APPLICANT_UI=false)."
      );
    }
    await browser.loginOnFirstTab(loginUsername, loginPassword);
    firstUrl = await browser.getFirstTabUrl();
    kind = classifyVfsFirstTabUrl(firstUrl);
    didLoginThisCycle = true;
  } else if (kind === "dashboard") {
    logger.info({ instanceId }, "On dashboard — skipping automated login");
  } else if (kind === "vfs_other") {
    logger.info({ url: firstUrl, instanceId }, "On post-login VFS page — skipping automated login; polling from here");
  }

  /** After login: resolve IP via in-page fetch (same egress as Chrome / proxy extension) for save-applicants. */
  await browser.resolveApplicantIpForPayload();

  const skipDashboardNavigate = !meta.firstSubmit || kind === "vfs_other";

  if (config.loginOnly) {
    logger.info({ instanceId }, "[LoginOnly] VFS_LOGIN_ONLY=true — stopping after login, no polling or booking");
    return;
  }

  let slotFoundDuringPoll = false;
  if (config.pollingEnabled) {
    if (didLoginThisCycle) {
      // Dashboard: no auto "Start new booking" / center / category (handle in browser yourself).
      await new Promise((r) => setTimeout(r, POST_LOGIN_POLL_DELAY_MS));
      const fixedTiming = getFixedTimingForInstance(instanceId);
      logger.info(
        { instanceId, delayMs: fixedTiming.postLoginOffsetMs, mode: "fixed_by_instance" },
        "Post-login fixed delay before polling (after base delay)"
      );
      await new Promise((r) => setTimeout(r, fixedTiming.postLoginOffsetMs));
    }
    await telegram.notify("VFS bot run: polling for slots.").catch(() => { });
    logger.info({ skipDashboardNavigate, instanceId }, "Starting slot polling");
    await browser.preparePollingAfterLogin({ skipDashboardNavigate });

    // Build the periodic relogin callback when the interval is enabled.
    const pollReloginInterval = config.pollReloginInterval;
    const onPollRelogin = pollReloginInterval > 0
      ? async () => {
        logger.info({ instanceId, pollReloginInterval }, "[Relogin] Navigating to login page for fresh VFS session...");
        await browser.openLoginInFirstTab();
        await browser.loginOnFirstTab(loginUsername, loginPassword);
        await browser.preparePollingAfterLogin({ skipDashboardNavigate: true });
      }
      : undefined;

    slotFoundDuringPoll = await runPollLoop(instanceId, {
      reloginAfter: pollReloginInterval > 0 ? pollReloginInterval : undefined,
      onRelogin: onPollRelogin,
    });
  }

  const runBookingChain = !config.pollingEnabled || slotFoundDuringPoll;

  if (runBookingChain) {
    let pollHits = slotFoundDuringPoll;
    while (true) {
      // Snapshot slot state before booking starts so sibling failures that delete
      // slot-state.json do not break this instance's calendar / timeslot lookup.
      const slotStateSnapshot = isSlotFoundByAnyInstance();
      instanceBookingActive = true;
      logger.info({ instanceId }, "[Booking] Started — this instance will not be interrupted by new slot finds");
      try {
        await runBookingChainWithRetry(instanceId, slotStateSnapshot);
        // Booking chain completed (schedule API called) — payment page is now open.
        instanceBookingActive = false;
        instanceOnPaymentPage = true;
        logger.info({ instanceId }, "[Booking] Complete — Chrome is on the payment page and will stay there permanently");
        return; // Leave Chrome on the payment page; do not fall through to cycle end.
      } catch (err) {
        instanceBookingActive = false; // Release booking lock so new slot finds can reach this instance again.
        const noDates =
          err instanceof NoDatesInScheduleRangeError ||
          (err instanceof Error && (err as Error & { code?: string }).code === "NO_DATES_IN_RANGE");
        if (noDates) {
          logger.warn(
            { instanceId },
            "No calendar dates match allowed schedule dates — clearing slot state and restarting polling"
          );
        } else {
          // Any other booking error: log, notify, clear state, restart polling instead of stopping.
          logger.error({ err, instanceId }, "Booking chain error — clearing slot state and restarting poll");
          await telegram
            .alert("error", `Booking error (instance ${instanceId ?? 1}), restarting poll: ${err instanceof Error ? err.message : String(err)}`)
            .catch(() => { });
        }
        clearSlotState();
        clearSlotCenterOverride();
        clearSlotDate();
        if (!config.pollingEnabled) {
          throw err;
        }
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

    // Listen for IPC messages from parent process
    if (process.send) {
      let ipcChain: Promise<void> = Promise.resolve();
      process.on("message", (msg: any) => {
        ipcChain = ipcChain.then(async () => {
          if (msg?.instanceId !== myInstanceId) return;

          if (msg?.type === "config-updated") {
            syncInstanceStoresFromDisk();
            requestPollingAbort("config-updated", myInstanceId);
            return;
          }

          if (msg?.type === "run-bot-cycle") {
            syncInstanceStoresFromDisk();
            let cycleAttempt = 0;
            while (true) {
              cycleAttempt++;
              try {
                await runOneBotCycle({ firstSubmit: cycleAttempt === 1, instanceId: myInstanceId });
                process.send?.({ type: "bot-cycle-complete", instanceId: myInstanceId });
                break;
              } catch (err) {
                logger.error({ err, instanceId: myInstanceId, cycleAttempt }, "Bot cycle failed — restarting after 15s");
                await telegram
                  .alert("error", `Cycle error (instance ${myInstanceId}), restarting: ${err instanceof Error ? err.message : String(err)}`)
                  .catch(() => { });
                await new Promise((r) => setTimeout(r, 15_000));
                syncInstanceStoresFromDisk();
              }
            }
          }
        });
      });
    }

    // Keep process alive, don't launch Chrome until submit
    return;
  }

  await ensureChromeWithDevTools();

  if (isApplicantFormUiDisabled()) {
    logger.info("Applicant UI disabled — single bot cycle from current Chrome tab");
    await runOneBotCycle({ firstSubmit: true });
    return;
  }

  await runApplicantFormWithSubmitHandler((info) => {
    const instanceId = typeof info.instanceId === "number" ? info.instanceId : undefined;
    enqueueSubmitTask(() => runOneBotCycle({ firstSubmit: info.firstSubmit, instanceId }));
  });
}

function shutdown(): void {
  logger.info("Shutting down");
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
      await browser.close();
    })
    .finally(() => {
      process.exit(0);
    });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((err) => {
  logger.fatal({ err }, "Start failed");
  process.exit(1);
});

import dotenv from "dotenv";
dotenv.config({ override: true });
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import path from "node:path";
import { config } from "./config/config";
import { classifyVfsFirstTabUrl } from "./flows/vfsTabUrl";
import { logger } from "./utils/logger";
import { PollingService } from "./services/polling.service";
import { BrowserService } from "./services/browser.service";
import { TelegramService } from "./services/telegram.service";
import {
  isApplicantFormUiDisabled,
  runApplicantFormWithSubmitHandler,
} from "./ui/applicantDetailsFormServer";
import { getSessionLoginCredentials } from "./utils/sessionLogin.store";

const polling = new PollingService();
const browser = new BrowserService();
const telegram = new TelegramService();

const POLL_INTERVAL_MS = config.pollingIntervalMs;
const POST_LOGIN_POLL_DELAY_MS = 30_000;
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

function resolveLoginUsername(): string {
  const fromUi = getSessionLoginCredentials()?.username?.trim();
  if (fromUi) return fromUi;
  return (config.vfsUsername || process.env.VFS_USERNAME || "").trim();
}

function resolveLoginPassword(): string {
  const fromUi = getSessionLoginCredentials()?.password;
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

  for (const url of getChromeDevToolsCheckUrls()) {
    if (await checkDevToolsEndpoint(url)) {
      if (selectedProxy) {
        throw new Error(
          "Chrome DevTools is already running. Proxy is enabled, so a fresh Chrome launch is required to apply proxy settings. Close all Chrome windows, then start the bot again."
        );
      }
      console.log(`[Chrome] DevTools already at ${url}`);
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
  logger.info(
    {
      debugPort,
      instanceId,
      proxyEnabled: Boolean(resolvedProxy.launchProxy),
      proxyPreview: resolvedProxy.launchProxy ? resolvedProxy.launchProxy.slice(0, 120) : null,
      proxyHasAuth: resolvedProxy.proxyHasAuth,
      viaLocalProxyTunnel: resolvedProxy.viaLocalTunnel,
    },
    "Launched Chrome with remote debugging"
  );
  if (selectedProxy && !resolvedProxy.launchProxy) {
    logger.warn({ selectedProxy }, "Proxy parse failed; starting without proxy. Use format: http://user:pass@host:port");
  }

  const delayMs = 400;
  const maxWaitMs = 60_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    for (const url of getChromeDevToolsCheckUrls()) {
      if (await checkDevToolsEndpoint(url)) {
        console.log(`[Chrome] DevTools ready at ${url}`);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Chrome DevTools did not become ready. Start Chrome manually with --remote-debugging-port=9222");
}

/** `true` if at least one slot was seen (polling stops after the first hit). */
async function runPollLoop(): Promise<boolean> {
  const limit = config.pollLimit;
  let completed = 0;
  let slotFound = false;
  while (limit === 0 || completed < limit) {
    try {
      const { slot, response } = await polling.checkSlotsInBrowser(browser);
      console.log("[Poll]", JSON.stringify(response, null, 2));

      if (slot) {
        slotFound = true;
        await telegram.alert("slot_found", `Slot: ${slot.center || "—"} ${slot.date} ${slot.time}`, { slotId: slot.id }).catch(() => { });
        logger.info("Slot found — stopping poll loop; running booking chain next");
        break;
      }
    } catch (err) {
      logger.error({ err }, "Poll error");
      await telegram.alert("error", err instanceof Error ? err.message : "Poll error").catch(() => { });
    }
    completed += 1;
    if (limit > 0 && completed >= limit) {
      logger.info({ completed, limit }, "Polling finished (POLL_LIMIT reached)");
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return slotFound;
}

const MAX_SAVE_APPLICANTS_RETRIES = 3;

function isSaveApplicants422(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Save applicants API error:") && err.message.includes("422");
}

/**
 * Try save-applicants; on 422 "Invalid request", retry by re-polling then re-calling save.
 * This mimics the manual re-submit flow (which consistently succeeds).
 */
async function runBookingChainWithRetry(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_SAVE_APPLICANTS_RETRIES; attempt++) {
    try {
      await browser.saveApplicantsViaLiftApi();
      break;
    } catch (err) {
      if (!isSaveApplicants422(err) || attempt === MAX_SAVE_APPLICANTS_RETRIES) throw err;
      logger.warn(
        { attempt, maxRetries: MAX_SAVE_APPLICANTS_RETRIES },
        "Save applicants returned 422 — retrying after fresh CDP + poll (mimics manual re-submit)"
      );
      await browser.disconnectCdp();
      await browser.getFirstTabUrl();
      await browser.preparePollingAfterLogin({ skipDashboardNavigate: true });
      const stillAvailable = await runPollLoop();
      if (!stillAvailable) {
        logger.warn("Slot no longer available on retry poll — aborting booking chain");
        return;
      }
    }
  }
  await browser.postCalendarLiftApi();
  await browser.postTimeslotLiftApi();
  await browser.postFeesLiftApi();
  await browser.postScheduleLiftApi();
}

type SubmitMeta = { firstSubmit: boolean };

/**
 * One full run after setup form Submit (or headless single run): CDP refresh → tab URL branch → poll → optional booking.
 */
async function runOneBotCycle(meta: SubmitMeta): Promise<void> {
  // 1) Drop old Playwright CDP attachment; 2) ensure Chrome + DevTools; 3) reconnect
  await browser.disconnectCdp();
  await ensureChromeWithDevTools();

  let firstUrl = await browser.getFirstTabUrl();
  console.log("[Chrome] First tab:", firstUrl || "(blank)");

  let kind = classifyVfsFirstTabUrl(firstUrl);

  if (kind === "blank") {
    await browser.openLoginInFirstTab();
    console.log("[Chrome] Opened login page (was blank)");
    firstUrl = await browser.getFirstTabUrl();
    kind = classifyVfsFirstTabUrl(firstUrl);
  }

  let didLoginThisCycle = false;
  if (kind === "login") {
    const username = resolveLoginUsername();
    const password = resolveLoginPassword();
    if (!username || !password) {
      throw new Error(
        "VFS login missing: fill username/password on the setup form, or set VFS_USERNAME / VFS_PASSWORD in .env (or disable UI with VFS_APPLICANT_UI=false)."
      );
    }
    await browser.loginOnFirstTab(username, password);
    firstUrl = await browser.getFirstTabUrl();
    kind = classifyVfsFirstTabUrl(firstUrl);
    didLoginThisCycle = true;
    logger.info({ kind, url: firstUrl }, "After automated login");
  } else if (kind === "dashboard") {
    logger.info("On dashboard — skipping automated login");
  } else if (kind === "vfs_other") {
    logger.info({ url: firstUrl }, "On post-login VFS page — skipping automated login; polling from here");
  }

  /** After login: resolve IP via in-page fetch (same egress as Chrome / proxy extension) for save-applicants. */
  await browser.resolveApplicantIpForPayload();

  const skipDashboardNavigate = !meta.firstSubmit || kind === "vfs_other";

  let slotFoundDuringPoll = false;
  if (config.pollingEnabled) {
    if (didLoginThisCycle) {
      logger.info(
        { delayMs: POST_LOGIN_POLL_DELAY_MS },
        "Post-login delay before polling"
      );
      await new Promise((r) => setTimeout(r, POST_LOGIN_POLL_DELAY_MS));
    }
    await telegram.notify("VFS bot run: polling for slots.").catch(() => { });
    logger.info({ skipDashboardNavigate }, "Starting slot polling");
    await browser.preparePollingAfterLogin({ skipDashboardNavigate });
    slotFoundDuringPoll = await runPollLoop();
  }

  const runBookingChain = !config.pollingEnabled || slotFoundDuringPoll;

  if (runBookingChain) {
    await runBookingChainWithRetry();
  } else {
    logger.info("No slot found this run — skipping save applicants, fees, calendar, timeslot, schedule");
  }
}

async function start(): Promise<void> {
  await ensureChromeWithDevTools();

  if (isApplicantFormUiDisabled()) {
    logger.info("Applicant UI disabled — single bot cycle from current Chrome tab");
    await runOneBotCycle({ firstSubmit: true });
    return;
  }

  await runApplicantFormWithSubmitHandler((info) => {
    enqueueSubmitTask(() => runOneBotCycle({ firstSubmit: info.firstSubmit }));
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

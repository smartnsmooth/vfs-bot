import dotenv from "dotenv";
// Don't override env vars set by parent process (cluster mode)
dotenv.config({ override: false });
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
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
  runApplicantFormWithSubmitHandler,
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
import {
  getScheduleAllowedDates,
  isPollingSlotInAllowedSet,
  NoDatesInScheduleRangeError,
} from "./utils/scheduleAllowedDates.js";
import { clearApplicantIpCache } from "./utils/applicantIp";
import { clearChromeSessionDataBeforeLaunch, resolveChromeProfileFolderName } from "./utils/chromeProfileSessionClean";

const polling = new PollingService();
const browser = new BrowserService();
const telegram = new TelegramService();

const POST_LOGIN_POLL_DELAY_MS = 30_000;
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
 * Remove saved window placement from Chrome's Preferences file so Chrome
 * doesn't restore an off-screen or wrong-sized window from a previous run.
 * Must be called before Chrome starts (profile not locked).
 */
function clearChromeWindowPlacement(userDataDir: string): void {
  try {
    const profile = resolveChromeProfileFolderName();
    const prefsPath = path.join(userDataDir, profile, "Preferences");
    if (!existsSync(prefsPath)) return;
    const raw = readFileSync(prefsPath, "utf-8");
    const prefs = JSON.parse(raw);
    let changed = false;
    if (prefs.browser?.window_placement) {
      delete prefs.browser.window_placement;
      changed = true;
    }
    if (changed) {
      writeFileSync(prefsPath, JSON.stringify(prefs), "utf-8");
    }
  } catch {
    // Non-critical — Chrome will just use its default placement
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

async function ensureChromeWithDevTools(): Promise<void> {
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

  await clearChromeSessionDataBeforeLaunch(userDataDir);

  const selectedProxy = resolveProxyForInstance(instanceId);
  bumpProxyRotationForProfile(instanceId);
  if (selectedProxy) {
    logger.info(
      {
        instanceId,
        proxyRotationStep: proxyRotationOffsetByProfileId.get(instanceId) ?? 0,
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

  clearChromeWindowPlacement(userDataDir);

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
    # SW_RESTORE=9 restores from minimized/maximized/hidden; then move+resize
    [Win32Move.WM]::ShowWindow($h, 9) | Out-Null
    [Win32Move.WM]::SetForegroundWindow($h) | Out-Null
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

        // Round-robin: check one center per poll round, alternating each iteration.
        const center = centers[completed % centers.length]!;

        if (await checkPeerFoundSlotAndJoinBooking(instanceId)) {
          return true;
        }

        const currentUrl = await browser.getFirstTabUrl();
        if (!/\/(applications|dashboard|home)/i.test(currentUrl)) {
          logger.error({ instanceId, currentUrl }, "Browser is not on the dashboard page. Stopping polling.");
          await telegram.alert("error", `Not on dashboard page (${currentUrl || "unknown"}). Polling stopped.`).catch(() => { });
          return false;
        }

        logger.info(
          { instanceId, centerNumber: center.centerNumber, vacCode: center.vacCode, visaCategoryCode: center.visaCategoryCode, poll: completed + 1 },
          `Checking Center ${center.centerNumber}`
        );

        const { slot, response, centerNumber, centerCode, visaCategoryCode, unauthorized, rateLimited } = await polling.checkSlotsInBrowser(browser, {
          centerCode: center.vacCode,
          visaCategoryCode: center.visaCategoryCode,
          centerNumber: center.centerNumber,
        });

        console.log(`[Poll Center ${center.centerNumber}]`, JSON.stringify(response, null, 2));

        if (unauthorized) {
          logger.error({ instanceId }, "401 Unauthorized — session expired or invalid. Stopping polling. Please re-login on the VFS tab.");
          await telegram.alert("error", "401 Unauthorized — session expired. Polling stopped. Please re-login.").catch(() => { });
          return false;
        }

        if (rateLimited) {
          logger.error({ instanceId }, "429 Too Many Requests — rate limited by VFS API. Stopping polling.");
          await telegram.alert("error", "429 Too Many Requests — rate limited. Polling stopped.").catch(() => { });
          return false;
        }

        if (slot) {
          slotFound = true;

          markSlotFound(instanceId ?? 0, centerCode!, visaCategoryCode!, slot);
          setSlotCenterOverride(centerCode!, visaCategoryCode!);

          await telegram.alert("slot_found", `Slot (Center ${centerNumber}): ${slot.center || "—"} ${slot.date} ${slot.time}`, { slotId: slot.id, centerNumber }).catch(() => { });
          logger.info(
            { instanceId, centerNumber, centerCode, visaCategoryCode, slot },
            `Slot found by this instance in Center ${centerNumber} — broadcasting center/category to all instances`
          );
          break;
        }

        if (await checkPeerFoundSlotAndJoinBooking(instanceId)) {
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

/** Final save-applicants failure — do not restart polling after this. */
function isSaveApplicantsFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes("Save applicants API error:") ||
    m.includes("Save applicants failed HTTP") ||
    m.includes("Save applicants failed after retry HTTP") ||
    m.startsWith("Save applicants: response is not JSON")
  );
}

function getFixedTimingForInstance(instanceId?: number): { postLoginOffsetMs: number; pollIntervalMs: number } {
  const id = typeof instanceId === "number" && Number.isFinite(instanceId) && instanceId >= 1 ? Math.floor(instanceId) : 1;

  // Read userPollInterval (seconds) from global store (instance 0), fall back to env/default.
  const globalDet = getApplicantDetailsOverrides(0);
  const userPollIntervalSec =
    globalDet && typeof globalDet.userPollInterval === "number" && globalDet.userPollInterval >= 1
      ? globalDet.userPollInterval
      : DEFAULT_POLL_INTERVAL_SEC;

  const numInstancesRaw = parseInt(process.env.BOT_TOTAL_INSTANCES ?? "1", 10);
  const numInstances = Number.isFinite(numInstancesRaw) && numInstancesRaw > 0 ? numInstancesRaw : 1;

  const stepMs = Math.max(1000, userPollIntervalSec * 1000);

  // POLL_INTERVAL_SCALED: true (default) = userInterval * instanceCount + per-instance offset; false = userInterval only, no offset.
  const scaled = (process.env.POLL_INTERVAL_SCALED ?? "true").trim().toLowerCase();
  const isScaled = scaled !== "false" && scaled !== "0";
  const pollIntervalMs = isScaled ? stepMs * numInstances : stepMs;

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
        "Save applicants returned 422 — retrying after re-poll"
      );
      await browser.preparePollingAfterLogin({ skipDashboardNavigate: true });
      const stillAvailable = await runPollLoop(instanceId);
      if (!stillAvailable) {
        logger.warn({ instanceId }, "Slot no longer available on retry poll — aborting booking chain");
        return;
      }
    }
  }
  const fastSkipCalendar = (instanceId ?? 1) <= FAST_SKIP_CALENDAR_UP_TO_INSTANCE;
  const allowed = getScheduleAllowedDates(instanceId);
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

  const MAX_SCHEDULE_RETRIES_FROM_TIMESLOT = 3;
  for (let schedAttempt = 1; schedAttempt <= MAX_SCHEDULE_RETRIES_FROM_TIMESLOT; schedAttempt++) {
    try {
      await browser.postScheduleLiftApi();
      break;
    } catch (schedErr) {
      if (schedAttempt === MAX_SCHEDULE_RETRIES_FROM_TIMESLOT) throw schedErr;
      logger.warn(
        { err: schedErr, attempt: schedAttempt, maxRetries: MAX_SCHEDULE_RETRIES_FROM_TIMESLOT, instanceId },
        "Schedule failed — retrying from timeslot"
      );
      await telegram
        .alert("error", `Schedule failed (attempt ${schedAttempt}/${MAX_SCHEDULE_RETRIES_FROM_TIMESLOT}), retrying from timeslot`)
        .catch(() => {});
      await browser.postTimeslotLiftApi();
      await browser.postFeesLiftApi();
    }
  }
}

type SubmitMeta = { firstSubmit: boolean; instanceId?: number };

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

  if (
    /^true|1|yes$/i.test((process.env.VFS_CLEAR_APPLICANT_IP_CACHE_EACH_CYCLE ?? "").trim())
  ) {
    clearApplicantIpCache();
    logger.info(
      { instanceId },
      "Applicant IP cache cleared at cycle start (VFS_CLEAR_APPLICANT_IP_CACHE_EACH_CYCLE) — safe mainly when each cycle uses new Chrome or full relogin so VFS session matches the new reading"
    );
  }

  // Clear shared slot state at the start of a new cycle
  if (meta.firstSubmit) {
    clearSlotState();
    clearSlotCenterOverride();
  }

  // 1) Drop old Playwright CDP attachment; 2) ensure Chrome + DevTools; 3) reconnect
  await browser.disconnectCdp();
  await ensureChromeWithDevTools();

  // Log outbound IP as soon as CDP can attach (Chrome proxy egress). A later call reuses cache; if this fails
  // (no tab yet), the post-login resolve retries.
  await browser.resolveApplicantIpForPayload();

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

  let didLoginThisCycle = false;
  if (kind === "login") {
    await performVfsLoginFromStore(instanceId);
    firstUrl = await browser.getFirstTabUrl();
    kind = classifyVfsFirstTabUrl(firstUrl);
    didLoginThisCycle = true;
    await minimizeChromeWindow();
    logger.info({ instanceId }, "[Chrome] Minimized browser after login");
  } else if (kind === "dashboard") {
    logger.info({ instanceId }, "On dashboard — skipping automated login");
  } else if (kind === "vfs_other") {
    logger.info({ url: firstUrl, instanceId }, "On post-login VFS page — skipping automated login; polling from here");
  }

  /** Retry or confirm IP after navigation/login (cached if early resolve already succeeded). */
  await browser.resolveApplicantIpForPayload();

  const skipDashboardNavigate = !meta.firstSubmit || kind === "vfs_other";

  if (config.loginOnly) {
    logger.info({ instanceId }, "[LoginOnly] VFS_LOGIN_ONLY=true — stopping after login, no polling or booking");
    return;
  }

  const skipPolling = !!(getApplicantDetailsOverrides(0)?.skipPolling);

  let slotFoundDuringPoll = false;
  if (!skipPolling) {
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
        const hardSwap = config.credentialSwapBrowserRestart && hasSecondCredentials(instanceId);
        if (hardSwap) {
          logger.info(
            { instanceId, pollReloginInterval },
            "[Relogin] Two accounts: logout → close Chrome → rotate PROXY_URLS → new Chrome → login (next credential)"
          );
          await browser.logoutVfsAndOpenLoginFirstTab().catch(() => {
            /* tab may already be gone */
          });
          clearApplicantIpCache();
          await relaunchChromeAfterCredentialSwapLogout();
          await performVfsLoginFromStore(instanceId);
          await browser.resolveApplicantIpForPayload();
        } else {
          logger.info(
            { instanceId, pollReloginInterval },
            "[Relogin] Logout (best-effort) → login page → next credential (if two are configured) → fresh session"
          );
          await browser.logoutVfsAndOpenLoginFirstTab();
          await performVfsLoginFromStore(instanceId);
        }
        await browser.preparePollingAfterLogin({ skipDashboardNavigate: true });
      }
      : undefined;

    slotFoundDuringPoll = await runPollLoop(instanceId, {
      reloginAfter: pollReloginInterval > 0 ? pollReloginInterval : undefined,
      onRelogin: onPollRelogin,
    });
  }

  const runBookingChain = skipPolling || slotFoundDuringPoll;

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
        await restoreChromeWindow();
        logger.info({ instanceId }, "[Chrome] Restored browser for payment page");
        logger.info({ instanceId }, "[Booking] Complete — Chrome is on the payment page and will stay there permanently");
        return; // Leave Chrome on the payment page; do not fall through to cycle end.
      } catch (err) {
        instanceBookingActive = false; // Release booking lock so new slot finds can reach this instance again.
        if (isSaveApplicantsFailure(err)) {
          logger.error(
            { err, instanceId },
            "Save applicants failed — stopping polling (fix applicant payload / session and restart the bot)"
          );
          await telegram
            .alert(
              "error",
              `Save applicants failed (instance ${instanceId ?? 1}) — polling stopped: ${err instanceof Error ? err.message : String(err)}`
            )
            .catch(() => { });
          clearSlotState();
          clearSlotCenterOverride();
          clearSlotDate();
          break;
        }
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
        if (skipPolling) {
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
            try {
              await runOneBotCycle({ firstSubmit: true, instanceId: myInstanceId });
              process.send?.({ type: "bot-cycle-complete", instanceId: myInstanceId });
            } catch (err) {
              logger.error({ err, instanceId: myInstanceId }, "Bot cycle failed — stopped");
              await telegram
                .alert("error", `Bot ${myInstanceId} is stopped.`)
                .catch(() => { });
            }
          }
        });
      });
    }

    // Keep process alive, don't launch Chrome until submit
    return;
  }

  await ensureChromeWithDevTools();

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

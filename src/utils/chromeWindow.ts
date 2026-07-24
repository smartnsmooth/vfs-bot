/**
 * Chrome window control + DevTools discovery by remote-debugging port.
 *
 * Focus uses the same proven ShowWindow(SW_RESTORE)+SetForegroundWindow path as
 * moveWindow. Avoid SwitchToThisWindow / WinForms — those were minimizing or
 * closing Chrome on monitor-tile clicks.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { get as httpGet } from "node:http";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { logger } from "./logger";

// ── Resident PowerShell window helper ───────────────────────────────────────

const BOOTSTRAP = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class VfsWin {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int dwProcessId);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);

  public static IntPtr Find(HashSet<uint> pids) {
    IntPtr best = IntPtr.Zero;
    int bestArea = 0;
    EnumWindows((h, l) => {
      if (!IsWindow(h)) return true;
      if (GetWindowTextLength(h) == 0) return true;
      if (!IsWindowVisible(h) && !IsIconic(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid)) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      int w = r.Right - r.Left, ht = r.Bottom - r.Top;
      int area = Math.Max(0, w) * Math.Max(0, ht);
      if (w < 200 || ht < 200 || area < 40000) return true;
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  // Same idea as moveWindow: restore + foreground. No SwitchToThisWindow (that was minimizing).
  public static void Focus(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindow(h)) return;
    AllowSetForegroundWindow(-1);
    if (IsIconic(h)) ShowWindow(h, 9);   // SW_RESTORE only when minimized
    else ShowWindow(h, 5);               // SW_SHOW when already visible
    IntPtr fg = GetForegroundWindow();
    uint fgPid; uint fgTid = GetWindowThreadProcessId(fg, out fgPid);
    uint targetPid; uint targetTid = GetWindowThreadProcessId(h, out targetPid);
    uint my = GetCurrentThreadId();
    bool a1 = false, a2 = false;
    try {
      if (fg != h && fgTid != 0 && fgTid != my) a1 = AttachThreadInput(my, fgTid, true);
      if (targetTid != 0 && targetTid != my) a2 = AttachThreadInput(my, targetTid, true);
      BringWindowToTop(h);
      // HWND_TOP=0, SWP_NOSIZE|SWP_NOMOVE|SWP_SHOWWINDOW = 0x0043
      SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0043);
      SetForegroundWindow(h);
    } finally {
      if (a2) AttachThreadInput(my, targetTid, false);
      if (a1) AttachThreadInput(my, fgTid, false);
    }
    SetForegroundWindow(h);
  }
  public static void Minimize(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindow(h)) return;
    ShowWindow(h, 6);
  }
  static System.Threading.Timer _watch;
  public static void StartWatchdog(int parentPid) {
    _watch = new System.Threading.Timer((object s) => {
      try { System.Diagnostics.Process.GetProcessById(parentPid); }
      catch { Environment.Exit(0); }
    }, null, 2000, 2000);
  }
}
'@ -ErrorAction SilentlyContinue

$parentPid = 0
if ($args.Count -ge 1) { [int]::TryParse($args[0], [ref]$parentPid) | Out-Null }
if ($parentPid -gt 0) { [VfsWin]::StartWatchdog($parentPid) }

function Get-ChromeHwnd($port) {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object ProcessId,ParentProcessId,CommandLine)
  $roots = @($procs | Where-Object { $_.CommandLine -match ("--remote-debugging-port=" + $port + "\\b") } | Select-Object -ExpandProperty ProcessId)
  if ($roots.Count -eq 0) { return [IntPtr]::Zero }
  $set = New-Object 'System.Collections.Generic.HashSet[uint32]'
  foreach ($r in $roots) { [void]$set.Add([uint32]$r) }
  $go = $true
  while ($go) {
    $go = $false
    foreach ($p in $procs) {
      if ($set.Contains([uint32]$p.ParentProcessId) -and -not $set.Contains([uint32]$p.ProcessId)) {
        [void]$set.Add([uint32]$p.ProcessId); $go = $true
      }
    }
  }
  foreach ($procId in $set) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
      return $proc.MainWindowHandle
    }
  }
  return [VfsWin]::Find($set)
}

function Invoke-Win($mode, $port, $reqId) {
  try {
    $hwnd = Get-ChromeHwnd $port
    if ($hwnd -eq [IntPtr]::Zero) { [Console]::Out.WriteLine("RESULT $reqId FAIL"); [Console]::Out.Flush(); return }
    $m = ([string]$mode).Trim().ToLowerInvariant()
    if ($m -eq 'min' -or $m -eq 'minimize') {
      [VfsWin]::Minimize($hwnd)
    } elseif ($m -eq 'focus') {
      [VfsWin]::Focus($hwnd)
    } else {
      [Console]::Out.WriteLine("RESULT $reqId FAIL"); [Console]::Out.Flush(); return
    }
    [Console]::Out.WriteLine("RESULT $reqId OK"); [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine("RESULT $reqId FAIL"); [Console]::Out.Flush()
  }
}

[Console]::Out.WriteLine("READY"); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq 'QUIT') { break }
  if ($line.Length -eq 0) { continue }
  $parts = $line.Split(' ')
  if ($parts.Length -ge 3) { Invoke-Win $parts[0] $parts[1] $parts[2] }
}
`.trim();

let helper: ChildProcess | null = null;
let seq = 0;
let stdoutBuf = "";
const pending = new Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
let exitHookAdded = false;
let helperReadyResolve: (() => void) | null = null;
let helperReadyPromise: Promise<void> | null = null;

const HELPER_SCRIPT_NAME = "vfs-winhelper-v4.ps1";

function killStaleHelpers(): void {
  if (process.platform !== "win32") return;
  try {
    spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match 'vfs-winhelper' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ],
      { windowsHide: true, timeout: 5000, stdio: "ignore" }
    );
  } catch {
    /* ignore */
  }
}

function resetHelperReady(): void {
  helperReadyPromise = new Promise<void>((resolve) => {
    helperReadyResolve = resolve;
    setTimeout(() => {
      if (helperReadyResolve) {
        helperReadyResolve();
        helperReadyResolve = null;
      }
    }, 12_000);
  });
}

function failAllPending(): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve(false);
  }
  pending.clear();
}

function onHelperData(d: Buffer): void {
  stdoutBuf += d.toString();
  let i: number;
  while ((i = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, i).trim();
    stdoutBuf = stdoutBuf.slice(i + 1);
    if (line === "READY") {
      helperReadyResolve?.();
      helperReadyResolve = null;
      continue;
    }
    const m = line.match(/^RESULT (\S+) (OK|FAIL)$/);
    if (m) {
      const p = pending.get(m[1]);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(m[1]);
        p.resolve(m[2] === "OK");
      }
    }
  }
}

/** Spawn (or reuse) the resident helper. Returns false on non-Windows / failure. */
function ensureHelper(): boolean {
  if (process.platform !== "win32") return false;
  if (helper && !helper.killed && helper.stdin?.writable) return true;

  killStaleHelpers();

  const tmpDir = process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
  const scriptPath = path.join(tmpDir, HELPER_SCRIPT_NAME);
  try {
    writeFileSync(scriptPath, BOOTSTRAP, "utf-8");
  } catch (err) {
    logger.warn({ err }, "[Monitor] Could not write window-helper script");
    return false;
  }

  try {
    helper = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, String(process.pid)],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true }
    );
  } catch (err) {
    logger.warn({ err }, "[Monitor] Could not spawn window helper");
    helper = null;
    return false;
  }

  stdoutBuf = "";
  resetHelperReady();
  helper.stdout?.on("data", onHelperData);
  helper.on("exit", () => { helper = null; failAllPending(); });
  helper.on("error", (err) => { logger.warn({ err }, "[Monitor] window helper error"); helper = null; failAllPending(); });

  if (!exitHookAdded) {
    exitHookAdded = true;
    const cleanup = (): void => killHelper();
    process.on("exit", cleanup);
    process.on("SIGINT", () => { killHelper(); });
    process.on("SIGTERM", () => { killHelper(); });
  }
  return true;
}

function killHelper(): void {
  const h = helper;
  if (!h) return;
  helper = null;
  const pid = h.pid;
  try { h.stdin?.end(); } catch { /* ignore */ }
  try { h.kill(); } catch { /* ignore */ }
  if (process.platform === "win32" && pid) {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, timeout: 3000, stdio: "ignore" });
    } catch { /* ignore */ }
  }
}

export function warmupWindowHelper(): void {
  ensureHelper();
}

function sendCmd(mode: "focus" | "min", debugPort: number): Promise<boolean> {
  if (!ensureHelper() || !helper?.stdin?.writable) return Promise.resolve(false);
  const id = "R" + (++seq);
  const readyWait = helperReadyPromise ?? Promise.resolve();
  return readyWait.then(
    () =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(false);
        }, 8000);
        pending.set(id, { resolve, timer });
        try {
          helper!.stdin!.write(`${mode} ${debugPort} ${id}\n`);
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          resolve(false);
        }
      }),
    () => false
  );
}

function focusChromeByPortOneShot(debugPort: number): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  const scriptContent = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class VfsFocus {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  public static void Activate(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindow(h)) return;
    AllowSetForegroundWindow(-1);
    if (IsIconic(h)) ShowWindow(h, 9); else ShowWindow(h, 5);
    IntPtr fg = GetForegroundWindow();
    uint fgPid; uint fgTid = GetWindowThreadProcessId(fg, out fgPid);
    uint targetPid; uint targetTid = GetWindowThreadProcessId(h, out targetPid);
    uint my = GetCurrentThreadId();
    bool a1 = false, a2 = false;
    try {
      if (fg != h && fgTid != 0 && fgTid != my) a1 = AttachThreadInput(my, fgTid, true);
      if (targetTid != 0 && targetTid != my) a2 = AttachThreadInput(my, targetTid, true);
      BringWindowToTop(h);
      SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0043);
      SetForegroundWindow(h);
    } finally {
      if (a2) AttachThreadInput(my, targetTid, false);
      if (a1) AttachThreadInput(my, fgTid, false);
    }
    SetForegroundWindow(h);
  }
}
'@ -ErrorAction SilentlyContinue
$procs = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object ProcessId,ParentProcessId,CommandLine)
$roots = @($procs | Where-Object { $_.CommandLine -match ('--remote-debugging-port=' + ${debugPort} + '\\b') } | Select-Object -ExpandProperty ProcessId)
if ($roots.Count -eq 0) { Write-Output FAIL; exit 1 }
$set = New-Object 'System.Collections.Generic.HashSet[uint32]'
foreach ($r in $roots) { [void]$set.Add([uint32]$r) }
$go = $true
while ($go) {
  $go = $false
  foreach ($p in $procs) {
    if ($set.Contains([uint32]$p.ParentProcessId) -and -not $set.Contains([uint32]$p.ProcessId)) {
      [void]$set.Add([uint32]$p.ProcessId); $go = $true
    }
  }
}
$hwnd = [IntPtr]::Zero
foreach ($procId in $set) {
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) { $hwnd = $proc.MainWindowHandle; break }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output FAIL; exit 1 }
[VfsFocus]::Activate($hwnd)
Write-Output OK
`.trim();
  const tmpDir = process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
  const scriptPath = path.join(tmpDir, `vfs-focus-chrome-${debugPort}.ps1`);
  try {
    writeFileSync(scriptPath, scriptContent, "utf-8");
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const ps = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
    );
    let out = "";
    ps.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    const timer = setTimeout(() => { try { ps.kill(); } catch { /* ignore */ } finish(false); }, 10_000);
    ps.on("exit", () => { clearTimeout(timer); finish(/\bOK\b/.test(out)); });
    ps.on("error", () => { clearTimeout(timer); finish(false); });
    let done = false;
    function finish(ok: boolean) {
      if (done) return;
      done = true;
      try { unlinkSync(scriptPath); } catch { /* ignore */ }
      resolve(ok);
    }
  });
}

/** Activate (bring to front, like the taskbar) the instance's Chrome window. No resize.
 *  `shouldAbort` — polled before activation so a late captcha-focus cannot undo dashboard minimize.
 */
export async function focusChromeByPort(
  debugPort: number,
  opts?: { shouldAbort?: () => boolean }
): Promise<boolean> {
  if (opts?.shouldAbort?.()) return false;
  const viaHelper = await sendCmd("focus", debugPort);
  if (opts?.shouldAbort?.()) return false;
  if (viaHelper) return true;
  logger.info({ debugPort }, "[Monitor] Resident focus helper failed — trying one-shot taskbar focus");
  if (opts?.shouldAbort?.()) return false;
  return focusChromeByPortOneShot(debugPort);
}

export function minimizeChromeByPort(debugPort: number): Promise<boolean> {
  return sendCmd("min", debugPort);
}

// ── DevTools discovery (read-only) ──────────────────────────────────────────

interface DevtoolsTarget {
  type?: string;
  url?: string;
  title?: string;
  devtoolsFrontendUrl?: string;
  webSocketDebuggerUrl?: string;
}

function httpGetJson<T>(url: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("devtools request timed out"));
    });
  });
}

export async function getDevtoolsInfo(debugPort: number): Promise<{ ok: boolean; url?: string; error?: string }> {
  const base = `http://127.0.0.1:${debugPort}`;
  try {
    const targets = await httpGetJson<DevtoolsTarget[]>(`${base}/json`);
    const page =
      targets.find((t) => t.type === "page" && /vfsglobal\.com/i.test(t.url ?? "")) ??
      targets.find((t) => t.type === "page") ??
      targets[0];
    if (page?.devtoolsFrontendUrl) {
      const url = page.devtoolsFrontendUrl.startsWith("http")
        ? page.devtoolsFrontendUrl
        : `${base}${page.devtoolsFrontendUrl}`;
      return { ok: true, url };
    }
    return { ok: true, url: `${base}/json` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);

/**
 * Kill the Chrome process tree that was launched with
 * `--remote-debugging-port=<port>`. We identify it by its command line
 * (not by listening socket) because child Chrome processes do not listen on
 * the CDP port but do inherit the flag on their command line.
 *
 * Used on shutdown so that closing the terminal / Ctrl+C actually closes the
 * Chrome windows this bot instance launched (Chrome is spawned detached, so
 * Node exit alone does NOT close it).
 */

function buildKillCommand(port: number): { cmd: string; shell?: string } {
  if (process.platform === "win32") {
    // WMIC is available on Windows 10/11 consoles used in this project and is
    // synchronous-friendly. We match Chrome processes by their command line
    // containing the exact debugging-port marker.
    //
    // The `where` clause uses WMIC's own syntax; we escape the single quotes.
    const marker = `--remote-debugging-port=${port}`;
    // Build a PowerShell one-liner that is robust on modern Windows where
    // wmic may be deprecated. This kills the whole chrome.exe tree whose
    // command line contains the marker.
    const ps = [
      "$ErrorActionPreference='SilentlyContinue';",
      `$roots = @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match '--remote-debugging-port=${port}\\b' } | Select-Object -ExpandProperty ProcessId);`,
      "if ($roots.Count -eq 0) { exit 0 }",
      "$all = @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,ParentProcessId);",
      "$set = [System.Collections.Generic.HashSet[int]]::new();",
      "foreach ($r in $roots) { [void]$set.Add($r) }",
      "$go = $true;",
      "while ($go) { $go = $false; foreach ($p in $all) { if ($set.Contains($p.ParentProcessId) -and -not $set.Contains($p.ProcessId)) { [void]$set.Add($p.ProcessId); $go = $true } } }",
      "foreach ($procId in $set) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }",
    ].join(" ");
    const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`;
    return { cmd };
    void marker;
  }
  // POSIX: pgrep matches by command line
  const cmd = `pkill -9 -f -- "--remote-debugging-port=${port}\\b" || true`;
  return { cmd };
}

/** Synchronous kill — safe to call from `process.on('exit', ...)`. */
export function killChromeTreeByCdpPortSync(port: number): void {
  try {
    const { cmd } = buildKillCommand(port);
    execSync(cmd, { timeout: 8_000, stdio: "ignore", windowsHide: true });
  } catch {
    /* best effort */
  }
}

/** Async kill — use from signal handlers. */
export async function killChromeTreeByCdpPort(port: number): Promise<void> {
  try {
    const { cmd } = buildKillCommand(port);
    await execAsync(cmd, { timeout: 8_000, windowsHide: true });
  } catch {
    // Best effort — Chrome may already be gone (killed by another process/instance during shutdown race).
  }
}

/** Kill a contiguous range of CDP ports (used by cluster mode). */
export function killChromeTreeByCdpPortRangeSync(startPort: number, count: number): void {
  for (let i = 0; i < count; i++) {
    killChromeTreeByCdpPortSync(startPort + i);
  }
}

export async function killChromeTreeByCdpPortRange(startPort: number, count: number): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, (_, i) => killChromeTreeByCdpPort(startPort + i))
  );
}

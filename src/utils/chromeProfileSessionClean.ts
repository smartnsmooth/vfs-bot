import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { logger } from "./logger";

/** Chrome profile folder under `user-data-dir` (e.g. `Default`, `Profile 1`). */
export function resolveChromeProfileFolderName(): string {
  const p = process.env.CHROME_PROFILE_DIRECTORY?.trim();
  return p || "Default";
}

function clearSessionOnLaunchEnabled(): boolean {
  const v = (process.env.VFS_CLEAR_CHROME_SESSION_ON_LAUNCH ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no" && v !== "off";
}

/**
 * Paths under the profile dir to remove. Keeps `Preferences`, `Secure Preferences`, `Extensions`, etc.
 * so proxy extensions and profile settings survive; drops cookies, storage, caches, and session restore.
 */
const SESSION_RELATIVE_PATHS: readonly string[] = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "blob_storage",
  "Network",
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "Service Worker",
  "Session",
  "Current Session",
  "Last Session",
  "Current Tabs",
  "Last Tabs",
  "shared_proto_db",
  "VideoDecodeStats",
  "LOG",
  "LOG.old",
  "History",
  "History-journal",
  "Web Data",
  "Web Data-journal",
  "Login Data",
  "Login Data-journal",
  "Cookies",
  "Cookies-journal",
];

const USER_DATA_ROOT_LOCK_FILES: readonly string[] = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

function tryRemove(p: string): void {
  if (!existsSync(p)) return;
  try {
    rmSync(p, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ err, path: p }, "[Chrome] Could not remove path during session clean (in use?)");
  }
}

/**
 * Call only when Chrome for this `user-data-dir` is not running (e.g. before spawn in `ensureChromeWithDevTools`).
 * Disabled when `VFS_CLEAR_CHROME_SESSION_ON_LAUNCH=false` (except lock files are always cleared so Chrome can start).
 *
 * @param preserveAuthSession When true (4292XX IP rotate without relogin), only remove Singleton* locks;
 *   keep cookies / local+session storage so the VFS JWT can survive the Chrome respawn.
 */
export async function clearChromeSessionDataBeforeLaunch(
  userDataDir: string,
  opts?: { preserveAuthSession?: boolean }
): Promise<void> {
  const dir = userDataDir.trim();
  if (!dir) return;

  const profile = resolveChromeProfileFolderName();
  const profilePath = path.join(dir, profile);

  for (const name of USER_DATA_ROOT_LOCK_FILES) {
    tryRemove(path.join(dir, name));
  }

  if (opts?.preserveAuthSession) {
    logger.info(
      { userDataDir: dir, profile },
      "[Chrome] Preserving auth session (cookies/storage) — only cleared Singleton locks for IP rotate"
    );
    await new Promise((r) => setTimeout(r, 200));
    return;
  }

  if (!clearSessionOnLaunchEnabled()) return;

  if (!existsSync(profilePath)) {
    logger.debug({ profilePath }, "[Chrome] Profile dir missing — skip session clean");
    return;
  }

  for (const rel of SESSION_RELATIVE_PATHS) {
    tryRemove(path.join(profilePath, ...rel.split("/")));
  }

  logger.info({ userDataDir: dir, profile }, "[Chrome] Cleared cookies, storage, and caches before launch");

  await new Promise((r) => setTimeout(r, 200));
}

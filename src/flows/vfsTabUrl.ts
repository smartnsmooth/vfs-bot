export type VfsTabKind = "blank" | "login" | "dashboard" | "vfs_other" | "page_not_found";

/**
 * Classify first VFS tab URL for submit-driven flow:
 * - blank → open login
 * - login → run login automation
 * - dashboard → skip login
 * - vfs_other (application detail, your-details, etc.) → skip login, go to polling
 * - page_not_found → IP/session blocked; needs full browser restart + IP rotation
 */
export function classifyVfsFirstTabUrl(raw: string): VfsTabKind {
  const u = (raw || "").trim().toLowerCase();
  if (!u || u === "about:blank") return "blank";

  if (!u.includes("visa.vfsglobal.com")) return "blank";

  // VFS sometimes redirects to page-not-found or session-expired when the IP/session is blocked.
  if (u.includes("page-not-found") || u.includes("session-expired")) return "page_not_found";

  if (u.includes("/login")) return "login";

  if (u.includes("dashboard")) return "dashboard";

  if (
    u.includes("your-details") ||
    u.includes("application-detail") ||
    u.includes("application/details") ||
    u.includes("/detail") ||
    u.includes("appointment") ||
    u.includes("applicant")
  ) {
    return "vfs_other";
  }

  return "vfs_other";
}

/** Post-login VFS pages the bot treats as "login already succeeded". */
export const VFS_DASHBOARD_URL_RE = /\/(applications|dashboard|home)/i;

/** True when Chrome is already past login (dashboard / applications / home). */
export function isVfsDashboardUrl(raw: string): boolean {
  const u = (raw || "").trim();
  if (!u) return false;
  if (classifyVfsFirstTabUrl(u) === "dashboard") return true;
  return VFS_DASHBOARD_URL_RE.test(u);
}

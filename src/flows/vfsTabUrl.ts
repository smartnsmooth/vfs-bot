export type VfsTabKind = "blank" | "login" | "dashboard" | "vfs_other";

/**
 * Classify first VFS tab URL for submit-driven flow:
 * - blank → open login
 * - login → run login automation
 * - dashboard → skip login
 * - vfs_other (application detail, your-details, etc.) → skip login, go to polling
 */
export function classifyVfsFirstTabUrl(raw: string): VfsTabKind {
  const u = (raw || "").trim().toLowerCase();
  if (!u || u === "about:blank") return "blank";

  if (!u.includes("visa.vfsglobal.com")) return "blank";

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

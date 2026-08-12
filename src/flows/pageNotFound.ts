/** True when VFS redirected to a block / session-dead URL that needs a full bot restart. */
export function isPageNotFoundUrl(url: string): boolean {
  const u = (url || "").trim().toLowerCase();
  return u.includes("page-not-found") || u.includes("session-expired");
}

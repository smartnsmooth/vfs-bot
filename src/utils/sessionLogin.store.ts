/** VFS credentials from the setup UI (in-memory only; not persisted). */

let username: string | null = null;
let password: string | null = null;

export function setSessionLoginCredentials(user: string, pass: string): void {
  const u = user.trim();
  const p = pass; // keep as-is (spaces may be intentional)
  if (!u || !p) return;
  username = u;
  password = p;
}

export function getSessionLoginCredentials(): { username: string; password: string } | null {
  if (!username || !password) return null;
  return { username, password };
}

export function clearSessionLoginCredentials(): void {
  username = null;
  password = null;
}

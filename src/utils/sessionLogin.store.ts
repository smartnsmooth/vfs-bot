/** VFS credentials from the setup UI (in-memory only; not persisted). */
/** Per-instance storage: Map<instanceId, {username, password}> */

import { loadInstancesFromDisk, saveInstancesToDisk } from "./instanceStorage";

export type StoredInstanceCredentials = {
  username: string;
  password: string;
  username2?: string;
  password2?: string;
};

const instanceCredentials = new Map<number, StoredInstanceCredentials>();

// Load from disk on module import
const diskData = loadInstancesFromDisk();
for (const [idStr, data] of Object.entries(diskData.instances)) {
  const id = parseInt(idStr, 10);
  if (data.credentials) {
    instanceCredentials.set(id, data.credentials);
  }
}

/** Re-read `instances-data.json` into this process (cluster workers need this after the parent updates disk). */
export function reloadSessionCredentialsFromDisk(): void {
  instanceCredentials.clear();
  const data = loadInstancesFromDisk();
  for (const [idStr, row] of Object.entries(data.instances)) {
    const id = parseInt(idStr, 10);
    if (row.credentials) {
      instanceCredentials.set(id, row.credentials);
    }
  }
}

function persistToDisk(): void {
  const instances: Record<string, { credentials?: StoredInstanceCredentials; details?: Record<string, unknown> }> = {};
  
  // Get credentials
  for (const [id, creds] of instanceCredentials.entries()) {
    if (!instances[String(id)]) instances[String(id)] = {};
    instances[String(id)].credentials = creds;
  }
  
  // Merge with existing details from disk (in case applicantDetails.store hasn't saved yet)
  const current = loadInstancesFromDisk();
  for (const [idStr, data] of Object.entries(current.instances)) {
    if (!instances[idStr]) instances[idStr] = {};
    if (data.details) instances[idStr].details = data.details;
  }
  
  saveInstancesToDisk({ instances });
}

/**
 * Second pair: set when both provided; `"clear"` removes rotation; `"preserve"` keeps existing second pair when updating primary only.
 */
export function setSessionLoginCredentials(
  user: string,
  pass: string,
  instanceId?: number,
  second?: { username2: string; password2: string } | "clear" | "preserve"
): void {
  const u = user.trim();
  const p = pass; // keep as-is (spaces may be intentional)
  if (!u || !p) return;

  const id = instanceId ?? 0; // 0 = default/single instance mode
  const prev = instanceCredentials.get(id);
  const entry: StoredInstanceCredentials = { username: u, password: p };

  if (second === "preserve" || second === undefined) {
    if (prev?.username2 && prev.password2 != null && String(prev.password2) !== "") {
      entry.username2 = prev.username2;
      entry.password2 = prev.password2;
    }
  } else if (second === "clear") {
    /* omit username2/password2 */
  } else {
    const u2 = second.username2.trim();
    const p2 = second.password2;
    if (u2 && p2 !== "") {
      entry.username2 = u2;
      entry.password2 = p2;
    }
  }
  instanceCredentials.set(id, entry);
  persistToDisk();
}

export function getSessionLoginCredentials(instanceId?: number): StoredInstanceCredentials | null {
  const id = instanceId ?? 0;
  return instanceCredentials.get(id) ?? null;
}

export function clearSessionLoginCredentials(instanceId?: number): void {
  if (instanceId === undefined) {
    instanceCredentials.clear();
  } else {
    instanceCredentials.delete(instanceId);
  }
  persistToDisk();
}

export function getAllInstanceCredentials(): Map<number, StoredInstanceCredentials> {
  return instanceCredentials;
}

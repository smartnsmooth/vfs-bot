/** VFS credentials from the setup UI (in-memory only; not persisted). */
/** Per-instance storage: Map<instanceId, {username, password}> */

import { loadInstancesFromDisk, saveInstancesToDisk } from "./instanceStorage";

const instanceCredentials = new Map<number, { username: string; password: string }>();

// Load from disk on module import
const diskData = loadInstancesFromDisk();
for (const [idStr, data] of Object.entries(diskData.instances)) {
  const id = parseInt(idStr, 10);
  if (data.credentials) {
    instanceCredentials.set(id, data.credentials);
  }
}

function persistToDisk(): void {
  const instances: Record<string, { credentials?: { username: string; password: string }; details?: Record<string, unknown> }> = {};
  
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

export function setSessionLoginCredentials(user: string, pass: string, instanceId?: number): void {
  const u = user.trim();
  const p = pass; // keep as-is (spaces may be intentional)
  if (!u || !p) return;
  
  const id = instanceId ?? 0; // 0 = default/single instance mode
  instanceCredentials.set(id, { username: u, password: p });
  persistToDisk();
}

export function getSessionLoginCredentials(instanceId?: number): { username: string; password: string } | null {
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

export function getAllInstanceCredentials(): Map<number, { username: string; password: string }> {
  return instanceCredentials;
}

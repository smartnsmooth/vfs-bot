/**
 * Applicant fields collected from the post-login UI, merged into
 * {@link buildSaveApplicantsBody} `applicantList[0]` before save applicants.
 * Per-instance storage: Map<instanceId, applicantDetails>
 */

import { loadInstancesFromDisk, saveInstancesToDisk } from "./instanceStorage";

const instanceApplicantDetails = new Map<number, Record<string, unknown>>();

const GLOBAL_SCHEDULE_KEY = "scheduleAllowedDates" as const;

export function omitGlobalScheduleFields(fields: Record<string, unknown>): Record<string, unknown> {
  const { scheduleAllowedDates: _s, ...rest } = fields;
  return rest;
}

// Load from disk on module import
const diskData = loadInstancesFromDisk();
for (const [idStr, data] of Object.entries(diskData.instances)) {
  const id = parseInt(idStr, 10);
  if (data.details) {
    instanceApplicantDetails.set(id, data.details);
  }
}

/** Re-read `instances-data.json` into this process (cluster workers need this after the parent updates disk). */
export function reloadApplicantDetailsFromDisk(): void {
  instanceApplicantDetails.clear();
  const data = loadInstancesFromDisk();
  for (const [idStr, row] of Object.entries(data.instances)) {
    const id = parseInt(idStr, 10);
    if (row.details) {
      instanceApplicantDetails.set(id, row.details);
    }
  }
}

function persistToDisk(): void {
  const instances: Record<string, { credentials?: { username: string; password: string }; details?: Record<string, unknown> }> = {};
  
  // Get details
  for (const [id, details] of instanceApplicantDetails.entries()) {
    if (!instances[String(id)]) instances[String(id)] = {};
    instances[String(id)].details = details;
  }
  
  // Merge with existing credentials from disk (in case sessionLogin.store hasn't saved yet)
  const current = loadInstancesFromDisk();
  for (const [idStr, data] of Object.entries(current.instances)) {
    if (!instances[idStr]) instances[idStr] = {};
    if (data.credentials) instances[idStr].credentials = data.credentials;
  }
  
  saveInstancesToDisk({ instances });
}

/**
 * Merge allowed schedule dates into instance 0 (shared by all instances).
 * Raw body should include `scheduleAllowedDates` string (textarea) when updating.
 */
export function mergeGlobalScheduleAllowedDatesFromPayload(j: Record<string, unknown>): void {
  if (!(GLOBAL_SCHEDULE_KEY in j)) return;
  const cur = instanceApplicantDetails.get(0) ?? {};
  const next = { ...cur };
  const v = j[GLOBAL_SCHEDULE_KEY];
  next[GLOBAL_SCHEDULE_KEY] =
    typeof v === "string" ? v : Array.isArray(v) ? v.map((x) => String(x)).join("\n") : "";
  delete next.scheduleDateRangeStart;
  delete next.scheduleDateRangeEnd;
  instanceApplicantDetails.set(0, next);
  persistToDisk();
}

export function setApplicantDetailsOverrides(fields: Record<string, unknown>, instanceId?: number): void {
  const id = instanceId ?? 0; // 0 = default/single instance mode
  instanceApplicantDetails.set(id, { ...fields });
  persistToDisk();
}

export function getApplicantDetailsOverrides(instanceId?: number): Record<string, unknown> | null {
  const id = instanceId ?? 0;
  return instanceApplicantDetails.get(id) ?? null;
}

export function clearApplicantDetailsOverrides(instanceId?: number): void {
  if (instanceId === undefined) {
    instanceApplicantDetails.clear();
  } else {
    instanceApplicantDetails.delete(instanceId);
  }
  persistToDisk();
}

export function getAllInstanceApplicantDetails(): Map<number, Record<string, unknown>> {
  return instanceApplicantDetails;
}

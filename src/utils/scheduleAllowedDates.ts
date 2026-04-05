/**
 * Optional appointment date constraint from setup (per bot instance in applicant details).
 * Primary: inclusive `scheduleDateRangeStart`–`scheduleDateRangeEnd` (YYYY-MM-DD).
 * Legacy: `scheduleAllowedDates` discrete list (still read if no valid range).
 * If the chosen instance has no schedule data, falls back to applicant details id 0 (migration).
 * Calendar API returns MM/DD/YYYY.
 */

import { getCurrentInstanceId } from "../config/config.js";
import { getApplicantDetailsOverrides } from "./applicantDetails.store.js";

/** Thrown when filtering removes every calendar date (restart polling). */
export class NoDatesInScheduleRangeError extends Error {
  readonly code = "NO_DATES_IN_RANGE" as const;
  constructor() {
    super("No calendar dates match your allowed schedule date range");
    this.name = "NoDatesInScheduleRangeError";
  }
}

function hasScheduleConstraintInDetails(d: Record<string, unknown> | null | undefined): boolean {
  if (!d) return false;
  const rs = typeof d.scheduleDateRangeStart === "string" ? d.scheduleDateRangeStart.trim() : "";
  const re = typeof d.scheduleDateRangeEnd === "string" ? d.scheduleDateRangeEnd.trim() : "";
  if (rs && re) return true;
  const legacy = d.scheduleAllowedDates;
  if (legacy == null) return false;
  if (typeof legacy === "string") return legacy.trim() !== "";
  return Array.isArray(legacy) && legacy.length > 0;
}

function detailsForScheduleLookup(instanceId: number): Record<string, unknown> | null {
  const own = getApplicantDetailsOverrides(instanceId);
  if (hasScheduleConstraintInDetails(own)) return own;
  if (instanceId !== 0) {
    const z = getApplicantDetailsOverrides(0);
    if (hasScheduleConstraintInDetails(z)) return z;
  } else {
    const one = getApplicantDetailsOverrides(1);
    if (hasScheduleConstraintInDetails(one)) return one;
  }
  return own;
}

/**
 * Allowed dates for calendar filtering / fast-path checks.
 * @param instanceId Bot instance (1-based in cluster); defaults to {@link getCurrentInstanceId}, then `BOT_INSTANCE_ID`, then 0.
 */
export function getScheduleAllowedDates(instanceId?: number): Set<string> | null {
  let id = instanceId;
  if (id === undefined) {
    id = getCurrentInstanceId();
  }
  if (id === undefined) {
    const fromEnv = parseInt(process.env.BOT_INSTANCE_ID ?? "", 10);
    id = Number.isFinite(fromEnv) && fromEnv >= 1 ? fromEnv : 0;
  }
  const d = detailsForScheduleLookup(id);
  const startRaw = d?.scheduleDateRangeStart;
  const endRaw = d?.scheduleDateRangeEnd;
  const start = typeof startRaw === "string" ? startRaw.trim() : "";
  const end = typeof endRaw === "string" ? endRaw.trim() : "";
  if (start && end) {
    const fromRange = expandInclusiveIsoDateRangeToSet(start, end);
    if (fromRange && fromRange.size > 0) return fromRange;
  }
  const parsed = normalizeAllowedDatesFromStorage(d?.scheduleAllowedDates);
  if (parsed.length === 0) return null;
  return new Set(parsed);
}

/** Inclusive UTC calendar days; swaps if start > end; invalid ISO → null. */
export function expandInclusiveIsoDateRangeToSet(startIso: string, endIso: string): Set<string> | null {
  let t0 = parseIsoDateUtc(startIso);
  let t1 = parseIsoDateUtc(endIso);
  if (t0 == null || t1 == null) return null;
  if (t0 > t1) [t0, t1] = [t1, t0];
  const out = new Set<string>();
  const dayMs = 86_400_000;
  for (let t = t0; t <= t1; t += dayMs) {
    out.add(formatUtcYmd(t));
  }
  return out;
}

function formatUtcYmd(utcMs: number): string {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeAllowedDatesFromStorage(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const x of raw) {
      const n = normalizeIsoDateString(String(x).trim());
      if (n) out.push(n);
    }
    return dedupeSorted(out);
  }
  if (typeof raw === "string") return parseAllowedDatesFromText(raw);
  return [];
}

export function parseAllowedDatesFromText(text: string): string[] {
  const parts = text
    .split(/[\s,;|\n\r]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const n = normalizeIsoDateString(p);
    if (n) out.push(n);
  }
  return dedupeSorted(out);
}

function dedupeSorted(dates: string[]): string[] {
  return [...new Set(dates)].sort();
}

function normalizeIsoDateString(s: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  if (parseIsoDateUtc(s) == null) return null;
  return s;
}

function parseIsoDateUtc(iso: string): number | null {
  const m = iso.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  const t = Date.UTC(y, mo, day);
  const d = new Date(t);
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo || d.getUTCDate() !== day) return null;
  return t;
}

/** lift-api calendar: MM/DD/YYYY → YYYY-MM-DD */
export function calendarApiDateToIso(calDate: string): string | null {
  const m = calDate.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const mm = m[1];
  const dd = m[2];
  const yyyy = m[3];
  const iso = `${yyyy}-${mm}-${dd}`;
  return normalizeIsoDateString(iso);
}

export function calendarApiDateInAllowedSet(calDate: string, allowed: Set<string>): boolean {
  const iso = calendarApiDateToIso(calDate);
  return iso != null && allowed.has(iso);
}

export function isPollingSlotInAllowedSet(
  slot: { date?: string; rawDate?: string } | undefined,
  allowed: Set<string>
): boolean {
  if (!slot) return false;
  if (slot.date) {
    const iso = slot.date.trim().slice(0, 10);
    return normalizeIsoDateString(iso) != null && allowed.has(iso);
  }
  const raw = slot.rawDate?.trim();
  if (raw) {
    const iso = calendarApiDateToIso(raw);
    return iso != null && allowed.has(iso);
  }
  return false;
}

/**
 * Optional appointment date window from setup (per bot instance in applicant details).
 * Inclusive `scheduleDateRangeStart`–`scheduleDateRangeEnd` (YYYY-MM-DD); either bound may be
 * omitted for an open-ended range. Calendar API dates (MM/DD/YYYY) are compared in UTC day space.
 * Each bot instance uses only that instance's saved range; unset means no filter.
 */

import { getCurrentInstanceId } from "../config/config.js";
import { getApplicantDetailsOverrides } from "./applicantDetails.store.js";

/** Thrown when filtering removes every calendar date (caller may stop the cycle). */
export class NoDatesInScheduleRangeError extends Error {
  readonly code = "NO_DATES_IN_RANGE" as const;
  constructor() {
    super("No calendar dates match your schedule date range");
    this.name = "NoDatesInScheduleRangeError";
  }
}

export type ScheduleDateConstraint =
  | { kind: "none" }
  | { kind: "range"; start: string | null; end: string | null };

export function scheduleConstraintIsActive(c: ScheduleDateConstraint): boolean {
  if (c.kind === "none") return false;
  return c.start != null || c.end != null;
}

function constraintFromDetailsRecord(d: Record<string, unknown> | null | undefined): ScheduleDateConstraint {
  if (!d) return { kind: "none" };
  const startRaw = typeof d.scheduleDateRangeStart === "string" ? d.scheduleDateRangeStart.trim() : "";
  const endRaw = typeof d.scheduleDateRangeEnd === "string" ? d.scheduleDateRangeEnd.trim() : "";
  const startNorm = startRaw ? normalizeIsoDateString(startRaw.slice(0, 10)) : null;
  const endNorm = endRaw ? normalizeIsoDateString(endRaw.slice(0, 10)) : null;

  if (startNorm != null || endNorm != null) {
    let lo = startNorm;
    let hi = endNorm;
    const t0 = lo != null ? parseIsoDateUtc(lo) : null;
    const t1 = hi != null ? parseIsoDateUtc(hi) : null;
    if (t0 != null && t1 != null && t0 > t1) {
      [lo, hi] = [hi, lo];
    }
    return { kind: "range", start: lo, end: hi };
  }

  return { kind: "none" };
}

/**
 * Resolved schedule range for calendar / fast-path checks.
 * @param instanceId Bot instance (1-based in cluster); defaults to {@link getCurrentInstanceId}, then `BOT_INSTANCE_ID`, then 0.
 */
export function resolveScheduleDateConstraint(instanceId?: number): ScheduleDateConstraint {
  let id = instanceId;
  if (id === undefined) {
    id = getCurrentInstanceId();
  }
  if (id === undefined) {
    const fromEnv = parseInt(process.env.BOT_INSTANCE_ID ?? "", 10);
    id = Number.isFinite(fromEnv) && fromEnv >= 1 ? fromEnv : 0;
  }
  const d = getApplicantDetailsOverrides(id);
  return constraintFromDetailsRecord(d);
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

function isoYmdInRange(iso: string, c: { kind: "range"; start: string | null; end: string | null }): boolean {
  const t = parseIsoDateUtc(iso);
  if (t == null) return false;
  if (c.start) {
    const ts = parseIsoDateUtc(c.start);
    if (ts != null && t < ts) return false;
  }
  if (c.end) {
    const te = parseIsoDateUtc(c.end);
    if (te != null && t > te) return false;
  }
  return true;
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

export function calendarApiDateMatchesConstraint(calDate: string, c: ScheduleDateConstraint): boolean {
  if (c.kind === "none") return true;
  const iso = calendarApiDateToIso(calDate);
  return iso != null && isoYmdInRange(iso, c);
}

export function isPollingSlotInConstraint(
  slot: { date?: string; rawDate?: string } | undefined,
  c: ScheduleDateConstraint
): boolean {
  if (!scheduleConstraintIsActive(c) || c.kind !== "range") return false;
  if (!slot) return false;
  if (slot.date) {
    const iso = slot.date.trim().slice(0, 10);
    if (normalizeIsoDateString(iso) == null) return false;
    return isoYmdInRange(iso, c);
  }
  const raw = slot.rawDate?.trim();
  if (raw) {
    const iso = calendarApiDateToIso(raw);
    if (iso == null) return false;
    return isoYmdInRange(iso, c);
  }
  return false;
}

export function scheduleConstraintLogValue(c: ScheduleDateConstraint): Record<string, unknown> {
  if (c.kind === "none") return { scheduleConstraint: "none" };
  return { scheduleConstraint: "range", scheduleDateRangeStart: c.start, scheduleDateRangeEnd: c.end };
}

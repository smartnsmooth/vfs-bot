/**
 * Optional allow-list of appointment dates from setup (YYYY-MM-DD, one per line in UI).
 * Shared on applicant details id 0. Calendar API returns MM/DD/YYYY.
 */

import { getApplicantDetailsOverrides } from "./applicantDetails.store.js";

/** Thrown when filtering removes every calendar date (restart polling). */
export class NoDatesInScheduleRangeError extends Error {
  readonly code = "NO_DATES_IN_RANGE" as const;
  constructor() {
    super("No calendar dates match your allowed schedule dates");
    this.name = "NoDatesInScheduleRangeError";
  }
}

export function getScheduleAllowedDates(): Set<string> | null {
  const d = getApplicantDetailsOverrides(0);
  const parsed = normalizeAllowedDatesFromStorage(d?.scheduleAllowedDates);
  if (parsed.length === 0) return null;
  return new Set(parsed);
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

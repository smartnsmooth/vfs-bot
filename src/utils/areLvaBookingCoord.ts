/**
 * are-lva date / timeslot assignment on top of calendar-booking-coord.json.
 *
 * Calendar dates are split evenly across active waiters (first dates get the remainder).
 * The first timeslot response on a date publishes times only (no allocationId).
 * Every instance on that date calls timeslot itself and claims a distinct time;
 * leftovers move to a surplus date.
 */

import {
  activeWaiters,
  mutateCalendarBookingState,
  readCalendarBookingState,
  type AreLvaSlotClaim,
  type CalendarBookingCoordState,
} from "./calendarBookingCoord";

export function datesKeyOf(dates: string[]): string {
  return dates.map((d) => d.trim()).filter(Boolean).join("|");
}

/** Split N instance ids across D dates: 8/3 → 3, 3, 2. */
export function distributeIdsAcrossDates(ids: number[], dates: string[]): Record<string, number[]> {
  const groups: Record<string, number[]> = {};
  for (const d of dates) groups[d] = [];
  if (dates.length === 0 || ids.length === 0) return groups;
  const sorted = [...new Set(ids.filter((n) => n >= 1))].sort((a, b) => a - b);
  const D = dates.length;
  const N = sorted.length;
  const base = Math.floor(N / D);
  const rem = N % D;
  let i = 0;
  for (let di = 0; di < D; di++) {
    const count = base + (di < rem ? 1 : 0);
    groups[dates[di]!] = sorted.slice(i, i + count);
    i += count;
  }
  return groups;
}

function assignedIds(groups: Record<string, number[]>): Set<number> {
  const out = new Set<number>();
  for (const ids of Object.values(groups)) {
    for (const id of ids) out.add(id);
  }
  return out;
}

/** (Re)build groups when calendar dates change; late waiters join the smallest group. */
export function ensureAreLvaDateGroups(dates: string[]): CalendarBookingCoordState {
  const clean = dates.map((d) => d.trim()).filter(Boolean);
  const key = datesKeyOf(clean);
  return mutateCalendarBookingState((s) => {
    const waiters = activeWaiters(s);
    if (clean.length === 0) return false;
    if (s.areLvaDatesKey !== key) {
      s.areLvaDatesKey = key;
      s.areLvaGroups = distributeIdsAcrossDates(waiters, clean);
      s.areLvaSlots = {};
      s.areLvaTimeslotOwner = {};
      s.areLvaTimeslotOwnerAt = {};
      s.areLvaLastTimeslotDate = {};
      return true;
    }
    const have = assignedIds(s.areLvaGroups);
    const missing = waiters.filter((id) => !have.has(id));
    if (missing.length === 0) return false;
    for (const id of missing) {
      let best = clean[0]!;
      let bestN = (s.areLvaGroups[best] ?? []).length;
      for (const d of clean) {
        const n = (s.areLvaGroups[d] ?? []).length;
        if (n < bestN) {
          best = d;
          bestN = n;
        }
      }
      s.areLvaGroups[best] = [...(s.areLvaGroups[best] ?? []), id];
    }
    return true;
  }).state;
}

export function assignedDateFor(instanceId: number): string | null {
  const id = Math.max(1, Math.floor(instanceId));
  const s = readCalendarBookingState();
  for (const [date, ids] of Object.entries(s.areLvaGroups ?? {})) {
    if (ids.includes(id)) return date;
  }
  return null;
}

/**
 * Publish unique time labels from a timeslot response. allocationId is never stored.
 * An empty list still marks the date ready so peers stop waiting for the first fetch.
 */
export function publishAreLvaTimeslots(
  instanceId: number,
  date: string,
  entries: Array<{ allocationId: string; time: string }>
): void {
  const id = Math.max(1, Math.floor(instanceId));
  const d = date.trim();
  mutateCalendarBookingState((s) => {
    const prev = s.areLvaSlots[d] ?? [];
    const byTime = new Map<string, AreLvaSlotClaim>();
    for (const row of prev) {
      const t = String(row.time ?? "").trim();
      if (t && !byTime.has(t)) byTime.set(t, { time: t, claimedBy: row.claimedBy ?? null });
    }
    for (const e of entries) {
      const time = String(e.time ?? "").trim() || "unknown";
      if (!byTime.has(time)) byTime.set(time, { time, claimedBy: null });
    }
    s.areLvaSlots[d] = [...byTime.values()];
    if (s.areLvaTimeslotOwner[d] === id) s.areLvaTimeslotOwner[d] = null;
    s.areLvaLastTimeslotDate[String(id)] = d;
    return true;
  });
}

export function areLvaSlotsReady(date: string): boolean {
  const d = date.trim();
  const s = readCalendarBookingState();
  return Array.isArray(s.areLvaSlots[d]);
}

/**
 * Claim a distinct published time on this date.
 * If this instance already holds a time, that claim is returned unchanged.
 * `preferTimes` (this instance's own timeslot labels) is tried before any unclaimed time.
 */
export function claimUnclaimedSlotOnDate(
  instanceId: number,
  date: string,
  preferTimes?: ReadonlySet<string>
): AreLvaSlotClaim | null {
  const id = Math.max(1, Math.floor(instanceId));
  const d = date.trim();
  let picked: AreLvaSlotClaim | null = null;
  const r = mutateCalendarBookingState((s) => {
    const rows = s.areLvaSlots[d];
    if (!rows?.length) return false;
    const mineIdx = rows.findIndex((row) => row.claimedBy === id);
    if (mineIdx >= 0) {
      picked = { ...rows[mineIdx]! };
      return false;
    }
    let idx = -1;
    if (preferTimes && preferTimes.size > 0) {
      idx = rows.findIndex((row) => row.claimedBy == null && preferTimes.has(row.time));
    }
    if (idx < 0) idx = rows.findIndex((row) => row.claimedBy == null);
    if (idx < 0) return false;
    rows[idx] = { ...rows[idx]!, claimedBy: id };
    picked = { ...rows[idx]! };
    s.areLvaLastTimeslotDate[String(id)] = d;
    return true;
  });
  if (picked) return picked;
  return r.outcome === "applied" ? picked : null;
}

export function releaseAreLvaTimeClaim(instanceId: number, date: string): void {
  const id = Math.max(1, Math.floor(instanceId));
  const d = date.trim();
  mutateCalendarBookingState((s) => {
    const rows = s.areLvaSlots[d];
    if (!rows?.length) return false;
    const idx = rows.findIndex((row) => row.claimedBy === id);
    if (idx < 0) return false;
    rows[idx] = { ...rows[idx]!, claimedBy: null };
    return true;
  });
}

/** Date with more times than originally assigned instances, and at least one free time. */
export function findSurplusDate(exceptDate?: string): string | null {
  const skip = (exceptDate ?? "").trim();
  const s = readCalendarBookingState();
  for (const date of Object.keys(s.areLvaSlots)) {
    if (date === skip) continue;
    const rows = s.areLvaSlots[date] ?? [];
    const assigned = (s.areLvaGroups[date] ?? []).length;
    const unclaimed = rows.filter((row) => row.claimedBy == null).length;
    if (rows.length > assigned && unclaimed > 0) return date;
  }
  return null;
}

/** Last-resort: any published time on the date (may already be claimed by a peer). */
export function claimAnySlotOnDate(instanceId: number, date: string): AreLvaSlotClaim | null {
  const id = Math.max(1, Math.floor(instanceId));
  const d = date.trim();
  let picked: AreLvaSlotClaim | null = null;
  const r = mutateCalendarBookingState((s) => {
    const rows = s.areLvaSlots[d];
    if (!rows?.length) return false;
    const idx = Math.floor(Math.random() * rows.length);
    const row = rows[idx]!;
    rows[idx] = { ...row, claimedBy: id };
    picked = { ...rows[idx]! };
    s.areLvaLastTimeslotDate[String(id)] = d;
    return true;
  });
  return r.outcome === "applied" ? picked : null;
}

export function lastTimeslotDateFor(instanceId: number): string | null {
  const s = readCalendarBookingState();
  const d = s.areLvaLastTimeslotDate[String(Math.max(1, Math.floor(instanceId)))] ?? "";
  return d.trim() || null;
}

export function unclaimedCountOnDate(date: string): number {
  const s = readCalendarBookingState();
  return (s.areLvaSlots[date.trim()] ?? []).filter((row) => row.claimedBy == null).length;
}

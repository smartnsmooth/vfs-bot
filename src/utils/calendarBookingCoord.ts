/**
 * Fleet coordination for the Calendar-polling booking system.
 *
 * Shared state (JSON file) tracks:
 * - urnHolders: instances that got a URN from applicants
 * - feeCalculatorId: first URN holder → calls Calendar + Fees
 *   (a prior 1037/1101 retire does not block this — URN wins)
 * - availableDateList: deduped dates from Calendar (consumed by instances for Timeslot)
 * - availableDatetimeList: date+time entries from Timeslot (consumed for Schedule)
 * - fees / totalAmount: published by FeeCalculator, used by all for Schedule
 * - calendarPollers: URN holders doing round-robin Calendar polling (case III)
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, watch } from "node:fs";
import { join } from "node:path";
import { getApplicantsJoinStaggerMs } from "./fleetPollSchedule";

export type CalendarBookingPhase = "poll" | "active" | "calendar_repoll";

export interface AvailableDatetime {
  date: string;
  time: string;
}

export interface SharedFees {
  totalAmount: string;
  currency: string | null;
}

export interface CalendarBookingCoordState {
  revision: number;
  phase: CalendarBookingPhase;

  /** Instance ids registered as waiters (have URN). */
  waiters: number[];
  /** Instance ids that finished save-applicants with a URN. */
  urnHolders: number[];

  /** First URN holder = FeeCalculator. Prior already-booked does not override a later URN. */
  feeCalculatorId: number | null;
  firstApplicantsSuccessId: number | null;

  /** FeeCalculator already called Calendar this wave. */
  calendarCalled: boolean;

  /** Deduplicated dates from Calendar — instances pick randomly. */
  availableDateList: string[];
  /** Date+time entries from Timeslot — instances pick randomly. */
  availableDatetimeList: AvailableDatetime[];

  fees: SharedFees | null;
  feesDone: boolean;

  /** Calendar round-robin polling state (case III). */
  calendarAttemptIndex: number;
  lastCalendarAttemptAt: number;
  lastCalendarCallerId: number | null;

  /** Extra join-stagger ms added fleet-wide after each Lift API 504. */
  joinStaggerExtraMs: number;

  /** Successfully scheduled — leave the fleet. */
  scheduled: number[];

  /** Retired instances (1037/1101 etc.) — removed from fleet. */
  retired: number[];
}

const COORD_FILE = join(process.cwd(), "calendar-booking-coord.json");

function emptyState(): CalendarBookingCoordState {
  return {
    revision: 0,
    phase: "poll",
    waiters: [],
    urnHolders: [],
    feeCalculatorId: null,
    firstApplicantsSuccessId: null,
    calendarCalled: false,
    availableDateList: [],
    availableDatetimeList: [],
    fees: null,
    feesDone: false,
    calendarAttemptIndex: 0,
    lastCalendarAttemptAt: 0,
    lastCalendarCallerId: null,
    joinStaggerExtraMs: 0,
    scheduled: [],
    retired: [],
  };
}

function normalizeState(raw: Partial<CalendarBookingCoordState> | null | undefined): CalendarBookingCoordState {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;

  const safeIntArray = (arr: unknown): number[] =>
    Array.isArray(arr) ? arr.map((n) => Math.floor(Number(n))).filter((n) => n >= 1) : [];

  const safeDatetimeArray = (arr: unknown): AvailableDatetime[] => {
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e): e is { date: string; time: string } =>
        e != null && typeof e === "object" && typeof e.date === "string" && typeof e.time === "string"
      )
      .map((e) => ({ date: e.date.trim(), time: e.time.trim() }))
      .filter((e) => e.date !== "" && e.time !== "");
  };

  return {
    ...base,
    ...raw,
    revision: typeof raw.revision === "number" && Number.isFinite(raw.revision) ? raw.revision : 0,
    phase: raw.phase === "active" || raw.phase === "calendar_repoll" ? raw.phase : "poll",
    waiters: safeIntArray(raw.waiters),
    urnHolders: safeIntArray(raw.urnHolders),
    feeCalculatorId:
      typeof raw.feeCalculatorId === "number" && Number.isFinite(raw.feeCalculatorId) ? raw.feeCalculatorId : null,
    firstApplicantsSuccessId:
      typeof raw.firstApplicantsSuccessId === "number" && Number.isFinite(raw.firstApplicantsSuccessId)
        ? raw.firstApplicantsSuccessId
        : null,
    calendarCalled: raw.calendarCalled === true,
    availableDateList: Array.isArray(raw.availableDateList) ? raw.availableDateList.map(String).filter(Boolean) : [],
    availableDatetimeList: safeDatetimeArray(raw.availableDatetimeList),
    fees: raw.fees && typeof raw.fees === "object" && typeof (raw.fees as SharedFees).totalAmount === "string"
      ? raw.fees as SharedFees
      : null,
    feesDone: raw.feesDone === true,
    calendarAttemptIndex:
      typeof raw.calendarAttemptIndex === "number" && Number.isFinite(raw.calendarAttemptIndex)
        ? Math.max(0, Math.floor(raw.calendarAttemptIndex))
        : 0,
    lastCalendarAttemptAt:
      typeof raw.lastCalendarAttemptAt === "number" && Number.isFinite(raw.lastCalendarAttemptAt)
        ? Math.max(0, Math.floor(raw.lastCalendarAttemptAt))
        : 0,
    lastCalendarCallerId:
      typeof raw.lastCalendarCallerId === "number" && Number.isFinite(raw.lastCalendarCallerId)
        ? raw.lastCalendarCallerId
        : null,
    joinStaggerExtraMs:
      typeof raw.joinStaggerExtraMs === "number" && Number.isFinite(raw.joinStaggerExtraMs)
        ? Math.max(0, Math.floor(raw.joinStaggerExtraMs))
        : 0,
    scheduled: safeIntArray(raw.scheduled),
    retired: safeIntArray(raw.retired),
  };
}

export function readCalendarBookingState(): CalendarBookingCoordState {
  try {
    if (!existsSync(COORD_FILE)) return emptyState();
    return normalizeState(JSON.parse(readFileSync(COORD_FILE, "utf8")) as Partial<CalendarBookingCoordState>);
  } catch {
    return emptyState();
  }
}

function writeState(state: CalendarBookingCoordState): void {
  try {
    writeFileSync(COORD_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* swallow — another process may be writing */
  }
}

function sleepMs(ms: number): void {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    /* spin briefly for tight CAS retries */
  }
}

export function updateCalendarBookingState(
  mutator: (state: CalendarBookingCoordState) => boolean
): CalendarBookingCoordState {
  for (let attempt = 0; attempt < 40; attempt++) {
    const cur = readCalendarBookingState();
    const rev = cur.revision;
    const next = structuredClone(cur) as CalendarBookingCoordState;
    if (!mutator(next)) return cur;
    next.revision = rev + 1;
    const again = readCalendarBookingState();
    if (again.revision !== rev) {
      sleepMs(5 + attempt);
      continue;
    }
    writeState(next);
    return next;
  }
  const cur = readCalendarBookingState();
  const next = structuredClone(cur) as CalendarBookingCoordState;
  mutator(next);
  next.revision = cur.revision + 1;
  writeState(next);
  return next;
}

export function clearCalendarBookingCoord(): void {
  try {
    if (existsSync(COORD_FILE)) unlinkSync(COORD_FILE);
  } catch {
    /* ignore */
  }
}

// ── Join stagger ────────────────────────────────────────────────────────

/** Base applicantsJoinStaggerSec + fleet-wide 504 bump (ms). */
export function getEffectiveJoinStaggerMs(): number {
  const extra = readCalendarBookingState().joinStaggerExtraMs ?? 0;
  return getApplicantsJoinStaggerMs() + Math.max(0, extra);
}

/** After a Lift API 504: bump stagger by 0.5s fleet-wide. */
export function bumpJoinStaggerOn504(): CalendarBookingCoordState {
  return updateCalendarBookingState((s) => {
    s.joinStaggerExtraMs = (s.joinStaggerExtraMs ?? 0) + 500;
    return true;
  });
}

// ── Calendar dates helpers ──────────────────────────────────────────────

export function dedupeCalendarDates(dates: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dates) {
    const key = String(d).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// ── URN registration ────────────────────────────────────────────────────

export function registerFleetUrn(instanceId: number): CalendarBookingCoordState {
  const id = Math.max(1, Math.floor(instanceId));
  return updateCalendarBookingState((s) => {
    // URN is the source of truth: un-retire so a prior 1037/1101 cannot
    // block this instance from being FeeCalculator (first URN holder).
    s.retired = s.retired.filter((n) => n !== id);
    if (!s.urnHolders.includes(id)) s.urnHolders.push(id);
    s.urnHolders = [...new Set(s.urnHolders)].filter((n) => n >= 1).sort((a, b) => a - b);
    if (!s.waiters.includes(id)) s.waiters.push(id);
    s.waiters = [...new Set(s.waiters)].filter((n) => n >= 1).sort((a, b) => a - b);
    if (s.feeCalculatorId == null) {
      s.feeCalculatorId = id;
      s.firstApplicantsSuccessId = id;
    }
    return true;
  });
}

export function getFleetUrnHolders(state?: CalendarBookingCoordState): number[] {
  const s = state ?? readCalendarBookingState();
  return [...new Set(s.urnHolders)].filter((n) => n >= 1).sort((a, b) => a - b);
}

/** Active waiters: registered, not yet successfully scheduled or retired. */
export function activeWaiters(state: CalendarBookingCoordState): number[] {
  const excluded = new Set([...state.scheduled, ...state.retired]);
  return [...new Set(state.waiters)]
    .filter((id) => id >= 1 && !excluded.has(id))
    .sort((a, b) => a - b);
}

export function registerCalendarWaiter(instanceId: number): CalendarBookingCoordState {
  const id = Math.max(1, Math.floor(instanceId));
  return updateCalendarBookingState((s) => {
    if (s.retired.includes(id)) return false;
    if (!s.waiters.includes(id)) s.waiters.push(id);
    s.waiters = [...new Set(s.waiters)].filter((n) => n >= 1).sort((a, b) => a - b);
    return true;
  });
}

/** Retire instance from fleet (1037/1101). */
export function retireFromFleet(instanceId: number): CalendarBookingCoordState {
  const id = Math.max(1, Math.floor(instanceId));
  return updateCalendarBookingState((s) => {
    if (!s.retired.includes(id)) s.retired.push(id);
    s.waiters = s.waiters.filter((w) => w !== id);
    s.urnHolders = s.urnHolders.filter((w) => w !== id);
    if (s.feeCalculatorId === id) s.feeCalculatorId = null;
    return true;
  });
}

// ── FeeCalculator: Calendar + Fees ──────────────────────────────────────

/**
 * FeeCalculator calls Calendar: store deduped dates in availableDateList,
 * set phase to "active" so instances can start picking dates.
 */
export function publishCalendarDates(
  feeCalculatorId: number,
  dates: string[]
): CalendarBookingCoordState {
  const fc = Math.max(1, Math.floor(feeCalculatorId));
  const cleanDates = dedupeCalendarDates(dates);
  return updateCalendarBookingState((s) => {
    if (s.feeCalculatorId !== fc) return false;
    s.calendarCalled = true;
    s.availableDateList = cleanDates;
    s.lastCalendarCallerId = fc;
    s.lastCalendarAttemptAt = Date.now();
    if (cleanDates.length > 0) {
      s.phase = "active";
    }
    return true;
  });
}

export function publishSharedFees(instanceId: number, fees: SharedFees): CalendarBookingCoordState {
  const id = Math.max(1, Math.floor(instanceId));
  return updateCalendarBookingState((s) => {
    if (s.feeCalculatorId !== id) return false;
    s.fees = {
      totalAmount: String(fees.totalAmount).trim(),
      currency: fees.currency != null && String(fees.currency).trim() !== "" ? String(fees.currency).trim() : null,
    };
    s.feesDone = true;
    return true;
  });
}

// ── Available date list: atomic pick + remove ───────────────────────────

/**
 * Atomically pick a random date from availableDateList and remove it.
 * Returns the picked date or null if list is empty.
 */
export function pickRandomDate(): string | null {
  let picked: string | null = null;
  updateCalendarBookingState((s) => {
    if (s.availableDateList.length === 0) return false;
    const idx = Math.floor(Math.random() * s.availableDateList.length);
    picked = s.availableDateList[idx]!;
    s.availableDateList.splice(idx, 1);
    return true;
  });
  return picked;
}

// ── Available datetime list: atomic add / pick + remove ─────────────────

/**
 * Add timeslot entries to the shared availableDatetimeList.
 * Each entry is { date, time } like { date: "07/30/2026", time: "10:00-11:00" }.
 */
export function addToAvailableDatetimeList(entries: AvailableDatetime[]): CalendarBookingCoordState {
  return updateCalendarBookingState((s) => {
    for (const e of entries) {
      const dt = { date: e.date.trim(), time: e.time.trim() };
      if (!dt.date || !dt.time) continue;
      s.availableDatetimeList.push(dt);
    }
    return true;
  });
}

/**
 * Atomically pick a random datetime from availableDatetimeList and remove it.
 * Returns the picked entry or null if list is empty.
 */
export function pickRandomDatetime(): AvailableDatetime | null {
  let picked: AvailableDatetime | null = null;
  updateCalendarBookingState((s) => {
    if (s.availableDatetimeList.length === 0) return false;
    const idx = Math.floor(Math.random() * s.availableDatetimeList.length);
    picked = { ...s.availableDatetimeList[idx]! };
    s.availableDatetimeList.splice(idx, 1);
    return true;
  });
  return picked;
}

// ── Calendar round-robin polling (case III) ─────────────────────────────

/** Get the next Calendar polling caller among URN holders (round-robin). */
export function getCalendarPollingCallerId(state: CalendarBookingCoordState): number | null {
  const pollers = activeWaiters(state).filter((id) => state.urnHolders.includes(id));
  if (pollers.length === 0) return null;
  const attempt = Math.max(0, Math.floor(state.calendarAttemptIndex));
  return pollers[attempt % pollers.length] ?? null;
}

export function recordCalendarPollFailure(instanceId: number): CalendarBookingCoordState {
  const id = Math.max(1, Math.floor(instanceId));
  return updateCalendarBookingState((s) => {
    if (s.phase !== "poll" && s.phase !== "calendar_repoll") return false;
    if (getCalendarPollingCallerId(s) !== id) return false;
    s.lastCalendarCallerId = id;
    s.lastCalendarAttemptAt = Date.now();
    s.calendarAttemptIndex = Math.max(0, s.calendarAttemptIndex) + 1;
    return true;
  });
}

/**
 * Calendar round-robin success: store new dates and re-enter active phase.
 */
export function publishCalendarRepollDates(
  callerId: number,
  dates: string[]
): CalendarBookingCoordState {
  const id = Math.max(1, Math.floor(callerId));
  const cleanDates = dedupeCalendarDates(dates);
  return updateCalendarBookingState((s) => {
    if (s.phase !== "calendar_repoll") return false;
    s.lastCalendarCallerId = id;
    s.lastCalendarAttemptAt = Date.now();
    s.calendarCalled = true;
    for (const d of cleanDates) {
      if (!s.availableDateList.includes(d)) s.availableDateList.push(d);
    }
    if (s.availableDateList.length > 0) {
      s.phase = "active";
    }
    return true;
  });
}

/**
 * When both lists are empty and an instance checks: transition to calendar_repoll.
 * Returns true if transition happened (or already in calendar_repoll).
 */
export function enterCalendarRepoll(): boolean {
  let entered = false;
  updateCalendarBookingState((s) => {
    if (s.phase === "calendar_repoll") { entered = true; return false; }
    if (s.availableDateList.length > 0 || s.availableDatetimeList.length > 0) return false;
    s.phase = "calendar_repoll";
    s.calendarAttemptIndex = 0;
    s.lastCalendarAttemptAt = Date.now();
    s.lastCalendarCallerId = null;
    entered = true;
    return true;
  });
  return entered;
}

// ── Schedule result tracking ────────────────────────────────────────────

export function markScheduledSuccess(instanceId: number): CalendarBookingCoordState {
  const id = Math.max(1, Math.floor(instanceId));
  return updateCalendarBookingState((s) => {
    if (!s.scheduled.includes(id)) s.scheduled.push(id);
    s.waiters = s.waiters.filter((w) => w !== id);
    return true;
  });
}

// ── File watcher ────────────────────────────────────────────────────────

export function createCalendarBookingWatcher(): {
  wait: () => Promise<void>;
  dispose: () => void;
} {
  let disposed = false;
  let pending: (() => void) | null = null;

  const notify = (): void => {
    if (disposed) return;
    const p = pending;
    pending = null;
    p?.();
  };

  const wait = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      pending = resolve;
    });
  };

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(process.cwd(), { persistent: false }, (_event, filename) => {
      if (!filename) return;
      if (String(filename).toLowerCase() !== "calendar-booking-coord.json") return;
      setTimeout(notify, 30);
    });
  } catch {
    const interval = setInterval(() => {
      notify();
      if (disposed) clearInterval(interval);
    }, 200);
  }

  const dispose = (): void => {
    disposed = true;
    pending = null;
    try {
      watcher?.close();
    } catch {
      /* ignore */
    }
  };

  return { wait, dispose };
}

// ── Backward compat re-exports (used by other modules) ──────────────────

/** @deprecated Use publishCalendarDates. */
export function beginCalendarSuccessPendingUrnWait(
  feeCalculatorId: number,
  dates: string[]
): CalendarBookingCoordState {
  return publishCalendarDates(feeCalculatorId, dates);
}

/** @deprecated No longer used — kept for import compat. */
export function beginDistributeAfterCalendarSuccess(
  feeCalculatorId: number,
  dates: string[]
): CalendarBookingCoordState {
  return publishCalendarDates(feeCalculatorId, dates);
}

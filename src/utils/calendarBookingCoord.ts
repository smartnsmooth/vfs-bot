/**
 * Fleet coordination for the Calendar-polling booking system.
 *
 * There is no privileged instance: every URN holder is an equal candidate for both
 * the Fees and the Calendar round-robin.
 *
 * Shared state (JSON file) tracks:
 * - urnHolders: instances that got a URN from applicants
 * - fees / totalAmount: one caller at a time, one call each. A miss (504, empty body,
 *   any error) passes the turn to the next instance immediately.
 * - availableDateList: deduped dates from Calendar (consumed by instances for Timeslot)
 * - availableDatetimeList: date+time entries from Timeslot (consumed for Schedule)
 * - calendar round-robin: when both lists are empty, URN holders take turns
 *
 * Whoever gets a successful fees or calendar response publishes it. All writes
 * go through an exclusive lock file and a temp+rename, so a concurrent writer
 * cannot produce a torn read or silently drop a peer's update.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isAmountGetter } from "./amountGetter";

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

  /** Calendar has been called this wave. */
  calendarCalled: boolean;

  /** Deduplicated dates from Calendar — instances pick randomly. */
  availableDateList: string[];
  /** Dates already handed out by `pickRandomDate`, so a late publish cannot resurrect them. */
  consumedDates: string[];
  /** Date+time entries from Timeslot — instances pick randomly. */
  availableDatetimeList: AvailableDatetime[];

  fees: SharedFees | null;
  /** True once a fleet member published a usable totalAmount. */
  feesDone: boolean;
  /** Round-robin pointer among URN holders while `feesDone` is false. */
  feesAttemptIndex: number;
  /** Instance whose one-shot fees call is in flight; null means the seat is free. */
  feesAttemptOwnerId: number | null;
  lastFeesAttemptAt: number;
  lastFeesCallerId: number | null;

  /** Calendar round-robin polling state (case III). */
  calendarAttemptIndex: number;
  /** Instance whose Calendar call is in flight; null means the seat is free. */
  calendarAttemptOwnerId: number | null;
  lastCalendarAttemptAt: number;
  lastCalendarCallerId: number | null;

  /** Successfully scheduled — leave the fleet. */
  scheduled: number[];

  /** Retired instances (1037/1101 etc.) — removed from fleet. */
  retired: number[];
}

const COORD_FILE = join(process.cwd(), "calendar-booking-coord.json");
const LOCK_FILE = join(process.cwd(), "calendar-booking-coord.lock");
const TMP_FILE = `${COORD_FILE}.${process.pid}.tmp`;

/**
 * An attempt seat is held only for as long as one call can plausibly run. If the owner
 * never comes back (killed, or thrown out of the booking loop by a 401) the seat frees
 * itself and the round-robin continues. Calendar gets the longer budget because that
 * call retries 504s and rides out repeated-delay backoff internally.
 */
const FEES_ATTEMPT_STALE_MS = 20_000;
const CALENDAR_ATTEMPT_STALE_MS = 90_000;

/**
 * Head start the instance at the front of the round-robin gets before any other URN
 * holder may take the turn. Long enough for a healthy instance to wake up and claim,
 * short enough that one stuck in relogin barely costs the fleet anything.
 */
const FEES_TURN_GRACE_MS = 750;
const CALENDAR_TURN_GRACE_MS = 2_500;

/**
 * Minimum gap before the *same* instance may call fees again. Only bites once the
 * round-robin has come all the way back around, so it never delays a peer.
 */
const FEES_SELF_RETRY_GAP_MS = 1_500;

/** Bound on `consumedDates` so a long run cannot grow the file without limit. */
const MAX_CONSUMED_DATES = 200;

function emptyState(): CalendarBookingCoordState {
  return {
    revision: 0,
    phase: "poll",
    waiters: [],
    urnHolders: [],
    calendarCalled: false,
    availableDateList: [],
    consumedDates: [],
    availableDatetimeList: [],
    fees: null,
    feesDone: false,
    feesAttemptIndex: 0,
    feesAttemptOwnerId: null,
    lastFeesAttemptAt: 0,
    lastFeesCallerId: null,
    calendarAttemptIndex: 0,
    calendarAttemptOwnerId: null,
    lastCalendarAttemptAt: 0,
    lastCalendarCallerId: null,
    scheduled: [],
    retired: [],
  };
}

function normalizeState(raw: Partial<CalendarBookingCoordState> | null | undefined): CalendarBookingCoordState {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;

  const safeIntArray = (arr: unknown): number[] =>
    Array.isArray(arr) ? arr.map((n) => Math.floor(Number(n))).filter((n) => n >= 1) : [];

  const safeCount = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;

  const safeId = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : null;

  const safeStringArray = (arr: unknown): string[] =>
    Array.isArray(arr) ? arr.map((d) => String(d).trim()).filter(Boolean) : [];

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
    revision: safeCount(raw.revision),
    phase: raw.phase === "active" || raw.phase === "calendar_repoll" ? raw.phase : "poll",
    waiters: safeIntArray(raw.waiters),
    urnHolders: safeIntArray(raw.urnHolders),
    calendarCalled: raw.calendarCalled === true,
    availableDateList: safeStringArray(raw.availableDateList),
    consumedDates: safeStringArray(raw.consumedDates).slice(-MAX_CONSUMED_DATES),
    availableDatetimeList: safeDatetimeArray(raw.availableDatetimeList),
    fees: raw.fees && typeof raw.fees === "object" && typeof (raw.fees as SharedFees).totalAmount === "string"
      ? raw.fees as SharedFees
      : null,
    feesDone: raw.feesDone === true,
    feesAttemptIndex: safeCount(raw.feesAttemptIndex),
    feesAttemptOwnerId: safeId(raw.feesAttemptOwnerId),
    lastFeesAttemptAt: safeCount(raw.lastFeesAttemptAt),
    lastFeesCallerId: safeId(raw.lastFeesCallerId),
    calendarAttemptIndex: safeCount(raw.calendarAttemptIndex),
    calendarAttemptOwnerId: safeId(raw.calendarAttemptOwnerId),
    lastCalendarAttemptAt: safeCount(raw.lastCalendarAttemptAt),
    lastCalendarCallerId: safeId(raw.lastCalendarCallerId),
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

/** Temp+rename so a reader never observes a half-written file. */
function writeStateAtomic(state: CalendarBookingCoordState): boolean {
  try {
    writeFileSync(TMP_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(TMP_FILE, COORD_FILE);
      return true;
    } catch {
      spinWait(2);
    }
  }
  try {
    if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE);
  } catch {
    /* ignore */
  }
  return false;
}

function spinWait(ms: number): void {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    /* no sync sleep primitive in node — spin briefly while contending for the lock */
  }
}

function maybeClearStaleLock(maxAgeMs = 2_000): void {
  try {
    if (!existsSync(LOCK_FILE)) return;
    if (Date.now() - statSync(LOCK_FILE).mtimeMs > maxAgeMs) unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

/** Lock is held only for one sync read+write, so a short total budget suffices. */
const LOCK_WAIT_BUDGET_MS = 400;

function withCoordLock<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  const deadline = Date.now() + LOCK_WAIT_BUDGET_MS;
  let attempt = 0;
  do {
    maybeClearStaleLock();
    let fd: number | null = null;
    try {
      fd = openSync(LOCK_FILE, "wx");
    } catch {
      fd = null;
    }
    if (fd != null) {
      try {
        return { ok: true, value: fn() };
      } finally {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(LOCK_FILE);
        } catch {
          /* ignore */
        }
      }
    }
    spinWait(1 + (attempt++ % 5));
  } while (Date.now() < deadline);
  return { ok: false };
}

export type MutateOutcome = "applied" | "declined" | "failed";

export interface MutateResult {
  state: CalendarBookingCoordState;
  outcome: MutateOutcome;
}

/**
 * Read-modify-write the shared state under the lock.
 *
 * `declined` means the mutator chose not to change anything; `failed` means the
 * write could not be made (lock contention or rename failure) and the caller
 * should retry. Nothing is ever written outside the lock, so a failed attempt
 * leaves peer updates intact rather than overwriting them.
 */
export function mutateCalendarBookingState(
  mutator: (state: CalendarBookingCoordState) => boolean
): MutateResult {
  const res = withCoordLock<MutateResult>(() => {
    const cur = readCalendarBookingState();
    const next = structuredClone(cur) as CalendarBookingCoordState;
    if (!mutator(next)) return { state: cur, outcome: "declined" };
    next.revision = cur.revision + 1;
    if (!writeStateAtomic(next)) return { state: cur, outcome: "failed" };
    return { state: next, outcome: "applied" };
  });
  if (res.ok) return res.value;
  return { state: readCalendarBookingState(), outcome: "failed" };
}

export function updateCalendarBookingState(
  mutator: (state: CalendarBookingCoordState) => boolean
): CalendarBookingCoordState {
  return mutateCalendarBookingState(mutator).state;
}

export function clearCalendarBookingCoord(): void {
  for (const f of [COORD_FILE, LOCK_FILE, TMP_FILE]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
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
  // The amountGetter holds a URN but never books — keeping it out of the holder
  // list stops the fees round-robin handing turns to an instance that is not there.
  if (isAmountGetter(id)) return readCalendarBookingState();
  return updateCalendarBookingState((s) => {
    // URN is the source of truth: un-retire so a prior 1037/1101 cannot keep this
    // instance out of the fees and calendar round-robins.
    const wasRetired = s.retired.includes(id);
    const wasHolder = s.urnHolders.includes(id);
    const wasWaiter = s.waiters.includes(id);
    if (!wasRetired && wasHolder && wasWaiter) return false;

    s.retired = s.retired.filter((n) => n !== id);
    if (!wasHolder) s.urnHolders.push(id);
    s.urnHolders = [...new Set(s.urnHolders)].filter((n) => n >= 1).sort((a, b) => a - b);
    if (!wasWaiter) s.waiters.push(id);
    s.waiters = [...new Set(s.waiters)].filter((n) => n >= 1).sort((a, b) => a - b);
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
  if (isAmountGetter(id)) return readCalendarBookingState();
  return updateCalendarBookingState((s) => {
    if (s.retired.includes(id)) return false;
    // Called on every loop iteration by every instance — only write when it changes something.
    if (s.waiters.includes(id)) return false;
    s.waiters = [...new Set([...s.waiters, id])].filter((n) => n >= 1).sort((a, b) => a - b);
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
    if (s.feesAttemptOwnerId === id) {
      s.feesAttemptOwnerId = null;
      s.feesAttemptIndex = Math.max(0, s.feesAttemptIndex) + 1;
    }
    if (s.calendarAttemptOwnerId === id) {
      s.calendarAttemptOwnerId = null;
      s.lastCalendarAttemptAt = 0;
      s.calendarAttemptIndex = Math.max(0, s.calendarAttemptIndex) + 1;
    }
    return true;
  });
}

// ── Fees: one call at a time, one shot each ─────────────────────────────

function roundRobinCallers(s: CalendarBookingCoordState): number[] {
  return activeWaiters(s).filter((id) => s.urnHolders.includes(id));
}

/**
 * A turn is a preference, not a right. The instance at the front of the round-robin
 * gets a head start; after that any URN holder may take the turn, so a peer that is
 * mid-relogin or gone for good cannot stall the whole fleet.
 */
function turnIsOpenTo(opts: {
  id: number;
  preferred: number | null;
  openedAt: number;
  graceMs: number;
  now: number;
}): boolean {
  if (opts.preferred === opts.id) return true;
  if (opts.openedAt <= 0) return true;
  return opts.now - opts.openedAt >= opts.graceMs;
}

/**
 * Instance whose turn it is to call Fees — the in-flight owner while a call is
 * running, otherwise the next URN holder in the round-robin. Null once the fleet
 * has a totalAmount or while nobody holds a URN.
 */
export function getFeesCallerId(
  state: CalendarBookingCoordState,
  now: number = Date.now()
): number | null {
  if (state.feesDone) return null;
  const callers = roundRobinCallers(state);
  if (callers.length === 0) return null;
  const owner = state.feesAttemptOwnerId;
  if (owner != null && now - state.lastFeesAttemptAt < FEES_ATTEMPT_STALE_MS) return owner;
  const idx = Math.max(0, Math.floor(state.feesAttemptIndex));
  return callers[idx % callers.length] ?? null;
}

/**
 * Take the fees seat for exactly one call.
 *
 * The seat is held only while that call is in flight; `releaseFeesAttempt` hands it
 * to the next instance the moment the call comes back without a totalAmount, so a
 * miss costs the fleet one request rather than a retry loop.
 */
export function claimFeesAttempt(instanceId: number): boolean {
  const id = Math.max(1, Math.floor(instanceId));
  let claimed = false;
  const r = mutateCalendarBookingState((s) => {
    if (s.feesDone) return false;
    const now = Date.now();
    if (!roundRobinCallers(s).includes(id)) return false;
    const owner = s.feesAttemptOwnerId;
    if (owner != null && owner !== id && now - s.lastFeesAttemptAt < FEES_ATTEMPT_STALE_MS) return false;
    if (s.lastFeesCallerId === id && now - s.lastFeesAttemptAt < FEES_SELF_RETRY_GAP_MS) return false;
    if (
      !turnIsOpenTo({
        id,
        preferred: getFeesCallerId(s, now),
        openedAt: s.lastFeesAttemptAt,
        graceMs: FEES_TURN_GRACE_MS,
        now,
      })
    ) {
      return false;
    }
    s.feesAttemptOwnerId = id;
    s.lastFeesCallerId = id;
    s.lastFeesAttemptAt = now;
    claimed = true;
    return true;
  });
  return claimed && r.outcome === "applied";
}

/**
 * The call came back without a totalAmount — 504, empty body, error, it makes no
 * difference. Advance the round-robin so the next instance can call right away; this
 * instance is free to try again later without anyone waiting on it.
 */
export function releaseFeesAttempt(instanceId: number): CalendarBookingCoordState {
  const id = Math.max(1, Math.floor(instanceId));
  return updateCalendarBookingState((s) => {
    if (s.feesAttemptOwnerId !== id) return false;
    s.feesAttemptOwnerId = null;
    s.feesAttemptIndex = Math.max(0, s.feesAttemptIndex) + 1;
    return true;
  });
}

// ── Publishing Calendar + Fees results ──────────────────────────────────

/** Any URN holder that is still in the fleet may publish a successful response. */
function publisherIsEligible(s: CalendarBookingCoordState, id: number): boolean {
  return s.urnHolders.includes(id) && !s.retired.includes(id);
}

/**
 * Publish Calendar dates. Merges into `availableDateList` rather than replacing
 * it, and skips dates already handed out, so a publish that lands after peers
 * started consuming cannot resurrect a taken date or drop a fresh one.
 *
 * A response that brings nothing usable rotates the round-robin, so the next poll
 * comes from a different instance.
 *
 * Returns true when the state now reflects this call.
 */
export function publishCalendarDates(publisherId: number, dates: string[]): boolean {
  const id = Math.max(1, Math.floor(publisherId));
  const cleanDates = dedupeCalendarDates(dates);
  const r = mutateCalendarBookingState((s) => {
    if (!publisherIsEligible(s, id)) return false;
    s.calendarCalled = true;
    s.lastCalendarCallerId = id;
    s.lastCalendarAttemptAt = Date.now();
    if (s.calendarAttemptOwnerId === id) s.calendarAttemptOwnerId = null;
    const consumed = new Set(s.consumedDates);
    for (const d of cleanDates) {
      if (consumed.has(d) || s.availableDateList.includes(d)) continue;
      s.availableDateList.push(d);
    }
    if (s.availableDateList.length > 0) {
      s.phase = "active";
    } else {
      s.calendarAttemptIndex = Math.max(0, s.calendarAttemptIndex) + 1;
    }
    return true;
  });
  return r.outcome === "applied";
}

/**
 * Publish shared fees. First successful caller wins, whoever it is — an instance
 * that missed its turn but still came back with an amount latches it for the fleet.
 *
 * Returns true when shared fees are present (published now or already there).
 */
export function publishSharedFees(publisherId: number, fees: SharedFees): boolean {
  const id = Math.max(1, Math.floor(publisherId));
  const totalAmount = String(fees.totalAmount).trim();
  if (!totalAmount) return false;
  let alreadyPublished = false;
  const r = mutateCalendarBookingState((s) => {
    if (s.feesDone && s.fees?.totalAmount?.trim()) {
      alreadyPublished = true;
      return false;
    }
    if (!publisherIsEligible(s, id)) return false;
    s.fees = {
      totalAmount,
      currency: fees.currency != null && String(fees.currency).trim() !== "" ? String(fees.currency).trim() : null,
    };
    s.feesDone = true;
    s.feesAttemptOwnerId = null;
    return true;
  });
  return alreadyPublished || r.outcome === "applied";
}

// ── Available date list: atomic pick + remove ───────────────────────────

/**
 * Atomically pick a random date from availableDateList and remove it.
 * Returns the picked date or null if list is empty.
 */
export function pickRandomDate(): string | null {
  let picked: string | null = null;
  const r = mutateCalendarBookingState((s) => {
    if (s.availableDateList.length === 0) return false;
    const idx = Math.floor(Math.random() * s.availableDateList.length);
    picked = s.availableDateList[idx]!;
    s.availableDateList.splice(idx, 1);
    if (!s.consumedDates.includes(picked)) s.consumedDates.push(picked);
    if (s.consumedDates.length > MAX_CONSUMED_DATES) {
      s.consumedDates = s.consumedDates.slice(-MAX_CONSUMED_DATES);
    }
    return true;
  });
  // A failed write means the removal was not recorded, so another instance still
  // owns this date — do not act on it.
  return r.outcome === "applied" ? picked : null;
}

// ── Available datetime list: atomic add / pick + remove ─────────────────

/**
 * Add timeslot entries to the shared availableDatetimeList.
 * Each entry is { date, time } like { date: "07/30/2026", time: "10:00-11:00" }.
 */
export function addToAvailableDatetimeList(entries: AvailableDatetime[]): CalendarBookingCoordState {
  return updateCalendarBookingState((s) => {
    let changed = false;
    for (const e of entries) {
      const dt = { date: e.date.trim(), time: e.time.trim() };
      if (!dt.date || !dt.time) continue;
      // Several instances hand back the same date's slots, so keep one entry per date+time.
      if (s.availableDatetimeList.some((x) => x.date === dt.date && x.time === dt.time)) continue;
      s.availableDatetimeList.push(dt);
      changed = true;
    }
    return changed;
  });
}

/**
 * Atomically pick a random datetime from availableDatetimeList and remove it.
 * Returns the picked entry or null if list is empty.
 */
export function pickRandomDatetime(): AvailableDatetime | null {
  let picked: AvailableDatetime | null = null;
  const r = mutateCalendarBookingState((s) => {
    if (s.availableDatetimeList.length === 0) return false;
    const idx = Math.floor(Math.random() * s.availableDatetimeList.length);
    picked = { ...s.availableDatetimeList[idx]! };
    s.availableDatetimeList.splice(idx, 1);
    return true;
  });
  return r.outcome === "applied" ? picked : null;
}

// ── Calendar round-robin polling (case III) ─────────────────────────────

/** Get the next Calendar polling caller among URN holders (round-robin). */
export function getCalendarPollingCallerId(state: CalendarBookingCoordState): number | null {
  const pollers = roundRobinCallers(state);
  if (pollers.length === 0) return null;
  const attempt = Math.max(0, Math.floor(state.calendarAttemptIndex));
  return pollers[attempt % pollers.length] ?? null;
}

/**
 * Take the Calendar seat for one call. `intervalMs` is the configured re-poll gap:
 * a fresh call is only allowed once that long has passed since the last attempt.
 */
export function claimCalendarAttempt(instanceId: number, intervalMs: number): boolean {
  const id = Math.max(1, Math.floor(instanceId));
  let claimed = false;
  const r = mutateCalendarBookingState((s) => {
    const now = Date.now();
    if (!roundRobinCallers(s).includes(id)) return false;
    const owner = s.calendarAttemptOwnerId;
    if (owner != null && owner !== id && now - s.lastCalendarAttemptAt < CALENDAR_ATTEMPT_STALE_MS) return false;
    const gap = Math.max(0, intervalMs);
    if (s.lastCalendarAttemptAt > 0 && now - s.lastCalendarAttemptAt < gap) return false;
    if (
      !turnIsOpenTo({
        id,
        preferred: getCalendarPollingCallerId(s),
        // The turn opens when the re-poll interval expires, not when the last call started.
        openedAt: s.lastCalendarAttemptAt > 0 ? s.lastCalendarAttemptAt + gap : 0,
        graceMs: CALENDAR_TURN_GRACE_MS,
        now,
      })
    ) {
      return false;
    }
    s.calendarAttemptOwnerId = id;
    s.lastCalendarCallerId = id;
    s.lastCalendarAttemptAt = now;
    claimed = true;
    return true;
  });
  return claimed && r.outcome === "applied";
}

/**
 * Calendar call came back with nothing to publish. Rotate to the next poller and
 * clear the interval gate: the polling interval exists to space out "no slots"
 * answers, not to punish a request that never landed.
 */
export function releaseCalendarAttempt(instanceId: number): CalendarBookingCoordState {
  const id = Math.max(1, Math.floor(instanceId));
  return updateCalendarBookingState((s) => {
    if (s.calendarAttemptOwnerId !== id) return false;
    s.calendarAttemptOwnerId = null;
    s.lastCalendarAttemptAt = 0;
    s.calendarAttemptIndex = Math.max(0, s.calendarAttemptIndex) + 1;
    return true;
  });
}

/**
 * When both lists are empty and an instance checks: transition to calendar_repoll.
 * Returns true if transition happened (or already in calendar_repoll).
 */
export function enterCalendarRepoll(): boolean {
  let entered = false;
  mutateCalendarBookingState((s) => {
    if (s.phase === "calendar_repoll") { entered = true; return false; }
    if (s.availableDateList.length > 0 || s.availableDatetimeList.length > 0) return false;
    s.phase = "calendar_repoll";
    s.calendarAttemptIndex = 0;
    s.calendarAttemptOwnerId = null;
    // No attempt yet in this round, so the first caller goes without waiting out the interval.
    s.lastCalendarAttemptAt = 0;
    s.lastCalendarCallerId = null;
    // Fresh round: a date that went nowhere last round may have opened up again.
    s.consumedDates = [];
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

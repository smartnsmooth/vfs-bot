/**
 * Fleet-wide CheckIsSlotAvailable scheduler.
 *
 * - One poll every `userPollInterval` across the fleet.
 * - Round-robin among registered (prepared) pollers so the same bot cannot
 *   monopolize consecutive slots.
 * - If the expected bot misses its turn (recovering / not ready), another
 *   registered bot may claim after a short grace — gap fill, no dead air.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getFleetPollStepMs, getFleetWorkerIds } from "./fleetPollSchedule";
import { isAmountGetter } from "./amountGetter";

export interface FleetPollCoordState {
  revision: number;
  /** ms timestamp of the last successful claim (0 = never). */
  lastPollAt: number;
  lastPollerId: number | null;
  /** Absolute earliest time any bot may claim (fleet gate / pollStartAt). */
  earliestPollAt: number;
  /** Next instance id that should poll (round-robin). */
  nextPollerId: number;
  /** Instances currently in the poll loop (prepared). */
  activePollers: number[];
}

const COORD_FILE = join(process.cwd(), "fleet-poll-coord.json");
const LOCK_FILE = join(process.cwd(), "fleet-poll-coord.lock");

/** Lowest instance id allowed to poll (skips the amountGetter). */
function defaultNextPollerId(): number {
  return getFleetWorkerIds()[0] ?? 1;
}

function emptyState(): FleetPollCoordState {
  return {
    revision: 0,
    lastPollAt: 0,
    lastPollerId: null,
    earliestPollAt: 0,
    nextPollerId: defaultNextPollerId(),
    activePollers: [],
  };
}

function safeIdArray(arr: unknown): number[] {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((n) => Math.floor(Number(n))).filter((n) => n >= 1))].sort((a, b) => a - b);
}

function normalizeState(raw: Partial<FleetPollCoordState> | null | undefined): FleetPollCoordState {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  const active = safeIdArray(raw.activePollers).filter((id) => !isAmountGetter(id));
  const nextRaw =
    typeof raw.nextPollerId === "number" && Number.isFinite(raw.nextPollerId) && raw.nextPollerId >= 1
      ? Math.floor(raw.nextPollerId)
      : defaultNextPollerId();
  return {
    revision: typeof raw.revision === "number" && Number.isFinite(raw.revision) ? Math.max(0, Math.floor(raw.revision)) : 0,
    lastPollAt: typeof raw.lastPollAt === "number" && Number.isFinite(raw.lastPollAt) ? Math.max(0, Math.floor(raw.lastPollAt)) : 0,
    lastPollerId:
      typeof raw.lastPollerId === "number" && Number.isFinite(raw.lastPollerId) && raw.lastPollerId >= 1
        ? Math.floor(raw.lastPollerId)
        : null,
    earliestPollAt:
      typeof raw.earliestPollAt === "number" && Number.isFinite(raw.earliestPollAt)
        ? Math.max(0, Math.floor(raw.earliestPollAt))
        : 0,
    nextPollerId: nextRaw,
    activePollers: active,
  };
}

function readState(): FleetPollCoordState {
  try {
    if (!existsSync(COORD_FILE)) return emptyState();
    return normalizeState(JSON.parse(readFileSync(COORD_FILE, "utf8")) as Partial<FleetPollCoordState>);
  } catch {
    return emptyState();
  }
}

function writeState(state: FleetPollCoordState): void {
  writeFileSync(COORD_FILE, JSON.stringify(state, null, 2), "utf8");
}

function tryAcquireLock(): number | null {
  try {
    return openSync(LOCK_FILE, "wx");
  } catch {
    return null;
  }
}

function releaseLock(fd: number | null): void {
  if (fd == null) return;
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

function maybeClearStaleLock(maxAgeMs = 15_000): void {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const { mtimeMs } = statSync(LOCK_FILE);
    if (Date.now() - mtimeMs > maxAgeMs) {
      unlinkSync(LOCK_FILE);
    }
  } catch {
    /* ignore */
  }
}

function withExclusiveLock<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  maybeClearStaleLock();
  const fd = tryAcquireLock();
  if (fd == null) return { ok: false };
  try {
    return { ok: true, value: fn() };
  } finally {
    releaseLock(fd);
  }
}

function spinWait(ms: number): void {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    /* spin */
  }
}

/** How long after a slot is due before another bot may gap-fill. */
function turnGraceMs(stepMs: number): number {
  return Math.min(1500, Math.max(400, Math.floor(stepMs * 0.25)));
}

function pollerRing(state: FleetPollCoordState): number[] {
  if (state.activePollers.length > 0) return state.activePollers;
  return getFleetWorkerIds();
}

/** Advance round-robin past `currentNext` within the active ring. */
function advanceNextPoller(ring: number[], currentNext: number): number {
  if (ring.length === 0) return 1;
  const idx = ring.indexOf(currentNext);
  if (idx >= 0) return ring[(idx + 1) % ring.length]!;
  const ge = ring.find((x) => x >= currentNext);
  return ge ?? ring[0]!;
}

function resolveExpected(state: FleetPollCoordState): number {
  const ring = pollerRing(state);
  if (ring.length === 0) return Math.max(1, state.nextPollerId || 1);
  if (ring.includes(state.nextPollerId)) return state.nextPollerId;
  return advanceNextPoller(ring, state.nextPollerId || 0);
}

export function clearFleetPollCoord(): void {
  try {
    if (existsSync(COORD_FILE)) unlinkSync(COORD_FILE);
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

/** First writer sets the fleet gate; later calls keep the existing earliest time. */
export function ensureFleetPollEarliest(earliestPollAtMs: number): void {
  const t = Math.max(0, Math.floor(earliestPollAtMs));
  if (t <= 0) return;

  for (let attempt = 0; attempt < 80; attempt++) {
    const result = withExclusiveLock(() => {
      const s = readState();
      if (s.earliestPollAt > 0) return false;
      s.earliestPollAt = t;
      if (!s.nextPollerId || s.nextPollerId < 1) s.nextPollerId = defaultNextPollerId();
      s.revision += 1;
      writeState(s);
      return true;
    });
    if (result.ok) return;
    spinWait(5 + attempt);
  }
}

/** Mark this instance as an active fleet poller (call when entering the poll loop). */
export function registerFleetPoller(instanceId: number): void {
  const id = Math.max(1, Math.floor(instanceId));
  if (isAmountGetter(id)) return;
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = withExclusiveLock(() => {
      const s = readState();
      if (s.activePollers.includes(id)) return false;
      s.activePollers = safeIdArray([...s.activePollers, id]);
      if (!s.activePollers.includes(s.nextPollerId)) {
        s.nextPollerId = s.activePollers[0] ?? 1;
      }
      s.revision += 1;
      writeState(s);
      return true;
    });
    if (result.ok) return;
    spinWait(5 + attempt);
  }
}

/** Remove this instance from the active ring (call when leaving the poll loop). */
export function unregisterFleetPoller(instanceId: number): void {
  const id = Math.max(1, Math.floor(instanceId));
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = withExclusiveLock(() => {
      const s = readState();
      if (!s.activePollers.includes(id)) return false;
      s.activePollers = s.activePollers.filter((x) => x !== id);
      if (s.nextPollerId === id) {
        s.nextPollerId = advanceNextPoller(pollerRing(s), id);
      }
      s.revision += 1;
      writeState(s);
      return true;
    });
    if (result.ok) return;
    spinWait(5 + attempt);
  }
}

function nextClaimAtMs(state: FleetPollCoordState, stepMs: number, now: number): number {
  const gate = state.earliestPollAt > 0 ? state.earliestPollAt : now;
  if (state.lastPollAt <= 0) return gate;
  return Math.max(gate, state.lastPollAt + stepMs);
}

/**
 * Wait until this instance owns the next fleet poll slot (round-robin).
 * Spacing between any two fleet polls = configured poll interval.
 */
export async function waitAndClaimFleetPollSlot(opts: {
  instanceId: number;
  waitUntil: (targetAtMs: number) => Promise<"timer" | "slot" | "abort">;
}): Promise<"claimed" | "slot" | "abort"> {
  const id = Math.max(1, Math.floor(opts.instanceId));

  for (;;) {
    const stepMs = getFleetPollStepMs();
    const grace = turnGraceMs(stepMs);
    const state = readState();
    const now = Date.now();
    const dueAt = nextClaimAtMs(state, stepMs, now);
    const expected = resolveExpected(state);
    const isMyTurn = id === expected;
    // Own turn: claim at `due`. Others: only after grace (gap fill).
    const myEligibleAt = isMyTurn ? dueAt : dueAt + grace;

    if (now < myEligibleAt) {
      // Wake early in slices so we notice when the turn pointer moves to us.
      const wakeAt = Math.min(myEligibleAt, now + 250);
      const woke = await opts.waitUntil(wakeAt);
      if (woke !== "timer") return woke;
      continue;
    }

    const result = withExclusiveLock(() => {
      const s = readState();
      const step = getFleetPollStepMs();
      const g = turnGraceMs(step);
      const due = nextClaimAtMs(s, step, Date.now());
      const t = Date.now();
      if (t < due) return false;

      const exp = resolveExpected(s);
      if (id !== exp && t < due + g) return false;

      const ring = pollerRing(s);
      s.lastPollAt = t;
      s.lastPollerId = id;
      s.nextPollerId = advanceNextPoller(ring, exp);
      s.revision += 1;
      writeState(s);
      return true;
    });

    if (result.ok && result.value) return "claimed";

    // Lost race / not our turn — wait for next opportunity.
    const after = readState();
    const nextDue = nextClaimAtMs(after, getFleetPollStepMs(), Date.now());
    const nextExp = resolveExpected(after);
    const nextGrace = turnGraceMs(getFleetPollStepMs());
    const nextMine = id === nextExp ? nextDue : nextDue + nextGrace;
    if (Date.now() < nextMine) {
      const woke = await opts.waitUntil(Math.min(nextMine, Date.now() + 250));
      if (woke !== "timer") return woke;
    } else {
      await new Promise<void>((r) => setTimeout(r, 20 + Math.floor(Math.random() * 40)));
    }
  }
}

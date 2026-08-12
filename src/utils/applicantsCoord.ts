/**
 * Fleet coordination for POST /appointment/applicants after a slot hit.
 *
 * After a poll 1036 ("apologies") hit, bots call applicants one-by-one on a
 * round-robin schedule using `apologiesIntervalSec` from the setup form.
 * Real slot hits rely on join stagger only. When any bot receives a URN, peers
 * wake immediately and call applicants after a short finder-first join stagger
 * (`applicantsJoinStaggerSec` from the setup form).
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, watch } from "node:fs";
import { join } from "node:path";
export interface ApplicantsCoordState {
  /** Shared T0 for round-robin (usually slot-found timestamp). */
  waveStartedAt: number;
  /** True once any instance saved applicants and got a URN. */
  urnUnlocked: boolean;
  urnUnlockedBy?: number;
  urnUnlockedAt?: number;
}

const COORD_FILE = join(process.cwd(), "applicants-coord.json");

function readState(): ApplicantsCoordState | null {
  try {
    if (!existsSync(COORD_FILE)) return null;
    return JSON.parse(readFileSync(COORD_FILE, "utf8")) as ApplicantsCoordState;
  } catch {
    return null;
  }
}

function writeState(state: ApplicantsCoordState): void {
  try {
    writeFileSync(COORD_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
      }
}

/** Start (or keep) the applicants wave clock. First writer wins. */
export function ensureApplicantsWave(startedAtMs: number): number {
  const cur = readState();
  if (cur?.waveStartedAt) return cur.waveStartedAt;
  return resetApplicantsWave(startedAtMs);
}

/** Force a new round-robin clock (new slot hit / after recovery). Clears URN unlock. */
export function resetApplicantsWave(startedAtMs: number): number {
  const waveStartedAt = Math.max(1, Math.floor(startedAtMs));
  writeState({
    waveStartedAt,
    urnUnlocked: false,
  });
    return waveStartedAt;
}

export function getApplicantsWaveStartedAt(): number {
  return readState()?.waveStartedAt ?? 0;
}

export function isApplicantsUrnUnlocked(): boolean {
  return readState()?.urnUnlocked === true;
}

/** URN unlock finder + timestamp for join stagger (0 when not unlocked). */
export function getApplicantsUrnUnlockMeta(): {
  unlocked: boolean;
  unlockedBy: number;
  unlockedAt: number;
} {
  const cur = readState();
  if (!cur?.urnUnlocked) {
    return { unlocked: false, unlockedBy: 0, unlockedAt: 0 };
  }
  return {
    unlocked: true,
    unlockedBy: typeof cur.urnUnlockedBy === "number" && cur.urnUnlockedBy >= 1 ? Math.floor(cur.urnUnlockedBy) : 1,
    unlockedAt: typeof cur.urnUnlockedAt === "number" && cur.urnUnlockedAt > 0 ? cur.urnUnlockedAt : Date.now(),
  };
}

export function markApplicantsUrnUnlocked(instanceId: number): void {
  const cur = readState() ?? { waveStartedAt: Date.now(), urnUnlocked: false };
  if (cur.urnUnlocked) return;
  cur.urnUnlocked = true;
  cur.urnUnlockedBy = instanceId;
  cur.urnUnlockedAt = Date.now();
  writeState(cur);
  }

export function clearApplicantsCoord(): void {
  try {
    if (existsSync(COORD_FILE)) {
      unlinkSync(COORD_FILE);
          }
  } catch (err) {
      }
}

/**
 * Target time for this bot's Nth applicants attempt (0-based), round-robin:
 *   T0 + (instanceId-1)×step + attempt×(numInstances×step)
 */
export function applicantsAttemptTargetMs(
  instanceId: number,
  attemptIndex: number,
  stepMs: number,
  numInstances: number
): number {
  const id = Math.max(1, Math.floor(instanceId));
  const n = Math.max(1, Math.floor(numInstances));
  const step = Math.max(1000, Math.floor(stepMs));
  const k = Math.max(0, Math.floor(attemptIndex));
  const wave = getApplicantsWaveStartedAt() || Date.now();
  return wave + (id - 1) * step + k * (n * step);
}

/**
 * Next scheduled applicants slot for this instance (never in the past).
 * Late bots wait for their next round-robin turn instead of firing immediately.
 */
export function nextApplicantsAttemptTargetMs(
  instanceId: number,
  attemptIndex: number,
  stepMs: number,
  numInstances: number,
  nowMs: number = Date.now()
): number {
  const id = Math.max(1, Math.floor(instanceId));
  const n = Math.max(1, Math.floor(numInstances));
  const step = Math.max(1000, Math.floor(stepMs));
  const cycleMs = step * n;
  const wave = getApplicantsWaveStartedAt() || nowMs;
  const offset = (id - 1) * step;
  const attempt = Math.max(0, Math.floor(attemptIndex));

  let target = wave + offset + attempt * cycleMs;
  if (target > nowMs) return target;

  const elapsed = nowMs - wave - offset;
  let k = Math.max(attempt, Math.ceil(elapsed / cycleMs));
  target = wave + offset + k * cycleMs;
  if (target <= nowMs) target += cycleMs;
  return target;
}

/**
 * Watch for URN unlock from a peer. Resolves when unlocked (or immediately if already).
 */
export function createApplicantsUrnUnlockWatcher(): {
  wait: () => Promise<void>;
  dispose: () => void;
} {
  let disposed = false;
  let resolved = false;
  let pending: (() => void) | null = null;

  const settle = (): void => {
    if (disposed || resolved) return;
    if (!isApplicantsUrnUnlocked()) return;
    resolved = true;
    const p = pending;
    pending = null;
    p?.();
  };

  const wait = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (isApplicantsUrnUnlocked()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      pending = resolve;
      settle();
    });
  };

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(process.cwd(), { persistent: false }, (_event, filename) => {
      if (!filename) return;
      if (String(filename).toLowerCase() !== "applicants-coord.json") return;
      setTimeout(settle, 30);
    });
  } catch {
    const interval = setInterval(() => {
      settle();
      if (disposed || resolved) clearInterval(interval);
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

/**
 * Fleet coordination for POST /appointment/applicants after a slot hit.
 *
 * Bots call applicants one-by-one on a round-robin schedule using
 * `applicantsIntervalSec` from the setup form (independent of CheckIsSlotAvailable
 * poll interval). When any bot receives a URN, peers wake immediately and call
 * applicants without waiting for their next stagger slot.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, watch } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger";

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
    logger.error({ err }, "Failed to write applicants-coord state");
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
  logger.info({ waveStartedAt }, "[ApplicantsCoord] Wave started/reset");
  return waveStartedAt;
}

export function getApplicantsWaveStartedAt(): number {
  return readState()?.waveStartedAt ?? 0;
}

export function isApplicantsUrnUnlocked(): boolean {
  return readState()?.urnUnlocked === true;
}

export function markApplicantsUrnUnlocked(instanceId: number): void {
  const cur = readState() ?? { waveStartedAt: Date.now(), urnUnlocked: false };
  if (cur.urnUnlocked) return;
  cur.urnUnlocked = true;
  cur.urnUnlockedBy = instanceId;
  cur.urnUnlockedAt = Date.now();
  writeState(cur);
  logger.info({ instanceId }, "[ApplicantsCoord] URN unlocked — peers should call applicants immediately");
}

export function clearApplicantsCoord(): void {
  try {
    if (existsSync(COORD_FILE)) {
      unlinkSync(COORD_FILE);
      logger.info("Cleared applicants-coord state");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to clear applicants-coord state");
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

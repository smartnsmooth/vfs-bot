/**
 * Fleet-wide join-stagger bump, kept in its own file.
 *
 * Every Lift API 504 bumps this, so during an outage burst it is written far more
 * often than anything else in the fleet. It lives apart from
 * `calendar-booking-coord.json` so that write volume cannot clobber booking
 * coordination state (urnHolders / feesDone / totalAmount / date lists).
 */

import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getApplicantsJoinStaggerMs } from "./fleetPollSchedule";

interface JoinStaggerState {
  extraMs: number;
}

const STATE_FILE = join(process.cwd(), "join-stagger-coord.json");
const LOCK_FILE = join(process.cwd(), "join-stagger-coord.lock");
const TMP_FILE = `${STATE_FILE}.${process.pid}.tmp`;

/** Cap so a long outage cannot stagger the fleet into never joining a wave. */
const MAX_EXTRA_MS = 30_000;
const BUMP_STEP_MS = 500;

function readState(): JoinStaggerState {
  try {
    if (!existsSync(STATE_FILE)) return { extraMs: 0 };
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<JoinStaggerState>;
    const extra = typeof raw?.extraMs === "number" && Number.isFinite(raw.extraMs) ? raw.extraMs : 0;
    return { extraMs: Math.min(MAX_EXTRA_MS, Math.max(0, Math.floor(extra))) };
  } catch {
    return { extraMs: 0 };
  }
}

function writeStateAtomic(state: JoinStaggerState): void {
  try {
    writeFileSync(TMP_FILE, JSON.stringify(state), "utf8");
    renameSync(TMP_FILE, STATE_FILE);
  } catch {
    try {
      if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE);
    } catch {
      /* ignore */
    }
  }
}

function maybeClearStaleLock(maxAgeMs = 5_000): void {
  try {
    if (!existsSync(LOCK_FILE)) return;
    if (Date.now() - statSync(LOCK_FILE).mtimeMs > maxAgeMs) unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

export function getJoinStaggerExtraMs(): number {
  return readState().extraMs;
}

/** Base applicantsJoinStaggerSec + fleet-wide 504 bump (ms). */
export function getEffectiveJoinStaggerMs(): number {
  return getApplicantsJoinStaggerMs() + getJoinStaggerExtraMs();
}

/**
 * After a Lift API 504: bump stagger fleet-wide.
 *
 * Best-effort by design — a dropped bump only costs a little stagger, so this
 * never spins or blocks the caller's event loop waiting for the lock.
 */
export function bumpJoinStaggerOn504(): void {
  maybeClearStaleLock();
  let fd: number | null = null;
  try {
    fd = openSync(LOCK_FILE, "wx");
  } catch {
    return;
  }
  try {
    const cur = readState();
    if (cur.extraMs >= MAX_EXTRA_MS) return;
    writeStateAtomic({ extraMs: Math.min(MAX_EXTRA_MS, cur.extraMs + BUMP_STEP_MS) });
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

export function clearJoinStaggerCoord(): void {
  for (const f of [STATE_FILE, LOCK_FILE, TMP_FILE]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

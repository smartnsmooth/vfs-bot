import { existsSync, readFileSync, writeFileSync, unlinkSync, watch } from "node:fs";
import { join } from "node:path";
export interface PollReadyState {
  totalExpected: number;
  readyInstances: number[];
  readyAt: Record<number, number>;
  /** Shared reference timestamp written by the first instance that detects
   *  the gate is open (all ready or timeout). Every instance computes its
   *  sequential offset relative to this value so the gaps are exact. */
  gateOpenedAt?: number;
}

const POLL_READY_FILE = join(process.cwd(), "poll-ready-state.json");

function readState(): PollReadyState {
  try {
    if (!existsSync(POLL_READY_FILE)) {
      return { totalExpected: 0, readyInstances: [], readyAt: {} };
    }
    const raw = readFileSync(POLL_READY_FILE, "utf8");
    return JSON.parse(raw) as PollReadyState;
  } catch {
    return { totalExpected: 0, readyInstances: [], readyAt: {} };
  }
}

function writeState(state: PollReadyState): void {
  try {
    writeFileSync(POLL_READY_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
      }
}

export function clearPollReadyState(): void {
  try {
    if (existsSync(POLL_READY_FILE)) {
      unlinkSync(POLL_READY_FILE);
          }
  } catch (err) {
      }
}

export function initPollReadyState(totalExpected: number): void {
  writeState({ totalExpected, readyInstances: [], readyAt: {} });
  }

export function markInstanceReady(instanceId: number): void {
  const state = readState();
  if (!state.readyInstances.includes(instanceId)) {
    state.readyInstances.push(instanceId);
    state.readyInstances.sort((a, b) => a - b);
    state.readyAt[instanceId] = Date.now();
    writeState(state);
      }
}

export function getPollReadyState(): PollReadyState {
  return readState();
}

export function allInstancesReady(): boolean {
  const state = readState();
  return state.totalExpected > 0 && state.readyInstances.length >= state.totalExpected;
}

/**
 * Stamp `gateOpenedAt` into the shared file exactly once (first writer wins).
 * Returns the shared timestamp that all instances should use as reference.
 */
export function stampGateOpened(): number {
  const state = readState();
  if (state.gateOpenedAt) return state.gateOpenedAt;
  state.gateOpenedAt = Date.now();
  writeState(state);
  return state.gateOpenedAt;
}

/**
 * Read the shared gate-opened timestamp. Returns 0 if not yet stamped.
 */
export function getGateOpenedAt(): number {
  return readState().gateOpenedAt ?? 0;
}

/**
 * Compute the sequential polling offset for this instance based on which
 * instances actually reached the dashboard. Failed instances are excluded,
 * so the offsets are packed without gaps.
 *
 * e.g. if step=2s, instances 1,3,4 are ready (2 failed):
 *   instance 1 → offset 0, instance 3 → offset 2s, instance 4 → offset 4s
 */
export function getReadyInstanceOffset(instanceId: number, stepMs: number): number {
  const state = readState();
  const sorted = [...state.readyInstances].sort((a, b) => a - b);
  const idx = sorted.indexOf(instanceId);
  if (idx < 0) return 0;
  return idx * stepMs;
}

/**
 * Get the total polling interval based on how many instances are actually
 * ready (not the total expected). This replaces the old `stepMs * numInstances`
 * calculation with `stepMs * readyCount` so the interval tightens when
 * some instances failed to reach the dashboard.
 *
 * Returns 0 when nobody is marked ready yet — callers should fall back to
 * `stepMs * BOT_TOTAL_INSTANCES`. (Returning `stepMs * 1` here used to make
 * every bot sleep only the user step, defeating POLL_INTERVAL_SCALED.)
 */
export function getReadyInstancePollInterval(stepMs: number): number {
  const state = readState();
  const readyCount = state.readyInstances.length;
  if (readyCount > 0) return stepMs * readyCount;
  if (state.totalExpected > 0) return stepMs * state.totalExpected;
  return 0;
}

/**
 * Watch for poll-ready-state.json changes and resolve when all instances
 * are ready or when the timeout expires.
 *
 * Returns the list of instance IDs that are ready when it resolves.
 */
export function waitForAllReady(
  timeoutMs: number,
  abortSignal?: { aborted: boolean },
): Promise<number[]> {
  return new Promise<number[]>((resolve) => {
    if (allInstancesReady()) {
      resolve(readState().readyInstances);
      return;
    }

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      try { watcher?.close(); } catch { /* ignore */ }
      clearTimeout(timer);
      resolve(readState().readyInstances);
    };

    const timer = setTimeout(settle, timeoutMs);

    const check = () => {
      if (abortSignal?.aborted) { settle(); return; }
      if (allInstancesReady()) settle();
    };

    let watcher: ReturnType<typeof watch> | null = null;
    try {
      watcher = watch(process.cwd(), { persistent: false }, (_event, filename) => {
        if (!filename) return;
        if (String(filename).toLowerCase() !== "poll-ready-state.json") return;
        setTimeout(check, 50);
      });
    } catch {
      const interval = setInterval(() => {
        check();
        if (settled) clearInterval(interval);
      }, 500);
    }

    check();
  });
}

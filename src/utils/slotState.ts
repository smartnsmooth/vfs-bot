import { existsSync, readFileSync, writeFileSync, unlinkSync, watch } from "node:fs";
import { join } from "node:path";
import { clearApplicantsCoord, resetApplicantsWave } from "./applicantsCoord";
import { clearCalendarBookingCoord } from "./calendarBookingCoord";

export interface SlotFoundState {
  found: boolean;
  foundBy?: number; // instance ID
  timestamp?: number;
  /** Poll returned VFS error 1036 ("Services will be back shortly") — synthetic slot hit. */
  apologies1036?: boolean;
  slot?: {
    id?: string;
    center?: string;
    date?: string;
    time?: string;
    rawDate?: string;
  };
  centerCode?: string;
  visaCategoryCode?: string;
}

const SLOT_STATE_FILE = join(process.cwd(), "slot-state.json");

export function isSlotFoundByAnyInstance(): SlotFoundState {
  try {
    if (!existsSync(SLOT_STATE_FILE)) {
      return { found: false };
    }
    const raw = readFileSync(SLOT_STATE_FILE, "utf8");
    const state = JSON.parse(raw) as SlotFoundState;
    return state;
  } catch (err) {
    return { found: false };
  }
}

export function markSlotFound(
  instanceId: number,
  centerCode: string,
  visaCategoryCode: string,
  slot?: { id?: string; center?: string; date?: string; time?: string; rawDate?: string }
): void {
  const apologies1036 = slot?.id?.startsWith("svc-unavailable-1036_") === true;
  const state: SlotFoundState = {
    found: true,
    foundBy: instanceId,
    timestamp: Date.now(),
    apologies1036,
    slot,
    centerCode,
    visaCategoryCode,
  };
  try {
    const json = JSON.stringify(state, null, 2);
    writeFileSync(SLOT_STATE_FILE, json, "utf8");
      } catch (err) {
      }
  resetApplicantsWave(state.timestamp ?? Date.now());
}

export function clearSlotState(): void {
  try {
    if (existsSync(SLOT_STATE_FILE)) {
      unlinkSync(SLOT_STATE_FILE);
          }
  } catch (err) {
      }
  clearApplicantsCoord();
  clearCalendarBookingCoord();
}

/**
 * Resolve as soon as another instance marks slot found (fs.watch based).
 * Used to wake sleeping poll loops immediately (no need to wait for interval).
 *
 * `cachedState()` returns the captured slot state even after the file is deleted,
 * so a peer that clears `slot-state.json` quickly doesn't erase the signal for
 * instances that are mid-API-call when the file was written.
 */
export function createSlotFoundWatcher(myInstanceId?: number): {
  wait: () => Promise<SlotFoundState>;
  cachedState: () => SlotFoundState | null;
  dispose: () => void;
} {
  let disposed = false;
  let resolved = false;
  let pending: ((s: SlotFoundState) => void) | null = null;
  let captured: SlotFoundState | null = null;

  const cachedState = (): SlotFoundState | null => captured;

  const wait = (): Promise<SlotFoundState> => {
    if (disposed) return Promise.resolve({ found: false });
    if (resolved) return Promise.resolve(captured ?? isSlotFoundByAnyInstance());
    return new Promise<SlotFoundState>((resolve) => {
      pending = resolve;
    });
  };

  const maybeResolve = (): void => {
    if (disposed || resolved) return;
    const state = isSlotFoundByAnyInstance();
    if (!state.found) return;
    if (myInstanceId != null && state.foundBy === myInstanceId) return;
    resolved = true;
    captured = state;
    if (pending) {
      pending(state);
      pending = null;
    }
  };

  // Edge: slot may already be marked before watcher starts.
  maybeResolve();

  let unwatch: (() => void) | null = null;
  try {
    const w = watch(process.cwd(), { persistent: false }, (_event, filename) => {
      if (!filename) return;
      if (String(filename).toLowerCase() !== "slot-state.json") return;
      // File write may be in progress; attempt read in next tick.
      setTimeout(maybeResolve, 0);
    });
    unwatch = () => w.close();
  } catch (err) {
    // If watch fails (rare), we still allow polling loop to detect via periodic top-of-loop checks.
      }

  const dispose = (): void => {
    disposed = true;
    pending = null;
    try {
      unwatch?.();
    } catch {
      /* ignore */
    }
  };

  return { wait, cachedState, dispose };
}

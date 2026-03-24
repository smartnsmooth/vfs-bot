import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger";

interface SlotFoundState {
  found: boolean;
  foundBy?: number; // instance ID
  timestamp?: number;
  slot?: {
    id?: string;
    center?: string;
    date?: string;
    time?: string;
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
  slot?: { id?: string; center?: string; date?: string; time?: string }
): void {
  const state: SlotFoundState = {
    found: true,
    foundBy: instanceId,
    timestamp: Date.now(),
    slot,
    centerCode,
    visaCategoryCode,
  };
  try {
    const json = JSON.stringify(state, null, 2);
    writeFileSync(SLOT_STATE_FILE, json, "utf8");
    logger.info({ instanceId, centerCode, visaCategoryCode, slot }, "Marked slot as found (broadcast to all instances)");
  } catch (err) {
    logger.error({ err, instanceId }, "Failed to write slot state");
  }
}

export function clearSlotState(): void {
  try {
    if (existsSync(SLOT_STATE_FILE)) {
      unlinkSync(SLOT_STATE_FILE);
      logger.info("Cleared slot state");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to clear slot state");
  }
}

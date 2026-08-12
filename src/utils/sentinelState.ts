import { existsSync, readFileSync, writeFileSync, unlinkSync, watch } from "node:fs";
import { join } from "node:path";
export type BotRole = "sentinel" | "standby";

export interface SentinelConfig {
  sentinelCount: number;
  totalInstances: number;
  sentinelIds: number[];
  standbyIds: number[];
}

export interface RoleAssignments {
  sentinelIds: number[];
  standbyIds: number[];
  stoppedIds?: number[];
  timestamp: number;
}

export interface SlotSignal {
  activated: boolean;
  activatedBy?: number;
  timestamp?: number;
  centerCode?: string;
  visaCategoryCode?: string;
  slot?: {
    id?: string;
    center?: string;
    date?: string;
    time?: string;
    rawDate?: string;
  };
}

const SENTINEL_SIGNAL_FILE = join(process.cwd(), "sentinel-signal.json");

const DEFAULT_SENTINEL_COUNT = 4;

/**
 * Determine role assignments: first N instances are sentinels, rest are standby.
 * @param totalInstances Total number of bot instances running.
 * @param overrideSentinelCount Optional sentinel count from setup UI. Falls back to env var then default (4).
 */
export function resolveSentinelConfig(totalInstances: number, overrideSentinelCount?: number): SentinelConfig {
  let sentinelCount: number;
  if (overrideSentinelCount != null && overrideSentinelCount >= 1) {
    sentinelCount = Math.min(overrideSentinelCount, totalInstances);
  } else {
    const envCount = parseInt(process.env.SENTINEL_COUNT ?? "", 10);
    sentinelCount = Number.isFinite(envCount) && envCount >= 1
      ? Math.min(envCount, totalInstances)
      : Math.min(DEFAULT_SENTINEL_COUNT, totalInstances);
  }

  const sentinelIds: number[] = [];
  const standbyIds: number[] = [];

  for (let i = 1; i <= totalInstances; i++) {
    if (i <= sentinelCount) {
      sentinelIds.push(i);
    } else {
      standbyIds.push(i);
    }
  }

  return { sentinelCount, totalInstances, sentinelIds, standbyIds };
}

/**
 * Get the role for a specific instance based on current config.
 * @param overrideSentinelCount Optional sentinel count from setup UI.
 */
export function getInstanceRole(instanceId: number, totalInstances: number, overrideSentinelCount?: number): BotRole {
  const cfg = resolveSentinelConfig(totalInstances, overrideSentinelCount);
  return cfg.sentinelIds.includes(instanceId) ? "sentinel" : "standby";
}

// --- Dynamic Role Assignments (runtime swaps) ---

const SENTINEL_ROLES_FILE = join(process.cwd(), "sentinel-roles.json");

export function writeRoleAssignments(assignments: RoleAssignments): void {
  try {
    writeFileSync(SENTINEL_ROLES_FILE, JSON.stringify(assignments, null, 2), "utf8");
  } catch (err) {
      }
}

export function readRoleAssignments(): RoleAssignments | null {
  try {
    if (!existsSync(SENTINEL_ROLES_FILE)) return null;
    const raw = readFileSync(SENTINEL_ROLES_FILE, "utf8");
    return JSON.parse(raw) as RoleAssignments;
  } catch {
    return null;
  }
}

export function clearRoleAssignments(force = false): void {
  try {
    if (!existsSync(SENTINEL_ROLES_FILE)) return;
    if (!force) {
      const existing = readRoleAssignments();
      // If there are stopped instances, the dynamic roles are meaningful
      // (login failures already triggered demotions). Don't wipe them.
      if (existing?.stoppedIds && existing.stoppedIds.length > 0) {
                return;
      }
    }
    unlinkSync(SENTINEL_ROLES_FILE);
      } catch (err) {
      }
}

/**
 * Get the current runtime role for an instance.
 * Checks sentinel-roles.json first (runtime swaps), falls back to static config.
 */
export function getCurrentRole(instanceId: number, totalInstances: number, overrideSentinelCount?: number): BotRole {
  const dynamic = readRoleAssignments();
  if (dynamic) {
    if (dynamic.sentinelIds.includes(instanceId)) return "sentinel";
    if (dynamic.standbyIds.includes(instanceId)) return "standby";
  }
  return getInstanceRole(instanceId, totalInstances, overrideSentinelCount);
}

/**
 * Demote a blocked sentinel to standby and promote the lowest-numbered standby to sentinel.
 * Writes the updated assignments to disk so all instances can detect the change.
 * Returns the ID of the newly promoted sentinel (or null if no standby available).
 */
/**
 * Mark an instance as stopped so it is never promoted to sentinel.
 * Must be called BEFORE demoteSentinelAndPromoteStandby so concurrent
 * demoters see this instance in the stopped set and skip it.
 */
/**
 * Mark an instance as stopped so it is never picked as a promotion target.
 * Does NOT remove the instance from sentinelIds — that is done by
 * demoteSentinelAndPromoteStandby which also handles the promotion.
 */
export function markInstanceStopped(instanceId: number, totalInstances: number, overrideSentinelCount?: number): void {
  const dynamic = readRoleAssignments();
  let sentinelIds: number[];
  let standbyIds: number[];
  let stoppedIds: number[];

  if (dynamic) {
    sentinelIds = [...dynamic.sentinelIds];
    standbyIds = [...dynamic.standbyIds];
    stoppedIds = [...(dynamic.stoppedIds ?? [])];
  } else {
    const cfg = resolveSentinelConfig(totalInstances, overrideSentinelCount);
    sentinelIds = [...cfg.sentinelIds];
    standbyIds = [...cfg.standbyIds];
    stoppedIds = [];
  }

  if (!stoppedIds.includes(instanceId)) {
    stoppedIds.push(instanceId);
  }
  // Remove from standby only — sentinel removal + promotion is handled by demoteSentinelAndPromoteStandby.
  standbyIds = standbyIds.filter((id) => id !== instanceId);

  writeRoleAssignments({ sentinelIds, standbyIds, stoppedIds, timestamp: Date.now() });
  }

const DEMOTE_CAS_MAX_RETRIES = 5;

export function demoteSentinelAndPromoteStandby(
  blockedInstanceId: number,
  totalInstances: number,
  overrideSentinelCount?: number
): number | null {
  for (let attempt = 0; attempt < DEMOTE_CAS_MAX_RETRIES; attempt++) {
    const dynamic = readRoleAssignments();
    let sentinelIds: number[];
    let standbyIds: number[];
    let stoppedIds: number[];

    if (dynamic) {
      sentinelIds = [...dynamic.sentinelIds];
      standbyIds = [...dynamic.standbyIds];
      stoppedIds = [...(dynamic.stoppedIds ?? [])];
    } else {
      const cfg = resolveSentinelConfig(totalInstances, overrideSentinelCount);
      sentinelIds = [...cfg.sentinelIds];
      standbyIds = [...cfg.standbyIds];
      stoppedIds = [];
    }

    if (!sentinelIds.includes(blockedInstanceId)) {
            return null;
    }

    // Filter out stopped instances — they must never be promoted.
    const eligibleStandbys = standbyIds.filter((id) => !stoppedIds.includes(id));

    if (eligibleStandbys.length === 0) {
            sentinelIds = sentinelIds.filter((id) => id !== blockedInstanceId);
      if (!stoppedIds.includes(blockedInstanceId)) stoppedIds.push(blockedInstanceId);
      writeRoleAssignments({ sentinelIds, standbyIds, stoppedIds, timestamp: Date.now() });
      return null;
    }

    eligibleStandbys.sort((a, b) => a - b);
    const promoted = eligibleStandbys[0]!;

    sentinelIds = sentinelIds.filter((id) => id !== blockedInstanceId);
    sentinelIds.push(promoted);
    standbyIds = standbyIds.filter((id) => id !== promoted);
    if (!stoppedIds.includes(blockedInstanceId)) stoppedIds.push(blockedInstanceId);

    const assignments: RoleAssignments = { sentinelIds, standbyIds, stoppedIds, timestamp: Date.now() };
    writeRoleAssignments(assignments);

    // Verify: re-read to confirm our write wasn't clobbered by a concurrent process.
    const verified = readRoleAssignments();
    if (verified && verified.sentinelIds.includes(promoted) && (verified.stoppedIds ?? []).includes(blockedInstanceId)) {
            return promoted;
    }

      }

    return null;
}

/**
 * Watch for role changes in sentinel-roles.json.
 * Resolves when this instance is promoted from standby to sentinel.
 */
export function createRoleChangeWatcher(myInstanceId: number): {
  wait: () => Promise<"promoted">;
  dispose: () => void;
} {
  let disposed = false;
  let resolved = false;
  let pending: ((v: "promoted") => void) | null = null;

  const wait = (): Promise<"promoted"> => {
    if (disposed) return new Promise(() => {});
    if (resolved) return Promise.resolve("promoted" as const);
    return new Promise<"promoted">((resolve) => {
      pending = resolve;
    });
  };

  const maybeResolve = (): void => {
    if (disposed || resolved) return;
    const assignments = readRoleAssignments();
    if (!assignments) return;
    if (assignments.sentinelIds.includes(myInstanceId)) {
      resolved = true;
      if (pending) {
        pending("promoted");
        pending = null;
      }
    }
  };

  maybeResolve();

  let unwatch: (() => void) | null = null;
  try {
    const w = watch(process.cwd(), { persistent: false }, (_event, filename) => {
      if (!filename) return;
      if (String(filename).toLowerCase() !== "sentinel-roles.json") return;
      setTimeout(maybeResolve, 0);
    });
    unwatch = () => w.close();
  } catch (err) {
      }

  const dispose = (): void => {
    disposed = true;
    pending = null;
    try {
      unwatch?.();
    } catch { /* ignore */ }
  };

  return { wait, dispose };
}

// --- Activation Signal (slot found broadcast) ---

/**
 * Broadcast activation signal: a sentinel found a slot and all standby bots must wake up.
 */
export function broadcastActivationSignal(
  activatedBy: number,
  centerCode: string,
  visaCategoryCode: string,
  slot?: { id?: string; center?: string; date?: string; time?: string; rawDate?: string }
): void {
  const signal: SlotSignal = {
    activated: true,
    activatedBy,
    timestamp: Date.now(),
    centerCode,
    visaCategoryCode,
    slot,
  };
  try {
    writeFileSync(SENTINEL_SIGNAL_FILE, JSON.stringify(signal, null, 2), "utf8");
      } catch (err) {
      }
}

/**
 * Read the current activation signal state.
 */
export function readActivationSignal(): SlotSignal {
  try {
    if (!existsSync(SENTINEL_SIGNAL_FILE)) {
      return { activated: false };
    }
    const raw = readFileSync(SENTINEL_SIGNAL_FILE, "utf8");
    return JSON.parse(raw) as SlotSignal;
  } catch {
    return { activated: false };
  }
}

/**
 * Clear the activation signal (after booking completes or fails).
 */
export function clearActivationSignal(): void {
  try {
    if (existsSync(SENTINEL_SIGNAL_FILE)) {
      unlinkSync(SENTINEL_SIGNAL_FILE);
          }
  } catch (err) {
      }
}

/**
 * Watch for the activation signal file to appear/change.
 * Used by standby bots to wake up immediately when a sentinel finds a slot.
 */
export function createActivationWatcher(myInstanceId: number): {
  wait: () => Promise<SlotSignal>;
  dispose: () => void;
} {
  let disposed = false;
  let resolved = false;
  let pending: ((s: SlotSignal) => void) | null = null;

  const wait = (): Promise<SlotSignal> => {
    if (disposed) return Promise.resolve({ activated: false });
    if (resolved) return Promise.resolve(readActivationSignal());
    return new Promise<SlotSignal>((resolve) => {
      pending = resolve;
    });
  };

  const maybeResolve = (): void => {
    if (disposed || resolved) return;
    const signal = readActivationSignal();
    if (!signal.activated) return;
    if (signal.activatedBy === myInstanceId) return;
    resolved = true;
    if (pending) {
      pending(signal);
      pending = null;
    }
  };

  maybeResolve();

  let unwatch: (() => void) | null = null;
  try {
    const w = watch(process.cwd(), { persistent: false }, (_event, filename) => {
      if (!filename) return;
      if (String(filename).toLowerCase() !== "sentinel-signal.json") return;
      setTimeout(maybeResolve, 0);
    });
    unwatch = () => w.close();
  } catch (err) {
      }

  const dispose = (): void => {
    disposed = true;
    pending = null;
    try {
      unwatch?.();
    } catch { /* ignore */ }
  };

  return { wait, dispose };
}

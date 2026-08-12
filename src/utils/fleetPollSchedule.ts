import { getApplicantDetailsOverrides } from "./applicantDetails.store";

export const DEFAULT_POLL_INTERVAL_SEC = 60;
export const DEFAULT_APOLOGIES_INTERVAL_SEC = 2;

/** Setup-form "Apologies interval" (seconds); legacy key `applicantsIntervalSec` still read. */
export function resolveApologiesIntervalSec(details?: Record<string, unknown> | null): number {
  const globalDet = details ?? getApplicantDetailsOverrides(0);
  if (!globalDet) return DEFAULT_APOLOGIES_INTERVAL_SEC;
  if (typeof globalDet.apologiesIntervalSec === "number" && globalDet.apologiesIntervalSec >= 1) {
    return Math.floor(globalDet.apologiesIntervalSec);
  }
  if (typeof globalDet.applicantsIntervalSec === "number" && globalDet.applicantsIntervalSec >= 1) {
    return Math.floor(globalDet.applicantsIntervalSec);
  }
  return DEFAULT_APOLOGIES_INTERVAL_SEC;
}

export function getApologiesIntervalMs(): number {
  return Math.max(1000, resolveApologiesIntervalSec() * 1000);
}

export const DEFAULT_APPLICANTS_JOIN_STAGGER_SEC = 0.5;

/** Gap between bots when joining save-applicants after a peer URN unlock (setup form). */
export function resolveApplicantsJoinStaggerSec(details?: Record<string, unknown> | null): number {
  const globalDet = details ?? getApplicantDetailsOverrides(0);
  if (!globalDet) return DEFAULT_APPLICANTS_JOIN_STAGGER_SEC;
  if (typeof globalDet.applicantsJoinStaggerSec === "number" && globalDet.applicantsJoinStaggerSec >= 0.1) {
    return globalDet.applicantsJoinStaggerSec;
  }
  return DEFAULT_APPLICANTS_JOIN_STAGGER_SEC;
}

export function getApplicantsJoinStaggerMs(): number {
  return Math.max(100, Math.round(resolveApplicantsJoinStaggerSec() * 1000));
}

/** Fixed buffer after the login stagger ramp before the first fleet poll (ms). */
export const FLEET_POLL_START_BUFFER_MS = 60_000;

export function getFleetPollIntervalSec(): number {
  const globalDet = getApplicantDetailsOverrides(0);
  return globalDet && typeof globalDet.userPollInterval === "number" && globalDet.userPollInterval >= 1
    ? globalDet.userPollInterval
    : DEFAULT_POLL_INTERVAL_SEC;
}

export function getFleetPollStepMs(): number {
  return Math.max(1000, getFleetPollIntervalSec() * 1000);
}

export function getFleetInstanceCount(): number {
  const raw = parseInt(process.env.BOT_TOTAL_INSTANCES ?? "1", 10);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}

/** Full fleet round-robin period: pollInterval × instanceCount. */
export function getFleetPollCycleMs(): number {
  return getFleetPollStepMs() * getFleetInstanceCount();
}

export function normalizeFleetInstanceId(instanceId?: number): number {
  return typeof instanceId === "number" && Number.isFinite(instanceId) && instanceId >= 1
    ? Math.floor(instanceId)
    : 1;
}

/**
 * Fleet poll-start anchor from rollout submit time:
 * startInterval × instanceCount + 60s (absolute ms timestamp).
 */
export function computeFleetPollAnchorAt(rolloutStartedAtMs: number, startIntervalMs: number, instanceCount: number): number {
  const n = Math.max(1, Math.floor(instanceCount));
  const staggerMs = Math.max(0, Math.floor(startIntervalMs));
  return rolloutStartedAtMs + staggerMs * n + FLEET_POLL_START_BUFFER_MS;
}

/** Instance i first poll: anchor + pollInterval × (i − 1). */
export function computeScheduledPollAtMs(
  pollAnchorAtMs: number,
  instanceId: number,
  scheduleSlot: number
): number {
  const id = normalizeFleetInstanceId(instanceId);
  const stepMs = getFleetPollStepMs();
  const cycleMs = getFleetPollCycleMs();
  const slot = Math.max(0, Math.floor(scheduleSlot));
  return pollAnchorAtMs + (id - 1) * stepMs + slot * cycleMs;
}

/** True when Chrome is on the post-login dashboard (not application-detail / booking). */
export function isPreparedForFleetPolling(url: string): boolean {
  return /\/(applications|dashboard|home)\b/i.test(url);
}

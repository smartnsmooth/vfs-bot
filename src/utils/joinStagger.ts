/**
 * Small delay between bots when a "finder" wakes peers to join an API wave.
 * Order: finder first, then remaining bots by ascending Bot #.
 * Step defaults to setup-form `applicantsJoinStaggerSec` (0.5s).
 */

import { getEffectiveJoinStaggerMs } from "./calendarBookingCoord";

/** @deprecated Use {@link getApplicantsJoinStaggerMs} — kept for callers that import the constant. */
export const JOIN_STAGGER_MS = 500;

/**
 * Join order: [finder, ...others sorted by Bot #].
 * If finder is not in the participant list, returns others only.
 */
export function buildFinderFirstJoinOrder(finderId: number, participantIds: number[]): number[] {
  const finder = Math.max(1, Math.floor(finderId));
  const unique = [
    ...new Set(
      participantIds
        .map((n) => Math.floor(Number(n)))
        .filter((n) => Number.isFinite(n) && n >= 1)
    ),
  ];
  const rest = unique.filter((id) => id !== finder).sort((a, b) => a - b);
  return unique.includes(finder) ? [finder, ...rest] : rest;
}

/** Milliseconds this bot should still wait before joining the wave. */
export function joinStaggerRemainingMs(
  myInstanceId: number,
  finderId: number,
  participantIds: number[],
  waveStartedAt: number,
  stepMs?: number
): number {
  const myId = Math.max(1, Math.floor(myInstanceId));
  const order = buildFinderFirstJoinOrder(finderId, participantIds);
  const rank = order.indexOf(myId);
  if (rank < 0) return 0;
  const step = Math.max(0, Math.floor(stepMs ?? getEffectiveJoinStaggerMs()));
  const started = Math.max(0, Math.floor(waveStartedAt));
  const targetAt = started + rank * step;
  return Math.max(0, targetAt - Date.now());
}

export async function waitForJoinStagger(opts: {
  label: string;
  myInstanceId: number;
  finderId: number;
  participantIds: number[];
  waveStartedAt: number;
  stepMs?: number;
  abortSeq?: number;
  isAbort?: (seq: number) => boolean;
  waitForAbort?: (seq: number) => Promise<void>;
}): Promise<"ready" | "abort"> {
  const remainingMs = joinStaggerRemainingMs(
    opts.myInstanceId,
    opts.finderId,
    opts.participantIds,
    opts.waveStartedAt,
    opts.stepMs
  );
  if (remainingMs <= 0) return "ready";

  const order = buildFinderFirstJoinOrder(opts.finderId, opts.participantIds);
  const rank = order.indexOf(Math.max(1, Math.floor(opts.myInstanceId)));
  
  if (opts.abortSeq != null && opts.isAbort && opts.waitForAbort) {
    const seq = opts.abortSeq;
    const woke = await Promise.race([
      new Promise<"ready">((r) => setTimeout(() => r("ready"), remainingMs)),
      opts.waitForAbort(seq).then(() => "abort" as const),
    ]);
    if (woke === "abort" || opts.isAbort(seq)) return "abort";
    return "ready";
  }

  await new Promise<void>((r) => setTimeout(r, remainingMs));
  return "ready";
}

/** All bot instance ids 1..N from BOT_TOTAL_INSTANCES. */
export function allClusterParticipantIds(): number[] {
  const raw = parseInt(process.env.BOT_TOTAL_INSTANCES ?? "1", 10);
  const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
  return Array.from({ length: n }, (_, i) => i + 1);
}

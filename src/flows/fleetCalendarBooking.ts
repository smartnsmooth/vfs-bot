/**
 * Fleet Calendar booking flow (sole booking system).
 *
 * Every URN holder runs the same loop — no privileged instance.
 *
 * 1. Fees first: while the fleet has no totalAmount, one instance at a time makes a
 *    single Fees call. Anything other than a totalAmount passes the turn on at once.
 * 2. Then, with the shared totalAmount in hand:
 *    I.  availableDateList not empty → pick random date → timeslot → add rest to
 *        availableDatetimeList → pick one slot → schedule
 *    II. availableDateList empty, availableDatetimeList not empty → pick random datetime →
 *        timeslot for that date → find allocationId for that time → schedule
 *    III. Both empty → join the Calendar round-robin (one caller at a time)
 * 3. Schedule fail → re-check lists → I/II/III again
 */

import type { BrowserService } from "../services/browser.service";
import {
  VfsRateLimitedError,
  AlreadyBookedError,
  VfsForbiddenError,
  VfsUnauthorizedError,
  IndDeuAccountRecreateError,
  MissingUrnError,
} from "../services/browser.service";
import { getApplicantDetailsOverrides } from "../utils/applicantDetails.store";
import { setAllocationId } from "../utils/allocationId.store";
import { getTotalAmount, setTotalAmount, getCurrency, setCurrency } from "../utils/totalAmount.store";
import {
  activeWaiters,
  addToAvailableDatetimeList,
  claimCalendarAttempt,
  claimFeesAttempt,
  createCalendarBookingWatcher,
  enterCalendarRepoll,
  markScheduledSuccess,
  pickRandomDate,
  pickRandomDatetime,
  publishCalendarDates,
  publishSharedFees,
  readCalendarBookingState,
  registerCalendarWaiter,
  registerFleetUrn,
  releaseCalendarAttempt,
  releaseFeesAttempt,
  type AvailableDatetime,
  type CalendarBookingCoordState,
} from "../utils/calendarBookingCoord";
import { reporter } from "../monitoring/statusReporter";

const DEFAULT_CALENDAR_POLLING_INTERVAL_SEC = 60;

export function getCalendarPollingIntervalMs(): number {
  const globalDet = getApplicantDetailsOverrides(0);
  const sec =
    globalDet && typeof globalDet.calendarPollingInterval === "number" && globalDet.calendarPollingInterval >= 1
      ? globalDet.calendarPollingInterval
      : DEFAULT_CALENDAR_POLLING_INTERVAL_SEC;
  return Math.max(1000, Math.floor(sec) * 1000);
}

/**
 * Session / IP / account blocks must reach the bot-cycle recovery in `index.ts`, and a
 * missing URN must reach the save-applicants loop there. Everything else is a per-attempt
 * failure the booking loop retries on its own.
 */
function isUnrecoverableHere(err: unknown): boolean {
  return (
    err instanceof AlreadyBookedError ||
    err instanceof VfsRateLimitedError ||
    err instanceof VfsUnauthorizedError ||
    err instanceof VfsForbiddenError ||
    err instanceof IndDeuAccountRecreateError ||
    err instanceof MissingUrnError
  );
}

function applySharedFeesLocally(state: CalendarBookingCoordState): void {
  const fees = state.fees;
  if (!fees?.totalAmount?.trim()) {
    throw new Error("Fleet Schedule: no shared totalAmount yet");
  }
  setTotalAmount(fees.totalAmount);
  if (fees.currency) setCurrency(fees.currency);
}

/** Any instance that already got a fees response can latch it for the whole fleet. */
function tryPublishLocalFees(instanceId: number): boolean {
  const totalAmount = getTotalAmount();
  if (!totalAmount?.trim()) return false;
  return publishSharedFees(instanceId, { totalAmount, currency: getCurrency() });
}

async function waitForCoordOrTimeout(opts: {
  abortSeq: number;
  waitForAbort: (seq: number) => Promise<void>;
  timeoutMs: number;
  watcherWait: () => Promise<void>;
}): Promise<"timeout" | "change" | "abort"> {
  if (opts.timeoutMs <= 0) return "timeout";
  return Promise.race([
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), opts.timeoutMs)),
    opts.watcherWait().then(() => "change" as const),
    opts.waitForAbort(opts.abortSeq).then(() => "abort" as const),
  ]);
}

// ── Schedule with shared fees ───────────────────────────────────────────

async function runScheduleWithSharedFees(
  browser: BrowserService,
  instanceId: number,
  allocationId: string
): Promise<"booked" | "rejoin"> {
  const state = readCalendarBookingState();
  applySharedFeesLocally(state);
  setAllocationId(allocationId);
  reporter.setBookingStep("schedule");
  try {
    const { booked } = await browser.postScheduleLiftApi();
    if (booked) {
      markScheduledSuccess(instanceId);
      return "booked";
    }
    return "rejoin";
  } catch (err) {
    if (isUnrecoverableHere(err)) throw err;
    return "rejoin";
  }
}

// ── Fees: one call, then hand the turn on ───────────────────────────────

/**
 * Make this instance's single Fees call and share the amount.
 *
 * Whatever comes back that is not a totalAmount — 504, empty body, error — releases
 * the turn so the next instance can call immediately. This instance does not sit on
 * the turn to retry.
 */
async function runFeesAttempt(browser: BrowserService, instanceId: number): Promise<void> {
  reporter.setBookingStep("fees");
  let published = false;
  try {
    await browser.postFeesLiftApi();
    published = tryPublishLocalFees(instanceId);
  } catch (err) {
    if (isUnrecoverableHere(err)) {
      releaseFeesAttempt(instanceId);
      throw err;
    }
  }
  if (!published) releaseFeesAttempt(instanceId);
}

// ── Case I: pick date → timeslot → pick slot → schedule ────────────────

async function runCaseI(
  browser: BrowserService,
  instanceId: number,
  date: string
): Promise<"booked" | "continue"> {
  reporter.setBookingStep(`timeslot (date: ${date})`);
  try {
    const entries = await browser.fetchTimeslotAllocationsForFleet(date);
    if (entries.length === 0) {
      return "continue";
    }

    const pickIdx = Math.floor(Math.random() * entries.length);
    const picked = entries[pickIdx]!;
    const remaining = entries.filter((_, i) => i !== pickIdx);

    if (remaining.length > 0) {
      addToAvailableDatetimeList(
        remaining.map((e) => ({ date: e.date, time: e.time }))
      );
    }

    const outcome = await runScheduleWithSharedFees(browser, instanceId, picked.allocationId);
    return outcome === "booked" ? "booked" : "continue";
  } catch (err) {
    if (isUnrecoverableHere(err)) throw err;
    return "continue";
  }
}

// ── Case II: pick datetime → timeslot for date → find allocationId → schedule

async function runCaseII(
  browser: BrowserService,
  instanceId: number,
  dt: AvailableDatetime
): Promise<"booked" | "continue"> {
  reporter.setBookingStep(`timeslot (${dt.date} ${dt.time})`);
  try {
    const entries = await browser.fetchTimeslotAllocationsForFleet(dt.date);
    const match = entries.find((e) => e.time === dt.time);

    // This call fetched every slot for the date — hand the ones we do not take back to the fleet.
    const remaining = entries.filter((e) => e !== match);
    if (remaining.length > 0) {
      addToAvailableDatetimeList(
        remaining.map((e) => ({ date: e.date, time: e.time }))
      );
    }

    if (!match) {
      return "continue";
    }

    const outcome = await runScheduleWithSharedFees(browser, instanceId, match.allocationId);
    return outcome === "booked" ? "booked" : "continue";
  } catch (err) {
    if (isUnrecoverableHere(err)) throw err;
    return "continue";
  }
}

// ── Main entry point ────────────────────────────────────────────────────

export async function runFleetCalendarBooking(opts: {
  browser: BrowserService;
  instanceId: number;
  abortSeq: number;
  isAbort: (seq: number) => boolean;
  waitForAbort: (seq: number) => Promise<void>;
}): Promise<boolean> {
  const { browser, abortSeq, isAbort, waitForAbort } = opts;
  const instanceId = Math.max(1, Math.floor(opts.instanceId));

  registerFleetUrn(instanceId);
  registerCalendarWaiter(instanceId);
  const watcher = createCalendarBookingWatcher();

  try {
    while (true) {
      if (isAbort(abortSeq)) return false;

      registerCalendarWaiter(instanceId);
      let state = readCalendarBookingState();

      if (state.scheduled.includes(instanceId)) return true;
      if (state.retired.includes(instanceId)) return false;

      // ── Fees before anything else: no schedule without a totalAmount ─
      if (!state.feesDone) {
        // An amount this instance already fetched is as good as a fresh call.
        if (tryPublishLocalFees(instanceId)) continue;

        if (claimFeesAttempt(instanceId)) {
          await runFeesAttempt(browser, instanceId);
          continue;
        }

        reporter.setBookingStep("fees · waiting");
        const woke = await waitForCoordOrTimeout({
          abortSeq, waitForAbort,
          timeoutMs: 500,
          watcherWait: watcher.wait,
        });
        if (woke === "abort") return false;
        continue;
      }

      // ── Instance action loop (I / II / III) ────────────────────────

      // Case I: available date list not empty
      const pickedDate = pickRandomDate();
      if (pickedDate) {
        const result = await runCaseI(browser, instanceId, pickedDate);
        if (result === "booked") return true;
        continue;
      }

      // Case II: available datetime list not empty
      const pickedDt = pickRandomDatetime();
      if (pickedDt) {
        const result = await runCaseII(browser, instanceId, pickedDt);
        if (result === "booked") return true;
        continue;
      }

      // Case III: both empty → calendar round-robin polling
      enterCalendarRepoll();
      state = readCalendarBookingState();

      if (state.phase === "calendar_repoll") {
        const intervalMs = getCalendarPollingIntervalMs();
        const readyAt =
          !state.calendarSkipInterval && state.lastCalendarAttemptAt > 0
            ? state.lastCalendarAttemptAt + intervalMs
            : 0;
        const waitMs = Math.max(0, readyAt - Date.now());

        if (waitMs === 0 && claimCalendarAttempt(instanceId, intervalMs)) {
          reporter.setBookingStep("calendar");
          try {
            const dates = await browser.fetchCalendarDatesForFleet();
            publishCalendarDates(instanceId, dates);
          } catch (err) {
            releaseCalendarAttempt(instanceId);
            if (isUnrecoverableHere(err)) throw err;
          }
          continue;
        }

        // Either the interval has not expired or a peer holds the turn.
        reporter.setBookingStep(
          waitMs > 0 ? `calendar · re-poll in ${Math.round(waitMs / 1000)}s` : "calendar · waiting turn"
        );
        const woke = await waitForCoordOrTimeout({
          abortSeq, waitForAbort,
          timeoutMs: waitMs > 0 ? Math.min(waitMs, 2000) : 500,
          watcherWait: watcher.wait,
        });
        if (woke === "abort") return false;
        continue;
      }

      // Phase is "active" but both lists were empty by the time we checked — re-loop
      const woke = await waitForCoordOrTimeout({
        abortSeq, waitForAbort,
        timeoutMs: 500,
        watcherWait: watcher.wait,
      });
      if (woke === "abort") return false;
    }
  } finally {
    watcher.dispose();
  }
}

/** Debug helper — active waiter count from shared state. */
export function fleetCalendarActiveWaiterCount(): number {
  return activeWaiters(readCalendarBookingState()).length;
}

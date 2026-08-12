/**
 * Fleet Calendar booking flow (sole booking system).
 *
 * 1. First URN = FeeCalculator → Calendar (dedup) → Fees → then joins instance loop
 * 2. Every URN holder (including FeeCalculator after fees) runs:
 *    I.  availableDateList not empty → pick random date → timeslot → add rest to
 *        availableDatetimeList → pick one slot → schedule
 *    II. availableDateList empty, availableDatetimeList not empty → pick random datetime →
 *        timeslot for that date → find allocationId for that time → schedule
 *    III. Both empty → join Calendar round-robin (all URN holders, no FeeCalculator priority)
 * 3. Schedule fail → re-check lists → I/II/III again
 */

import type { BrowserService } from "../services/browser.service";
import { VfsRateLimitedError, AlreadyBookedError } from "../services/browser.service";
import { getApplicantDetailsOverrides } from "../utils/applicantDetails.store";
import { setAllocationId } from "../utils/allocationId.store";
import { getTotalAmount, setTotalAmount, getCurrency, setCurrency } from "../utils/totalAmount.store";
import {
  activeWaiters,
  addToAvailableDatetimeList,
  createCalendarBookingWatcher,
  dedupeCalendarDates,
  enterCalendarRepoll,
  getCalendarPollingCallerId,
  getEffectiveJoinStaggerMs,
  markScheduledSuccess,
  pickRandomDate,
  pickRandomDatetime,
  publishCalendarDates,
  publishCalendarRepollDates,
  publishSharedFees,
  readCalendarBookingState,
  recordCalendarPollFailure,
  registerCalendarWaiter,
  registerFleetUrn,
  retireFromFleet,
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

function applySharedFeesLocally(state: CalendarBookingCoordState): void {
  const fees = state.fees;
  if (!fees?.totalAmount?.trim()) {
    throw new Error("Fleet Schedule: FeeCalculator has not published totalAmount yet");
  }
  setTotalAmount(fees.totalAmount);
  if (fees.currency) setCurrency(fees.currency);
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
    const { paymentUrl } = await browser.postScheduleLiftApi();
    if (paymentUrl?.trim()) {
      markScheduledSuccess(instanceId);
      return "booked";
    }
    return "rejoin";
  } catch (err) {
    if (err instanceof AlreadyBookedError) throw err;
    if (err instanceof VfsRateLimitedError) throw err;
    return "rejoin";
  }
}

// ── FeeCalculator helpers ───────────────────────────────────────────────

async function runFeeCalculatorCalendarAndFees(
  browser: BrowserService,
  instanceId: number
): Promise<boolean> {
  reporter.setBookingStep("calendar");
  try {
    const dates = await browser.fetchCalendarDatesForFleet();
    const deduped = dedupeCalendarDates(dates);
    publishCalendarDates(instanceId, deduped);
  } catch (err) {
    if (err instanceof VfsRateLimitedError) throw err;
    recordCalendarPollFailure(instanceId);
    return false;
  }

  reporter.setBookingStep("fees");
  try {
    await browser.postFeesLiftApi();
    const totalAmount = getTotalAmount();
    if (!totalAmount?.trim()) {
      throw new Error("FeeCalculator: fees response had no totalAmount");
    }
    publishSharedFees(instanceId, { totalAmount, currency: getCurrency() });
  } catch (err) {
    if (err instanceof VfsRateLimitedError) throw err;
    return false;
  }
  return true;
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
    if (err instanceof AlreadyBookedError) throw err;
    if (err instanceof VfsRateLimitedError) throw err;
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
    if (!match) {
      return "continue";
    }

    const outcome = await runScheduleWithSharedFees(browser, instanceId, match.allocationId);
    return outcome === "booked" ? "booked" : "continue";
  } catch (err) {
    if (err instanceof AlreadyBookedError) throw err;
    if (err instanceof VfsRateLimitedError) throw err;
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
  const intervalMs = getCalendarPollingIntervalMs();

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

      // ── FeeCalculator: Calendar + Fees (once) ──────────────────────
      if (
        state.feeCalculatorId === instanceId &&
        !state.calendarCalled
      ) {
        const ok = await runFeeCalculatorCalendarAndFees(browser, instanceId);
        if (!ok) {
          const woke = await waitForCoordOrTimeout({
            abortSeq, waitForAbort,
            timeoutMs: 2000,
            watcherWait: watcher.wait,
          });
          if (woke === "abort") return false;
        }
        continue;
      }

      // ── FeeCalculator: if Calendar done but fees not published yet ─
      if (
        state.feeCalculatorId === instanceId &&
        state.calendarCalled &&
        !state.feesDone
      ) {
        reporter.setBookingStep("fees · retry");
        try {
          await browser.postFeesLiftApi();
          const totalAmount = getTotalAmount();
          if (totalAmount?.trim()) {
            publishSharedFees(instanceId, { totalAmount, currency: getCurrency() });
          }
        } catch (err) {
          if (err instanceof VfsRateLimitedError) throw err;
        }
        continue;
      }

      // ── Wait for fees to be published before any instance proceeds ─
      if (!state.feesDone) {
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
      state = readCalendarBookingState();

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
        const caller = getCalendarPollingCallerId(state);

        if (caller === instanceId) {
          const readyAt = state.lastCalendarAttemptAt > 0 ? state.lastCalendarAttemptAt + intervalMs : 0;
          const waitMs = Math.max(0, readyAt - Date.now());

          if (waitMs > 0) {
            reporter.setBookingStep(`calendar · re-poll in ${Math.round(waitMs / 1000)}s`);
            const woke = await waitForCoordOrTimeout({
              abortSeq, waitForAbort,
              timeoutMs: Math.min(waitMs, 2000),
              watcherWait: watcher.wait,
            });
            if (woke === "abort") return false;
            continue;
          }

          reporter.setBookingStep("calendar · re-poll");
          try {
            const dates = await browser.fetchCalendarDatesForFleet();
            publishCalendarRepollDates(instanceId, dates);
          } catch (err) {
            if (err instanceof VfsRateLimitedError) throw err;
            recordCalendarPollFailure(instanceId);
          }
          continue;
        }

        // Not our turn — wait for coord change
        reporter.setBookingStep("calendar · waiting turn");
        const woke = await waitForCoordOrTimeout({
          abortSeq, waitForAbort,
          timeoutMs: 2000,
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

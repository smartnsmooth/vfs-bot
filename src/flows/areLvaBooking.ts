/**
 * are-lva booking after login + post-login delay + applicants URN.
 *
 * No CheckIsSlotAvailable. Fees if totalAmount is missing. Calendar round-robin
 * in fleet order. Dates are split across instances. Every bot on a date calls
 * timeslot; the first response publishes times only. Each bot then takes a
 * distinct time and schedules with the allocationId from its own timeslot call.
 * Each instance's calendar API calls are counted like CheckIsSlotAvailable; after
 * `reloginAfter` empty polls, hard-relogin then applicants then calendar again.
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
import { setAllocationId } from "../utils/allocationId.store";
import { getTotalAmount, setTotalAmount, getCurrency, setCurrency } from "../utils/totalAmount.store";
import {
  activeWaiters,
  claimCalendarAttempt,
  createCalendarBookingWatcher,
  forceCalendarRepoll,
  leaveFleetCalendar,
  markScheduledSuccess,
  publishCalendarDates,
  publishSharedFees,
  readCalendarBookingState,
  registerCalendarWaiter,
  registerFleetUrn,
  releaseCalendarAttempt,
  type CalendarBookingCoordState,
} from "../utils/calendarBookingCoord";
import {
  areLvaSlotsReady,
  assignedDateFor,
  claimAnySlotOnDate,
  claimUnclaimedSlotOnDate,
  ensureAreLvaDateGroups,
  findSurplusDate,
  lastTimeslotDateFor,
  publishAreLvaTimeslots,
  releaseAreLvaTimeClaim,
  unclaimedCountOnDate,
} from "../utils/areLvaBookingCoord";
import { getCalendarPollingIntervalMs } from "./fleetCalendarBooking";
import { reporter } from "../monitoring/statusReporter";

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

async function runSchedule(
  browser: BrowserService,
  instanceId: number,
  allocationId: string
): Promise<"booked" | "retry"> {
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
    return "retry";
  } catch (err) {
    if (isUnrecoverableHere(err)) throw err;
    return "retry";
  }
}

async function runFeesIfMissing(browser: BrowserService, instanceId: number): Promise<void> {
  if (tryPublishLocalFees(instanceId)) return;
  const state = readCalendarBookingState();
  if (state.feesDone) {
    applySharedFeesLocally(state);
    return;
  }
  reporter.setBookingStep("fees");
  try {
    await browser.postFeesLiftApi();
    tryPublishLocalFees(instanceId);
  } catch (err) {
    if (isUnrecoverableHere(err)) throw err;
  }
}

type LocalTimeslotEntry = { allocationId: string; time: string };

function showCalendarPoll(n: number): void {
  reporter.setPoll({ pollCount: n });
  reporter.setBookingStep(`poll #${n} · calendar`);
}

async function maybeCalendarPollRelogin(
  instanceId: number,
  calendarPolls: number,
  opts: { reloginAfter?: number; onRelogin?: () => Promise<void> }
): Promise<void> {
  const reloginAfter = opts.reloginAfter;
  if (!(reloginAfter && reloginAfter > 0 && calendarPolls >= reloginAfter && opts.onRelogin)) return;
  leaveFleetCalendar(instanceId);
  await opts.onRelogin();
  throw new MissingUrnError("calendar poll interval — need applicants");
}

function localTimesOf(cache: Map<string, LocalTimeslotEntry[]>, date: string): Set<string> {
  return new Set(
    (cache.get(date) ?? []).map((e) => e.time.trim()).filter(Boolean)
  );
}

function allocationIdForTime(
  cache: Map<string, LocalTimeslotEntry[]>,
  date: string,
  time: string
): string | null {
  const want = time.trim();
  for (const e of cache.get(date) ?? []) {
    if (e.time.trim() === want && e.allocationId.trim()) return e.allocationId.trim();
  }
  return null;
}

async function fetchTimeslotForDate(
  browser: BrowserService,
  instanceId: number,
  date: string
): Promise<LocalTimeslotEntry[] | null> {
  reporter.setBookingStep(`timeslot (${date})`);
  try {
    const entries = await browser.fetchTimeslotAllocationsForFleet(date);
    publishAreLvaTimeslots(instanceId, date, entries);
    return entries.map((e) => ({ allocationId: e.allocationId, time: e.time }));
  } catch (err) {
    if (isUnrecoverableHere(err)) throw err;
    return null;
  }
}

export async function runAreLvaBooking(opts: {
  browser: BrowserService;
  instanceId: number;
  abortSeq: number;
  isAbort: (seq: number) => boolean;
  waitForAbort: (seq: number) => Promise<void>;
  /** After this many calendar API calls by this instance, hard-relogin (same as CheckIsSlotAvailable). */
  reloginAfter?: number;
  onRelogin?: () => Promise<void>;
}): Promise<boolean> {
  const { browser, abortSeq, isAbort, waitForAbort } = opts;
  const instanceId = Math.max(1, Math.floor(opts.instanceId));
  let calendarPolls = 0;

  registerFleetUrn(instanceId);
  registerCalendarWaiter(instanceId);
  const watcher = createCalendarBookingWatcher();
  const localTimeslots = new Map<string, LocalTimeslotEntry[]>();

  try {
    while (true) {
      if (isAbort(abortSeq)) return false;

      registerCalendarWaiter(instanceId);
      let state = readCalendarBookingState();

      if (state.scheduled.includes(instanceId)) return true;
      if (state.retired.includes(instanceId)) return false;

      if (!state.feesDone) {
        if (tryPublishLocalFees(instanceId)) continue;
        const localAmount = getTotalAmount();
        if (!localAmount?.trim()) {
          await runFeesIfMissing(browser, instanceId);
          continue;
        }
        tryPublishLocalFees(instanceId);
        continue;
      }
      applySharedFeesLocally(state);

      const dates = state.availableDateList;
      if (dates.length > 0) {
        ensureAreLvaDateGroups(dates);
      }

      let date = assignedDateFor(instanceId);

      if (!date && dates.length === 0) {
        state = readCalendarBookingState();
        const intervalMs = getCalendarPollingIntervalMs();
        const readyAt =
          !state.calendarSkipInterval && state.lastCalendarAttemptAt > 0
            ? state.lastCalendarAttemptAt + intervalMs
            : 0;
        const waitMs = Math.max(0, readyAt - Date.now());

        if (waitMs === 0 && claimCalendarAttempt(instanceId, intervalMs)) {
          showCalendarPoll(calendarPolls + 1);
          let gotDates = false;
          try {
            const calDates = await browser.fetchCalendarDatesForFleet();
            publishCalendarDates(instanceId, calDates);
            const next = readCalendarBookingState();
            if (next.availableDateList.length > 0) {
              ensureAreLvaDateGroups(next.availableDateList);
              gotDates = true;
            }
          } catch (err) {
            releaseCalendarAttempt(instanceId);
            if (isUnrecoverableHere(err)) throw err;
          }
          calendarPolls += 1;
          reporter.setPoll({ pollCount: calendarPolls });
          if (!gotDates) {
            await maybeCalendarPollRelogin(instanceId, calendarPolls, opts);
          }
          continue;
        }

        showCalendarPoll(calendarPolls);
        const woke = await waitForCoordOrTimeout({
          abortSeq,
          waitForAbort,
          timeoutMs: waitMs > 0 ? Math.min(waitMs, 2000) : 500,
          watcherWait: watcher.wait,
        });
        if (woke === "abort") return false;
        continue;
      }

      if (!date) {
        const woke = await waitForCoordOrTimeout({
          abortSeq, waitForAbort, timeoutMs: 400, watcherWait: watcher.wait,
        });
        if (woke === "abort") return false;
        continue;
      }

      if (!areLvaSlotsReady(date)) {
        const entries = await fetchTimeslotForDate(browser, instanceId, date);
        if (entries) localTimeslots.set(date, entries);
        else {
          const woke = await waitForCoordOrTimeout({
            abortSeq, waitForAbort, timeoutMs: 400, watcherWait: watcher.wait,
          });
          if (woke === "abort") return false;
        }
        continue;
      }

      if (!localTimeslots.has(date)) {
        const entries = await fetchTimeslotForDate(browser, instanceId, date);
        if (!entries) {
          const woke = await waitForCoordOrTimeout({
            abortSeq, waitForAbort, timeoutMs: 400, watcherWait: watcher.wait,
          });
          if (woke === "abort") return false;
          continue;
        }
        localTimeslots.set(date, entries);
      }

      let slot = claimUnclaimedSlotOnDate(instanceId, date, localTimesOf(localTimeslots, date));

      if (!slot) {
        const surplus = findSurplusDate(date);
        if (surplus) {
          if (!localTimeslots.has(surplus)) {
            const entries = await fetchTimeslotForDate(browser, instanceId, surplus);
            if (entries) localTimeslots.set(surplus, entries);
            if (!entries && !areLvaSlotsReady(surplus)) {
              const woke = await waitForCoordOrTimeout({
                abortSeq, waitForAbort, timeoutMs: 400, watcherWait: watcher.wait,
              });
              if (woke === "abort") return false;
              continue;
            }
          }
          slot = claimUnclaimedSlotOnDate(instanceId, surplus, localTimesOf(localTimeslots, surplus));
          if (slot) date = surplus;
        }
      }

      if (!slot) {
        const last = lastTimeslotDateFor(instanceId) ?? date;
        if (!localTimeslots.has(last)) {
          const entries = await fetchTimeslotForDate(browser, instanceId, last);
          if (entries) localTimeslots.set(last, entries);
        }
        slot = claimAnySlotOnDate(instanceId, last);
        if (slot) date = last;
      }

      if (!slot) {
        showCalendarPoll(calendarPolls);
        forceCalendarRepoll();
        localTimeslots.clear();
        continue;
      }

      let alloc = allocationIdForTime(localTimeslots, date, slot.time);
      if (!alloc) {
        const entries = await fetchTimeslotForDate(browser, instanceId, date);
        if (entries) localTimeslots.set(date, entries);
        alloc = allocationIdForTime(localTimeslots, date, slot.time);
      }
      if (!alloc) {
        releaseAreLvaTimeClaim(instanceId, date);
        continue;
      }

      const outcome = await runSchedule(browser, instanceId, alloc);
      if (outcome === "booked") return true;

      reporter.setBookingStep(`timeslot retry (${date})`);
      const retried = await fetchTimeslotForDate(browser, instanceId, date);
      if (retried) localTimeslots.set(date, retried);
      const retryAlloc = allocationIdForTime(localTimeslots, date, slot.time);
      if (retryAlloc) {
        const again = await runSchedule(browser, instanceId, retryAlloc);
        if (again === "booked") return true;
      }

      releaseAreLvaTimeClaim(instanceId, date);
      const leftover = unclaimedCountOnDate(date);
      if (leftover <= 0) {
        const surplus = findSurplusDate(date);
        if (surplus) {
          if (!localTimeslots.has(surplus)) {
            const entries = await fetchTimeslotForDate(browser, instanceId, surplus);
            if (entries) localTimeslots.set(surplus, entries);
          }
          continue;
        }
        forceCalendarRepoll();
        localTimeslots.clear();
      }
    }
  } finally {
    watcher.dispose();
  }
}

export function areLvaActiveWaiterCount(): number {
  return activeWaiters(readCalendarBookingState()).length;
}

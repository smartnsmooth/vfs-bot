import type { Page } from "playwright";
import { config, getCurrentInstanceId } from "../config/config";
import {
  calendarApiDateMatchesConstraint,
  NoDatesInScheduleRangeError,
  scheduleConstraintIsActive,
  scheduleConstraintLogValue,
  type ScheduleDateConstraint,
} from "../utils/scheduleAllowedDates.js";
import { buildCalendarBody, CALENDAR_URL, firstDayOfNextMonthFromDdMmYyyy } from "../config/calendar";
import { buildScheduleBody, SCHEDULE_URL } from "../config/schedule";
import { buildTimeslotBody, TIMESLOT_URL } from "../config/timeslot";
import { buildFeesBody, FEES_URL } from "../config/fees";
import { buildMapVasBody, MAPVAS_URL } from "../config/mapvas";
import { buildSaveApplicantsBody, SAVE_APPLICANTS_URL } from "../config/saveApplicants";
import { logger } from "../utils/logger";
import { ensureApplicantIpResolved } from "../utils/applicantIp";
import { getAllocationId, setAllocationId } from "../utils/allocationId.store";
import { getApplicationUrn, setApplicationUrn } from "../utils/applicationUrn.store";
import { getSlotDate, setSlotDate, getCalendarDatesCount, setCalendarDatesCount } from "../utils/slotDate.store";
import { setTotalAmount, setCurrency } from "../utils/totalAmount.store";
import { getCapturedClientSource } from "../utils/capturedClientSource.store";
import { setScheduleUrl } from "../utils/scheduleUrl.store";
import { saveBookingConfirmationFile } from "../utils/bookingConfirmationFile";
import { buildScheduleRedirectUrl } from "../utils/scheduleRedirectUrl";
import { classifyVfsFirstTabUrl } from "../flows/vfsTabUrl";
import { VfsGatewayTimeoutError, throwVfsRateLimited } from "./browser.errors";
import { classifyVfs429FromHttp } from "../utils/vfsRateLimit";
import { TelegramService } from "./telegram.service";

// ── Lift-API page context helpers ───────────────────────────────────────

function getLiftApiPageContextFromSource(page: Page): { origin: string; referer: string; route: string } {
  const sourceUrl = page.url();
  const origin = new URL(sourceUrl).origin;
  const referer = sourceUrl.endsWith("/") ? sourceUrl : `${sourceUrl}/`;
  const pathname = new URL(sourceUrl).pathname;
  const route = pathname.split("/").filter(Boolean).slice(0, -1).join("/");
  return { origin, referer, route };
}

function assertVfsPageLoggedInForLiftApi(page: Page): void {
  let url = "";
  try {
    url = page.url();
  } catch {
    throw new Error("Lift-api call blocked: could not read the active tab URL.");
  }
  const kind = classifyVfsFirstTabUrl(url);
  if (kind === "login" || kind === "blank") {
    throw new Error(
      "Lift-api call blocked: VFS tab is still on login or blank. Complete login and OTP first; slot/API calls run only after a logged-in page."
    );
  }
}

export async function postLiftJsonFromPage(
  page: Page,
  url: string,
  payload: Record<string, unknown>
): Promise<{ status: number; body: string }> {
  assertVfsPageLoggedInForLiftApi(page);
  const { origin, referer, route } = getLiftApiPageContextFromSource(page);
  const clientSourceOverride: string | null = getCapturedClientSource()?.trim() || null;
  const result = await page.evaluate(
    async (args: {
      url: string;
      payload: Record<string, unknown>;
      origin: string;
      referer: string;
      route: string;
      clientSourceOverride: string | null;
    }) => {
      const getStored = (keys: string[]): string | null => {
        try {
          for (const k of keys) {
            const v = sessionStorage.getItem(k) ?? localStorage.getItem(k);
            if (v) return v;
          }
          const w = window as unknown as Record<string, unknown>;
          for (const k of keys) {
            const v = w[k];
            if (typeof v === "string") return v;
          }
        } catch {
          /* ignore */
        }
        return null;
      };
      const getStoredByPrefix = (prefix: string): string | null => {
        try {
          for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i);
            if (k && k.toLowerCase().includes(prefix)) {
              const v = sessionStorage.getItem(k);
              const t = v?.trim();
              if (t) return t;
            }
          }
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.toLowerCase().includes(prefix)) {
              const v = localStorage.getItem(k);
              const t = v?.trim();
              if (t) return t;
            }
          }
        } catch {
          /* ignore */
        }
        return null;
      };
      const authorize =
        getStored(["JWT", "authorize", "authToken", "token", "authorization"]) ?? getStoredByPrefix("auth");
      const fromStorage =
        getStored(["clientsource", "clientSource", "client_source"]) ?? getStoredByPrefix("client");
      const clientsource = args.clientSourceOverride?.trim() || fromStorage?.trim() || "";
      const headers: Record<string, string> = {
        "Content-Type": "application/json;charset=UTF-8",
        Accept: "application/json, text/plain, */*",
        Origin: args.origin,
        Referer: args.referer,
        route: args.route,
      };
      if (authorize?.trim()) headers.authorize = authorize.trim();
      if (clientsource) headers.clientsource = clientsource;
      const r = await fetch(args.url, {
        method: "POST",
        headers,
        body: JSON.stringify(args.payload),
        credentials: "include",
      });
      return { status: r.status, body: await r.text() };
    },
    { url, payload, origin, referer, route, clientSourceOverride }
  );
  if (result.status === 504) {
    throw new VfsGatewayTimeoutError(`API returned 504 Gateway Timeout: ${url}`);
  }
  const rate = classifyVfs429FromHttp(result.status, result.body);
  if (rate) {
    logger.warn(
      { url, status: result.status, code: rate.code, kind: rate.kind, bodySnippet: result.body.slice(0, 200) },
      "[Lift API] 429 rate-limit response"
    );
    throwVfsRateLimited(rate.kind, rate.code, `Lift API ${url}`);
  }
  return result;
}

// ── Applicants ──────────────────────────────────────────────────────────

function parseApplicantsResponseJson(body: string): { urn?: string; error?: unknown; applicantList?: unknown } {
  let parsed: { urn?: string; error?: unknown; applicantList?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new Error("Save applicants: response is not JSON");
  }
  if (parsed.error != null && parsed.error !== "") {
    throw new Error(`Save applicants API error: ${JSON.stringify(parsed.error)}`);
  }
  return parsed;
}

export async function saveApplicantsOnPage(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  await ensureApplicantIpResolved(page);
  const body = buildSaveApplicantsBody();
  logger.info({ url: SAVE_APPLICANTS_URL, payload: JSON.stringify(body) }, "Saving applicant via lift-api");

  const res = await postLiftJsonFromPage(page, SAVE_APPLICANTS_URL, body);
  logger.info({ status: res.status, responseBody: res.body.slice(0, 1000) }, "Applicants API response");

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Save applicants failed HTTP ${res.status}: ${res.body.slice(0, 500)}`
    );
  }

  const parsed = parseApplicantsResponseJson(res.body);
  const urn = parsed.urn?.trim();
  if (!urn) {
    throw new Error(
      `Save applicants failed: no URN in response (HTTP ${res.status})`
    );
  }
  setApplicationUrn(urn);
  logger.info({ urn }, "Applicants saved");
}

export async function testSaveApplicantsOnPage(page: Page): Promise<{ status: number; body: string }> {
  await page.waitForTimeout(500);
  await ensureApplicantIpResolved(page);
  const body = buildSaveApplicantsBody();
  logger.info({ url: SAVE_APPLICANTS_URL }, "[Test] POST appointment/applicants");
  const res = await postLiftJsonFromPage(page, SAVE_APPLICANTS_URL, body);
  logger.info({ status: res.status, responseBody: res.body.slice(0, 1500) }, "[Test] Applicants API response");
  return res;
}

// ── Fees ─────────────────────────────────────────────────────────────────

export async function postFeesOnPage(page: Page, urn: string): Promise<void> {
  const feesPayload = buildFeesBody(urn);
  logger.info({ url: FEES_URL }, "Calling lift-api fees");
  const res = await postLiftJsonFromPage(page, FEES_URL, feesPayload);
  try {
    const j = JSON.parse(res.body) as {
      error?: unknown;
      totalAmount?: unknown;
      totalamount?: unknown;
      feeDetails?: Array<{ currency?: unknown }>;
    };
    if (j.error != null && j.error !== "") {
      throw new Error(`Fees API error: ${JSON.stringify(j.error)}`);
    }
    const totalAmountRaw = j.totalAmount ?? j.totalamount;
    if (typeof totalAmountRaw === "string" && totalAmountRaw.trim() !== "") {
      setTotalAmount(totalAmountRaw);
      logger.info({ totalAmount: totalAmountRaw }, "Stored fees totalAmount");
    } else if (typeof totalAmountRaw === "number" && Number.isFinite(totalAmountRaw)) {
      const s = String(totalAmountRaw);
      setTotalAmount(s);
      logger.info({ totalAmount: s }, "Stored fees totalAmount");
    } else {
      logger.warn("Fees response has no totalAmount; nothing stored");
    }
    if (j.feeDetails && j.feeDetails.length > 0 && typeof j.feeDetails[0]?.currency === "string" && j.feeDetails[0]?.currency.trim() !== "") {
      setCurrency(j.feeDetails[0]?.currency);
      logger.info({ currency: j.feeDetails[0]?.currency }, "Stored fees currency");
    } else {
      logger.warn("Fees response has no currency; nothing stored");
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Fees API error")) throw e;
    throw new Error("Fees: response is not JSON");
  }
  logger.info("Fees retrieved OK");
}

// ── MapVas ───────────────────────────────────────────────────────────────

export async function postMapVasOnPage(page: Page, urn: string): Promise<void> {
  const payload = buildMapVasBody(urn);
  logger.info({ url: MAPVAS_URL }, "Calling lift-api mapvas");
  const res = await postLiftJsonFromPage(page, MAPVAS_URL, payload);
  try {
    const j = JSON.parse(res.body) as { urn?: string; amount?: number; currency?: string; error?: unknown };
    if (j.error != null && j.error !== "") {
      throw new Error(`MapVas API error: ${JSON.stringify(j.error)}`);
    }
    logger.info({ urn: j.urn, amount: j.amount, currency: j.currency }, "MapVas response OK");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("MapVas API error")) throw e;
    throw new Error("MapVas: response is not JSON");
  }
}

// ── Calendar ─────────────────────────────────────────────────────────────

export async function postCalendarOnPage(
  page: Page,
  urn: string,
  opts?: { scheduleConstraint?: ScheduleDateConstraint }
): Promise<void> {
  type CalJson = { error?: unknown; calendars?: Array<{ date?: string; isWeekend?: boolean }> | null };
  const isCalendar1035FullSlot = (e: unknown): boolean =>
    e != null && typeof e === "object" && (e as { code?: unknown }).code === 1035;

  let payload: Record<string, unknown> = buildCalendarBody(urn);
  logger.info({ url: CALENDAR_URL, fromDate: payload.fromDate }, "Calling lift-api calendar");
  let res = await postLiftJsonFromPage(page, CALENDAR_URL, payload);
  let j: CalJson;
  try {
    j = JSON.parse(res.body) as CalJson;
    if (isCalendar1035FullSlot(j.error)) {
      const prevFrom = String(payload.fromDate ?? "");
      const retryFrom = firstDayOfNextMonthFromDdMmYyyy(prevFrom);
      logger.warn(
        { previousFrom: prevFrom, retryFrom },
        "Calendar API 1035 (slot full) — retrying with first day of next month for fromDate"
      );
      payload = buildCalendarBody(urn, { fromDate: retryFrom });
      logger.info({ url: CALENDAR_URL, fromDate: payload.fromDate }, "Calling lift-api calendar (retry)");
      res = await postLiftJsonFromPage(page, CALENDAR_URL, payload);
      j = JSON.parse(res.body) as CalJson;
    }
    if (j.error != null && j.error !== "") {
      throw new Error(`Calendar API error: ${JSON.stringify(j.error)}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Calendar API error")) throw e;
    throw new Error("Calendar: response is not JSON");
  }
  let dates = (j.calendars ?? []).map((c) => String(c?.date ?? "").trim()).filter(Boolean);
  const constraint = opts?.scheduleConstraint;
  if (constraint && scheduleConstraintIsActive(constraint)) {
    const before = dates.length;
    dates = dates.filter((d) => calendarApiDateMatchesConstraint(d, constraint));
    logger.info(
      { beforeCount: before, afterCount: dates.length, ...scheduleConstraintLogValue(constraint) },
      "Calendar dates filtered by schedule constraint"
    );
    if (dates.length === 0) {
      throw new NoDatesInScheduleRangeError();
    }
  }

  if (dates.length > 0) {
    const totalInstances = Math.max(1, parseInt(process.env.BOT_TOTAL_INSTANCES ?? "1", 10) || 1);
    const myId = getCurrentInstanceId() ?? 1;
    const myIdx = Math.max(0, Math.min(totalInstances - 1, myId - 1));

    const base = Math.floor(totalInstances / dates.length);
    const rem = totalInstances % dates.length;

    let chosenIdx = 0;
    let acc = 0;
    for (let i = 0; i < dates.length; i++) {
      const size = base + (i < rem ? 1 : 0);
      const start = acc;
      const end = acc + size;
      if (myIdx >= start && myIdx < end) {
        chosenIdx = i;
        break;
      }
      acc = end;
    }

    const chosen = dates[chosenIdx]!;
    setSlotDate(chosen);
    setCalendarDatesCount(dates.length);
    logger.info(
      { slotDate: chosen, chosenIdx, datesCount: dates.length, myId, totalInstances },
      "Stored sharded calendar date as slotDate"
    );
  } else {
    logger.warn("Calendar response has no calendars[].date; slotDate not set");
  }
  logger.info("Calendar retrieved OK");
}

// ── Timeslot ─────────────────────────────────────────────────────────────

export async function postTimeslotOnPage(page: Page, urn: string, slotDateFromCalendar: string): Promise<void> {
  const payload = buildTimeslotBody(urn, slotDateFromCalendar);
  logger.info({ url: TIMESLOT_URL, slotDate: payload.slotDate }, "Calling lift-api timeslot");
  const res = await postLiftJsonFromPage(page, TIMESLOT_URL, payload);
  let j: {
    error?: unknown;
    slots?: Array<{ allocationId?: string | number; slot?: string; type?: string }>;
  };
  try {
    j = JSON.parse(res.body) as typeof j;
    if (j.error !== null && j.error !== undefined) {
      throw new Error(`Timeslot API error: ${JSON.stringify(j.error)}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Timeslot API error")) throw e;
    throw new Error("Timeslot: response is not JSON");
  }
  const slots = j.slots ?? [];
  if (slots.length === 0) {
    logger.warn("Timeslot response has no slots");
  } else {
    const totalInstances = Math.max(1, parseInt(process.env.BOT_TOTAL_INSTANCES ?? "1", 10) || 1);
    const myId = getCurrentInstanceId() ?? 1;
    const myIdx = Math.max(0, Math.min(totalInstances - 1, myId - 1));

    const dateCount = Math.max(1, getCalendarDatesCount());
    const dateBase = Math.floor(totalInstances / dateCount);
    const dateRem = totalInstances % dateCount;

    let groupStart = 0;
    let groupSize = totalInstances;
    let acc = 0;
    for (let i = 0; i < dateCount; i++) {
      const size = dateBase + (i < dateRem ? 1 : 0);
      if (myIdx >= acc && myIdx < acc + size) {
        groupStart = acc;
        groupSize = size;
        break;
      }
      acc += size;
    }
    const subIdx = myIdx - groupStart;

    const chosenSlotIdx = subIdx % slots.length;
    const chosen = slots[chosenSlotIdx];
    const alloc = String(chosen?.allocationId ?? "").trim();
    if (alloc) {
      setAllocationId(alloc);
      logger.info(
        { allocationIdPrefix: alloc.slice(0, 16), chosenSlotIdx, slotsCount: slots.length, myId, totalInstances, dateGroupSize: groupSize, subIdx },
        "Stored sharded timeslot allocationId"
      );
    } else {
      logger.warn({ chosenSlotIdx }, "Chosen timeslot slot has no allocationId");
    }
  }
  logger.info("Timeslot retrieved OK");

  const inst = getCurrentInstanceId() ?? 1;
  void new TelegramService()
    .alert("hold_success", `Instance ${inst} holds slot for ${payload.slotDate}`)
    .catch(() => { });
}

// ── Schedule ─────────────────────────────────────────────────────────────

export async function postScheduleOnPage(page: Page, urn: string, allocationId: string): Promise<void> {
  const payload = buildScheduleBody(urn, allocationId);
  logger.info({ url: SCHEDULE_URL }, "Calling lift-api schedule");

  const res = await postLiftJsonFromPage(page, SCHEDULE_URL, payload);
  console.log("[Schedule] Final HTTP", res.status, res.body.slice(0, 800));
  let j: {
    error?: unknown;
    IsAppointmentBooked?: boolean;
    URL?: string | null;
    url?: string | null;
    payLoad?: string | null;
    payload?: string | null;
    appointmentDate?: string;
    appointmentTime?: string;
  };
  try {
    j = JSON.parse(res.body) as typeof j;
    if (j.error != null && j.error !== "") {
      throw new Error(`Schedule API error: ${JSON.stringify(j.error)}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Schedule API error")) throw e;
    throw new Error("Schedule: response is not JSON");
  }

  saveBookingConfirmationFile(payload, j, getCurrentInstanceId());

  const schedulePaymentUrl = buildScheduleRedirectUrl(j);
  if (schedulePaymentUrl) {
    setScheduleUrl(schedulePaymentUrl);
    logger.info({ urlPrefix: schedulePaymentUrl.slice(0, 80) }, "Stored schedule payment URL (URL + payLoad when present)");
    void new TelegramService()
      .alert("info", `A Slot is Booked. Open the link to pay for the slot: \n${schedulePaymentUrl}`, {
        booked: j.IsAppointmentBooked,
        date: j.appointmentDate,
        time: j.appointmentTime,
      })
      .catch(() => { });
  } else {
    logger.info({ IsAppointmentBooked: j.IsAppointmentBooked }, "Schedule OK; no URL in response (free service or VAC pay)");
    void new TelegramService()
      .alert(
        "info",
        `A Slot is Booked (free service — no payment required). Appointment: ${j.appointmentDate ?? "?"} ${j.appointmentTime ?? "?"}`,
        {
          booked: j.IsAppointmentBooked,
          date: j.appointmentDate,
          time: j.appointmentTime,
        }
      )
      .catch(() => { });
  }

  await callScheduleRedirectGetIfPresent(page, j);

  logger.info(
    { booked: j.IsAppointmentBooked, date: j.appointmentDate, time: j.appointmentTime },
    "Schedule retrieved OK"
  );
}

async function callScheduleRedirectGetIfPresent(
  page: Page,
  scheduleResponse: { URL?: string | null; url?: string | null; payLoad?: string | null; payload?: string | null }
): Promise<void> {
  let finalUrl = buildScheduleRedirectUrl(scheduleResponse);
  let isDashboardFallback = false;

  if (!finalUrl) {
    const rc = String(config.slotPayload.countryCode ?? "").trim().toLowerCase();
    const rm = String(config.slotPayload.missionCode ?? "").trim().toLowerCase();
    const routeKey = `${rc}-${rm}`;
    const NO_PAYMENT_ROUTES = new Set(["uzb-lva"]);
    if (NO_PAYMENT_ROUTES.has(routeKey) && rc && rm) {
      finalUrl = `https://visa.vfsglobal.com/${rc}/en/${rm}/dashboard`;
      isDashboardFallback = true;
    }
  }

  if (!finalUrl) return;

  const skipPaymentRedirect = /^true|1|yes$/i.test(
    (process.env.VFS_SKIP_SCHEDULE_PAYMENT_REDIRECT ?? "").trim()
  );
  if (skipPaymentRedirect && !isDashboardFallback) {
    logger.info(
      { urlPrefix: finalUrl.slice(0, 120) },
      "Skipping payment redirect after schedule (VFS_SKIP_SCHEDULE_PAYMENT_REDIRECT)"
    );
    return;
  }

  logger.info(
    { urlPrefix: finalUrl.slice(0, 120), isDashboardFallback },
    isDashboardFallback
      ? "Navigating to dashboard page (free service, no payment required)"
      : "Navigating to schedule redirect URL with payLoad"
  );

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45_000 }),
    page.evaluate((u) => window.location.assign(u), finalUrl),
  ]);
  logger.info({ redirectedTo: page.url() }, "Schedule redirect navigation completed");
}

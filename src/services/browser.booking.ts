import type { Page } from "playwright";
import { config, getCurrentInstanceId } from "../config/config";
import { buildCalendarBody, CALENDAR_URL, firstDayOfNextMonthFromDdMmYyyy } from "../config/calendar";
import { buildScheduleBody, SCHEDULE_URL } from "../config/schedule";
import { buildTimeslotBody, TIMESLOT_URL } from "../config/timeslot";
import { buildFeesBody, FEES_URL, type BuildFeesBodyOptions } from "../config/fees";
import { buildMapVasBody, MAPVAS_URL } from "../config/mapvas";
import { buildSaveApplicantsBody, SAVE_APPLICANTS_URL } from "../config/saveApplicants";
import { ensureApplicantIpResolved } from "../utils/applicantIp";
import { getApplicationUrn, setApplicationUrn } from "../utils/applicationUrn.store";
import { setTotalAmount, setCurrency } from "../utils/totalAmount.store";
import { getCapturedClientSource } from "../utils/capturedClientSource.store";
import { setScheduleUrl } from "../utils/scheduleUrl.store";
import { saveBookingConfirmationFile } from "../utils/bookingConfirmationFile";
import { isScheduleAlreadyBooked, saveAlreadyBookedAccountFile } from "../utils/alreadyBookedAccountFile";
import { buildScheduleRedirectUrl } from "../utils/scheduleRedirectUrl";
import { classifyVfsFirstTabUrl } from "../flows/vfsTabUrl";
import { AlreadyBookedError, VfsForbiddenError, VfsGatewayTimeoutError, isFailedToFetchError, throwVfsRateLimited } from "./browser.errors";
import { classifyVfs429FromHttp } from "../utils/vfsRateLimit";
import { throwIfLiftAuthBlocked } from "../utils/vfsAuthBlock";
import { bumpJoinStaggerOn504 } from "../utils/joinStaggerCoord";
import { getApiDelayMs, getRepeatedDelayMs, REPEATED_DELAY_STEP_SEC } from "../utils/fleetPollSchedule";
import { isCloudflareChallengeBody, logApiCall, liftUrlToLogKind } from "../utils/apiCallLog";
import { reporter } from "../monitoring/statusReporter";
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

const REPEATED_DELAY_KINDS = new Set(["polling", "applicants", "calendar", "timeslot", "fees", "schedule"]);

/** In-page retries for a dropped proxy connection before the caller rotates the IP. */
const MAX_IN_PAGE_FETCH_RETRIES = 3;
const IN_PAGE_FETCH_RETRY_STEP_MS = 1_000;

function isHttp409(status: number): boolean {
  return status === 409;
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
  const logKind = liftUrlToLogKind(url);
  const instanceId = getCurrentInstanceId();
  const payloadJson = JSON.stringify(payload);

  try {
    assertVfsPageLoggedInForLiftApi(page);
  } catch (err) {
    if (logKind) {
      logApiCall(
        logKind,
        "",
        instanceId ?? undefined,
        payloadJson,
        { error: err instanceof Error ? err.message : String(err) }
      );
    }
    throw err;
  }

  const { origin, referer, route } = getLiftApiPageContextFromSource(page);
  const clientSourceOverride: string | null = getCapturedClientSource()?.trim() || null;
  let repeatedDelayMs = getRepeatedDelayMs();
  let fetchFailures = 0;

  for (;;) {
    if (logKind === "polling") {
      reporter.flashCard(1, "polling");
    } else if (
      logKind === "applicants" ||
      logKind === "calendar" ||
      logKind === "fees" ||
      logKind === "timeslot" ||
      logKind === "schedule"
    ) {
      reporter.flashCard(3, logKind);
    }

    const apiDelayMs = getApiDelayMs();
    if (apiDelayMs > 0) {
      await new Promise<void>((r) => setTimeout(r, apiDelayMs));
    }

    let result: { status: number; body: string };
    try {
      result = await page.evaluate(
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
    } catch (err) {
      // A dropped proxy connection surfaces as "Failed to fetch". The VFS session is still
      // valid, so retry in place before letting the caller rotate the IP or relogin.
      if (isFailedToFetchError(err) && fetchFailures < MAX_IN_PAGE_FETCH_RETRIES) {
        fetchFailures += 1;
        reporter.setDetail(`fetch failed — retry ${fetchFailures}/${MAX_IN_PAGE_FETCH_RETRIES}`);
        await new Promise<void>((r) => setTimeout(r, IN_PAGE_FETCH_RETRY_STEP_MS * fetchFailures));
        continue;
      }
      if (logKind) {
        logApiCall(
          logKind,
          "",
          instanceId ?? undefined,
          payloadJson,
          { error: err instanceof Error ? err.message : String(err) }
        );
      }
      throw err;
    }

    if (logKind) {
      logApiCall(
        logKind,
        result.body ?? "",
        instanceId ?? undefined,
        payloadJson
      );
    }

    if (isCloudflareChallengeBody(result.body)) {
      throw new VfsForbiddenError(
        "Cloudflare challenge — clearing session, rotating IP, restarting Chrome."
      );
    }

    if (result.status === 504) {
      await new Promise<void>((r) => setTimeout(r, 1000));
      bumpJoinStaggerOn504();
      continue;
    }
    if (logKind && REPEATED_DELAY_KINDS.has(logKind) && isHttp409(result.status)) {
      const sleepSec = Math.max(1, Math.round(repeatedDelayMs / 1000));
      reporter.setDetail(`409 — retry ${logKind} in ${sleepSec}s`);
      await new Promise<void>((r) => setTimeout(r, repeatedDelayMs));
      repeatedDelayMs += REPEATED_DELAY_STEP_SEC * 1000;
      continue;
    }
    const rate = classifyVfs429FromHttp(result.status, result.body);
    if (rate) {
          throwVfsRateLimited(rate.kind, rate.code, `Lift API ${url}`);
    }
    throwIfLiftAuthBlocked(result.status, result.body, `Lift API ${url}`);
    return result;
  }
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
    const code = extractErrorCode(parsed.error);
    if (code === 1037) {
      throw new AlreadyBookedError(`Save applicants: already booked (code 1037) — ${JSON.stringify(parsed.error)}`);
    }
    if (code === 1101) {
      throw new AlreadyBookedError(`Save applicants: payment pending (code 1101) — ${JSON.stringify(parsed.error)}`);
    }
    throw new Error(`Save applicants API error: ${JSON.stringify(parsed.error)}`);
  }
  return parsed;
}

function extractErrorCode(error: unknown): number | null {
  if (error == null) return null;
  if (typeof error === "object") {
    const c = (error as { code?: unknown }).code;
    if (typeof c === "number") return c;
    if (typeof c === "string") { const n = parseInt(c, 10); return Number.isFinite(n) ? n : null; }
  }
  if (typeof error === "string") {
    const m = error.match(/\b(1037|1101)\b/);
    return m ? parseInt(m[1], 10) : null;
  }
  return null;
}

export async function saveApplicantsOnPage(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  await ensureApplicantIpResolved(page);
  const body = buildSaveApplicantsBody();
  
  const res = await postLiftJsonFromPage(page, SAVE_APPLICANTS_URL, body);
  
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
  }

// ── Fees ─────────────────────────────────────────────────────────────────

export async function postFeesOnPage(page: Page, urn: string, opts?: BuildFeesBodyOptions): Promise<void> {
  const feesPayload = buildFeesBody(urn, opts);
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
          } else if (typeof totalAmountRaw === "number" && Number.isFinite(totalAmountRaw)) {
      const s = String(totalAmountRaw);
      setTotalAmount(s);
          } else {
          }
    if (j.feeDetails && j.feeDetails.length > 0 && typeof j.feeDetails[0]?.currency === "string" && j.feeDetails[0]?.currency.trim() !== "") {
      setCurrency(j.feeDetails[0]?.currency);
          } else {
          }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Fees API error")) throw e;
    throw new Error("Fees: response is not JSON");
  }
  }

// ── MapVas ───────────────────────────────────────────────────────────────

export async function postMapVasOnPage(page: Page, urn: string): Promise<void> {
  const payload = buildMapVasBody(urn);
    const res = await postLiftJsonFromPage(page, MAPVAS_URL, payload);
  try {
    const j = JSON.parse(res.body) as { urn?: string; amount?: number; currency?: string; error?: unknown };
    if (j.error != null && j.error !== "") {
      throw new Error(`MapVas API error: ${JSON.stringify(j.error)}`);
    }
      } catch (e) {
    if (e instanceof Error && e.message.startsWith("MapVas API error")) throw e;
    throw new Error("MapVas: response is not JSON");
  }
}

// ── Calendar ─────────────────────────────────────────────────────────────

/**
 * Call Calendar and return all non-empty calendars[].date values.
 * Empty list or API error throws (caller advances to next waiter).
 */
export async function fetchCalendarDatesForFleetOnPage(page: Page, urn: string): Promise<string[]> {
  type CalJson = { error?: unknown; calendars?: Array<{ date?: string; isWeekend?: boolean }> | null };
  const isCalendar1035FullSlot = (e: unknown): boolean =>
    e != null && typeof e === "object" && (e as { code?: unknown }).code === 1035;

  let payload: Record<string, unknown> = buildCalendarBody(urn);
    let res = await postLiftJsonFromPage(page, CALENDAR_URL, payload);
  let j: CalJson;
  try {
    j = JSON.parse(res.body) as CalJson;
    if (isCalendar1035FullSlot(j.error)) {
      const prevFrom = String(payload.fromDate ?? "");
      const retryFrom = firstDayOfNextMonthFromDdMmYyyy(prevFrom);
            payload = buildCalendarBody(urn, { fromDate: retryFrom });
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
  const dates = (j.calendars ?? []).map((c) => String(c?.date ?? "").trim()).filter(Boolean);
  if (dates.length === 0) {
    throw new Error("Calendar response has empty calendars list");
  }
    return dates;
}

/**
 * Call Timeslot for a given date and return every allocationId in slots[]
 * (with that date).
 */
export interface FleetTimeslotEntry {
  allocationId: string;
  date: string;
  /** Time slot label, e.g. "10:00-11:00". */
  time: string;
}

export async function fetchTimeslotAllocationsForFleetOnPage(
  page: Page,
  urn: string,
  slotDateFromCalendar: string
): Promise<FleetTimeslotEntry[]> {
  const payload = buildTimeslotBody(urn, slotDateFromCalendar);
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
  const dateLabel = String(slotDateFromCalendar).trim();
  const entries: FleetTimeslotEntry[] = [];
  for (const slot of j.slots ?? []) {
    const alloc = String(slot?.allocationId ?? "").trim();
    const time = String(slot?.slot ?? "").trim();
    if (!alloc) continue;
    entries.push({ allocationId: alloc, date: dateLabel, time: time || "unknown" });
  }
  const inst = getCurrentInstanceId() ?? 1;
  if (entries.length > 0) {
    void new TelegramService()
      .alert("hold_success", `Instance ${inst} timeslot for ${dateLabel}: ${entries.length} allocation(s)`)
      .catch(() => { });
  } else {
    // The caller already consumed this date from the shared list, so record why it vanished.
    reporter.setDetail(`timeslot 0 — ${dateLabel} dropped`);
  }
  return entries;
}

// ── Schedule ─────────────────────────────────────────────────────────────

export interface ScheduleResult {
  paymentUrl: string | null;
  /** True when VFS confirmed the appointment. Free routes book without returning a payment URL. */
  booked: boolean;
}

export async function postScheduleOnPage(
  page: Page,
  urn: string,
  allocationId: string
): Promise<ScheduleResult> {
  const payload = buildScheduleBody(urn, allocationId);
  
  const res = await postLiftJsonFromPage(page, SCHEDULE_URL, payload);
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
    if (isScheduleAlreadyBooked(res.body, j)) {
      saveAlreadyBookedAccountFile(payload, j, getCurrentInstanceId());
      throw new AlreadyBookedError(`Schedule API: already booked (${JSON.stringify(j.error ?? res.body.slice(0, 500))})`);
    }
    if (j.error != null && j.error !== "") {
      throw new Error(`Schedule API error: ${JSON.stringify(j.error)}`);
    }
  } catch (e) {
    if (e instanceof AlreadyBookedError) throw e;
    if (isScheduleAlreadyBooked(res.body)) {
      saveAlreadyBookedAccountFile(payload, {}, getCurrentInstanceId());
      throw new AlreadyBookedError("Schedule API: already booked");
    }
    if (e instanceof Error && e.message.startsWith("Schedule API error")) throw e;
    throw new Error("Schedule: response is not JSON");
  }

  saveBookingConfirmationFile(payload, j, getCurrentInstanceId());

  const schedulePaymentUrl = buildScheduleRedirectUrl(j);
  // Free routes confirm the appointment without a payment URL, so the URL alone cannot decide this.
  const booked =
    schedulePaymentUrl != null ||
    j.IsAppointmentBooked === true ||
    String(j.appointmentDate ?? "").trim() !== "";
  if (schedulePaymentUrl) {
    setScheduleUrl(schedulePaymentUrl);
        void new TelegramService()
      .alert("info", `A Slot is Booked. Open the link to pay for the slot: \n${schedulePaymentUrl}`, {
        booked: j.IsAppointmentBooked,
        date: j.appointmentDate,
        time: j.appointmentTime,
      })
      .catch(() => { });
  } else {
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

  return { paymentUrl: schedulePaymentUrl, booked };
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
        return;
  }

  
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45_000 }),
    page.evaluate((u) => window.location.assign(u), finalUrl),
  ]);
  }

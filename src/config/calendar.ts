import { config, getCurrentInstanceId } from "./config";
import { getEffectiveLiftLoginUser } from "../utils/liftLoginUser";
import { getSlotCenterOverride } from "../utils/slotCenterOverride.store";
import { getApplicantDetailsOverrides } from "../utils/applicantDetails.store";

export const CALENDAR_URL = "https://lift-api.vfsglobal.com/appointment/calendar";

/** DD/MM/YYYY — two days after today in local timezone (when setup has no "From" range). */
function fallbackCalendarFromDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * From a calendar `fromDate` that was just sent (DD/MM/YYYY), the first day of the following month (DD/MM/YYYY),
 * e.g. 15/04/2025 → 01/05/2025, 20/12/2025 → 01/01/2026.
 */
export function firstDayOfNextMonthFromDdMmYyyy(currentFrom: string): string {
  const m = currentFrom.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) {
    const y = parseInt(m[3], 10);
    const mo1 = parseInt(m[2], 10);
    if (mo1 >= 1 && mo1 <= 12) {
      const t = new Date(y, mo1, 1);
      const mm = String(t.getMonth() + 1).padStart(2, "0");
      const dd = String(t.getDate()).padStart(2, "0");
      const yyyy = t.getFullYear();
      return `${dd}/${mm}/${yyyy}`;
    }
  }
  const t = new Date();
  t.setDate(1);
  t.setMonth(t.getMonth() + 1);
  const mm = String(t.getMonth() + 1).padStart(2, "0");
  const dd = String(t.getDate()).padStart(2, "0");
  const yyyy = t.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** `fromDate` for lift-api: setup "From" (scheduleDateRangeStart, YYYY-MM-DD) or {@link fallbackCalendarFromDate}. */
function calendarFromDateForInstance(details: Record<string, unknown> | null | undefined): string {
  const raw = typeof details?.scheduleDateRangeStart === "string"
    ? details.scheduleDateRangeStart.trim().slice(0, 10)
    : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-");
    return `${d}/${m}/${y}`;
  }
  return fallbackCalendarFromDate();
}

export type BuildCalendarBodyOptions = { fromDate?: string };

/** POST /appointment/calendar — requires urn from save applicants. */
export function buildCalendarBody(urn: string, options?: BuildCalendarBodyOptions): Record<string, unknown> {
  const u = urn.trim();
  if (!u) throw new Error("Calendar API requires a non-empty urn");

  const loginUser = getEffectiveLiftLoginUser();
  const override = getSlotCenterOverride();
  const instanceId = getCurrentInstanceId();
  const details = getApplicantDetailsOverrides(instanceId);
  const centerCode = override?.centerCode
    || (typeof details?.vacCode === "string" ? details.vacCode.trim() : "");
  const visaCategoryCode = override?.visaCategoryCode
    || (typeof details?.selectedSubvisaCategory === "string" ? details.selectedSubvisaCategory.trim() : "");

  if (!centerCode || !visaCategoryCode) {
    throw new Error("Calendar API requires centerCode/visaCategoryCode from slot override or setup form");
  }

  const fromDateRaw = typeof options?.fromDate === "string" ? options.fromDate.trim() : "";
  const fromDate = fromDateRaw
    || calendarFromDateForInstance(details);

  return {
    centerCode,
    countryCode: config.slotPayload.countryCode,
    fromDate,
    loginUser,
    missionCode: config.slotPayload.missionCode,
    payCode: "",
    urn: u,
    visaCategoryCode,
  };
}

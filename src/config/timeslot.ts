import { config, getCurrentInstanceId } from "./config";
import { getEffectiveLiftLoginUser } from "../utils/liftLoginUser";
import { getSlotCenterOverride } from "../utils/slotCenterOverride.store";
import { getApplicantDetailsOverrides } from "../utils/applicantDetails.store";

export const TIMESLOT_URL = "https://lift-api.vfsglobal.com/appointment/timeslot";

/**
 * Calendar API returns dates like MM/DD/YYYY (e.g. 03/19/2026).
 * Timeslot API expects DD/MM/YYYY (e.g. 19/03/2026).
 */
export function calendarDateToTimeslotSlotDate(calendarDate: string): string {
  const m = calendarDate.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return calendarDate.trim();
  const [, mm, dd, yyyy] = m;
  return `${dd}/${mm}/${yyyy}`;
}

/** POST /appointment/timeslot */
export function buildTimeslotBody(urn: string, slotDateFromCalendar: string): Record<string, unknown> {
  const u = urn.trim();
  if (!u) throw new Error("Timeslot API requires urn");

  const loginUser = getEffectiveLiftLoginUser();
  const slotDate = calendarDateToTimeslotSlotDate(slotDateFromCalendar);
  const override = getSlotCenterOverride();
  const details = getApplicantDetailsOverrides(getCurrentInstanceId());
  const centerCode = override?.centerCode
    || (typeof details?.vacCode === "string" ? details.vacCode.trim() : "");
  const visaCategoryCode = override?.visaCategoryCode
    || (typeof details?.selectedSubvisaCategory === "string" ? details.selectedSubvisaCategory.trim() : "");

  if (!centerCode || !visaCategoryCode) {
    throw new Error("Timeslot API requires centerCode/visaCategoryCode from slot override or setup form");
  }

  return {
    centerCode,
    countryCode: config.slotPayload.countryCode,
    loginUser,
    missionCode: config.slotPayload.missionCode,
    slotDate,
    urn: u,
    visaCategoryCode,
  };
}

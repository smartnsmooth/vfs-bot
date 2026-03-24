import { config } from "./config";
import { getEffectiveLiftLoginUser } from "../utils/liftLoginUser";
import { getSlotCenterOverride } from "../utils/slotCenterOverride.store";

export const TIMESLOT_URL =
  process.env.VFS_TIMESLOT_URL ?? "https://lift-api.vfsglobal.com/appointment/timeslot";

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

  return {
    centerCode: override?.centerCode ?? config.slotPayload.vacCode,
    countryCode: config.slotPayload.countryCode,
    loginUser,
    missionCode: config.slotPayload.missionCode,
    slotDate,
    urn: u,
    visaCategoryCode: override?.visaCategoryCode ?? config.slotPayload.visaCategoryCode,
  };
}

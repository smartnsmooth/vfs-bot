import { config } from "./config";
import { getEffectiveLiftLoginUser } from "../utils/liftLoginUser";

export const CALENDAR_URL =
  process.env.VFS_CALENDAR_URL ?? "https://lift-api.vfsglobal.com/appointment/calendar";

/** DD/MM/YYYY — today's date in local timezone. */
function calendarFromDate(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** POST /appointment/calendar — requires urn from save applicants. */
export function buildCalendarBody(urn: string): Record<string, unknown> {
  const u = urn.trim();
  if (!u) throw new Error("Calendar API requires a non-empty urn");

  const loginUser = getEffectiveLiftLoginUser();
  return {
    centerCode: config.slotPayload.vacCode,
    countryCode: config.slotPayload.countryCode,
    fromDate: calendarFromDate(),
    loginUser,
    missionCode: config.slotPayload.missionCode,
    payCode: config.slotPayload.payCode ?? "",
    urn: u,
    visaCategoryCode: config.slotPayload.visaCategoryCode,
  };
}

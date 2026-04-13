import { config, getCurrentInstanceId } from "./config";
import { getEffectiveLiftLoginUser } from "../utils/liftLoginUser";
import { getSlotCenterOverride } from "../utils/slotCenterOverride.store";
import { getApplicantDetailsOverrides } from "../utils/applicantDetails.store";

export const CALENDAR_URL = "https://lift-api.vfsglobal.com/appointment/calendar";

/** DD/MM/YYYY — two days after today in local timezone. */
function calendarFromDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 2);
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
  const override = getSlotCenterOverride();
  const details = getApplicantDetailsOverrides(getCurrentInstanceId());
  const centerCode = override?.centerCode
    || (typeof details?.vacCode === "string" ? details.vacCode.trim() : "");
  const visaCategoryCode = override?.visaCategoryCode
    || (typeof details?.selectedSubvisaCategory === "string" ? details.selectedSubvisaCategory.trim() : "");

  if (!centerCode || !visaCategoryCode) {
    throw new Error("Calendar API requires centerCode/visaCategoryCode from slot override or setup form");
  }

  return {
    centerCode,
    countryCode: config.slotPayload.countryCode,
    fromDate: calendarFromDate(),
    loginUser,
    missionCode: config.slotPayload.missionCode,
    payCode: "",
    urn: u,
    visaCategoryCode,
  };
}

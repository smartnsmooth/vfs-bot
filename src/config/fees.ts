import { config, getCurrentInstanceId } from "./config";
import { getEffectiveLiftLoginUser } from "../utils/liftLoginUser";
import { getSlotCenterOverride } from "../utils/slotCenterOverride.store";
import { getApplicantDetailsOverrides } from "../utils/applicantDetails.store";

export const FEES_URL = "https://lift-api.vfsglobal.com/appointment/fees";

function resolveCenterCodeForCurrentInstance(): string {
  const override = getSlotCenterOverride();
  const details = getApplicantDetailsOverrides(getCurrentInstanceId());
  const centerCode = override?.centerCode
    || (typeof details?.vacCode === "string" ? details.vacCode.trim() : "");
  if (!centerCode) throw new Error("Fees API requires centerCode from slot override or setup form");
  return centerCode;
}

/** POST /appointment/fees — same context as save applicants (urn from that response). */
export function buildFeesBody(urn: string): Record<string, unknown> {
  const u = urn.trim();
  if (!u) throw new Error("Fees API requires a non-empty urn");

  const loginUser = getEffectiveLiftLoginUser();
  const centerCode = resolveCenterCodeForCurrentInstance();

  return {
    centerCode,
    countryCode: config.slotPayload.countryCode,
    languageCode: "en-US",
    loginUser,
    missionCode: config.slotPayload.missionCode,
    urn: u,
  };
}

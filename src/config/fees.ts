import { config } from "./config";
import { getEffectiveLiftLoginUser } from "../utils/liftLoginUser";

export const FEES_URL =
  process.env.VFS_FEES_URL ?? "https://lift-api.vfsglobal.com/appointment/fees";

/** POST /appointment/fees — same context as save applicants (urn from that response). */
export function buildFeesBody(urn: string): Record<string, unknown> {
  const u = urn.trim();
  if (!u) throw new Error("Fees API requires a non-empty urn");

  const loginUser = getEffectiveLiftLoginUser();
  return {
    centerCode: config.slotPayload.vacCode,
    countryCode: config.slotPayload.countryCode,
    languageCode: process.env.VFS_SAVE_LANGUAGE_CODE ?? "en-US",
    loginUser,
    missionCode: config.slotPayload.missionCode,
    urn: u,
  };
}

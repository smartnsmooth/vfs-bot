import { config } from "./config";
import { getEffectiveLiftLoginUser } from "../utils/liftLoginUser";

export const MAPVAS_URL =
  process.env.VFS_MAPVAS_URL ?? "https://lift-api.vfsglobal.com/vas/mapvas";

/**
 * POST /vas/mapvas — after timeslot, before fees (VFS lift-api).
 * Payload keys match browser capture (lowercase).
 */
export function buildMapVasBody(urn: string): Record<string, unknown> {
  const u = urn.trim();
  if (!u) throw new Error("mapvas requires a non-empty urn");
  const loginuser = getEffectiveLiftLoginUser();
  if (!loginuser?.trim()) throw new Error("mapvas requires login user");
  return {
    loginuser,
    missioncode: config.slotPayload.missionCode,
    countrycode: config.slotPayload.countryCode,
    urn: u,
    applicants: [],
  };
}

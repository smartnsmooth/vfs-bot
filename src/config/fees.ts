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

function resolveCenterCodeForInstance(instanceId: number): string {
  const details = getApplicantDetailsOverrides(instanceId);
  const centerCode = typeof details?.vacCode === "string" ? details.vacCode.trim() : "";
  if (!centerCode) {
    throw new Error(`Fees API requires centerCode from instance ${instanceId}'s setup form (vacCode is unset)`);
  }
  return centerCode;
}

export interface BuildFeesBodyOptions {
  /**
   * Take `centerCode` from this instance's setup-form `vacCode` instead of this
   * instance's own center — the amountGetter prices a peer's center while its URN
   * comes from its own. Ignores the slot override and throws when unset.
   */
  centerCodeInstanceId?: number;
}

/** POST /appointment/fees — same context as save applicants (urn from that response). */
export function buildFeesBody(urn: string, opts?: BuildFeesBodyOptions): Record<string, unknown> {
  const u = urn.trim();
  if (!u) throw new Error("Fees API requires a non-empty urn");

  const loginUser = getEffectiveLiftLoginUser();
  const centerCode = opts?.centerCodeInstanceId !== undefined
    ? resolveCenterCodeForInstance(opts.centerCodeInstanceId)
    : resolveCenterCodeForCurrentInstance();

  return {
    centerCode,
    countryCode: config.slotPayload.countryCode,
    languageCode: "en-US",
    loginUser,
    missionCode: config.slotPayload.missionCode,
    urn: u,
  };
}

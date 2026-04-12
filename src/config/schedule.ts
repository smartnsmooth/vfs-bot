import { config, getCurrentInstanceId } from "./config";
import { getEffectiveLiftLoginUser } from "../utils/liftLoginUser";
import { getTotalAmount, getCurrency } from "../utils/totalAmount.store";
import { getSlotCenterOverride } from "../utils/slotCenterOverride.store";
import { getApplicantDetailsOverrides } from "../utils/applicantDetails.store";

export const SCHEDULE_URL = "https://lift-api.vfsglobal.com/appointment/schedule";

/** POST /appointment/schedule — after timeslot; needs urn + allocationId. */
export function buildScheduleBody(urn: string, allocationId: string): Record<string, unknown> {
  const u = urn.trim();
  const alloc = allocationId.trim();
  if (!u) throw new Error("Schedule API requires urn");
  if (!alloc) throw new Error("Schedule API requires allocationId");

  const loginUser = getEffectiveLiftLoginUser();
  const totalAmountRaw = getTotalAmount();
  if (!totalAmountRaw) {
    throw new Error("Schedule API requires totalAmount from fees response");
  }
  const normalizedAmount = totalAmountRaw.replace(/,/g, "").trim();
  const totalAmountNum = Number.parseFloat(normalizedAmount);
  if (!Number.isFinite(totalAmountNum)) {
    throw new Error(`Schedule API requires numeric totalAmount from fees response; got: ${totalAmountRaw}`);
  }

  const currencyRaw = getCurrency();
  if (!currencyRaw) {
    throw new Error("Schedule API requires currency from fees response");
  }

  const override = getSlotCenterOverride();
  const details = getApplicantDetailsOverrides(getCurrentInstanceId());
  const centerCode = override?.centerCode
    || (typeof details?.vacCode === "string" ? details.vacCode.trim() : "");

  if (!centerCode) throw new Error("Schedule API requires centerCode from slot override or setup form");

  return {
    CanVFSReachoutToApplicant: process.env.VFS_SCHEDULE_CAN_REACHOUT !== "false",
    TnCConsentAndAcceptance: process.env.VFS_SCHEDULE_TNC !== "false",
    allocationId: alloc,
    aurn: null,
    centerCode,
    countryCode: config.slotPayload.countryCode,
    loginUser,
    missionCode: config.slotPayload.missionCode,
    notificationType: (process.env.VFS_SCHEDULE_NOTIFICATION_TYPE ?? "none").trim() || "none",
    paymentdetails: {
      paymentmode: "Online",
      RequestRefNo: "",
      clientId: "",
      merchantId: "",
      amount: totalAmountNum,
      currency: currencyRaw,
    },
    urn: u,
  };
}

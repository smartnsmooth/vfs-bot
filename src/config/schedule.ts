import { config, getCurrentInstanceId } from "./config";
import { getEffectiveLiftLoginUser } from "../utils/liftLoginUser";
import { getTotalAmount, getCurrency } from "../utils/totalAmount.store";
import { getSlotCenterOverride } from "../utils/slotCenterOverride.store";
import { getApplicantDetailsOverrides } from "../utils/applicantDetails.store";

export const SCHEDULE_URL = "https://lift-api.vfsglobal.com/appointment/schedule";

/**
 * Per-route hardcoded defaults for free / VAC-collected services where the fees
 * response intentionally omits currency. Captured from real successful uzb-lva
 * schedule payloads (paymentmode "Vac" + currency "UZS").
 */
const ROUTE_PAYMENT_DEFAULTS: Record<string, { paymentmode: string; currency: string }> = {
  "uzb-lva": { paymentmode: "Vac", currency: "UZS" },
};

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

  const rc = String(config.slotPayload.countryCode ?? "").trim().toLowerCase();
  const rm = String(config.slotPayload.missionCode ?? "").trim().toLowerCase();
  const routeKey = `${rc}-${rm}`;
  const routeDefaults = ROUTE_PAYMENT_DEFAULTS[routeKey];

  const currencyRaw = getCurrency();
  let currency: string;
  let paymentmode: string;

  if (currencyRaw) {
    currency = currencyRaw;
    paymentmode = "Online";
  } else if (routeDefaults) {
    // Free / VAC-collected service: fees response omits currency; use captured route defaults.
    currency = routeDefaults.currency;
    paymentmode = routeDefaults.paymentmode;
  } else {
    throw new Error("Schedule API requires currency from fees response");
  }

  const override = getSlotCenterOverride();
  const details = getApplicantDetailsOverrides(getCurrentInstanceId());
  const centerCode = override?.centerCode
    || (typeof details?.vacCode === "string" ? details.vacCode.trim() : "");

  if (!centerCode) throw new Error("Schedule API requires centerCode from slot override or setup form");

  return {
    missionCode: config.slotPayload.missionCode,
    countryCode: config.slotPayload.countryCode,
    centerCode,
    loginUser,
    urn: u,
    aurn: null,
    notificationType: (process.env.VFS_SCHEDULE_NOTIFICATION_TYPE ?? "none").trim() || "none",
    paymentdetails: {
      paymentmode,
      RequestRefNo: "",
      clientId: "",
      merchantId: "",
      amount: totalAmountNum,
      currency,
    },
    allocationId: alloc,
    CanVFSReachoutToApplicant: process.env.VFS_SCHEDULE_CAN_REACHOUT !== "false",
    TnCConsentAndAcceptance: process.env.VFS_SCHEDULE_TNC !== "false",
  };
}

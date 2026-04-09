import { config, getCurrentInstanceId } from "./config";
import { getApplicantDetailsOverrides } from "../utils/applicantDetails.store";
import { getApplicantIpForPayload } from "../utils/applicantIp";
import { getEffectiveLiftLoginUser } from "../utils/liftLoginUser";
import { getSlotCenterOverride } from "../utils/slotCenterOverride.store";
import { getVfsLoginProfile } from "../utils/vfsLoginProfile.store.js";
import { looksLikeEmailForVfsLogin } from "../types/vfsUserLogin.type.js";

export const SAVE_APPLICANTS_URL = "https://lift-api.vfsglobal.com/appointment/applicants";

/**
 * lift-api (ind/bgr) success capture: `JSON.stringify` key order must match for a stable POST body.
 */
const SAVE_APPLICANTS_ROOT_KEY_ORDER: readonly string[] = [
  "countryCode",
  "missionCode",
  "centerCode",
  "loginUser",
  "visaCategoryCode",
  "isEdit",
  "feeEntryTypeCode",
  "feeExemptionTypeCode",
  "feeExemptionDetailsCode",
  "applicantList",
  "languageCode",
  "isWaitlist",
  "juridictionCode",
  "regionCode",
];

/** Same order as browser-captured successful save-applicants payload. */
const SAVE_APPLICANTS_APPLICANT_KEY_ORDER: readonly string[] = [
  "urn",
  "arn",
  "centerClassCode",
  "selectedSubvisaCategory",
  "Subclasscode",
  "dateOfApplication",
  "loginUser",
  "firstName",
  "employerFirstName",
  "middleName",
  "lastName",
  "employerLastName",
  "salutation",
  "gender",
  "nationalId",
  "VisaToken",
  "employerContactNumber",
  "contactNumber",
  "dialCode",
  "employerDialCode",
  "passportNumber",
  "confirmPassportNumber",
  "passportExpirtyDate",
  "dateOfBirth",
  "emailId",
  "employerEmailId",
  "nationalityCode",
  "state",
  "city",
  "isEndorsedChild",
  "applicantType",
  "addressline1",
  "addressline2",
  "pincode",
  "referenceNumber",
  "vlnNumber",
  "applicantGroupId",
  "parentPassportNumber",
  "parentPassportExpiry",
  "dateOfDeparture",
  "entryType",
  "eoiVisaType",
  "passportType",
  "vfsReferenceNumber",
  "familyReunificationCerificateNumber",
  "PVRequestRefNumber",
  "PVStatus",
  "PVStatusDescription",
  "PVCanAllowRetry",
  "PVisVerified",
  "eefRegistrationNumber",
  "isAutoRefresh",
  "helloVerifyNumber",
  "OfflineCClink",
  "idenfystatuscheck",
  "vafStatus",
  "SpecialAssistance",
  "AdditionalRefNo",
  "juridictionCode",
  "canInitiateVAF",
  "canEditVAF",
  "canDeleteVAF",
  "canDownloadVAF",
  "Retryleft",
  "visaSubClass",
  "ipAddress",
  "applicantImage",
  "applicantImageData",
];

function orderObjectKeys(obj: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const k of order) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      out[k] = obj[k];
      seen.add(k);
    }
  }
  const extras = Object.keys(obj)
    .filter((k) => !seen.has(k))
    .sort();
  for (const k of extras) {
    out[k] = obj[k];
  }
  return out;
}

/** lift-api (ind/bgr): root `countryCode` is lowercase (`ind`); applicant `nationalityCode` is uppercase (`IND`). */
function applyLiftApplicantsCountryNationalityCasing(body: Record<string, unknown>): void {
  const cc = body.countryCode;
  if (typeof cc === "string" && cc.trim() !== "") {
    body.countryCode = cc.trim().toLowerCase();
  }
  const list = body.applicantList;
  if (!Array.isArray(list) || list.length === 0) return;
  const first = list[0];
  if (typeof first !== "object" || first === null) return;
  const a = first as Record<string, unknown>;
  const nc = a.nationalityCode;
  if (typeof nc === "string" && nc.trim() !== "") {
    a.nationalityCode = nc.trim().toUpperCase();
  }
}

/** Reorders root + `applicantList[0]` so `JSON.stringify` matches lift-api success shape (merges can append keys). */
function normalizeSaveApplicantsBody(body: Record<string, unknown>): Record<string, unknown> {
  applyLiftApplicantsCountryNationalityCasing(body);
  const list = body.applicantList;
  if (!Array.isArray(list) || list.length === 0 || typeof list[0] !== "object" || list[0] === null) {
    return orderObjectKeys(body, SAVE_APPLICANTS_ROOT_KEY_ORDER);
  }
  const applicant = orderObjectKeys(list[0] as Record<string, unknown>, SAVE_APPLICANTS_APPLICANT_KEY_ORDER);
  const next: Record<string, unknown> = { ...body, applicantList: [applicant] };
  return orderObjectKeys(next, SAVE_APPLICANTS_ROOT_KEY_ORDER);
}

function mergeOverridesIntoBody(body: Record<string, unknown>, overrides: Record<string, unknown>): void {
  const list = body.applicantList;
  if (!Array.isArray(list) || !list[0] || typeof list[0] !== "object") return;
  Object.assign(list[0] as object, overrides);
}


/** Setup-form / bot-only fields merged into `applicantList[0]` — not part of lift-api save-applicants body. */
const APPLICANT_UI_ONLY_KEYS = [
  "scheduleAllowedDates",
  "scheduleDateRangeStart",
  "scheduleDateRangeEnd",
  "vacCode",
  "vacCode2",
  "selectedSubvisaCategory2",
] as const;

/**
 * Match browser-captured lift-api shape: drop UI-only keys; ensure `visaSubClass` (often null);
 * lift-api may require `applicantImage` / `applicantImageData` keys (even empty), lowercase `emailId`,
 * and strict JSON key order: `ipAddress` then `applicantImage` then `applicantImageData` (see SAVE_APPLICANTS_APPLICANT_KEY_ORDER).
 */
function finalizeApplicantForLiftApiPost(body: Record<string, unknown>): void {
  const list = body.applicantList;
  if (!Array.isArray(list) || list.length === 0 || typeof list[0] !== "object" || list[0] === null) return;
  const a = list[0] as Record<string, unknown>;
  for (const k of APPLICANT_UI_ONLY_KEYS) {
    delete a[k];
  }
  if (!Object.prototype.hasOwnProperty.call(a, "visaSubClass")) {
    a.visaSubClass = null;
  }
  if (!Object.prototype.hasOwnProperty.call(a, "applicantImage")) {
    a.applicantImage = "";
  }
  if (!Object.prototype.hasOwnProperty.call(a, "applicantImageData")) {
    a.applicantImageData = "";
  }
  const em = a.emailId;
  if (typeof em === "string" && em.trim() !== "") {
    a.emailId = em.trim().toLowerCase();
  }
}

/** Override applicant + root `loginUser` with 1:1 fields from last `POST /user/login` response (see vfsLoginProfile.store). */
function mergeVfsLoginProfileIntoSaveApplicantsBody(body: Record<string, unknown>): void {
  const p = getVfsLoginProfile();
  if (!p) return;
  const list = body.applicantList;
  if (!Array.isArray(list) || !list[0] || typeof list[0] !== "object" || list[0] === null) return;
  const a = list[0] as Record<string, unknown>;
  const pr = p as Record<string, unknown>;

  const setApplicant = (key: string, val: unknown): void => {
    if (val === undefined || val === null) return;
    if (typeof val === "string") {
      const t = val.trim();
      if (!t) return;
      a[key] = t;
      return;
    }
    a[key] = val;
  };

  setApplicant("firstName", p.firstName);
  setApplicant("lastName", p.lastName);
  setApplicant("middleName", pr.middleName);
  setApplicant("salutation", pr.salutation);
  setApplicant("dateOfBirth", p.dateOfBirth);
  setApplicant("passportNumber", p.passportNumber);
  setApplicant("passportExpirtyDate", pr.passportExpirtyDate);
  setApplicant("dialCode", p.dialCode);
  setApplicant("contactNumber", p.contactNumber);

  const eid = typeof pr.emailId === "string" ? pr.emailId.trim() : "";
  if (eid) {
    a.emailId = eid.toLowerCase();
  }

  const nat = typeof pr.nationalityCode === "string" ? pr.nationalityCode.trim() : "";
  if (nat) {
    a.nationalityCode = nat.toUpperCase();
  }

  const g = pr.gender;
  if (typeof g === "number" && Number.isFinite(g)) {
    a.gender = g;
  } else if (typeof g === "string" && g.trim()) {
    const n = parseInt(g, 10);
    if (Number.isFinite(n)) a.gender = n;
  }

  const lu = typeof p.loginUser === "string" ? p.loginUser.trim() : "";
  if (lu) {
    body.loginUser = lu;
    a.loginUser = lu;
    const hasEmail = typeof a.emailId === "string" && a.emailId.trim() !== "";
    if (!hasEmail && looksLikeEmailForVfsLogin(lu)) {
      a.emailId = lu.trim().toLowerCase();
    }
  }
}

/** Default template body (no UI overrides). All personal fields come from the setup form at runtime. */
export function buildSaveApplicantsBodyFromEnv(): Record<string, unknown> {
  const loginUser = getEffectiveLiftLoginUser();
  const countryCode = String(config.slotPayload.countryCode ?? "").trim().toLowerCase() || "ind";
  const missionCode = config.slotPayload.missionCode;
  
  const override = getSlotCenterOverride();
  const instanceId = getCurrentInstanceId();
  const details = getApplicantDetailsOverrides(instanceId);
  const centerCode = override?.centerCode
    || (typeof details?.vacCode === "string" ? details.vacCode.trim() : "");
  const visaCategoryCode = override?.visaCategoryCode
    || (typeof details?.selectedSubvisaCategory === "string" ? details.selectedSubvisaCategory.trim() : "");

  const applicant: Record<string, unknown> = {
    urn: "",
    arn: "",
    centerClassCode: null,
    selectedSubvisaCategory: null,
    Subclasscode: null,
    dateOfApplication: null,
    loginUser,
    firstName: "",
    employerFirstName: "",
    middleName: "",
    lastName: "",
    employerLastName: "",
    salutation: "",
    gender: 2,
    nationalId: null,
    VisaToken: null,
    employerContactNumber: "",
    contactNumber: "",
    dialCode: "",
    employerDialCode: "",
    passportNumber: "",
    confirmPassportNumber: null,
    passportExpirtyDate: "",
    dateOfBirth: "",
    emailId: "",
    employerEmailId: "",
    nationalityCode: "",
    state: null,
    city: null,
    isEndorsedChild: false,
    applicantType: 0,
    addressline1: null,
    addressline2: null,
    pincode: null,
    referenceNumber: null,
    vlnNumber: null,
    applicantGroupId: 0,
    parentPassportNumber: "",
    parentPassportExpiry: "",
    dateOfDeparture: null,
    entryType: "",
    eoiVisaType: "",
    passportType: "",
    vfsReferenceNumber: "",
    familyReunificationCerificateNumber: "",
    PVRequestRefNumber: "",
    PVStatus: "",
    PVStatusDescription: "",
    PVCanAllowRetry: true,
    PVisVerified: false,
    eefRegistrationNumber: "",
    isAutoRefresh: true,
    helloVerifyNumber: "",
    OfflineCClink: "",
    idenfystatuscheck: false,
    vafStatus: null,
    SpecialAssistance: "",
    AdditionalRefNo: null,
    juridictionCode: "",
    canInitiateVAF: false,
    canEditVAF: false,
    canDeleteVAF: false,
    canDownloadVAF: false,
    Retryleft: "",
    visaSubClass: null,
    ipAddress: getApplicantIpForPayload(),
    applicantImage: "",
    applicantImageData: "",
  };

  return normalizeSaveApplicantsBody({
    countryCode,
    missionCode,
    centerCode,
    loginUser,
    visaCategoryCode,
    isEdit: false,
    feeEntryTypeCode: null,
    feeExemptionTypeCode: null,
    feeExemptionDetailsCode: null,
    applicantList: [applicant],
    languageCode: "en-US",
    isWaitlist: false,
    juridictionCode: null,
    regionCode: null,
  });
}

/** Defaults for the post-login applicant form. */
export function getApplicantFormDefaults(): Record<string, string> {
  const body = buildSaveApplicantsBodyFromEnv();
  const list = body.applicantList as Record<string, unknown>[] | undefined;
  const a = list?.[0] ?? {};
  const keys = [
    "passportExpirtyDate",
    "confirmPassportNumber",
    "nationalityCode",
    "gender",
    "selectedSubvisaCategory",
    "Subclasscode",
    "salutation",
    "middleName",
  ] as const;
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = a[k];
    if (v !== undefined && v !== null) out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/**
 * Full body: default template merged with values from the applicant UI (if submitted).
 * `loginUser` on the body and first applicant use {@link getEffectiveLiftLoginUser} when non-empty (setup UI or env).
 */
export function buildSaveApplicantsBody(): Record<string, unknown> {
  const body = buildSaveApplicantsBodyFromEnv();
  const instanceId = getCurrentInstanceId();
  const o = getApplicantDetailsOverrides(instanceId);
  const needApplicantMerge = o && Object.keys(o).length > 0;
  const lu = getEffectiveLiftLoginUser();

  let merged: Record<string, unknown>;
  if (!needApplicantMerge && !lu) {
    merged = body;
  } else {
    const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    if (needApplicantMerge) mergeOverridesIntoBody(clone, o);
    if (lu) {
      clone.loginUser = lu;
      const list = clone.applicantList as Record<string, unknown>[] | undefined;
      if (list?.[0]) list[0].loginUser = lu;
    }
    merged = clone;
  }

  mergeVfsLoginProfileIntoSaveApplicantsBody(merged);

  finalizeApplicantForLiftApiPost(merged);
  return normalizeSaveApplicantsBody(merged);
}

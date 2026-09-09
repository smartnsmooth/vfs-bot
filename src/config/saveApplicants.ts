import { config, getCurrentInstanceId } from "./config";
import { getApplicantDetailsOverrides } from "../utils/applicantDetails.store";
import { getApplicantIpForPayload } from "../utils/applicantIp";
import { getEffectiveLiftLoginUser } from "../utils/liftLoginUser";
import { getSlotCenterOverride } from "../utils/slotCenterOverride.store";
import { getVfsLoginProfile, getOriginalLoginLastName } from "../utils/vfsLoginProfile.store.js";
import { looksLikeEmailForVfsLogin } from "../types/vfsUserLogin.type.js";
import { isAreLvaRoute, isIndDeuRoute, isIndLvaRoute, isUzbLvaRoute, keepApplicantEmailCasing } from "../utils/vfsRoute";
import { ensureIndDeuInstancePhone } from "../utils/indDeuPhone";

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
  "countryCode",
  "missionCode",
];

/** Exact key order from are-lva browser capture (includes noOfMinorDependents; no applicant countryCode). */
const SAVE_APPLICANTS_ARE_LVA_APPLICANT_KEY_ORDER: readonly string[] = [
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
  "noOfMinorDependents",
  "fathersName",
  "mothersName",
  "dateOfTravel",
  "ipAddress",
  "applicantImage",
];

/** Exact key order from ind-deu browser capture (no applicantImage / applicant countryCode). */
const SAVE_APPLICANTS_IND_DEU_APPLICANT_KEY_ORDER: readonly string[] = [
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
  "noOfMinorDependents",
  "fathersName",
  "mothersName",
  "dateOfTravel",
  "ipAddress",
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
  const rc = typeof body.countryCode === "string" ? body.countryCode.trim().toLowerCase() : "";
  const rm = typeof body.missionCode === "string" ? body.missionCode.trim().toLowerCase() : "";
  const applicantOrder = isIndDeuRoute(rc, rm)
    ? SAVE_APPLICANTS_IND_DEU_APPLICANT_KEY_ORDER
    : isAreLvaRoute(rc, rm)
      ? SAVE_APPLICANTS_ARE_LVA_APPLICANT_KEY_ORDER
      : SAVE_APPLICANTS_APPLICANT_KEY_ORDER;
  const applicant = orderObjectKeys(list[0] as Record<string, unknown>, applicantOrder);
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
  "scheduleDateRangeStart",
  "scheduleDateRangeEnd",
  "vacCode",
  "vacCode2",
  "selectedSubvisaCategory2",
  "userPollInterval",
  "apologiesIntervalSec",
  "applicantsJoinStaggerSec",
  "postLoginPollDelay",
  "staggerIntervalSec",
  "calendarPollingStartDate",
  "calendarPollingInterval",
  "calendarRetryNextMonth",
  "apiDelaySec",
  "repeatedDelaySec",
  "heroSmsActivationId",
  "heroSmsLastCode",
  "heroSmsPurchasedAt",
  "indDeuProcessSessionId",
  "indDeuEmailPrefix",
  "indDeuEmailDomain",
  "indDeuAccountPassword",
] as const;

/**
 * Match browser-captured lift-api shape: drop UI-only keys; ensure `visaSubClass` (often null);
 * Uppercase `emailId` (except India–Latvia), force `selectedSubvisaCategory` to null (empty string for India–Latvia),
 * blank `lastName` → `firstName` (non-ind/bgr); ind/bgr uses login `lastName` only, else `firstName` (ignores setup form),
 * and strict JSON key order (see SAVE_APPLICANTS_APPLICANT_KEY_ORDER).
 */
function finalizeApplicantForLiftApiPost(body: Record<string, unknown>): void {
  const list = body.applicantList;
  if (!Array.isArray(list) || list.length === 0 || typeof list[0] !== "object" || list[0] === null) return;
  const a = list[0] as Record<string, unknown>;
  for (const k of APPLICANT_UI_ONLY_KEYS) {
    delete a[k];
  }

  const rc = typeof body.countryCode === "string" ? body.countryCode.trim().toLowerCase() : "";
  const rm = typeof body.missionCode === "string" ? body.missionCode.trim().toLowerCase() : "";
  const isIndLva = rc === "ind" && rm === "lva";
  const isIndDeu = isIndDeuRoute(rc, rm);

  if (isIndDeu) {
    const phone = ensureIndDeuInstancePhone(getCurrentInstanceId());
    a.dialCode = phone.dialCode;
    a.contactNumber = phone.contactNumber;
    a.centerClassCode = null;
    a.selectedSubvisaCategory = null;
    a.Subclasscode = null;
    a.dateOfApplication = null;
    a.middleName = null;
    a.confirmPassportNumber = null;
    a.visaSubClass = null;
    a.noOfMinorDependents = "0";
    a.fathersName = null;
    a.mothersName = null;
    a.dateOfTravel = null;
    a.helloVerifyNumber = "";
    a.juridictionCode = "";
    a.AdditionalRefNo = null;
    delete a.applicantImage;
    delete a.applicantImageData;
    delete a.countryCode;
    delete a.missionCode;

    const fn = typeof a.firstName === "string" ? a.firstName.trim().toUpperCase() : "";
    const ln = typeof a.lastName === "string" ? a.lastName.trim().toUpperCase() : "";
    const pp = typeof a.passportNumber === "string" ? a.passportNumber.trim().toUpperCase() : "";
    a.firstName = fn;
    a.lastName = ln || fn;
    a.passportNumber = pp;

    const lu = getEffectiveLiftLoginUser();
    if (lu) {
      body.loginUser = lu;
      a.loginUser = lu;
      a.emailId = lu.toUpperCase();
    } else if (typeof a.emailId === "string" && a.emailId.trim() !== "") {
      a.emailId = a.emailId.trim().toUpperCase();
    }

    const g = a.gender;
    if (typeof g === "string" && g.trim() !== "") {
      const n = parseInt(g, 10);
      if (n === 1 || n === 2) a.gender = n;
    } else if (typeof g === "number" && g !== 1 && g !== 2) {
      a.gender = 1;
    }

    body.juridictionCode = null;
    return;
  }

  if (isAreLvaRoute(rc, rm)) {
    a.centerClassCode = "";
    a.selectedSubvisaCategory = "";
    a.Subclasscode = "";
    a.dateOfApplication = "";
    a.AdditionalRefNo = "";
    a.visaSubClass = "";
    a.confirmPassportNumber = null;
    a.helloVerifyNumber = null;
    a.juridictionCode = null;
    a.noOfMinorDependents = 0;
    a.fathersName = "";
    a.mothersName = "";
    a.dateOfTravel = "";
    a.applicantImage = "";
    delete a.applicantImageData;
    delete a.countryCode;
    delete a.missionCode;
    body.juridictionCode = null;

    const fn = typeof a.firstName === "string" ? a.firstName.trim() : "";
    const ln = typeof a.lastName === "string" ? a.lastName.trim() : "";
    a.firstName = fn;
    a.lastName = ln || fn;
    if (typeof a.passportNumber === "string") a.passportNumber = a.passportNumber.trim();
    if (typeof a.dateOfBirth === "string") a.dateOfBirth = a.dateOfBirth.trim();
    if (typeof a.passportExpirtyDate === "string") a.passportExpirtyDate = a.passportExpirtyDate.trim();
    if (typeof a.dialCode === "string") a.dialCode = a.dialCode.trim();
    if (typeof a.contactNumber === "string") a.contactNumber = a.contactNumber.trim();

    const em = a.emailId;
    if (typeof em === "string" && em.trim() !== "") {
      a.emailId = em.trim();
    }
    const lu = getEffectiveLiftLoginUser();
    if (lu) {
      body.loginUser = lu;
      a.loginUser = lu;
      if (typeof a.emailId !== "string" || !a.emailId.trim()) {
        a.emailId = lu.trim();
      }
    }

    const g = a.gender;
    if (typeof g === "string" && g.trim() !== "") {
      const n = parseInt(g, 10);
      if (n === 1 || n === 2) a.gender = n;
    } else if (typeof g !== "number" || (g !== 1 && g !== 2)) {
      a.gender = 1;
    }
    return;
  }

  if (isIndLva) {
    a.centerClassCode = "";
    a.selectedSubvisaCategory = "";
    a.Subclasscode = "";
    a.dateOfApplication = "";
    a.AdditionalRefNo = "";
    a.visaSubClass = "";
    a.confirmPassportNumber = null;
    const emLva = a.emailId;
    if (typeof emLva === "string" && emLva.trim() !== "") {
      a.emailId = emLva.trim();
    }
    delete a.applicantImageData;
    delete a.countryCode;
    delete a.missionCode;
    a.gender = 0;
  } else {
    if (!Object.prototype.hasOwnProperty.call(a, "visaSubClass")) {
      a.visaSubClass = null;
    }
    a.selectedSubvisaCategory = null;
    a.confirmPassportNumber = null;
    const em = a.emailId;
    if (typeof em === "string" && em.trim() !== "") {
      a.emailId = em.trim().toUpperCase();
    }
  }

  const fnTrimmed = typeof a.firstName === "string" ? a.firstName.trim() : "";

  if (rc === "ind" && rm === "bgr") {
    a.applicantImage = "";
    a.applicantImageData = "";
    a.countryCode = "ind";
    a.missionCode = "bgr";
    const loginLn = getOriginalLoginLastName();
    a.lastName = loginLn || fnTrimmed;
  } else {
    const lastTrimmed = typeof a.lastName === "string" ? a.lastName.trim() : "";
    if (!lastTrimmed) {
      a.lastName = fnTrimmed;
    }
  }

  if (rc === "ind" && rm === "lva") {
    const jc = typeof a.juridictionCode === "string" ? a.juridictionCode.trim() : "";
    if (jc) {
      body.juridictionCode = jc;
    }
    const vc = typeof body.visaCategoryCode === "string" ? body.visaCategoryCode.trim() : "";
    if (vc === "BUS") {
      a.helloVerifyNumber = null;
    } else {
      const hv = typeof a.helloVerifyNumber === "string" ? a.helloVerifyNumber.replace(/\D/g, "") : "";
      if (hv.length === 6) {
        a.helloVerifyNumber = hv;
      }
    }
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
  const rc = typeof body.countryCode === "string" ? body.countryCode.trim().toLowerCase() : "";
  const rm = typeof body.missionCode === "string" ? body.missionCode.trim().toLowerCase() : "";
  if (isIndDeuRoute(rc, rm)) return;
  const isIndLva = isIndLvaRoute(rc, rm);
  const isUzbLva = isUzbLvaRoute(rc, rm);
  const isAreLva = isAreLvaRoute(rc, rm);
  const keepEmail = keepApplicantEmailCasing(rc, rm);

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

  // For uzb-lva, the form supplies firstName / lastName / passportNumber / nationalityCode.
  // Only fall back to the VFS login profile when the form left those fields empty.
  const setApplicantIfEmpty = (key: string, val: unknown): void => {
    const cur = a[key];
    const hasVal = typeof cur === "string" ? cur.trim() !== "" : cur !== undefined && cur !== null;
    if (hasVal) return;
    setApplicant(key, val);
  };

  if (isUzbLva) {
    setApplicantIfEmpty("firstName", p.firstName);
    setApplicantIfEmpty("lastName", p.lastName);
    setApplicantIfEmpty("passportNumber", p.passportNumber);
  } else {
    setApplicant("firstName", p.firstName);
    setApplicant("lastName", p.lastName);
    setApplicant("passportNumber", p.passportNumber);
  }
  setApplicant("middleName", pr.middleName);
  setApplicant("salutation", pr.salutation);
  setApplicant("dateOfBirth", p.dateOfBirth);
  // Form supplies passport expiry / nationality / gender on are-lva (and expiry on ind-lva).
  if (!isIndLva && !isAreLva) {
    setApplicant("passportExpirtyDate", pr.passportExpirtyDate);
  }
  setApplicant("dialCode", p.dialCode);
  setApplicant("contactNumber", p.contactNumber);

  const eid = typeof pr.emailId === "string" ? pr.emailId.trim() : "";
  if (eid) {
    a.emailId = keepEmail ? eid : eid.toUpperCase();
  }

  const nat = typeof pr.nationalityCode === "string" ? pr.nationalityCode.trim() : "";
  if (nat) {
    if (isUzbLva || isAreLva) {
      const cur = typeof a.nationalityCode === "string" ? a.nationalityCode.trim() : "";
      if (!cur) a.nationalityCode = nat.toUpperCase();
    } else {
      a.nationalityCode = nat.toUpperCase();
    }
  }

  if (!isIndLva && !isAreLva) {
    const g = pr.gender;
    if (typeof g === "number" && Number.isFinite(g)) {
      a.gender = g;
    } else if (typeof g === "string" && g.trim()) {
      const n = parseInt(g, 10);
      if (Number.isFinite(n)) a.gender = n;
    }
  }

  const lu = typeof p.loginUser === "string" ? p.loginUser.trim() : "";
  if (lu) {
    body.loginUser = lu;
    a.loginUser = lu;
    const hasEmail = typeof a.emailId === "string" && a.emailId.trim() !== "";
    if (!hasEmail && looksLikeEmailForVfsLogin(lu)) {
      a.emailId = keepEmail ? lu.trim() : lu.trim().toUpperCase();
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

  const isIndDeu = isIndDeuRoute(countryCode, missionCode);
  const applicant: Record<string, unknown> = isIndDeu
    ? {
      urn: "",
      arn: "",
      centerClassCode: null,
      selectedSubvisaCategory: null,
      Subclasscode: null,
      dateOfApplication: null,
      loginUser,
      firstName: "",
      employerFirstName: "",
      middleName: null,
      lastName: "",
      employerLastName: "",
      salutation: "",
      gender: 1,
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
      noOfMinorDependents: "0",
      fathersName: null,
      mothersName: null,
      dateOfTravel: null,
      ipAddress: getApplicantIpForPayload(),
    }
    : {
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
      countryCode,
      missionCode,
    };

  if (isAreLvaRoute(countryCode, missionCode)) {
    applicant.centerClassCode = "";
    applicant.selectedSubvisaCategory = "";
    applicant.Subclasscode = "";
    applicant.dateOfApplication = "";
    applicant.gender = 1;
    applicant.helloVerifyNumber = null;
    applicant.AdditionalRefNo = "";
    applicant.juridictionCode = null;
    applicant.visaSubClass = "";
    applicant.noOfMinorDependents = 0;
    applicant.fathersName = "";
    applicant.mothersName = "";
    applicant.dateOfTravel = "";
    applicant.applicantImage = "";
    delete applicant.applicantImageData;
    delete applicant.countryCode;
    delete applicant.missionCode;
  }

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
      if (list?.[0]) {
        list[0].loginUser = lu;
        const a = list[0] as Record<string, unknown>;
        const hasEmail = typeof a.emailId === "string" && a.emailId.trim() !== "";
        if (!hasEmail && looksLikeEmailForVfsLogin(lu)) {
          a.emailId = keepApplicantEmailCasing(clone.countryCode, clone.missionCode)
            ? lu.trim()
            : lu.trim().toUpperCase();
        }
      }
    }
    merged = clone;
  }

  mergeVfsLoginProfileIntoSaveApplicantsBody(merged);

  finalizeApplicantForLiftApiPost(merged);
  return normalizeSaveApplicantsBody(merged);
}

/**
 * Parsed JSON from `POST https://lift-api.vfsglobal.com/user/login` (password or OTP step).
 */
export interface VfsUserLoginResponse {
  accessToken?: string;
  isAuthenticated?: boolean;
  nearestVACCountryCode?: string | null;
  FailedAttemptCount?: number;
  isAppointmentBooked?: boolean;
  isLastTransactionPending?: boolean;
  isAppointmentExpired?: boolean;
  isLimitedDashboard?: boolean;
  isROCompleted?: boolean;
  isSOCompleted?: boolean;
  roleName?: string | null;
  isUkraineScheme?: boolean;
  isUkraineSchemeDocumentUpload?: boolean;
  loginUser?: string | null;
  dialCode?: string | null;
  contactNumber?: string | null;
  remainingCount?: number;
  accountLockHours?: number;
  enableOTPAuthentication?: boolean;
  isNewUser?: boolean;
  taResetPWDToken?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  dateOfBirth?: string | null;
  isPasswordExpiryMessage?: boolean;
  PasswordExpirydays?: number;
  passportNumber?: string | null;
  isSpecialUser?: boolean;
  maximumlimit?: number;
  isSuspendedTA?: boolean;
  showPasswordExpiryMsgTA?: boolean;
  passwordExpiryDaysLeftTA?: number;
  isEmbassyUser?: boolean;
  IsLoginCapturePassportOCREnabled?: boolean;
  error?: unknown;
}

export function parseVfsUserLoginResponseBody(body: string): VfsUserLoginResponse | null {
  try {
    const j = JSON.parse(body) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    return j as VfsUserLoginResponse;
  } catch {
    return null;
  }
}

/**
 * lift-api `/user/login` often puts applicant identity on `applicantList[0]` or `applicant` while the password step
 * leaves top-level `firstName` / `passportNumber` empty. Merge those nested objects into a single flat record for
 * {@link mergeVfsLoginProfile} so save-applicants gets the post-OTP values.
 */
const LOGIN_PROFILE_FIELD_KEYS = [
  "firstName",
  "lastName",
  "middleName",
  "dateOfBirth",
  "passportNumber",
  "passportExpirtyDate",
  "dialCode",
  "contactNumber",
  "loginUser",
  "emailId",
  "salutation",
  "nationalityCode",
  "gender",
] as const;

function isEmptyProfileFieldValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return !v.trim();
  return false;
}

function collectNestedLoginApplicantSources(j: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const al = j.applicantList;
  if (Array.isArray(al)) {
    for (const item of al) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        out.push(item as Record<string, unknown>);
      }
    }
  }
  const ap = j.applicant;
  if (ap && typeof ap === "object" && !Array.isArray(ap)) {
    out.push(ap as Record<string, unknown>);
  }
  const data = j.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    const dal = d.applicantList;
    if (Array.isArray(dal)) {
      for (const item of dal) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          out.push(item as Record<string, unknown>);
        }
      }
    }
    if (d.applicant && typeof d.applicant === "object" && !Array.isArray(d.applicant)) {
      out.push(d.applicant as Record<string, unknown>);
    }
  }
  return out;
}

export function flattenVfsLoginResponseForProfile(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const j = raw as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...j };
  const nestedSources = collectNestedLoginApplicantSources(j);

  for (const key of LOGIN_PROFILE_FIELD_KEYS) {
    if (!isEmptyProfileFieldValue(merged[key])) continue;
    for (const src of nestedSources) {
      const v = src[key];
      if (!isEmptyProfileFieldValue(v)) {
        merged[key] = v;
        break;
      }
    }
  }
  return merged;
}

/**
 * First `/user/login` (password only) usually has empty applicant fields; the real values arrive on the second
 * call (OTP). Do not merge password-step identity into the stored profile — only OTP merge should set those keys.
 * Keeps flags/tokens from the password response (e.g. `enableOTPAuthentication`).
 */
export function stripPasswordStepApplicantFieldsForProfileMerge(
  flat: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!flat) return null;
  const o = { ...flat };
  for (const k of LOGIN_PROFILE_FIELD_KEYS) {
    delete o[k];
  }
  delete o.applicantList;
  delete o.applicant;
  return o;
}

export function looksLikeEmailForVfsLogin(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

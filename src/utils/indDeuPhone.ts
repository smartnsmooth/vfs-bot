/**
 * ind-deu phone for applicants payload.
 * Before account creation: generate a placeholder DE mobile once per instance.
 * After hero-sms account creation: persist that number on the same dialCode/contactNumber fields.
 */

import {
  getApplicantDetailsOverrides,
  patchApplicantDetailsOverrides,
} from "./applicantDetails.store";

export const IND_DEU_PLACEHOLDER_DIAL_CODE = "49";

export type StoredApplicantPhone = { dialCode: string; contactNumber: string };

export function generateIndDeuPlaceholderPhone(): StoredApplicantPhone {
  const prefixes = ["15", "16", "17"] as const;
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)]!;
  let rest = "";
  for (let i = 0; i < 9; i++) rest += String(Math.floor(Math.random() * 10));
  return { dialCode: IND_DEU_PLACEHOLDER_DIAL_CODE, contactNumber: `${prefix}${rest}` };
}

export function hasStoredApplicantPhone(details: Record<string, unknown> | null | undefined): boolean {
  const dial = typeof details?.dialCode === "string" ? details.dialCode.replace(/\D/g, "") : "";
  const num = typeof details?.contactNumber === "string" ? details.contactNumber.replace(/\D/g, "") : "";
  return dial.length > 0 && num.length > 0;
}

function digitsOnly(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

/**
 * Keep existing instance phone when the incoming save omitted dial/contact.
 * If still missing, generate a DE placeholder once and write it onto `instanceFields`.
 */
export function applyIndDeuPhoneToInstanceFields(
  instanceFields: Record<string, unknown>,
  instanceId?: number,
): StoredApplicantPhone {
  const prev = getApplicantDetailsOverrides(instanceId) ?? {};
  if (!hasStoredApplicantPhone(instanceFields) && hasStoredApplicantPhone(prev)) {
    instanceFields.dialCode = prev.dialCode;
    instanceFields.contactNumber = prev.contactNumber;
  }
  if (!hasStoredApplicantPhone(instanceFields)) {
    const phone = generateIndDeuPlaceholderPhone();
    instanceFields.dialCode = phone.dialCode;
    instanceFields.contactNumber = phone.contactNumber;
    return phone;
  }
  const phone = {
    dialCode: digitsOnly(instanceFields.dialCode),
    contactNumber: digitsOnly(instanceFields.contactNumber),
  };
  instanceFields.dialCode = phone.dialCode;
  instanceFields.contactNumber = phone.contactNumber;
  return phone;
}

/** Read stored phone, or generate+persist a DE placeholder once. */
export function ensureIndDeuInstancePhone(instanceId?: number): StoredApplicantPhone {
  const details = getApplicantDetailsOverrides(instanceId) ?? {};
  if (hasStoredApplicantPhone(details)) {
    return {
      dialCode: digitsOnly(details.dialCode),
      contactNumber: digitsOnly(details.contactNumber),
    };
  }
  const phone = generateIndDeuPlaceholderPhone();
  patchApplicantDetailsOverrides(phone, instanceId);
  return phone;
}

import {
  getApplicantDetailsOverrides,
  patchApplicantDetailsOverrides,
  setApplicantDetailsOverrides,
} from "./applicantDetails.store";
import { getSessionLoginCredentials, setSessionLoginCredentials, clearSessionLoginCredentials } from "./sessionLogin.store";
import { getIndDeuProcessSessionId } from "./indDeuProcessSession";
import { hasStoredApplicantPhone } from "./indDeuPhone";
import { heroSmsCancel, type HeroSmsNumber } from "../services/heroSms";

export const IND_DEU_ACCOUNT_PASSWORD = "123qwe!Q";

/** Relogin recreate + restart reuse threshold. Default 15 minutes. */
export function getIndDeuPhoneTtlMs(): number {
  const raw = parseInt(process.env.IND_DEU_PHONE_TTL_MINUTES ?? "15", 10);
  const minutes = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 15;
  return minutes * 60_000;
}

export function getHeroSmsPurchasedAt(instanceId?: number): number | null {
  const d = getApplicantDetailsOverrides(instanceId) ?? {};
  const n = typeof d.heroSmsPurchasedAt === "number" ? d.heroSmsPurchasedAt : Number(d.heroSmsPurchasedAt);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function getHeroSmsPhoneAgeMs(instanceId?: number): number | null {
  const at = getHeroSmsPurchasedAt(instanceId);
  if (at == null) return null;
  return Math.max(0, Date.now() - at);
}

/** True when the HeroSMS number is too old for a plain relogin (missing stamp counts as expired). */
export function isIndDeuPhoneExpiredForRelogin(instanceId?: number): boolean {
  const age = getHeroSmsPhoneAgeMs(instanceId);
  if (age == null) return true;
  return age >= getIndDeuPhoneTtlMs();
}

/** Record purchase time immediately when a HeroSMS number is bought. */
export function persistHeroSmsPurchase(instanceId: number | undefined, phone: HeroSmsNumber): void {
  patchApplicantDetailsOverrides(
    {
      dialCode: phone.dialCode,
      contactNumber: phone.localNumber,
      heroSmsActivationId: phone.activationId,
      heroSmsPurchasedAt: Date.now(),
    },
    instanceId,
  );
}

export function getIndDeuEmailPrefix(): string {
  const g = getApplicantDetailsOverrides(0) ?? {};
  return typeof g.indDeuEmailPrefix === "string" ? g.indDeuEmailPrefix.trim() : "";
}

export function setIndDeuEmailPrefix(prefix: string): void {
  const g = getApplicantDetailsOverrides(0) ?? {};
  g.indDeuEmailPrefix = prefix.trim();
  setApplicantDetailsOverrides(g, 0);
}

export function getIndDeuEmailDomain(): string {
  const g = getApplicantDetailsOverrides(0) ?? {};
  return typeof g.indDeuEmailDomain === "string" ? g.indDeuEmailDomain.trim().replace(/^@+/, "") : "";
}

export function setIndDeuEmailDomain(domain: string): void {
  const g = getApplicantDetailsOverrides(0) ?? {};
  g.indDeuEmailDomain = domain.trim().replace(/^@+/, "");
  setApplicantDetailsOverrides(g, 0);
}

export function getStoredHeroSmsActivationId(instanceId?: number): string {
  const d = getApplicantDetailsOverrides(instanceId) ?? {};
  return typeof d.heroSmsActivationId === "string" ? d.heroSmsActivationId.trim() : "";
}

export function getStoredHeroSmsLastCode(instanceId?: number): string {
  const d = getApplicantDetailsOverrides(instanceId) ?? {};
  return typeof d.heroSmsLastCode === "string" ? d.heroSmsLastCode.trim() : "";
}

export function shouldReuseIndDeuAccount(instanceId?: number): boolean {
  const creds = getSessionLoginCredentials(instanceId);
  if (!creds?.username?.trim() || !creds.password) return false;
  const d = getApplicantDetailsOverrides(instanceId) ?? {};
  if (!hasStoredApplicantPhone(d)) return false;
  if (!getStoredHeroSmsActivationId(instanceId)) return false;

  const age = getHeroSmsPhoneAgeMs(instanceId);
  if (age != null) {
    return age < getIndDeuPhoneTtlMs();
  }

  const processId = getIndDeuProcessSessionId();
  if (!processId) return false;
  const storedSession =
    typeof d.indDeuProcessSessionId === "string" ? d.indDeuProcessSessionId.trim() : "";
  if (!storedSession || storedSession !== processId) return false;
  return true;
}

export function persistIndDeuCreatedAccount(
  instanceId: number | undefined,
  opts: {
    email: string;
    password: string;
    dialCode: string;
    contactNumber: string;
    heroSmsActivationId: string;
    heroSmsLastCode?: string;
  },
): void {
  const processId = getIndDeuProcessSessionId();
  setSessionLoginCredentials(opts.email, opts.password, instanceId, "clear");
  patchApplicantDetailsOverrides(
    {
      dialCode: opts.dialCode,
      contactNumber: opts.contactNumber,
      heroSmsActivationId: opts.heroSmsActivationId,
      heroSmsLastCode: opts.heroSmsLastCode ?? "",
      heroSmsPurchasedAt: getHeroSmsPurchasedAt(instanceId) ?? Date.now(),
      indDeuProcessSessionId: processId ?? "",
    },
    instanceId,
  );
}

export function preserveIndDeuInternalFields(
  instanceFields: Record<string, unknown>,
  instanceId?: number,
): void {
  const prev = getApplicantDetailsOverrides(instanceId) ?? {};
  const keys = [
    "heroSmsActivationId",
    "heroSmsLastCode",
    "heroSmsPurchasedAt",
    "indDeuProcessSessionId",
    "dialCode",
    "contactNumber",
  ] as const;
  for (const k of keys) {
    const incoming = instanceFields[k];
    const empty =
      incoming == null || (typeof incoming === "string" && incoming.trim() === "");
    if (empty && prev[k] != null && String(prev[k]).trim() !== "") {
      instanceFields[k] = prev[k];
    }
  }
}

export async function cancelStoredHeroSms(instanceId?: number): Promise<void> {
  const id = getStoredHeroSmsActivationId(instanceId);
  if (!id) return;
  await heroSmsCancel(id).catch(() => {});
}

export function clearIndDeuCreatedAccount(instanceId?: number): void {
  clearSessionLoginCredentials(instanceId);
  const prev = getApplicantDetailsOverrides(instanceId) ?? {};
  const next = { ...prev };
  delete next.dialCode;
  delete next.contactNumber;
  delete next.heroSmsActivationId;
  delete next.heroSmsLastCode;
  delete next.heroSmsPurchasedAt;
  delete next.indDeuProcessSessionId;
  setApplicantDetailsOverrides(next, instanceId);
}

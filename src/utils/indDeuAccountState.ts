import {
  getApplicantDetailsOverrides,
  patchApplicantDetailsOverrides,
  setApplicantDetailsOverrides,
} from "./applicantDetails.store";
import { getSessionLoginCredentials, setSessionLoginCredentials, clearSessionLoginCredentials } from "./sessionLogin.store";
import { getIndDeuProcessSessionId } from "./indDeuProcessSession";
import { hasStoredApplicantPhone } from "./indDeuPhone";
import { heroSmsCancel } from "../services/heroSms";

export const IND_DEU_ACCOUNT_PASSWORD = "123qwe!Q";

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
  const processId = getIndDeuProcessSessionId();
  if (!processId) return false;
  const d = getApplicantDetailsOverrides(instanceId) ?? {};
  const storedSession =
    typeof d.indDeuProcessSessionId === "string" ? d.indDeuProcessSessionId.trim() : "";
  if (!storedSession || storedSession !== processId) return false;
  const creds = getSessionLoginCredentials(instanceId);
  if (!creds?.username?.trim() || !creds.password) return false;
  if (!hasStoredApplicantPhone(d)) return false;
  if (!getStoredHeroSmsActivationId(instanceId)) return false;
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
  delete next.indDeuProcessSessionId;
  setApplicantDetailsOverrides(next, instanceId);
}

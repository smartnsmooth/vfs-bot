import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getApplicantDetailsOverrides } from "./applicantDetails.store";
import { getSessionLoginCredentials } from "./sessionLogin.store";

const ALREADY_BOOKED_DIR = join(process.cwd(), "already-booked");

function sanitizeFilenamePart(raw: string, maxLen: number): string {
  const t = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/g, "");
  const s = t.slice(0, maxLen).trim();
  return s || "unknown";
}

export type ScheduleResponseForAlreadyBookedFile = {
  error?: unknown;
  IsAppointmentBooked?: boolean;
  appointmentDate?: string;
  appointmentTime?: string;
  URL?: string | null;
  url?: string | null;
  payLoad?: string | null;
  payload?: string | null;
};

/**
 * Persists email, password, and applicant details when Schedule API reports already booked.
 * Filename: `{email} - {firstName} {lastName}.json` under `./already-booked/`.
 */
export function saveAlreadyBookedAccountFile(
  schedulePayload: Record<string, unknown>,
  scheduleResponse: ScheduleResponseForAlreadyBookedFile,
  instanceId?: number
): string | null {
  try {
    const details = getApplicantDetailsOverrides(instanceId) ?? {};
    const creds = getSessionLoginCredentials(instanceId);

    const email = sanitizeFilenamePart(String(creds?.username ?? "unknown-email"), 80);
    const firstName = sanitizeFilenamePart(String(details.firstName ?? "Applicant"), 40);
    const lastName = sanitizeFilenamePart(String(details.lastName ?? ""), 40);
    const nameForFile = lastName ? `${firstName} ${lastName}` : firstName;

    let baseName = `${email} - ${sanitizeFilenamePart(nameForFile, 100)}`;
    if (!baseName.replace(/-/g, "").trim()) baseName = "already-booked-unknown";

    mkdirSync(ALREADY_BOOKED_DIR, { recursive: true });
    let filePath = join(ALREADY_BOOKED_DIR, `${baseName}.json`);
    if (existsSync(filePath)) {
      const suffix = `${instanceId ?? 0}-${Date.now()}`;
      filePath = join(ALREADY_BOOKED_DIR, `${baseName} - ${suffix}.json`);
    }

    const record = {
      savedAt: new Date().toISOString(),
      reason: "already-booked",
      instanceId: instanceId ?? null,
      email: creds?.username ?? null,
      credentials: creds
        ? {
            username: creds.username,
            password: creds.password,
            username2: creds.username2 ?? null,
            password2: creds.password2 ?? null,
          }
        : null,
      applicantDetails: details,
      schedulePayload,
      scheduleResponse,
    };

    writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
    return filePath;
  } catch {
    return null;
  }
}

export function isScheduleAlreadyBooked(body: string, parsed?: { error?: unknown }): boolean {
  const parts: string[] = [body];
  if (parsed?.error != null && parsed.error !== "") {
    parts.push(typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error));
  }
  return parts.some((s) => /already\s*booked/i.test(s));
}

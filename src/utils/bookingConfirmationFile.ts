import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getApplicantDetailsOverrides } from "./applicantDetails.store";
import { getSessionLoginCredentials } from "./sessionLogin.store";
import { buildScheduleRedirectUrl, type ScheduleResponseWithRedirect } from "./scheduleRedirectUrl";

const BOOKINGS_DIR = join(process.cwd(), "bookings");

function sanitizeFilenamePart(raw: string, maxLen: number): string {
  const t = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/g, "");
  const s = t.slice(0, maxLen).trim();
  return s || "unknown";
}

export type ScheduleResponseForBookingFile = ScheduleResponseWithRedirect & {
  appointmentDate?: string;
  appointmentTime?: string;
  IsAppointmentBooked?: boolean;
};

/**
 * Persists credentials, applicant details, schedule payload fields, and response appointment fields.
 * Filename: `{appointmentDate} - {firstName} {lastName}.json` (under `./bookings/`).
 */
export function saveBookingConfirmationFile(
  schedulePayload: Record<string, unknown>,
  scheduleResponse: ScheduleResponseForBookingFile,
  instanceId?: number
): string | null {
  try {
    const details = getApplicantDetailsOverrides(instanceId) ?? {};
    const creds = getSessionLoginCredentials(instanceId);

    const firstName = sanitizeFilenamePart(String(details.firstName ?? "Applicant"), 40);
    const lastName = sanitizeFilenamePart(String(details.lastName ?? ""), 40);
    const nameForFile = lastName ? `${firstName} ${lastName}` : firstName;

    const dateForFile = sanitizeFilenamePart(String(scheduleResponse.appointmentDate ?? "unknown-date"), 30);

    let baseName = `${dateForFile} - ${sanitizeFilenamePart(nameForFile, 100)}`;
    if (!baseName.replace(/-/g, "").trim()) baseName = "booking-unknown";

    mkdirSync(BOOKINGS_DIR, { recursive: true });
    let filePath = join(BOOKINGS_DIR, `${baseName}.json`);
    if (existsSync(filePath)) {
      const suffix = `${instanceId ?? 0}-${Date.now()}`;
      filePath = join(BOOKINGS_DIR, `${baseName} - ${suffix}.json`);
    }

    const pd = schedulePayload.paymentdetails as { amount?: number; currency?: string } | undefined;
    const scheduleUrl = buildScheduleRedirectUrl(scheduleResponse);

    const record = {
      savedAt: new Date().toISOString(),
      instanceId: instanceId ?? null,
      missionCode: schedulePayload.missionCode ?? null,
      centerCode: schedulePayload.centerCode ?? null,
      urn: schedulePayload.urn ?? null,
      amount: pd?.amount ?? null,
      paymentCurrency: pd?.currency ?? null,
      appointmentDate: scheduleResponse.appointmentDate ?? null,
      appointmentTime: scheduleResponse.appointmentTime ?? null,
      isAppointmentBooked: scheduleResponse.IsAppointmentBooked ?? null,
      scheduleUrl,
      scheduleResponseURL: scheduleResponse.URL ?? scheduleResponse.url ?? null,
      scheduleResponsePayLoad: scheduleResponse.payLoad ?? scheduleResponse.payload ?? null,
      credentials: creds ? { username: creds.username, password: creds.password } : null,
      applicantDetails: details,
      schedulePayload,
    };

    writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
        return filePath;
  } catch (err) {
        return null;
  }
}

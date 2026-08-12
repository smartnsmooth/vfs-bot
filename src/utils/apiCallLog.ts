import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentInstanceId } from "../config/config";

const LOG_FILE = join(process.cwd(), "log.txt");

export type ApiCallLogKind = "polling" | "applicants" | "calendar" | "timeslot" | "fees" | "schedule";

function resolveInstanceId(instanceId?: number): number {
  if (typeof instanceId === "number" && Number.isFinite(instanceId) && instanceId >= 1) {
    return Math.floor(instanceId);
  }
  const cur = getCurrentInstanceId();
  if (typeof cur === "number" && Number.isFinite(cur) && cur >= 1) return Math.floor(cur);
  return 1;
}

function formatCallTime(): string {
  return new Date().toISOString();
}

/** True when lift-api returned a Cloudflare interstitial HTML page instead of JSON. */
export function isCloudflareChallengeBody(body: string | undefined | null): boolean {
  if (!body) return false;
  const b = body;
  return (
    b.includes("<title>Just a moment...</title>") ||
    b.includes("challenges.cloudflare.com") ||
    b.includes("cdn-cgi/challenge-platform") ||
    (/cf-chl/i.test(b) && /<!DOCTYPE html/i.test(b))
  );
}

function formatResponseBlock(body: string): string {
  if (isCloudflareChallengeBody(body)) {
    return "   cloudflareChallenge";
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    return JSON.stringify(parsed, null, 2)
      .split("\n")
      .map((line) => `   ${line}`)
      .join("\n");
  } catch {
    const trimmed = body.trim();
    if (!trimmed) return "   (empty)";
    return trimmed
      .split("\n")
      .map((line) => `   ${line}`)
      .join("\n");
  }
}

/** Append one API call entry to `./log.txt` (previous style). Always writes a response block. */
export function logApiCall(
  kind: ApiCallLogKind,
  responseBody?: string,
  instanceId?: number,
  requestPayload?: string,
  opts?: { error?: string }
): void {
  const id = resolveInstanceId(instanceId);
  const time = formatCallTime();
  let entry = `- instance ${id} -> ${kind} -> ${time}\n`;

  if ((kind === "schedule" || kind === "timeslot") && requestPayload != null) {
    entry += `   payload:\n${formatResponseBlock(requestPayload)}\n`;
  }

  if (opts?.error) {
    entry += `   error: ${opts.error}\n`;
  }

  entry += `   response:\n${formatResponseBlock(responseBody ?? "")}\n`;

  try {
    appendFileSync(LOG_FILE, entry, "utf8");
  } catch {
    /* ignore disk errors — must not affect bot flow */
  }
}

export type InstanceIpLogReason = "login" | "rotate-ip" | "recover";

/** Log instance egress IP (login / IP rotate / recover). */
export function logInstanceIp(
  reason: InstanceIpLogReason,
  ip: string,
  instanceId?: number
): void {
  const id = resolveInstanceId(instanceId);
  const time = formatCallTime();
  const addr = (ip || "").trim() || "(unknown)";
  const entry = `- instance ${id} -> ${reason} -> ${time} -> ${addr}\n`;
  try {
    appendFileSync(LOG_FILE, entry, "utf8");
  } catch {
    /* ignore */
  }
}

export function liftUrlToLogKind(url: string): ApiCallLogKind | null {
  const u = url.toLowerCase();
  if (u.includes("checkisslotavailable") || u.includes("/appointment/checkisslotavailable")) {
    return "polling";
  }
  if (u.includes("/appointment/applicants")) return "applicants";
  if (u.includes("/appointment/calendar")) return "calendar";
  if (u.includes("/appointment/timeslot")) return "timeslot";
  if (u.includes("/appointment/fees")) return "fees";
  if (u.includes("/appointment/schedule")) return "schedule";
  return null;
}

export function logLiftApiCall(
  url: string,
  responseBody: string,
  instanceId?: number,
  requestPayload?: string,
  opts?: { error?: string }
): void {
  const kind = liftUrlToLogKind(url);
  if (!kind) return;
  logApiCall(kind, responseBody, instanceId, requestPayload, opts);
}

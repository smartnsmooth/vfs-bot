import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentInstanceId } from "../config/config";

const LOG_FILE = join(process.cwd(), "log.txt");

export type ApiCallLogKind = "polling" | "applicants" | "calendar" | "timeslot" | "fees" | "schedule";

export type ApiCallLogOpts = {
  error?: string;
  requestAt?: Date | string;
  responseAt?: Date | string;
  /** HTTP status from fetch (used e.g. for applicants 504 compact logs). */
  httpStatus?: number;
};

function resolveInstanceId(instanceId?: number): number {
  if (typeof instanceId === "number" && Number.isFinite(instanceId) && instanceId >= 1) {
    return Math.floor(instanceId);
  }
  const cur = getCurrentInstanceId();
  if (typeof cur === "number" && Number.isFinite(cur) && cur >= 1) return Math.floor(cur);
  return 1;
}

/** Clock time only: `03:13:21.182Z` (from ISO, or pass-through if already that shape). */
export function formatLogClockTime(at?: Date | string): string {
  if (typeof at === "string" && /^\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)) return at;
  const iso =
    typeof at === "string"
      ? at
      : (at instanceof Date ? at : new Date()).toISOString();
  const t = iso.includes("T") ? iso.slice(iso.indexOf("T") + 1) : iso;
  return t.endsWith("Z") ? t : `${t}Z`;
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

function asFiniteCode(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

function extractVfsErrorCode(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    return asFiniteCode(parsed?.error?.code);
  } catch {
    /* ignore */
  }
  return null;
}

/** Cloudflare / gateway 504 payload uses `status` / `error_code`. */
function extractGatewayStatusCode(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as {
      status?: unknown;
      error_code?: unknown;
      cloudflare_error?: unknown;
    };
    const fromStatus = asFiniteCode(parsed?.status);
    if (fromStatus === 504) return 504;
    const fromErrorCode = asFiniteCode(parsed?.error_code);
    if (fromErrorCode === 504) return 504;
    if (parsed?.cloudflare_error === true && fromStatus != null) return fromStatus;
  } catch {
    /* ignore */
  }
  return null;
}

/** Top-level `{ code, description: "Repeated Delay" }` body (HTTP 409). */
function isRepeatedDelayBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      description?: unknown;
      error?: { description?: unknown };
    };
    const desc =
      typeof parsed?.description === "string"
        ? parsed.description
        : typeof parsed?.error?.description === "string"
          ? parsed.error.description
          : "";
    return /repeated\s*delay/i.test(desc);
  } catch {
    /* ignore */
  }
  return false;
}

/** Problem-details / ASP.NET style `{ status: 401, title: "Unauthorized" }`. */
function extractHttpProblemStatus(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { status?: unknown; title?: unknown };
    const status = asFiniteCode(parsed?.status);
    if (status === 401 || status === 403 || status === 504) return status;
    if (status != null && typeof parsed?.title === "string" && /unauthorized/i.test(parsed.title)) {
      return 401;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Top-level VFS rate-limit style `{ "code": "429202", "description": "" }`
 * (also nested under `error.code`). Only 429202 is compacted.
 */
function extractCompact429202(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      code?: unknown;
      error?: { code?: unknown };
    };
    const candidates = [parsed?.code, parsed?.error?.code];
    for (const c of candidates) {
      const s = typeof c === "number" && Number.isFinite(c) ? String(c) : typeof c === "string" ? c.trim() : "";
      if (s === "429202") return "429202";
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Codes that use the compact one-line response (no JSON body):
 * - any kind: 409 (Repeated Delay), 401, 429202
 * - polling: 1035
 * - applicants: 1101, 504
 */
function compactLogCode(
  kind: ApiCallLogKind,
  body: string,
  httpStatus?: number
): string | number | null {
  if (httpStatus === 409 || isRepeatedDelayBody(body)) return 409;

  if (httpStatus === 401) return 401;
  const problem = extractHttpProblemStatus(body);
  if (problem === 401) return 401;

  const rate = extractCompact429202(body);
  if (rate) return rate;

  if (kind === "polling") {
    const code = extractVfsErrorCode(body);
    return code === 1035 ? 1035 : null;
  }
  if (kind === "applicants") {
    const vfs = extractVfsErrorCode(body);
    if (vfs === 1101) return 1101;
    if (httpStatus === 504) return 504;
    if (problem === 504) return 504;
    const gateway = extractGatewayStatusCode(body);
    if (gateway === 504) return 504;
  }
  return null;
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

/** Append one API call entry to `./log.txt`. Always writes a response block. */
export function logApiCall(
  kind: ApiCallLogKind,
  responseBody?: string,
  instanceId?: number,
  requestPayload?: string,
  opts?: ApiCallLogOpts
): void {
  const id = resolveInstanceId(instanceId);
  const requestTime = formatLogClockTime(opts?.requestAt);
  const responseTime = formatLogClockTime(opts?.responseAt);
  let entry = `- instance ${id} -> ${kind} -> ${requestTime}\n`;

  if (
    (kind === "calendar" || kind === "timeslot" || kind === "schedule") &&
    requestPayload != null
  ) {
    entry += `   payload:\n${formatResponseBlock(requestPayload)}\n`;
  }

  if (opts?.error) {
    entry += `   error: ${opts.error}\n`;
  }

  const body = responseBody ?? "";
  const compactCode = !opts?.error ? compactLogCode(kind, body, opts?.httpStatus) : null;

  if (compactCode != null) {
    entry += `   response:   -> ${compactCode}     -> ${responseTime}\n`;
  } else {
    entry += `   response:   -> ${responseTime}\n`;
    entry += `${formatResponseBlock(body)}\n`;
  }

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
  instanceId?: number,
  detail?: string
): void {
  const id = resolveInstanceId(instanceId);
  const time = formatLogClockTime();
  const addr = (ip || "").trim() || "(unknown)";
  const note = (detail ?? "").trim();
  const extra = note ? ` (${note})` : "";
  const entry = `- instance ${id} -> ${reason} -> ${time} -> ${addr}${extra}\n`;
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
  opts?: ApiCallLogOpts
): void {
  const kind = liftUrlToLogKind(url);
  if (!kind) return;
  logApiCall(kind, responseBody, instanceId, requestPayload, opts);
}

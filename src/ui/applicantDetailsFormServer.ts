import { exec } from "node:child_process";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { config } from "../config/config";
import { getApplicantFormDefaults } from "../config/saveApplicants";
import {
  getApplicantDetailsOverrides,
  setApplicantDetailsOverrides,
  getAllInstanceApplicantDetails,
} from "../utils/applicantDetails.store";
import { isIndDeuRoute } from "../utils/vfsRoute";
import { preserveIndDeuInternalFields } from "../utils/indDeuAccountState";
import { applyIndDeuPhoneToInstanceFields } from "../utils/indDeuPhone";
import { getSessionLoginCredentials, setSessionLoginCredentials, getAllInstanceCredentials } from "../utils/sessionLogin.store";
import { buildApplicantFormPageScript } from "./applicantDetailsFormClientScript";
import { buildMonitorTabHtml } from "./monitorTab";
import type { MonitorHooks } from "../monitoring/status.types";
import {
  getActiveProxyProvider,
  parseProxyProviderId,
  persistProxyProvider,
} from "../utils/proxyProvider";
import { isProxyListConfigured } from "../utils/proxyList";
import {
  getCalendarPollingCallerId,
  getFeesCallerId,
  getFleetUrnHolders,
  readCalendarBookingState,
} from "../utils/calendarBookingCoord";

const APPLICANT_UI_PORT = 3847;

/** Actual bound port (updated by {@link bindApplicantFormServerToFreePort} when the default is busy). */
let boundPort = APPLICANT_UI_PORT;

let applicantFormHttpServer: Server | null = null;

/** Stops the local setup form HTTP server if it is running. Safe to call multiple times. */
export function closeApplicantFormServer(): Promise<void> {
  return new Promise((resolve) => {
    const s = applicantFormHttpServer;
    if (!s) {
      resolve();
      return;
    }
    applicantFormHttpServer = null;
    s.close(() => resolve());
  });
}

/**
 * Fleet-wide booking state for the Monitor tab: the one shared totalAmount, the date
 * and timeslot pools every instance draws from, and whose turn each round-robin is on.
 * Read from the coordination file, so it is the same view the bots act on.
 */
function buildFleetSummary(): Record<string, unknown> {
  const s = readCalendarBookingState();
  return {
    phase: s.phase,
    urnHolders: getFleetUrnHolders(s),
    isTotalAmountRetrieved: s.feesDone,
    totalAmount: s.fees?.totalAmount ?? null,
    currency: s.fees?.currency ?? null,
    feesCallerId: getFeesCallerId(s),
    lastFeesCallerId: s.lastFeesCallerId,
    calendarCallerId: s.phase === "calendar_repoll" ? getCalendarPollingCallerId(s) : null,
    lastCalendarCallerId: s.lastCalendarCallerId,
    availableDateList: s.availableDateList,
    availableDatetimeList: s.availableDatetimeList,
    scheduled: s.scheduled,
  };
}

/** Base URL for the local setup form (same host the browser uses for Submit → `/api/submit`). */
export function getApplicantFormServerOrigin(): string {
  return `http://127.0.0.1:${boundPort}`;
}

/** True when `pageUrl` is the local setup form tab (never use for lift-api `fetch`). */
export function isApplicantFormServerUrl(pageUrl: string): boolean {
  try {
    const u = new URL(pageUrl);
    const fo = new URL(getApplicantFormServerOrigin());
    return u.protocol === fo.protocol && u.hostname === fo.hostname && u.port === fo.port;
  } catch {
    return false;
  }
}

/**
 * JSON body matching the browser form submit (for programmatic POST to `/api/submit`).
 * Merges stored overrides, then defaults from env; adds VFS login when `collectLogin`.
 */
export function buildApplicantFormSubmitJsonForBot(collectLogin: boolean): Record<string, unknown> | null {
  const defaults = getApplicantFormDefaults();
  const ov = getApplicantDetailsOverrides(1) ?? getApplicantDetailsOverrides(0);
  const base: Record<string, unknown> = { ...defaults };
  if (ov) Object.assign(base, ov);
  const g = base.gender;
  if (typeof g === "string" && g.trim() !== "") {
    base.gender = parseInt(g, 10);
  } else if (typeof g !== "number" || !Number.isFinite(g)) {
    base.gender = 2;
  }
  const exp = base.passportExpirtyDate;
  const vac = typeof base.vacCode === "string" ? base.vacCode.trim() : "";
  const cat = typeof base.selectedSubvisaCategory === "string" ? base.selectedSubvisaCategory.trim() : "";
  const nat = typeof base.nationalityCode === "string" ? base.nationalityCode.trim() : "";
  if (typeof exp !== "string" || !exp.trim() || !vac || !cat || !nat) {
    return null;
  }
  const mission = typeof base.missionCode === "string" ? base.missionCode.trim().toLowerCase() : "";
  if (mission === "lva") {
    const hvRaw = typeof base.helloVerifyNumber === "string" ? base.helloVerifyNumber.replace(/\D/g, "") : "";
    const jur = typeof base.juridictionCode === "string" ? base.juridictionCode.trim() : "";
    if (hvRaw.length !== 6 || !jur) {
      return null;
    }
  }
  if (collectLogin && mission !== "deu") {
    const s = getSessionLoginCredentials();
    if (!s?.username?.trim() || !s.password) return null;
    base.vfsUsername = s.username;
    base.vfsPassword = s.password;
  }
  return base;
}

/** POST to the running setup server — same handler as clicking Submit in the form UI. */
export async function postApplicantFormSubmitToLocalServer(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const url = `${getApplicantFormServerOrigin()}/api/submit`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let j: { ok?: boolean; error?: string };
    try {
      j = JSON.parse(text) as { ok?: boolean; error?: string };
    } catch {
      return { ok: false, error: `Non-JSON response HTTP ${r.status}` };
    }
    if (!j.ok) return { ok: false, error: j.error ?? `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}


function getLoginFormDefaults(): { vfsUsername: string } {
  return {
    vfsUsername: (config.vfsUsername || process.env.VFS_USERNAME || "").trim(),
  };
}

/** How to update optional second VFS account from JSON (Save / Submit). */
function readSecondCredentialAction(j: Record<string, unknown>): { username2: string; password2: string } | "clear" | "preserve" {
  const hasSecondKeys =
    "vfsUsername2" in j || "vfsPassword2" in j || "username2" in j || "password2" in j;
  if (!hasSecondKeys) return "preserve";
  const vu2 =
    (typeof j.vfsUsername2 === "string" ? j.vfsUsername2.trim() : "") ||
    (typeof j.username2 === "string" ? j.username2.trim() : "");
  const vp2 =
    (typeof j.vfsPassword2 === "string" ? j.vfsPassword2 : "") ||
    (typeof j.password2 === "string" ? j.password2 : "");
  if (vu2 && vp2 !== "") return { username2: vu2, password2: vp2 };
  return "clear";
}

function openUrlInBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "win32"
      ? `start "" "${url}"`
      : platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
      });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, obj: unknown): void {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(s),
  });
  res.end(s);
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

/** Applicant fields only (no vfs login keys). */
function parseApplicantFields(j: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const str = (k: string) => (typeof j[k] === "string" ? (j[k] as string).trim() : j[k]);
  const keys = [
    "firstName",
    "lastName",
    "dateOfBirth",
    "passportNumber",
    "dialCode",
    "contactNumber",
    "middleName",
    "passportExpirtyDate",
    "confirmPassportNumber",
    "nationalityCode",
    "selectedSubvisaCategory",
    "Subclasscode",
    "salutation",
    "vacCode",
    "vacCode2",
    "selectedSubvisaCategory2",
    "countryCode",
    "missionCode",
    "helloVerifyNumber",
    "juridictionCode",
    "indDeuEmailPrefix",
    "indDeuEmailDomain",
    "indDeuAccountPassword",
  ] as const;
  for (const k of keys) {
    const v = str(k);
    if (v !== undefined && v !== null && String(v) !== "") out[k] = v;
  }
  if (typeof out.nationalityCode === "string" && out.nationalityCode) {
    out.nationalityCode = out.nationalityCode.toUpperCase();
  }
  if ("scheduleDateRangeStart" in j) {
    const v = j.scheduleDateRangeStart;
    if (typeof v === "string" && v.trim() !== "") out.scheduleDateRangeStart = v.trim();
  }
  if ("scheduleDateRangeEnd" in j) {
    const v = j.scheduleDateRangeEnd;
    if (typeof v === "string" && v.trim() !== "") out.scheduleDateRangeEnd = v.trim();
  }
  if (typeof j.gender === "number" && Number.isFinite(j.gender)) {
    out.gender = j.gender;
  } else if (typeof j.gender === "string" && j.gender.trim() !== "") {
    out.gender = parseInt(j.gender, 10);
  }
  if (typeof j.userPollInterval === "number" && Number.isFinite(j.userPollInterval) && j.userPollInterval >= 1) {
    out.userPollInterval = Math.floor(j.userPollInterval);
  } else if (typeof j.userPollInterval === "string" && j.userPollInterval.trim() !== "") {
    const v = parseInt(j.userPollInterval, 10);
    if (Number.isFinite(v) && v >= 1) out.userPollInterval = v;
  }
  if (typeof j.apologiesIntervalSec === "number" && Number.isFinite(j.apologiesIntervalSec) && j.apologiesIntervalSec >= 1) {
    out.apologiesIntervalSec = Math.floor(j.apologiesIntervalSec);
  } else if (typeof j.apologiesIntervalSec === "string" && j.apologiesIntervalSec.trim() !== "") {
    const v = parseInt(j.apologiesIntervalSec, 10);
    if (Number.isFinite(v) && v >= 1) out.apologiesIntervalSec = v;
  } else if (typeof j.applicantsIntervalSec === "number" && Number.isFinite(j.applicantsIntervalSec) && j.applicantsIntervalSec >= 1) {
    out.apologiesIntervalSec = Math.floor(j.applicantsIntervalSec);
  } else if (typeof j.applicantsIntervalSec === "string" && j.applicantsIntervalSec.trim() !== "") {
    const v = parseInt(j.applicantsIntervalSec, 10);
    if (Number.isFinite(v) && v >= 1) out.apologiesIntervalSec = v;
  }
  if (typeof j.applicantsJoinStaggerSec === "number" && Number.isFinite(j.applicantsJoinStaggerSec) && j.applicantsJoinStaggerSec >= 0.1) {
    out.applicantsJoinStaggerSec = j.applicantsJoinStaggerSec;
  } else if (typeof j.applicantsJoinStaggerSec === "string" && j.applicantsJoinStaggerSec.trim() !== "") {
    const v = parseFloat(j.applicantsJoinStaggerSec);
    if (Number.isFinite(v) && v >= 0.1) out.applicantsJoinStaggerSec = v;
  }
  if (typeof j.apiDelaySec === "number" && Number.isFinite(j.apiDelaySec) && j.apiDelaySec >= 0) {
    out.apiDelaySec = j.apiDelaySec;
  } else if (typeof j.apiDelaySec === "string" && j.apiDelaySec.trim() !== "") {
    const v = parseFloat(j.apiDelaySec);
    if (Number.isFinite(v) && v >= 0) out.apiDelaySec = v;
  }
  if (typeof j.repeatedDelaySec === "number" && Number.isFinite(j.repeatedDelaySec) && j.repeatedDelaySec >= 1) {
    out.repeatedDelaySec = Math.floor(j.repeatedDelaySec);
  } else if (typeof j.repeatedDelaySec === "string" && j.repeatedDelaySec.trim() !== "") {
    const v = parseInt(j.repeatedDelaySec, 10);
    if (Number.isFinite(v) && v >= 1) out.repeatedDelaySec = v;
  }
  if (typeof j.postLoginPollDelay === "number" && Number.isFinite(j.postLoginPollDelay) && j.postLoginPollDelay >= 0) {
    out.postLoginPollDelay = Math.floor(j.postLoginPollDelay);
  } else if (typeof j.postLoginPollDelay === "string" && j.postLoginPollDelay.trim() !== "") {
    const v = parseInt(j.postLoginPollDelay, 10);
    if (Number.isFinite(v) && v >= 0) out.postLoginPollDelay = v;
  }
  if (typeof j.staggerIntervalSec === "number" && Number.isFinite(j.staggerIntervalSec) && j.staggerIntervalSec >= 0) {
    out.staggerIntervalSec = Math.floor(j.staggerIntervalSec);
  } else if (typeof j.staggerIntervalSec === "string" && j.staggerIntervalSec.trim() !== "") {
    const v = parseInt(j.staggerIntervalSec, 10);
    if (Number.isFinite(v) && v >= 0) out.staggerIntervalSec = v;
  }
  if ("calendarPollingStartDate" in j) {
    const v = j.calendarPollingStartDate;
    if (typeof v === "string" && v.trim() !== "") out.calendarPollingStartDate = v.trim();
  }
  if (typeof j.calendarPollingInterval === "number" && Number.isFinite(j.calendarPollingInterval) && j.calendarPollingInterval >= 1) {
    out.calendarPollingInterval = Math.floor(j.calendarPollingInterval);
  } else if (typeof j.calendarPollingInterval === "string" && j.calendarPollingInterval.trim() !== "") {
    const v = parseInt(j.calendarPollingInterval, 10);
    if (Number.isFinite(v) && v >= 1) out.calendarPollingInterval = v;
  }
  if (typeof out.helloVerifyNumber === "string") {
    const digits = out.helloVerifyNumber.replace(/\D/g, "").slice(0, 6);
    if (digits.length > 0) out.helloVerifyNumber = digits;
    else delete out.helloVerifyNumber;
  }
  return out;
}

function applyProxyProviderFromBody(
  j: Record<string, unknown>,
  monitor: MonitorHooks | undefined
): { ok: boolean; error?: string } {
  if (!("proxyProvider" in j)) return { ok: true };
  const id = parseProxyProviderId(j.proxyProvider);
  if (!id) return { ok: false, error: "Provider must be brightdata or iplist." };
  if (getActiveProxyProvider() === id) return { ok: true };
  if (monitor) return monitor.setProxyProvider(id);
  if (id === "iplist") {
    const check = isProxyListConfigured();
    if (!check.ok) return check;
  }
  persistProxyProvider(id);
  return { ok: true };
}

function buildPageHtml(collectLogin: boolean, hasMonitor: boolean): string {
  /** Per-instance date range row in the applicant column. */
  const scheduleDateRangeRow = `
  <div class="schedule-range-row" role="group" aria-label="Appointment date range">
    <label for="scheduleDateRangeStart">From</label>
    <input type="date" id="scheduleDateRangeStart" name="scheduleDateRangeStart" />
    <label for="scheduleDateRangeEnd">To</label>
    <input type="date" id="scheduleDateRangeEnd" name="scheduleDateRangeEnd" />
  </div>`;

  const defaultPollIntervalSec = 5;

  const instanceSelectBlock = `
  <fieldset style="border:1px solid #38444d;border-radius:8px;padding:1rem 1rem 0.25rem;margin:0 0 1.25rem">
    <legend style="color:#8b98a5;font-size:0.9rem">Bot configuration</legend>
    <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-top:0.5rem">
      <label for="countryCode" style="margin:0">From</label>
      <select id="countryCode" name="countryCode" style="flex:1;min-width:8rem">
        <option value="ind">India</option>
        <option value="egy">Egypt</option>
        <option value="sau">Saudi Arabia</option>
        <option value="uzb">Uzbekistan</option>
      </select>
      <label for="missionCode" style="margin:0">To</label>
      <select id="missionCode" name="missionCode" style="flex:1;min-width:8rem">
        <option value="bgr">Bulgaria</option>
        <option value="lva">Latvia</option>
        <option value="deu">Germany</option>
        <option value="prt">Portugal</option>
      </select>
    </div>
    <label style="margin-top:0.75rem">Proxy</label>
    <input type="hidden" id="proxyProvider" name="proxyProvider" value="brightdata" />
    <div class="cfg-proxy-row" role="group" aria-label="Proxy provider">
      <button type="button" class="cfg-proxy-btn active" id="cfgProxyBright" data-provider="brightdata" title="Bright Data (default)">Bright Data</button>
      <button type="button" class="cfg-proxy-btn" id="cfgProxyList" data-provider="iplist" title="IP List (proxies.txt)">IP List</button>
      <span id="cfgProxyHint" style="color:#8b98a5;font-size:0.78rem;"></span>
    </div>
    <label for="userPollInterval" style="margin-top:0.75rem">Poll interval (seconds)</label>
    <input type="number" id="userPollInterval" name="userPollInterval" min="1" value="${defaultPollIntervalSec}" />
    <div class="row2">
      <div>
        <label for="apiDelaySec" style="margin-top:0.75rem">API delay (seconds)</label>
        <input type="number" id="apiDelaySec" name="apiDelaySec" min="0" step="0.1" value="0" />
      </div>
      <div>
        <label for="repeatedDelaySec" style="margin-top:0.75rem">409 delay (seconds)</label>
        <input type="number" id="repeatedDelaySec" name="repeatedDelaySec" min="1" value="35" />
      </div>
    </div>
    <div class="row2">
      <div>
        <label for="apologiesIntervalSec" style="margin-top:0.75rem">Apologies interval (seconds)</label>
        <input type="number" id="apologiesIntervalSec" name="apologiesIntervalSec" min="1" value="2" />
      </div>
      <div>
        <label for="applicantsJoinStaggerSec" style="margin-top:0.75rem">Applicants join stagger (seconds)</label>
        <input type="number" id="applicantsJoinStaggerSec" name="applicantsJoinStaggerSec" min="0.1" step="0.1" value="0.5" />
      </div>
    </div>
    <div class="row2">
      <div>
        <label for="calendarPollingStartDate" style="margin-top:0.75rem">Calendar polling start date</label>
        <input type="date" id="calendarPollingStartDate" name="calendarPollingStartDate" />
      </div>
      <div>
      <label for="calendarPollingInterval" style="margin-top:0.75rem">Calendar polling interval (seconds)</label>
      <input type="number" id="calendarPollingInterval" name="calendarPollingInterval" min="1" value="60" />
      </div>
    </div>
    <div class="row2">
      <div>
        <label for="postLoginPollDelay" style="margin-top:0.75rem">Post-login poll delay (seconds)</label>
        <input type="number" id="postLoginPollDelay" name="postLoginPollDelay" min="0" value="30" />
      </div>
      <div>
        <label for="numInstances">Number of instances</label>
        <input type="number" id="numInstances" name="numInstances" min="1" max="100" value="1" />
      </div>
    </div>
    <div class="row2">
      <div>
        <label for="staggerIntervalSec" style="margin-top:0.75rem">Start interval between bots</label>
        <input type="number" id="staggerIntervalSec" name="staggerIntervalSec" min="0" max="120" value="6" />
      </div>
      <div id="instanceSelectWrapper" style="display:block">
        <label for="instanceId" style="margin-top:0.75rem">Select instance to configure</label>
        <select id="instanceId" name="instanceId">
          <option value="1">Instance 1</option>
        </select>
      </div>
    </div>
  </fieldset>`;

  const loginBlock = collectLogin
    ? `
  <fieldset id="vfsLoginFields" style="border:1px solid #38444d;border-radius:8px;padding:1rem 1rem 0.25rem;margin:0 0 1.25rem">
    <legend style="color:#8b98a5;font-size:0.9rem">VFS login</legend>
    <div class="row2">
      <div>
        <label for="vfsUsername">Email / username</label>
        <input id="vfsUsername" name="vfsUsername" type="email" autocomplete="username" />
      </div>
      <div>
        <label for="vfsPassword">Password</label>
        <input id="vfsPassword" name="vfsPassword" type="text" autocomplete="current-password" />
      </div>
    </div>
    <div id="loginAccount2Fields" class="row2">
      <div>
        <label for="vfsUsername2">Email / username (account 2)</label>
        <input id="vfsUsername2" name="vfsUsername2" type="email" autocomplete="off" />
      </div>
      <div>
        <label for="vfsPassword2">Password (account 2)</label>
        <input id="vfsPassword2" name="vfsPassword2" type="text" autocomplete="off" />
      </div>
    </div>
  </fieldset>`
    : "";

  const indDeuEmailPrefixBlock = `
  <fieldset id="indDeuEmailPrefixFields" style="display:none;border:1px solid #38444d;border-radius:8px;padding:1rem 1rem 0.25rem;margin:0 0 1.25rem">
    <legend style="color:#8b98a5;font-size:0.9rem">India → Germany account email</legend>
    <div class="row2">
      <div>
        <label for="indDeuEmailPrefix">Email prefix (global)</label>
        <input id="indDeuEmailPrefix" name="indDeuEmailPrefix" placeholder="tiger" autocomplete="off" />
      </div>
      <div>
        <label for="indDeuEmailDomain">Email domain (global)</label>
        <input id="indDeuEmailDomain" name="indDeuEmailDomain" placeholder="mail.tm" autocomplete="off" />
      </div>
    </div>
    <div class="row2">
      <div>
        <label for="indDeuAccountPassword">Account password (global)</label>
        <input id="indDeuAccountPassword" name="indDeuAccountPassword" type="text" value="123qwe!Q" placeholder="123qwe!Q" autocomplete="off" />
      </div>
    </div>
    <p class="hint">Uses prefix_001@domain (login only). If missing, creates prefix_001_r1, _r2, … All instances share this password for mail.tm + VFS register.</p>
  </fieldset>`;

  const title = collectLogin ? "VFS bot — login & applicant" : "VFS bot — applicant details";

  const collectLoginJs = collectLogin ? "true" : "false";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root { font-family: system-ui, sans-serif; background: #0f1419; color: #e7e9ea; }
    body { max-width: none; margin: 0; padding: 0.5rem 0.9rem 1rem; }
    /* Keep the configuration form readable; let the monitor grid use full width. */
    #tab-configure { max-width: 95%; margin: 0 auto; }
    #tab-monitor { max-width: none; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p.hint { color: #8b98a5; font-size: 0.9rem; margin-top: 0; }
    label { display: block; margin-top: 0.75rem; font-size: 0.85rem; color: #8b98a5; }
    input, select, textarea { width: 100%; box-sizing: border-box; margin-top: 0.25rem; padding: 0.5rem 0.6rem;
      border-radius: 8px; border: 1px solid #38444d; background: #15202b; color: #e7e9ea; font: inherit; }
    textarea { min-height: 6rem; resize: vertical; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    .form-layout {
      display: grid;
      grid-template-columns: minmax(280px, 1fr) minmax(320px, 1.15fr);
      gap: 1.75rem 2.25rem;
      align-items: start;
      margin-top: 1.25rem;
    }
    @media (max-width: 880px) {
      .form-layout { grid-template-columns: 1fr; }
    }
    .form-col--setup { min-width: 0; }
    .form-col--details {
      min-width: 0;
      padding: 1rem 1.1rem 0.5rem;
      border: 1px solid #38444d;
      border-radius: 10px;
      background: #12181f;
    }
    .col-heading {
      margin: 0 0 0.35rem;
      font-size: 0.95rem;
      font-weight: 600;
      color: #e7e9ea;
      letter-spacing: 0.02em;
    }
    .col-sub { margin: 0 0 0.75rem; font-size: 0.82rem; color: #8b98a5; }
    .schedule-range-row {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.65rem;
      margin: 0 0 0.85rem;
    }
    .schedule-range-row label {
      display: inline; margin: 0; font-size: 0.85rem; color: #8b98a5; white-space: nowrap;
    }
    .schedule-range-row input[type="date"] {
      width: auto; min-width: 10.25rem; max-width: 12rem; flex: 0 1 auto; margin-top: 0;
    }
    .picker-row { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; margin-top: 0.25rem; }
    .picker-row input[type="date"] { margin-top: 0; max-width: 11rem; flex: 1 1 auto; min-width: 0; }
    .form-actions { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid #38444d; display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
    button[type="submit"] { margin-top: 0; flex: 1; min-width: 8rem; }
    #forceBookBtn { margin-top: 0; flex: 1; min-width: 8rem; background: #f5a623; color: #15202b; font-weight: 700; }
    button { width: 100%; padding: 0.65rem; border: none; border-radius: 8px;
      background: #1d9bf0; color: #fff; font-weight: 600; cursor: pointer; font-size: 1rem; }
    button:hover { filter: brightness(1.08); }
    button:disabled { cursor: not-allowed; opacity: 0.8; }
    button:disabled:hover { filter: none; }
    #submitBtn.is-loading {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    #submitBtn.is-loading::before {
      content: "";
      width: 1em;
      height: 1em;
      border: 2px solid rgba(255, 255, 255, 0.35);
      border-top-color: #fff;
      border-radius: 50%;
      animation: submitSpin 0.7s linear infinite;
      flex-shrink: 0;
    }
    @keyframes submitSpin { to { transform: rotate(360deg); } }
    button.btn-inline { margin-top: 0; width: auto; padding: 0.5rem 0.9rem; font-size: 0.9rem; }
    button.btn-secondary { margin-top: 0.6rem; width: auto; background: #38444d; color: #e7e9ea; font-size: 0.85rem; padding: 0.45rem 0.75rem; }
    button.btn-secondary:hover { filter: brightness(1.12); }
    .date-chips { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.25rem; min-height: 2rem; }
    .date-chip { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.3rem 0.55rem; background: #253341; border-radius: 999px; font-size: 0.88rem; border: 1px solid #38444d; }
    .date-chip-remove { margin: 0; padding: 0 0.2rem; width: auto; min-width: 0; background: transparent; color: #8b98a5; font-size: 1.15rem; line-height: 1; font-weight: 400; }
    .date-chip-remove:hover { color: #f4212e; filter: none; }
    .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .row3 { display: grid; grid-template-columns: 1fr 1fr 0.5fr; gap: 0.75rem; }
    @media (max-width: 720px) {
      .row3 { grid-template-columns: 1fr; }
    }
    .section-rule { margin: 1.25rem 0; border: none; border-top: 1px solid #38444d; }
    .section-title { margin: 0 0 0.5rem; font-size: 0.92rem; font-weight: 600; color: #c4cdd4; }
    .ok { color: #00ba7c; margin-top: 1rem; }
    .err { color: #f4212e; margin-top: 1rem; }
    .tabbar { display: flex; gap: 0.35rem; border-bottom: 1px solid #38444d; margin-bottom: 0.5rem; }
    .tabbtn { width: auto; margin: 0; background: transparent; color: #8b98a5; border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 0.6rem 1rem; font-size: 0.95rem; font-weight: 600; }
    .tabbtn:hover { filter: none; color: #e7e9ea; }
    .tabbtn.active { color: #1d9bf0; border-bottom-color: #1d9bf0; }
    .tabpanel[hidden] { display: none; }
    .cfg-proxy-row { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; margin-top: 0.35rem; }
    .cfg-proxy-btn { width: auto; min-width: 0; flex: none; padding: 0.4rem 0.75rem; font-size: 0.85rem; font-weight: 600;
      border: 1px solid #38444d; background: #1c2732; color: #c4cdd4; border-radius: 8px; }
    .cfg-proxy-btn:hover { filter: none; background: #253341; border-color: #4a5a68; color: #e7e9ea; }
    .cfg-proxy-btn.active { background: #1d9bf0; border-color: #1d9bf0; color: #fff; }
  </style>
</head>
<body>
  <div class="tabbar" role="tablist">
    <button type="button" class="tabbtn active" data-tab="configure">Configure bots</button>
    ${hasMonitor ? `<button type="button" class="tabbtn" data-tab="monitor">Monitor bots</button>` : ""}
  </div>
  <div id="tab-configure" class="tabpanel">
  <form id="f">
    <div class="form-layout">
      <div class="form-col form-col--setup">
        ${instanceSelectBlock}
        ${loginBlock}
        ${indDeuEmailPrefixBlock}
      </div>
      <div class="form-col form-col--details">
        <h2 class="col-heading">Applicant details</h2>
        ${scheduleDateRangeRow}
        <div id="manualApplicantFields" style="margin-bottom:1rem;display:none">
          <div class="row2">
            <div>
              <label for="firstName">First name</label>
              <input id="firstName" name="firstName" placeholder="John" />
            </div>
            <div>
              <label for="lastName">Last name</label>
              <input id="lastName" name="lastName" placeholder="Doe" />
            </div>
          </div>
          <div id="manualDobPassportRow" class="row2">
            <div id="manualDobWrap">
              <label for="dateOfBirth">Date of birth (DD/MM/YYYY)</label>
              <input id="dateOfBirth" name="dateOfBirth" placeholder="15/06/1990" />
            </div>
            <div id="manualPassportNumberWrap">
              <label for="passportNumber">Passport number</label>
              <input id="passportNumber" name="passportNumber" placeholder="A12345678" />
            </div>
          </div>
          <div id="indDeuDobRow" class="row2" style="display:none"></div>
          <div id="manualDialContactFields" class="row2">
            <div>
              <label for="dialCode">Dial code</label>
              <input id="dialCode" name="dialCode" placeholder="+20" />
            </div>
            <div>
              <label for="contactNumber">Contact number</label>
              <input id="contactNumber" name="contactNumber" placeholder="1012345678" />
            </div>
          </div>
        </div>
        <div class="row3" id="applicantMetaRow">
          <div id="passportExpiryFieldWrap">
            <label for="passportExpirtyDate">Passport expiry (DD/MM/YYYY)</label>
            <input id="passportExpirtyDate" name="passportExpirtyDate" placeholder="23/04/2027" />
          </div>
          <div id="nationalityFieldWrap">
            <label for="nationalityCode">Nationality</label>
            <select id="nationalityCode" name="nationalityCode">
          <option value="">-- Select Nationality --</option>
          <option value="AFG">AFGHANISTAN</option>
          <option value="ALB">ALBANIA</option>
          <option value="DZA">ALGERIA</option>
          <option value="AGO">ANGOLA</option>
          <option value="AIA">ANGUILLA</option>
          <option value="ATG">ANTIGUA AND BARBUDA</option>
          <option value="ARG">ARGENTINA</option>
          <option value="ARM">ARMENIA</option>
          <option value="ABW">ARUBA</option>
          <option value="AUS">AUSTRALIA</option>
          <option value="AUT">AUSTRIA</option>
          <option value="AZE">AZERBAIJAN</option>
          <option value="BHS">BAHAMAS</option>
          <option value="BHR">BAHRAIN</option>
          <option value="BGD">BANGLADESH</option>
          <option value="BRB">BARBADOS</option>
          <option value="BLR">BELARUS</option>
          <option value="BEL">BELGIUM</option>
          <option value="BLZ">BELIZE</option>
          <option value="BEN">BENIN</option>
          <option value="BMU">BERMUDA</option>
          <option value="BTN">BHUTAN</option>
          <option value="BOL">BOLIVIA</option>
          <option value="BIH">BOSNIA AND HERZEGOVINA</option>
          <option value="BWA">BOTSWANA</option>
          <option value="BRA">BRAZIL</option>
          <option value="VGB">BRITISH VIRGIN ISLANDS</option>
          <option value="BRN">BRUNEI DARUSSALAM</option>
          <option value="BGR">BULGARIA</option>
          <option value="BFA">BURKINA FASO</option>
          <option value="BDI">BURUNDI</option>
          <option value="KHM">CAMBODIA</option>
          <option value="CMR">CAMEROON</option>
          <option value="CAN">CANADA</option>
          <option value="CPV">CAPE VERDE</option>
          <option value="CYM">CAYMAN ISLANDS</option>
          <option value="CAF">CENTRAL AFRICAN REPUBLIC</option>
          <option value="TCD">CHAD</option>
          <option value="CHL">CHILE</option>
          <option value="CHN">CHINA</option>
          <option value="CXR">CHRISTMAS ISLAND</option>
          <option value="CCK">COCOS (KEELING) ISLANDS</option>
          <option value="COL">COLOMBIA</option>
          <option value="COM">COMOROS</option>
          <option value="COD">CONGO</option>
          <option value="COK">COOK ISLANDS</option>
          <option value="CRI">COSTA RICA</option>
          <option value="HRV">CROATIA</option>
          <option value="CUB">CUBA</option>
          <option value="CYP">CYPRUS</option>
          <option value="CZE">CZECH REPUBLIC</option>
          <option value="COD">DEMOCRATIC REPUBLIC OF CONGO</option>
          <option value="DNK">DENMARK</option>
          <option value="DJI">DJIBOUTI</option>
          <option value="DMA">DOMINICA</option>
          <option value="DOM">DOMINICAN REPUBLIC</option>
          <option value="ECU">ECUADOR</option>
          <option value="EGY">EGYPT</option>
          <option value="SLV">EL SALVADOR</option>
          <option value="GNQ">EQUATORIAL GUINEA</option>
          <option value="ERI">ERITREA</option>
          <option value="EST">ESTONIA</option>
          <option value="ETH">ETHIOPIA</option>
          <option value="FLK">FALKLAND ISLANDS</option>
          <option value="FRO">FAROE ISLANDS</option>
          <option value="FJI">FIJI</option>
          <option value="FIN">FINLAND</option>
          <option value="FRA">FRANCE</option>
          <option value="GAB">GABON</option>
          <option value="GMB">GAMBIA</option>
          <option value="GEO">GEORGIA</option>
          <option value="DEU">GERMANY</option>
          <option value="GHA">GHANA</option>
          <option value="GIB">GIBRALTAR</option>
          <option value="GRC">GREECE</option>
          <option value="GRL">GREENLAND</option>
          <option value="GRD">GRENADA</option>
          <option value="GTM">GUATEMALA</option>
          <option value="GIN">GUINEA</option>
          <option value="GNB">GUINEA-BISSAU</option>
          <option value="GUY">GUYANA</option>
          <option value="HTI">HAITI</option>
          <option value="VAT">HOLY SEE</option>
          <option value="HND">HONDURAS</option>
          <option value="HKG">HONG KONG</option>
          <option value="GBN">Hong Kong BNO</option>
          <option value="ZZH">Hong Kong SAR</option>
          <option value="HUN">HUNGARY</option>
          <option value="ISL">ICELAND</option>
          <option value="IND">INDIA</option>
          <option value="IDN">INDONESIA</option>
          <option value="IRN">IRAN</option>
          <option value="IRQ">IRAQ</option>
          <option value="IRL">IRELAND</option>
          <option value="ISR">ISRAEL</option>
          <option value="ITA">ITALY</option>
          <option value="CIV">IVORY COAST</option>
          <option value="JAM">JAMAICA</option>
          <option value="JPN">JAPAN</option>
          <option value="JOR">JORDAN</option>
          <option value="KAZ">KAZAKHSTAN</option>
          <option value="KEN">KENYA</option>
          <option value="KIR">KIRIBATI</option>
          <option value="NFK">KOREA, DEMOCRATIC PEOPLES REP</option>
          <option value="KOS">KOSOVO</option>
          <option value="KWT">KUWAIT</option>
          <option value="KGZ">KYRGYZSTAN</option>
          <option value="LAO">LAOS</option>
          <option value="LVA">LATVIA</option>
          <option value="LBN">LEBANON</option>
          <option value="LSO">LESOTHO</option>
          <option value="LBR">LIBERIA</option>
          <option value="LBY">LIBYA</option>
          <option value="LIE">LIECHTENSTEIN</option>
          <option value="LTU">LITHUANIA</option>
          <option value="LUX">LUXEMBOURG</option>
          <option value="MAC">MACAU</option>
          <option value="ZZM">Macao Travel Permit</option>
          <option value="MKD">MACEDONIA</option>
          <option value="MDG">MADAGASCAR</option>
          <option value="MWI">MALAWI</option>
          <option value="MYS">MALAYSIA</option>
          <option value="MDV">MALDIVES</option>
          <option value="MLI">MALI</option>
          <option value="MLT">MALTA</option>
          <option value="MHL">MARSHALL ISLANDS</option>
          <option value="MRT">MAURITANIA</option>
          <option value="MUS">MAURITIUS</option>
          <option value="MEX">MEXICO</option>
          <option value="FSM">MICRONESIA</option>
          <option value="MDA">MOLDOVA</option>
          <option value="MCO">MONACO</option>
          <option value="MNG">MONGOLIA</option>
          <option value="MNE">MONTENEGRO</option>
          <option value="MSR">MONTSERRAT</option>
          <option value="MAR">MOROCCO</option>
          <option value="MOZ">MOZAMBIQUE</option>
          <option value="MMR">MYANMAR, BURMA</option>
          <option value="NAM">NAMIBIA</option>
          <option value="NRU">NAURU</option>
          <option value="NPL">NEPAL</option>
          <option value="NLD">NETHERLANDS</option>
          <option value="ANT">NETHERLANDS ANTILLES</option>
          <option value="NZL">NEW ZEALAND</option>
          <option value="NIC">NICARAGUA</option>
          <option value="NER">NIGER</option>
          <option value="NGA">NIGERIA</option>
          <option value="NOR">NORWAY</option>
          <option value="OMN">OMAN</option>
          <option value="PAK">PAKISTAN</option>
          <option value="PLW">PALAU</option>
          <option value="PSE">PALESTINE</option>
          <option value="PAN">PANAMA</option>
          <option value="PNG">PAPUA NEW GUINEA</option>
          <option value="PRY">PARAGUAY</option>
          <option value="PER">PERU</option>
          <option value="PHL">PHILIPPINES</option>
          <option value="PCN">PITCAIRN ISLAND</option>
          <option value="POL">POLAND</option>
          <option value="PRT">PORTUGAL</option>
          <option value="QAT">QATAR</option>
          <option value="ROU">ROMANIA</option>
          <option value="RUS">RUSSIAN FEDERATION</option>
          <option value="RWA">RWANDA</option>
          <option value="KNA">SAINT KITTS AND NEVIS</option>
          <option value="LCA">SAINT LUCIA</option>
          <option value="VCT">SAINT VINCENT AND THE GRENADINES</option>
          <option value="WSM">SAMOA</option>
          <option value="SMR">SAN MARINO</option>
          <option value="STP">SAO TOME AND PRINCIPE</option>
          <option value="SAU">SAUDI ARABIA</option>
          <option value="SEN">SENEGAL</option>
          <option value="SRB">REPUBLIC OF SERBIA</option>
          <option value="SYC">SEYCHELLES</option>
          <option value="SLE">SIERRA LEONE</option>
          <option value="SGP">SINGAPORE</option>
          <option value="SVK">SLOVAKIA</option>
          <option value="SVN">SLOVENIA</option>
          <option value="SLB">SOLOMON ISLANDS</option>
          <option value="SOM">SOMALIA</option>
          <option value="ZAF">SOUTH AFRICA</option>
          <option value="KOR">SOUTH KOREA</option>
          <option value="SSD">SOUTH SUDAN</option>
          <option value="ESP">SPAIN</option>
          <option value="LKA">SRI LANKA</option>
          <option value="XXA">STATELESS</option>
          <option value="SDN">SUDAN</option>
          <option value="SUR">SURINAME</option>
          <option value="SWZ">SWAZILAND</option>
          <option value="SWE">SWEDEN</option>
          <option value="CHE">SWITZERLAND</option>
          <option value="SYR">SYRIA</option>
          <option value="TWN">TAIWAN</option>
          <option value="TJK">TAJIKISTAN</option>
          <option value="TZA">TANZANIA</option>
          <option value="THA">THAILAND</option>
          <option value="TIB">TIBET</option>
          <option value="TLS">TIMOR-LESTE (EAST TIMOR)</option>
          <option value="TGO">TOGO</option>
          <option value="TON">TONGA</option>
          <option value="TTO">TRINIDAD AND TOBAGO</option>
          <option value="TUN">TUNISIA</option>
          <option value="TUR">Turkiye</option>
          <option value="TKM">TURKMENISTAN</option>
          <option value="TCA">TURKS AND CAICOS ISLANDS</option>
          <option value="TUV">TUVALU</option>
          <option value="UGA">UGANDA</option>
          <option value="UKR">UKRAINE</option>
          <option value="ARE">UNITED ARAB EMIRATES</option>
          <option value="GBR">UNITED KINGDOM</option>
          <option value="USA">UNITED STATES</option>
          <option value="URY">URUGUAY</option>
          <option value="UZB">UZBEKISTAN</option>
          <option value="VUT">VANUATU</option>
          <option value="VAT">VATICAN CITY</option>
          <option value="VEN">VENEZUELA</option>
          <option value="VNM">VIETNAM</option>
          <option value="YEM">YEMEN</option>
          <option value="ZMB">ZAMBIA</option>
          <option value="ZWE">ZIMBABWE</option>
        </select>
          </div>
          <div id="genderFieldWrap">
            <label for="gender">Gender</label>
            <select id="gender" name="gender">
              <option value="1">MALE</option>
              <option value="2">FEMALE</option>
            </select>
          </div>
        </div>
        <label for="vacCode">Visa Application Centre</label>
        <select id="vacCode" name="vacCode">
          <option value="">-- Select Centre --</option>
        </select>
        <label for="selectedSubvisaCategory">Visa Category (Center 1)</label>
        <select id="selectedSubvisaCategory" name="selectedSubvisaCategory">
          <option value="">-- Select Category --</option>
        </select>

        <div id="indLvaExtraFields" style="display:none;margin-top:0.75rem">
          <label for="helloVerifyNumber">Hello Verify Number (6 digits)</label>
          <input type="text" id="helloVerifyNumber" name="helloVerifyNumber" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" placeholder="000000" autocomplete="off" />
          <label for="juridictionCode">Jurisdiction</label>
          <select id="juridictionCode" name="juridictionCode">
            <option value="">-- Select Jurisdiction --</option>
            <option value="AHM">Latvia Visa Application Center - Ahmedabad</option>
            <option value="BEN">Latvia Visa Application Center - Bengaluru</option>
            <option value="CHA">Latvia Visa Application Center - Chandigarh</option>
            <option value="CHE">Latvia Visa Application Center - Chennai</option>
            <option value="KOC">Latvia Visa Application Center - Cochin</option>
            <option value="GOA">Latvia Visa Application Center - Goa</option>
            <option value="HYD">Latvia Visa Application Center - Hyderabad</option>
            <option value="JAL">Latvia Visa Application Center - Jalandhar</option>
            <option value="KOL">Latvia Visa Application Center - Kolkata</option>
            <option value="MUM">Latvia Visa Application center - Mumbai</option>
            <option value="DHI">Latvia Visa Application Center - New Delhi</option>
            <option value="PUN">Latvia Visa Application Center - Pune</option>
          </select>
        </div>

        <div id="uzbLvaApplicantFields" style="display:none;margin-top:0.75rem">
          <div class="row2">
            <div>
              <label for="firstNameUzbLva">First name</label>
              <input id="firstNameUzbLva" name="firstNameUzbLva" placeholder="Akmal" />
            </div>
            <div>
              <label for="lastNameUzbLva">Last name</label>
              <input id="lastNameUzbLva" name="lastNameUzbLva" placeholder="Karimov" />
            </div>
          </div>
          <label for="passportNumberUzbLva" style="margin-top:0.5rem">Passport number</label>
          <input id="passportNumberUzbLva" name="passportNumberUzbLva" placeholder="AA1234567" />
        </div>

        <div id="center2Fields">
        <hr class="section-rule" />
        <h3 class="section-title">Center 2 (optional)</h3>

        <label for="vacCode2">Visa Application Centre 2 (Optional)</label>
        <select id="vacCode2" name="vacCode2">
          <option value="">-- No Second Centre --</option>
        </select>
        <label for="selectedSubvisaCategory2">Visa Category 2 (Optional)</label>
        <select id="selectedSubvisaCategory2" name="selectedSubvisaCategory2">
          <option value="">-- Select Category --</option>
        </select>
        </div>
        <div class="form-actions">
          <button type="submit" id="submitBtn">Submit &amp; Run</button>
          <button type="button" id="forceBookBtn">Book Slot</button>
        </div>
      </div>
    </div>
  </form>
  <p id="msg"></p>
  </div>
  ${hasMonitor ? `<div id="tab-monitor" class="tabpanel" hidden>${buildMonitorTabHtml()}</div>` : ""}
  <script>
  (function(){
    var btns = Array.prototype.slice.call(document.querySelectorAll('.tabbtn'));
    btns.forEach(function(b){
      b.addEventListener('click', function(){
        btns.forEach(function(x){ x.classList.remove('active'); });
        b.classList.add('active');
        var t = b.getAttribute('data-tab');
        Array.prototype.slice.call(document.querySelectorAll('.tabpanel')).forEach(function(p){
          p.hidden = (p.id !== 'tab-' + t);
        });
        if (t === 'monitor' && window.__monitorInit) window.__monitorInit();
      });
    });
  })();
  </script>
  ${buildApplicantFormPageScript(collectLoginJs)}
</body>
</html>`;
}

export type ApplicantFormOptions = {
  /**
   * When true (default), form includes VFS username/password and stores them before `loginOnFirstTab`.
   * Use false for e.g. slot-found flow when already logged in (applicant fields only).
   */
  collectLogin?: boolean;
  /** Called when user clicks "Book Slot" — triggers force-booking on all instances. */
  onForceBook?: () => { ok: boolean; error?: string; queued?: number };
  /** Monitoring dashboard hooks. When set, the page shows a "Monitor bots" tab. */
  monitor?: MonitorHooks;
};

export type FormSubmitInfo = { firstSubmit: boolean;[key: string]: unknown };


/** Try `server.listen(port)` once; rejects with `EADDRINUSE` when the port is taken. */
function listenOnce(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

/**
 * Binds `server` on `preferredPort`, then `preferredPort+1`, … until a port is free or attempts exhausted.
 * Updates {@link boundPort} so {@link getApplicantFormServerOrigin} returns the correct URL.
 */
async function bindApplicantFormServerToFreePort(server: Server, host: string, preferredPort: number): Promise<number> {
  const maxTries = 20;
  for (let i = 0; i < maxTries; i++) {
    const tryPort = preferredPort + i;
    if (tryPort > 65535) break;
    try {
      await listenOnce(server, tryPort, host);
      boundPort = tryPort;
      return tryPort;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EADDRINUSE") throw err;
      await new Promise<void>((r) => {
        server.close(() => r());
      });
    }
  }
  throw new Error(
    `Could not bind setup form: ports ${preferredPort}–${preferredPort + maxTries - 1} are in use. Stop the other process.`
  );
}

/**
 * Serves the setup form; **every** successful Submit calls `onSubmit` (HTTP returns immediately).
 * Promise rejects only on server error/timeout; otherwise keeps running.
 */
export function runApplicantFormWithSubmitHandler(
  onSubmit: (info: FormSubmitInfo) => void | Promise<void>,
  options?: ApplicantFormOptions
): Promise<never> {
  const collectLogin = options?.collectLogin !== false;

  const preferredPort = APPLICANT_UI_PORT;
  const host = "127.0.0.1";

  return new Promise<never>((_resolve, reject) => {
    let settled = false;
    let seenSubmit = false;

    const safeReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const server = createServer(async (req, res) => {
      try {
        const u = new URL(req.url ?? "/", `http://${host}`);
        const path = u.pathname;

        if (req.method === "GET" && path === "/") {
          html(res, buildPageHtml(collectLogin, Boolean(options?.monitor)));
          return;
        }

        // ── Monitoring dashboard API (only when monitor hooks provided) ──
        if (options?.monitor && (path === "/api/monitor/events" || path.startsWith("/api/monitor/"))) {
          const monitor = options.monitor;

          if (req.method === "GET" && path === "/api/monitor/control") {
            json(res, 200, { ok: true, control: monitor.getControl() });
            return;
          }
          if (req.method === "GET" && path === "/api/monitor/snapshot") {
            json(res, 200, { ok: true, instances: monitor.snapshot() });
            return;
          }
          if (req.method === "GET" && path === "/api/monitor/fleet") {
            json(res, 200, { ok: true, fleet: buildFleetSummary() });
            return;
          }
          if (req.method === "GET" && path === "/api/monitor/events") {
            // Keep the streaming socket open indefinitely (no idle timeout) so the
            // dashboard stays "live" instead of dropping to "reconnecting…".
            req.socket.setTimeout(0);
            req.socket.setNoDelay(true);
            req.socket.setKeepAlive(true);
            res.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            });
            res.flushHeaders?.();
            res.write("retry: 3000\n\n");
            for (const s of monitor.snapshot()) {
              res.write(`data: ${JSON.stringify(s)}\n\n`);
            }
            const unsub = monitor.subscribe((s) => {
              try { res.write(`data: ${JSON.stringify(s)}\n\n`); } catch { /* client gone */ }
            });
            const ping = setInterval(() => {
              try { res.write(": ping\n\n"); } catch { /* client gone */ }
            }, 20_000);
            const cleanup = (): void => { clearInterval(ping); unsub(); };
            req.on("close", cleanup);
            req.on("error", cleanup);
            return;
          }
          if (req.method === "POST") {
            const raw = await readBody(req);
            let mj: Record<string, unknown> = {};
            try { mj = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; }
            catch { json(res, 400, { ok: false, error: "Invalid JSON" }); return; }
            const toNum = (v: unknown): number => (typeof v === "number" ? v : parseInt(String(v ?? ""), 10));
            const id = toNum(mj.instanceId);
            const action = path.slice("/api/monitor/".length);
            try {
              if (action === "focus") { json(res, 200, await monitor.focus(id)); return; }
              if (action === "devtools") { json(res, 200, await monitor.devtools(id)); return; }
              if (action === "stop") { json(res, 200, monitor.stopInstance(id)); return; }
              if (action === "restart") { json(res, 200, monitor.restartInstance(id)); return; }
              if (action === "pause") { json(res, 200, monitor.pauseRollout()); return; }
              if (action === "resume") { json(res, 200, monitor.resumeRollout()); return; }
              if (action === "pause-polling") {
                json(res, 200, monitor.pausePolling(Number.isFinite(id) && id >= 1 ? id : undefined));
                return;
              }
              if (action === "resume-polling") {
                json(res, 200, monitor.resumePolling(Number.isFinite(id) && id >= 1 ? id : undefined));
                return;
              }
              if (action === "stagger") {
                const ms = toNum(mj.intervalMs);
                json(res, 200, monitor.setStaggerInterval(Number.isFinite(ms) ? ms : 6000));
                return;
              }
              if (action === "apologies-interval") {
                const sec = toNum(mj.intervalSec);
                json(res, 200, monitor.setApologiesIntervalSec(Number.isFinite(sec) ? sec : 2));
                return;
              }
              if (action === "poll-interval") {
                const sec = toNum(mj.intervalSec);
                json(res, 200, monitor.setPollIntervalSec(Number.isFinite(sec) ? sec : 60));
                return;
              }
              if (action === "applicants-join-stagger") {
                const sec = typeof mj.intervalSec === "number" ? mj.intervalSec : parseFloat(String(mj.intervalSec ?? ""));
                json(res, 200, monitor.setApplicantsJoinStaggerSec(Number.isFinite(sec) ? sec : 0.5));
                return;
              }
              if (action === "calendar-polling-interval") {
                const sec = toNum(mj.intervalSec);
                json(res, 200, monitor.setCalendarPollingIntervalSec(Number.isFinite(sec) ? sec : 60));
                return;
              }
              if (action === "api-delay") {
                const sec = typeof mj.intervalSec === "number" ? mj.intervalSec : parseFloat(String(mj.intervalSec ?? ""));
                json(res, 200, monitor.setApiDelaySec(Number.isFinite(sec) ? sec : 0));
                return;
              }
              if (action === "repeated-delay") {
                const sec = toNum(mj.intervalSec);
                json(res, 200, monitor.setRepeatedDelaySec(Number.isFinite(sec) ? sec : 35));
                return;
              }
              if (action === "proxy-provider") {
                json(res, 200, monitor.setProxyProvider(String(mj.provider ?? "")));
                return;
              }
              if (action === "start") {
                const count = toNum(mj.count);
                const ms = toNum(mj.intervalMs);
                json(res, 200, monitor.start({ count: Number.isFinite(count) ? count : 1, intervalMs: Number.isFinite(ms) ? ms : 6000 }));
                return;
              }
            } catch (e) {
              json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
              return;
            }
            json(res, 404, { ok: false, error: "Unknown monitor action" });
            return;
          }
        }

        if (req.method === "GET" && path === "/api/defaults") {
          try {
            const defaults: Record<string, unknown> = { ...getApplicantFormDefaults() };

            // Prefer instance 1 data, fall back to instance 0.
            {
              const det1 = getApplicantDetailsOverrides(1);
              const det0 = getApplicantDetailsOverrides(0);
              const det = det1 ?? det0;
              if (det) Object.assign(defaults, det);
            }

            // Global settings stored under instance 0; surface them for all modes.
            const globalDet = getApplicantDetailsOverrides(0);
            if (globalDet && typeof globalDet.userPollInterval === "number") {
              defaults.userPollInterval = globalDet.userPollInterval;
            }
            if (globalDet && typeof globalDet.apologiesIntervalSec === "number") {
              defaults.apologiesIntervalSec = globalDet.apologiesIntervalSec;
            } else if (globalDet && typeof globalDet.applicantsIntervalSec === "number") {
              defaults.apologiesIntervalSec = globalDet.applicantsIntervalSec;
            }
            if (globalDet && typeof globalDet.applicantsJoinStaggerSec === "number") {
              defaults.applicantsJoinStaggerSec = globalDet.applicantsJoinStaggerSec;
            }
            if (globalDet && typeof globalDet.postLoginPollDelay === "number") {
              defaults.postLoginPollDelay = globalDet.postLoginPollDelay;
            }
            if (globalDet && typeof globalDet.calendarPollingStartDate === "string") {
              defaults.calendarPollingStartDate = globalDet.calendarPollingStartDate;
            }
            if (globalDet && typeof globalDet.calendarPollingInterval === "number") {
              defaults.calendarPollingInterval = globalDet.calendarPollingInterval;
            }
            if (globalDet && typeof globalDet.apiDelaySec === "number") {
              defaults.apiDelaySec = globalDet.apiDelaySec;
            }
            if (globalDet && typeof globalDet.repeatedDelaySec === "number") {
              defaults.repeatedDelaySec = globalDet.repeatedDelaySec;
            }
            defaults.proxyProvider = getActiveProxyProvider();
            defaults.proxyListReady = isProxyListConfigured().ok;
            if (globalDet && typeof globalDet.indDeuEmailPrefix === "string") {
              defaults.indDeuEmailPrefix = globalDet.indDeuEmailPrefix;
            }
            if (globalDet && typeof globalDet.indDeuEmailDomain === "string") {
              defaults.indDeuEmailDomain = globalDet.indDeuEmailDomain;
            }
            if (globalDet && typeof globalDet.indDeuAccountPassword === "string") {
              defaults.indDeuAccountPassword = globalDet.indDeuAccountPassword;
            }
            const payload: Record<string, unknown> = { ok: true, defaults };
            if (collectLogin) {
              const base = getLoginFormDefaults();
              const creds1 = getSessionLoginCredentials(1);
              const creds0 = getSessionLoginCredentials(0);
              const creds = creds1 ?? creds0;
              payload.loginDefaults = {
                ...base,
                vfsUsername: (creds?.username ?? base.vfsUsername ?? "").trim(),
                vfsPassword: creds?.password ?? "",
                vfsUsername2: (creds?.username2 ?? "").trim(),
                vfsPassword2: creds?.password2 ?? "",
              };
            }
            json(res, 200, payload);
          } catch (e) {
            json(res, 500, { ok: false, error: e instanceof Error ? e.message : "defaults failed" });
          }
          return;
        }

        if (req.method === "GET" && path === "/api/instances") {
          try {
            const credentials = getAllInstanceCredentials();
            const details = getAllInstanceApplicantDetails();

            const instances: Record<string, unknown> = {};
            const allIds = new Set([...credentials.keys(), ...details.keys()]);

            for (const id of allIds) {
              instances[String(id)] = {
                credentials: credentials.get(id) ?? null,
                details: details.get(id) ?? null,
              };
            }

            json(res, 200, { ok: true, instances });
          } catch (e) {
            json(res, 500, { ok: false, error: e instanceof Error ? e.message : "instances failed" });
          }
          return;
        }

        if (req.method === "POST" && path === "/api/save") {
          const raw = await readBody(req);
          let j: Record<string, unknown>;
          try {
            j = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            json(res, 400, { ok: false, error: "Invalid JSON" });
            return;
          }

          const instanceId = typeof j.instanceId === "number" ? j.instanceId : undefined;

          if (collectLogin && !isIndDeuRoute(j.countryCode, j.missionCode)) {
            const vu = typeof j.vfsUsername === "string" ? j.vfsUsername.trim() : "";
            const vp = typeof j.vfsPassword === "string" ? j.vfsPassword : "";
            if (vu && vp) {
              setSessionLoginCredentials(vu, vp, instanceId, readSecondCredentialAction(j));
            }
          }

          const {
            vfsUsername: _u,
            vfsPassword: _p,
            vfsUsername2: _u2,
            vfsPassword2: _p2,
            instanceId: _id,
            ...rest
          } = j;
          const fields = parseApplicantFields(rest);
          const {
            userPollInterval: upi,
            apologiesIntervalSec: ais,
            applicantsJoinStaggerSec: ajs,
            postLoginPollDelay: plpd,
            staggerIntervalSec: sis,
            calendarPollingStartDate: cpsd,
            calendarPollingInterval: cpi,
            apiDelaySec: ads,
            repeatedDelaySec: rds,
            ...instanceFields
          } = fields;

          const proxyResult = applyProxyProviderFromBody(j, options?.monitor);
          if (!proxyResult.ok) {
            json(res, 200, { ok: false, error: proxyResult.error });
            return;
          }

          {
            const global0 = getApplicantDetailsOverrides(0) ?? {};
            let changed = false;
            if (typeof upi === "number") { global0.userPollInterval = upi; changed = true; }
            if (typeof ais === "number") {
              global0.apologiesIntervalSec = ais;
              delete global0.applicantsIntervalSec;
              changed = true;
            }
            if (typeof ajs === "number") { global0.applicantsJoinStaggerSec = ajs; changed = true; }
            if (typeof plpd === "number") { global0.postLoginPollDelay = plpd; changed = true; }
            if (typeof sis === "number") { global0.staggerIntervalSec = sis; changed = true; }
            if (typeof cpsd === "string") { global0.calendarPollingStartDate = cpsd; changed = true; }
            else if ("calendarPollingStartDate" in rest) { delete global0.calendarPollingStartDate; changed = true; }
            if (typeof cpi === "number") { global0.calendarPollingInterval = cpi; changed = true; }
            if (typeof ads === "number") { global0.apiDelaySec = ads; changed = true; }
            if (typeof rds === "number") { global0.repeatedDelaySec = rds; changed = true; }
            if (typeof instanceFields.countryCode === "string") { global0.countryCode = instanceFields.countryCode; changed = true; }
            if (typeof instanceFields.missionCode === "string") { global0.missionCode = instanceFields.missionCode; changed = true; }
            if (typeof instanceFields.indDeuEmailPrefix === "string" && instanceFields.indDeuEmailPrefix.trim()) {
              global0.indDeuEmailPrefix = instanceFields.indDeuEmailPrefix.trim();
              changed = true;
            }
            if (typeof instanceFields.indDeuEmailDomain === "string" && instanceFields.indDeuEmailDomain.trim()) {
              global0.indDeuEmailDomain = instanceFields.indDeuEmailDomain.trim().replace(/^@+/, "");
              changed = true;
            }
            if (typeof instanceFields.indDeuAccountPassword === "string" && instanceFields.indDeuAccountPassword !== "") {
              global0.indDeuAccountPassword = instanceFields.indDeuAccountPassword;
              changed = true;
            }
            if (changed) setApplicantDetailsOverrides(global0, 0);
          }
          const id = instanceId ?? 0;
          if (typeof instanceFields.indDeuEmailPrefix === "string") {
            delete instanceFields.indDeuEmailPrefix;
          }
          if (typeof instanceFields.indDeuEmailDomain === "string") {
            delete instanceFields.indDeuEmailDomain;
          }
          if (typeof instanceFields.indDeuAccountPassword === "string") {
            delete instanceFields.indDeuAccountPassword;
          }
          if (isIndDeuRoute(instanceFields.countryCode, instanceFields.missionCode)) {
            applyIndDeuPhoneToInstanceFields(instanceFields, id);
            preserveIndDeuInternalFields(instanceFields, id);
          }
          setApplicantDetailsOverrides(instanceFields, id);

          json(res, 200, { ok: true });
          return;
        }

        if (req.method === "POST" && path === "/api/submit") {
          const raw = await readBody(req);
          let j: Record<string, unknown>;
          try {
            j = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            json(res, 400, { ok: false, error: "Invalid JSON" });
            return;
          }

          const proxyResult = applyProxyProviderFromBody(j, options?.monitor);
          if (!proxyResult.ok) {
            json(res, 200, { ok: false, error: proxyResult.error });
            return;
          }

          const submittedNumInstances =
            typeof j.numInstances === "number" && j.numInstances > 0
              ? Math.floor(j.numInstances)
              : 1;

          const submittedStaggerSec =
            typeof j.staggerIntervalSec === "number" && j.staggerIntervalSec >= 0
              ? Math.floor(j.staggerIntervalSec)
              : (() => {
                  const v = parseInt(String(j.staggerIntervalSec ?? ""), 10);
                  return Number.isFinite(v) && v >= 0 ? v : undefined;
                })();

          const submittedApologiesIntervalSec =
            typeof j.apologiesIntervalSec === "number" && j.apologiesIntervalSec >= 1
              ? Math.floor(j.apologiesIntervalSec)
              : typeof j.applicantsIntervalSec === "number" && j.applicantsIntervalSec >= 1
                ? Math.floor(j.applicantsIntervalSec)
                : (() => {
                    const v = parseInt(String(j.apologiesIntervalSec ?? j.applicantsIntervalSec ?? ""), 10);
                    return Number.isFinite(v) && v >= 1 ? v : undefined;
                  })();

          const submittedApplicantsJoinStaggerSec =
            typeof j.applicantsJoinStaggerSec === "number" && j.applicantsJoinStaggerSec >= 0.1
              ? j.applicantsJoinStaggerSec
              : (() => {
                  const v = parseFloat(String(j.applicantsJoinStaggerSec ?? ""));
                  return Number.isFinite(v) && v >= 0.1 ? v : undefined;
                })();

          const submittedCalendarPollingInterval =
            typeof j.calendarPollingInterval === "number" && j.calendarPollingInterval >= 1
              ? Math.floor(j.calendarPollingInterval)
              : (() => {
                  const v = parseInt(String(j.calendarPollingInterval ?? ""), 10);
                  return Number.isFinite(v) && v >= 1 ? v : undefined;
                })();

          const submittedCalendarPollingStartDate =
            typeof j.calendarPollingStartDate === "string" && j.calendarPollingStartDate.trim() !== ""
              ? j.calendarPollingStartDate.trim()
              : undefined;

          const submittedApiDelaySec =
            typeof j.apiDelaySec === "number" && j.apiDelaySec >= 0
              ? j.apiDelaySec
              : (() => {
                  const v = parseFloat(String(j.apiDelaySec ?? ""));
                  return Number.isFinite(v) && v >= 0 ? v : undefined;
                })();

          const submittedRepeatedDelaySec =
            typeof j.repeatedDelaySec === "number" && j.repeatedDelaySec >= 1
              ? Math.floor(j.repeatedDelaySec)
              : (() => {
                  const v = parseInt(String(j.repeatedDelaySec ?? ""), 10);
                  return Number.isFinite(v) && v >= 1 ? v : undefined;
                })();

          if (
            submittedApologiesIntervalSec != null ||
            submittedApplicantsJoinStaggerSec != null ||
            submittedStaggerSec != null ||
            typeof j.userPollInterval === "number" ||
            submittedCalendarPollingInterval != null ||
            submittedApiDelaySec != null ||
            submittedRepeatedDelaySec != null ||
            "calendarPollingStartDate" in j
          ) {
            const global0 = getApplicantDetailsOverrides(0) ?? {};
            let changed = false;
            if (submittedApologiesIntervalSec != null) {
              global0.apologiesIntervalSec = submittedApologiesIntervalSec;
              delete global0.applicantsIntervalSec;
              changed = true;
            }
            if (submittedApplicantsJoinStaggerSec != null) {
              global0.applicantsJoinStaggerSec = submittedApplicantsJoinStaggerSec;
              changed = true;
            }
            if (submittedStaggerSec != null) {
              global0.staggerIntervalSec = submittedStaggerSec;
              changed = true;
            }
            if (typeof j.userPollInterval === "number" && j.userPollInterval >= 1) {
              global0.userPollInterval = Math.floor(j.userPollInterval);
              changed = true;
            }
            if (submittedCalendarPollingInterval != null) {
              global0.calendarPollingInterval = submittedCalendarPollingInterval;
              changed = true;
            }
            if (submittedApiDelaySec != null) {
              global0.apiDelaySec = submittedApiDelaySec;
              changed = true;
            }
            if (submittedRepeatedDelaySec != null) {
              global0.repeatedDelaySec = submittedRepeatedDelaySec;
              changed = true;
            }
            if ("calendarPollingStartDate" in j) {
              if (submittedCalendarPollingStartDate != null) {
                global0.calendarPollingStartDate = submittedCalendarPollingStartDate;
              } else {
                delete global0.calendarPollingStartDate;
              }
              changed = true;
            }
            if (changed) setApplicantDetailsOverrides(global0, 0);
          }

          {
            const prefixFromSubmit =
              typeof j.indDeuEmailPrefix === "string" ? j.indDeuEmailPrefix.trim() : "";
            const domainFromSubmit =
              typeof j.indDeuEmailDomain === "string" ? j.indDeuEmailDomain.trim().replace(/^@+/, "") : "";
            const passwordFromSubmit =
              typeof j.indDeuAccountPassword === "string" ? j.indDeuAccountPassword : "";
            if (prefixFromSubmit || domainFromSubmit || passwordFromSubmit) {
              const global0 = getApplicantDetailsOverrides(0) ?? {};
              if (prefixFromSubmit) global0.indDeuEmailPrefix = prefixFromSubmit;
              if (domainFromSubmit) global0.indDeuEmailDomain = domainFromSubmit;
              if (passwordFromSubmit) global0.indDeuAccountPassword = passwordFromSubmit;
              setApplicantDetailsOverrides(global0, 0);
            }
          }

          const credentials = getAllInstanceCredentials();
          const details = getAllInstanceApplicantDetails();
          const allIds = new Set([...credentials.keys(), ...details.keys()]);

          if (allIds.size === 0) {
            json(res, 400, { ok: false, error: "No saved instances. Use Save button first to save data for each instance." });
            return;
          }

          const validInstanceIds: number[] = [];
          for (const instanceId of allIds) {
            if (instanceId === 0) continue;
            if (instanceId > submittedNumInstances) continue;
            const creds = credentials.get(instanceId);
            const dets = details.get(instanceId);
            if (!dets) continue;
            if (isIndDeuRoute(dets.countryCode, dets.missionCode)) {
              const g0 = getApplicantDetailsOverrides(0) ?? {};
              const prefix =
                (typeof g0.indDeuEmailPrefix === "string" ? g0.indDeuEmailPrefix.trim() : "") ||
                (typeof j.indDeuEmailPrefix === "string" ? j.indDeuEmailPrefix.trim() : "");
              const domain =
                (typeof g0.indDeuEmailDomain === "string" ? g0.indDeuEmailDomain.trim() : "") ||
                (typeof j.indDeuEmailDomain === "string" ? j.indDeuEmailDomain.trim() : "");
              const password =
                (typeof g0.indDeuAccountPassword === "string" ? g0.indDeuAccountPassword : "") ||
                (typeof j.indDeuAccountPassword === "string" ? j.indDeuAccountPassword : "");
              if (!prefix) {
                json(res, 400, { ok: false, error: "Email prefix is required for India → Germany." });
                return;
              }
              if (!domain) {
                json(res, 400, { ok: false, error: "Email domain is required for India → Germany." });
                return;
              }
              if (!password) {
                json(res, 400, { ok: false, error: "Account password is required for India → Germany." });
                return;
              }
              validInstanceIds.push(instanceId);
              continue;
            }
            if (creds) validInstanceIds.push(instanceId);
          }

          const actualInstanceCount = validInstanceIds.length;
          if (actualInstanceCount === 0) {
            json(res, 400, { ok: false, error: "No instances have details saved. Use Save button first." });
            return;
          }

          let queued = 0;
          for (const instanceId of validInstanceIds) {
            void Promise.resolve(onSubmit({
              firstSubmit: !seenSubmit,
              instanceId,
              numInstances: actualInstanceCount,
              staggerIntervalSec: submittedStaggerSec,
              ...credentials.get(instanceId),
              ...details.get(instanceId),
            }))
              .then(() => undefined)
              .catch(() => undefined);
            queued++;
          }

          seenSubmit = true;
          json(res, 200, { ok: true, firstSubmit: !seenSubmit, queued });
          return;
        }

        if (req.method === "POST" && path === "/api/force-book") {
          if (!options?.onForceBook) {
            json(res, 400, { ok: false, error: "Force-book not available in this mode." });
            return;
          }
          const result = options.onForceBook();
          json(res, result.ok ? 200 : 409, result);
          return;
        }

        res.writeHead(404);
        res.end();
      } catch (e) {
                try {
          json(res, 500, { ok: false, error: e instanceof Error ? e.message : "error" });
        } catch {
          res.destroy();
        }
      }
    });

    void (async () => {
      try {
        const boundPort = await bindApplicantFormServerToFreePort(server, host, preferredPort);
        applicantFormHttpServer = server;
        const url = `http://${host}:${boundPort}/`;
        server.on("error", (err) => {
          applicantFormHttpServer = null;
          server.close(() => { });
          safeReject(err);
        });
                openUrlInBrowser(url);
      } catch (err) {
        server.close(() => { });
        safeReject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}

/**
 * Waits until the first successful Submit (server keeps running for later submits).
 * Prefer {@link runApplicantFormWithSubmitHandler} for submit-driven bot runs.
 */
export function openApplicantDetailsFormAndWait(options?: ApplicantFormOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    void runApplicantFormWithSubmitHandler(async ({ firstSubmit }) => {
      if (firstSubmit && !settled) {
        settled = true;
        resolve();
      }
    }, options).catch((err) => {
      if (!settled) reject(err);
    });
  });
}

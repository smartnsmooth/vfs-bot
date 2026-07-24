import { exec } from "node:child_process";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { config } from "../config/config";
import { getApplicantFormDefaults } from "../config/saveApplicants";
import { logger } from "../utils/logger";
import {
  getApplicantDetailsOverrides,
  setApplicantDetailsOverrides,
  getAllInstanceApplicantDetails,
} from "../utils/applicantDetails.store";
import { getSessionLoginCredentials, setSessionLoginCredentials, getAllInstanceCredentials } from "../utils/sessionLogin.store";
import { buildApplicantFormPageScript } from "./applicantDetailsFormClientScript";
import { buildMonitorTabHtml } from "./monitorTab";
import type { MonitorHooks } from "../monitoring/status.types";

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
  if (collectLogin) {
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
    if (err) logger.warn({ err }, "Could not open browser for applicant form; open URL manually");
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
  if (typeof out.helloVerifyNumber === "string") {
    const digits = out.helloVerifyNumber.replace(/\D/g, "").slice(0, 6);
    if (digits.length > 0) out.helloVerifyNumber = digits;
    else delete out.helloVerifyNumber;
  }
  return out;
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

  const defaultPollIntervalSec = 60;

  const instanceSelectBlock = `
  <fieldset style="border:1px solid #38444d;border-radius:8px;padding:1rem 1rem 0.25rem;margin:0 0 1.25rem">
    <legend style="color:#8b98a5;font-size:0.9rem">Bot configuration</legend>
    <label for="countryCode" style="margin-top:0.5rem">From country</label>
    <select id="countryCode" name="countryCode">
      <option value="ind">India</option>
      <option value="egy">Egypt</option>
      <option value="sau">Saudi Arabia</option>
      <option value="uzb">Uzbekistan</option>
    </select>
    <label for="missionCode" style="margin-top:0.75rem">To country</label>
    <select id="missionCode" name="missionCode">
      <option value="bgr">Bulgaria</option>
      <option value="lva">Latvia</option>
      <option value="prt">Portugal</option>
    </select>
    <label for="userPollInterval" style="margin-top:0.75rem">Poll interval (seconds)</label>
    <input type="number" id="userPollInterval" name="userPollInterval" min="1" value="${defaultPollIntervalSec}" />
    <label for="postLoginPollDelay" style="margin-top:0.75rem">Post-login poll delay (seconds)</label>
    <input type="number" id="postLoginPollDelay" name="postLoginPollDelay" min="0" value="30" />
    <label for="numInstances">Number of instances</label>
    <input type="number" id="numInstances" name="numInstances" min="1" max="100" value="1" />
    <label for="staggerIntervalSec" style="margin-top:0.75rem">Start interval between bots (seconds)</label>
    <input type="number" id="staggerIntervalSec" name="staggerIntervalSec" min="0" max="120" value="6" />
    <div id="instanceSelectWrapper" style="display:block">
      <label for="instanceId" style="margin-top:0.75rem">Select instance to configure (each uses a different Chrome profile / IP)</label>
      <select id="instanceId" name="instanceId">
        <option value="1">Instance 1</option>
      </select>
    </div>
  </fieldset>`;

  const loginBlock = collectLogin
    ? `
  <fieldset style="border:1px solid #38444d;border-radius:8px;padding:1rem 1rem 0.25rem;margin:0 0 1.25rem">
    <legend style="color:#8b98a5;font-size:0.9rem">VFS login</legend>
    <p class="hint" style="margin-top:0">Used to sign in on the VFS portal in Chrome.</p>
    <label for="vfsUsername">Email / username</label>
    <input id="vfsUsername" name="vfsUsername" type="email" autocomplete="username" />
    <label for="vfsPassword">Password</label>
    <input id="vfsPassword" name="vfsPassword" type="text" autocomplete="current-password" />
    <p class="hint" style="margin-top:0.75rem">Second VFS account (optional). If both are set, the bot alternates: after each poll relogin it logs out, closes Chrome, opens a new browser (each Chrome launch uses the next <code>PROXY_URLS</code> entry for this profile), then logs in with the other account (unless <code>VFS_CREDENTIAL_SWAP_BROWSER_RESTART=false</code>).</p>
    <label for="vfsUsername2">Email / username (account 2)</label>
    <input id="vfsUsername2" name="vfsUsername2" type="email" autocomplete="off" />
    <label for="vfsPassword2">Password (account 2)</label>
    <input id="vfsPassword2" name="vfsPassword2" type="text" autocomplete="off" />
  </fieldset>`
    : "";

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
    #tab-configure { max-width: 1040px; margin: 0 auto; }
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
    .form-actions { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid #38444d; display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
    button[type="submit"] { margin-top: 0; flex: 1; min-width: 8rem; }
    #forceBookBtn { margin-top: 0; flex: 1; min-width: 8rem; background: #f5a623; color: #15202b; font-weight: 700; }
    #testApplicantsApiBtn { display: block; }
    button { width: 100%; padding: 0.65rem; border: none; border-radius: 8px;
      background: #1d9bf0; color: #fff; font-weight: 600; cursor: pointer; font-size: 1rem; }
    button:hover { filter: brightness(1.08); }
    button.btn-inline { margin-top: 0; width: auto; padding: 0.5rem 0.9rem; font-size: 0.9rem; }
    button.btn-secondary { margin-top: 0.6rem; width: auto; background: #38444d; color: #e7e9ea; font-size: 0.85rem; padding: 0.45rem 0.75rem; }
    button.btn-secondary:hover { filter: brightness(1.12); }
    .date-chips { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.25rem; min-height: 2rem; }
    .date-chip { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.3rem 0.55rem; background: #253341; border-radius: 999px; font-size: 0.88rem; border: 1px solid #38444d; }
    .date-chip-remove { margin: 0; padding: 0 0.2rem; width: auto; min-width: 0; background: transparent; color: #8b98a5; font-size: 1.15rem; line-height: 1; font-weight: 400; }
    .date-chip-remove:hover { color: #f4212e; filter: none; }
    .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .section-rule { margin: 1.25rem 0; border: none; border-top: 1px solid #38444d; }
    .section-title { margin: 0 0 0.5rem; font-size: 0.92rem; font-weight: 600; color: #c4cdd4; }
    .ok { color: #00ba7c; margin-top: 1rem; }
    .err { color: #f4212e; margin-top: 1rem; }
    .tabbar { display: flex; gap: 0.35rem; border-bottom: 1px solid #38444d; margin-bottom: 1.25rem; }
    .tabbtn { width: auto; margin: 0; background: transparent; color: #8b98a5; border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 0.6rem 1rem; font-size: 0.95rem; font-weight: 600; }
    .tabbtn:hover { filter: none; color: #e7e9ea; }
    .tabbtn.active { color: #1d9bf0; border-bottom-color: #1d9bf0; }
    .tabpanel[hidden] { display: none; }
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
      </div>
      <div class="form-col form-col--details">
        <h2 class="col-heading">Applicant details</h2>
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
          <div class="row2">
            <div>
              <label for="dateOfBirth">Date of birth (DD/MM/YYYY)</label>
              <input id="dateOfBirth" name="dateOfBirth" placeholder="15/06/1990" />
            </div>
            <div>
              <label for="passportNumber">Passport number</label>
              <input id="passportNumber" name="passportNumber" placeholder="A12345678" />
            </div>
          </div>
          <div class="row2">
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
        ${scheduleDateRangeRow}
        <label for="passportExpirtyDate">Passport expiry (DD/MM/YYYY)</label>
        <input id="passportExpirtyDate" name="passportExpirtyDate" placeholder="23/04/2027" />
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
        <label for="gender">Gender</label>
        <select id="gender" name="gender">
          <option value="1">MALE</option>
          <option value="2">FEMALE</option>
        </select>
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

        <hr class="section-rule" />
        <h3 class="section-title">Center 2 (optional)</h3>
        <p class="hint" style="margin-bottom:1rem">Leave empty to poll only Center 1</p>

        <label for="vacCode2">Visa Application Centre 2 (Optional)</label>
        <select id="vacCode2" name="vacCode2">
          <option value="">-- No Second Centre --</option>
        </select>
        <label for="selectedSubvisaCategory2">Visa Category 2 (Optional)</label>
        <select id="selectedSubvisaCategory2" name="selectedSubvisaCategory2">
          <option value="">-- Select Category --</option>
        </select>
      </div>
    </div>
    <div class="form-actions">
      <button type="submit" id="submitBtn">Submit &amp; Run</button>
      <button type="button" id="forceBookBtn">Book Slot</button>
      <button type="button" id="testApplicantsApiBtn">Test applicants API</button>
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

/** One bot instance’s outcome for POST `appointment/applicants` (test button). */
export type TestApplicantsApiInstanceResult =
  | { instanceId: number; ok: true; status: number; bodyPreview: string }
  | { instanceId: number; ok: false; error: string };

/** Response: every running instance runs the lift-api applicants POST (cluster: one Chrome each). */
export type TestApplicantsApiBatchResult = {
  results: TestApplicantsApiInstanceResult[];
};

export type ApplicantFormOptions = {
  /**
   * When true (default), form includes VFS username/password and stores them before `loginOnFirstTab`.
   * Use false for e.g. slot-found flow when already logged in (applicant fields only).
   */
  collectLogin?: boolean;
  /** Called when user clicks "Book Slot" — triggers force-booking on all instances. */
  onForceBook?: () => { ok: boolean; error?: string; queued?: number };
  /**
   * Called when user clicks "Test applicants API" — each running instance POSTs lift-api applicants
   * from its own logged-in Chrome tab (cluster); single-process returns one result row.
   */
  onTestApplicantsApi?: () => Promise<TestApplicantsApiBatchResult>;
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
      if (i > 0) {
        logger.warn(
          { requestedPort: preferredPort, boundPort: tryPort },
          "Setup form port was in use; using next free port"
        );
      }
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
  const onTestApplicantsApi = options?.onTestApplicantsApi;

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
              if (action === "stagger") {
                const ms = toNum(mj.intervalMs);
                json(res, 200, monitor.setStaggerInterval(Number.isFinite(ms) ? ms : 6000));
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
            if (globalDet && typeof globalDet.postLoginPollDelay === "number") {
              defaults.postLoginPollDelay = globalDet.postLoginPollDelay;
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

          if (collectLogin) {
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
          const { userPollInterval: upi, postLoginPollDelay: plpd, staggerIntervalSec: sis, ...instanceFields } = fields;

          {
            const global0 = getApplicantDetailsOverrides(0) ?? {};
            let changed = false;
            if (typeof upi === "number") { global0.userPollInterval = upi; changed = true; }
            if (typeof plpd === "number") { global0.postLoginPollDelay = plpd; changed = true; }
            if (typeof sis === "number") { global0.staggerIntervalSec = sis; changed = true; }
            if (typeof instanceFields.countryCode === "string") { global0.countryCode = instanceFields.countryCode; changed = true; }
            if (typeof instanceFields.missionCode === "string") { global0.missionCode = instanceFields.missionCode; changed = true; }
            if (changed) setApplicantDetailsOverrides(global0, 0);
          }
          const id = instanceId ?? 0;
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
            if (creds && dets) validInstanceIds.push(instanceId);
          }

          const actualInstanceCount = validInstanceIds.length;
          if (actualInstanceCount === 0) {
            json(res, 400, { ok: false, error: "No instances have both credentials and details saved. Use Save button first." });
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
              .catch((err) => logger.error({ err, instanceId }, "Form onSubmit handler failed"));
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

        if (req.method === "POST" && path === "/api/test-applicants") {
          if (!onTestApplicantsApi) {
            json(res, 400, { ok: false, error: "Test applicants API not available in this mode." });
            return;
          }
          try {
            const result = await onTestApplicantsApi();
            json(res, 200, result);
          } catch (e) {
            json(res, 500, {
              results: [],
              error: e instanceof Error ? e.message : String(e),
            });
          }
          return;
        }

        res.writeHead(404);
        res.end();
      } catch (e) {
        logger.error({ e }, "Applicant UI server error");
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
        console.log("\n  >>> Bot setup form: " + url + "\n");
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

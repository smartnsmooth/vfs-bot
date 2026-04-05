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
const UI_DISABLED = process.env.VFS_APPLICANT_UI === "false";

export function isApplicantFormUiDisabled(): boolean {
  return UI_DISABLED;
}

export function applicantUiPort(): number {
  const p = parseInt(process.env.VFS_APPLICANT_UI_PORT ?? "3847", 10);
  return Number.isFinite(p) && p > 0 && p < 65536 ? p : 3847;
}

/** Base URL for the local setup form (same host the browser uses for Submit → `/api/submit`). */
export function getApplicantFormServerOrigin(): string {
  return `http://127.0.0.1:${applicantUiPort()}`;
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

/**
 * Returns the UI timeout in ms.  0 means "no timeout" (server stays up forever).
 * Default is 0 so the form server never auto-closes while the bot is running.
 */
function applicantUiTimeoutMs(): number {
  const raw = process.env.VFS_APPLICANT_UI_TIMEOUT_MS;
  if (!raw) return 0; // no env var → run forever
  const t = parseInt(raw, 10);
  return Number.isFinite(t) && t > 0 ? t : 0;
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
  if (process.env.VFS_APPLICANT_UI_OPEN_BROWSER === "false") return;
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
  if ("scheduleAllowedDates" in j) {
    const v = j.scheduleAllowedDates;
    out.scheduleAllowedDates =
      typeof v === "string" ? v : Array.isArray(v) ? v.map((x) => String(x)).join("\n") : "";
  }
  if (typeof j.gender === "number" && Number.isFinite(j.gender)) {
    out.gender = j.gender;
  } else if (typeof j.gender === "string" && j.gender.trim() !== "") {
    out.gender = parseInt(j.gender, 10);
  }
  return out;
}

function buildPageHtml(collectLogin: boolean): string {
  const defaultNumInstances = Math.max(1, parseInt(process.env.VFS_BOT_INSTANCES ?? "1", 10) || 1);
  const isMultiInstance = defaultNumInstances > 1;
  const fastSkipCalendarUpTo =
    parseInt(process.env.FAST_SKIP_CALENDAR_UP_TO_INSTANCE ?? "5", 10) || 5;

  /** Per-instance date range row in the applicant column. */
  const scheduleAllowedDatesBlock = `
  <div class="schedule-range-row" role="group" aria-label="Appointment date range">
    <label for="scheduleDateRangeStart">From</label>
    <input type="date" id="scheduleDateRangeStart" name="scheduleDateRangeStart" />
    <label for="scheduleDateRangeEnd">To</label>
    <input type="date" id="scheduleDateRangeEnd" name="scheduleDateRangeEnd" />
  </div>`;

  const instanceSelectBlock = `
  <fieldset style="border:1px solid #38444d;border-radius:8px;padding:1rem 1rem 0.25rem;margin:0 0 1.25rem">
    <legend style="color:#8b98a5;font-size:0.9rem">Bot configuration</legend>
    <label for="numInstances">Number of instances</label>
    <input type="number" id="numInstances" name="numInstances" min="1" max="50" value="${defaultNumInstances}" />
    <div id="instanceSelectWrapper" style="display:block">
      <label for="instanceId" style="margin-top:0.75rem">Select instance to configure (each uses a different Chrome profile / IP)</label>
      <select id="instanceId" name="instanceId">
        ${Array.from({ length: defaultNumInstances }, (_, i) => `<option value="${i + 1}">Instance ${i + 1}</option>`).join("\n        ")}
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
  const isMultiInstanceJs = isMultiInstance ? "true" : "false";
  const defaultNumInstancesJs = String(defaultNumInstances);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root { font-family: system-ui, sans-serif; background: #0f1419; color: #e7e9ea; }
    body { max-width: 1040px; margin: 2rem auto; padding: 0 1.25rem; }
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
    .form-actions { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid #38444d; }
    button[type="submit"] { margin-top: 0; }
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
  </style>
</head>
<body>
  <form id="f">
    <div class="form-layout">
      <div class="form-col form-col--setup">
        ${instanceSelectBlock}
        ${loginBlock}
      </div>
      <div class="form-col form-col--details">
        <h2 class="col-heading">Applicant details</h2>
        <p class="col-sub">Passport expiry, nationality, gender, and visa centre / category. Name, email, phone, DOB, and passport number come from the VFS login response after sign-in.</p>
        ${scheduleAllowedDatesBlock}
        <label for="passportExpirtyDate">Passport expiry (DD/MM/YYYY)</label>
        <input id="passportExpirtyDate" name="passportExpirtyDate" placeholder="23/04/2027" />
        <label for="nationalityCode">Nationality (ISO 3166-1 alpha-3, e.g. IND, USA, GBR)</label>
        <input id="nationalityCode" name="nationalityCode" maxlength="3" autocapitalize="characters" autocomplete="off" placeholder="IND" />
        <label for="gender">Gender</label>
        <select id="gender" name="gender">
          <option value="1">MALE</option>
          <option value="2">FEMALE</option>
        </select>
        <label for="vacCode">Visa Application Centre</label>
        <select id="vacCode" name="vacCode">
          <option value="">-- Select Centre --</option>
          <option value="JAI">Bulgaria Visa Application Centre-Jaipur</option>
          <option value="HYD">Bulgaria Visa Application Centre-Hyderabad</option>
          <option value="JLD">Bulgaria Visa Application Centre-Jalandhar</option>
          <option value="BLR">Bulgaria Visa Application Center ,Bangalore</option>
          <option value="IXC">Bulgaria Visa Application Centre-Chandigarh</option>
          <option value="PNQ">Bulgaria Visa Application Centre-Pune</option>
          <option value="COK">Bulgaria Visa Application Centre-Cochin</option>
          <option value="GOI">Bulgaria Visa Application Centre-Goa</option>
          <option value="AMD">Bulgaria Visa Application Centre-Ahmedabad</option>
          <option value="PUD">Bulgaria Visa Application Centre-Puducherry</option>
          <option value="GUR">Bulgaria Visa Application Center ,Gurugram</option>
          <option value="NDEL">Bulgaria Visa Application Center ,New Delhi</option>
          <option value="BKC">Bulgaria Visa Application Center, Mumbai</option>
          <option value="MAA">Bulgaria Visa Application Centre-Chennai</option>
          <option value="CCU">Bulgarian visa application center-Kolkata-VAC</option>
        </select>
        <label for="selectedSubvisaCategory">Visa Category (Center 1)</label>
        <select id="selectedSubvisaCategory" name="selectedSubvisaCategory">
          <option value="">-- Select Category --</option>
          <option value="LONGSTAY">Long Stay D visa</option>
          <option value="SAW">Seasonal worker</option>
          <option value="Busi">Business Visa</option>
        </select>

        <hr class="section-rule" />
        <h3 class="section-title">Center 2 (optional)</h3>
        <p class="hint" style="margin-bottom:1rem">Leave empty to poll only Center 1</p>

        <label for="vacCode2">Visa Application Centre 2 (Optional)</label>
        <select id="vacCode2" name="vacCode2">
          <option value="">-- No Second Centre --</option>
          <option value="JAI">Bulgaria Visa Application Centre-Jaipur</option>
          <option value="HYD">Bulgaria Visa Application Centre-Hyderabad</option>
          <option value="JLD">Bulgaria Visa Application Centre-Jalandhar</option>
          <option value="BLR">Bulgaria Visa Application Center ,Bangalore</option>
          <option value="IXC">Bulgaria Visa Application Centre-Chandigarh</option>
          <option value="PNQ">Bulgaria Visa Application Centre-Pune</option>
          <option value="COK">Bulgaria Visa Application Centre-Cochin</option>
          <option value="GOI">Bulgaria Visa Application Centre-Goa</option>
          <option value="AMD">Bulgaria Visa Application Centre-Ahmedabad</option>
          <option value="PUD">Bulgaria Visa Application Centre-Puducherry</option>
          <option value="GUR">Bulgaria Visa Application Center ,Gurugram</option>
          <option value="NDEL">Bulgaria Visa Application Center ,New Delhi</option>
          <option value="BKC">Bulgaria Visa Application Center, Mumbai</option>
          <option value="MAA">Bulgaria Visa Application Centre-Chennai</option>
          <option value="CCU">Bulgarian visa application center-Kolkata-VAC</option>
        </select>
        <label for="selectedSubvisaCategory2">Visa Category 2 (Optional)</label>
        <select id="selectedSubvisaCategory2" name="selectedSubvisaCategory2">
          <option value="">-- Select Category --</option>
          <option value="LONGSTAY">Long Stay D visa</option>
          <option value="SAW">Seasonal worker</option>
          <option value="Busi">Business Visa</option>
        </select>
      </div>
    </div>
    <div class="form-actions">
      <button type="submit" id="submitBtn">${isMultiInstance ? "Submit & Run All Instances" : "Submit & Run Bot"}</button>
    </div>
  </form>
  <p id="msg"></p>
  ${buildApplicantFormPageScript(collectLoginJs, isMultiInstanceJs, defaultNumInstancesJs)}
</body>
</html>`;
}

export type ApplicantFormOptions = {
  /**
   * When true (default), form includes VFS username/password and stores them before `loginOnFirstTab`.
   * Use false for e.g. slot-found flow when already logged in (applicant fields only).
   */
  collectLogin?: boolean;
};

export type FormSubmitInfo = { firstSubmit: boolean;[key: string]: unknown };

function applicantUiPortFallbackAttempts(): number {
  const n = parseInt(process.env.VFS_APPLICANT_UI_PORT_TRY ?? "20", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(100, n) : 20;
}

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
 * Sets `process.env.VFS_APPLICANT_UI_PORT` to the bound port so {@link getApplicantFormServerOrigin} matches.
 */
async function bindApplicantFormServerToFreePort(server: Server, host: string, preferredPort: number): Promise<number> {
  const maxTries = applicantUiPortFallbackAttempts();
  for (let i = 0; i < maxTries; i++) {
    const tryPort = preferredPort + i;
    if (tryPort > 65535) break;
    try {
      await listenOnce(server, tryPort, host);
      if (i > 0) {
        logger.warn(
          { requestedPort: preferredPort, boundPort: tryPort },
          "Applicant UI port was in use; using next free port (close the other bot/cluster or set VFS_APPLICANT_UI_PORT)"
        );
      }
      process.env.VFS_APPLICANT_UI_PORT = String(tryPort);
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
    `Could not bind applicant UI: ports ${preferredPort}–${preferredPort + maxTries - 1} are in use. Stop the other process or set VFS_APPLICANT_UI_PORT to a free port.`
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

  if (UI_DISABLED) {
    logger.info("Applicant UI disabled (VFS_APPLICANT_UI=false); using .env / VFS_APPLICANTS_JSON only");
    return Promise.reject(new Error("Applicant form UI disabled; use run without form handler"));
  }

  const preferredPort = applicantUiPort();
  const host = "127.0.0.1";

  return new Promise<never>((_resolve, reject) => {
    let settled = false;
    let seenSubmit = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = (): void => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
    const safeReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      reject(err);
    };

    const server = createServer(async (req, res) => {
      try {
        const u = new URL(req.url ?? "/", `http://${host}`);
        const path = u.pathname;

        if (req.method === "GET" && path === "/") {
          html(res, buildPageHtml(collectLogin));
          return;
        }

        if (req.method === "GET" && path === "/api/defaults") {
          try {
            const numInstances = parseInt(process.env.VFS_BOT_INSTANCES ?? "1", 10) || 1;
            const defaults: Record<string, unknown> = { ...getApplicantFormDefaults() };

            // Single-instance UX: the form has no instance selector, but data is still saved per instance ID.
            // Prefer instance 1 (cluster) and fall back to instance 0.
            if (numInstances <= 1) {
              const det1 = getApplicantDetailsOverrides(1);
              const det0 = getApplicantDetailsOverrides(0);
              const det = det1 ?? det0;
              if (det) Object.assign(defaults, det);
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
          const id = instanceId ?? 0;
          setApplicantDetailsOverrides(fields, id);

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

          // Prefer the numInstances value the user set in the form; fall back to env.
          const submittedNumInstances =
            typeof j.numInstances === "number" && j.numInstances > 0
              ? Math.floor(j.numInstances)
              : parseInt(process.env.VFS_BOT_INSTANCES ?? "1", 10) || 1;

          // In cluster / multi-instance mode, start ALL saved instances up to the chosen count.
          if (submittedNumInstances > 1) {
            const credentials = getAllInstanceCredentials();
            const details = getAllInstanceApplicantDetails();
            const allIds = new Set([...credentials.keys(), ...details.keys()]);

            if (allIds.size === 0) {
              json(res, 400, { ok: false, error: "No saved instances. Use Save button first to save data for each instance." });
              return;
            }

            let queued = 0;
            for (const instanceId of allIds) {
              // Instance 0 is a global/shared store slot, not a real bot instance
              if (instanceId === 0) continue;
              // Only submit for instances within the chosen count
              if (instanceId > submittedNumInstances) {
                continue;
              }

              const creds = credentials.get(instanceId);
              const dets = details.get(instanceId);

              if (creds && dets) {
                void Promise.resolve(onSubmit({
                  firstSubmit: !seenSubmit,
                  instanceId,
                  numInstances: submittedNumInstances,
                  ...creds,
                  ...dets
                }))
                  .then(() => undefined)
                  .catch((err) => logger.error({ err, instanceId }, "Form onSubmit handler failed"));
                queued++;
              }
            }

            seenSubmit = true;
            json(res, 200, { ok: true, firstSubmit: !seenSubmit, queued });
            return;
          }

          // Single instance mode (legacy)
          const instanceId = typeof j.instanceId === "number" ? j.instanceId : undefined;

          if (collectLogin) {
            const vu = typeof j.vfsUsername === "string" ? j.vfsUsername.trim() : "";
            const vp = typeof j.vfsPassword === "string" ? j.vfsPassword : "";
            if (!vu || !vp) {
              json(res, 400, { ok: false, error: "VFS username and password are required" });
              return;
            }
            setSessionLoginCredentials(vu, vp, instanceId, readSecondCredentialAction(j));
          }

          const {
            vfsUsername: _u,
            vfsPassword: _p,
            vfsUsername2: _ux2,
            vfsPassword2: _px2,
            instanceId: _id,
            ...rest
          } = j;
          const fields = parseApplicantFields(rest);
          if (!fields.passportExpirtyDate || !fields.vacCode || !fields.selectedSubvisaCategory || !fields.nationalityCode) {
            json(res, 400, {
              ok: false,
              error: "passport expiry, nationality, visa centre (VAC), and visa category are required",
            });
            return;
          }
          setApplicantDetailsOverrides(fields, instanceId ?? 0);
          const firstSubmit = !seenSubmit;
          seenSubmit = true;
          json(res, 200, { ok: true, firstSubmit });
          void Promise.resolve(onSubmit({ firstSubmit, instanceId, ...j }))
            .then(() => undefined)
            .catch((err) => logger.error({ err }, "Form onSubmit handler failed"));
          logger.info({ firstSubmit, instanceId }, "Setup form submitted — onSubmit queued");
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
        const url = `http://${host}:${boundPort}/`;
        server.on("error", (err) => {
          server.close(() => { });
          safeReject(err);
        });
        console.log("\n  >>> Bot setup form: " + url + "\n");
        openUrlInBrowser(url);
        const uiTimeoutMs = applicantUiTimeoutMs();
        if (uiTimeoutMs > 0) {
          timeoutId = setTimeout(() => {
            server.close(() => { });
            safeReject(
              new Error(
                `Applicant UI timed out after ${uiTimeoutMs}ms. Submit the form or set VFS_APPLICANT_UI=false to skip.`
              )
            );
          }, uiTimeoutMs);
        }
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
  if (UI_DISABLED) return Promise.resolve();
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

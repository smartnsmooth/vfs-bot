import { exec } from "node:child_process";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config/config";
import { getApplicantFormDefaults } from "../config/saveApplicants";
import { logger } from "../utils/logger";
import {
  getApplicantDetailsOverrides,
  setApplicantDetailsOverrides,
  getAllInstanceApplicantDetails,
  mergeGlobalScheduleAllowedDatesFromPayload,
  omitGlobalScheduleFields,
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
  const ov = getApplicantDetailsOverrides();
  const base: Record<string, unknown> = { ...defaults };
  if (ov) Object.assign(base, ov);
  const g = base.gender;
  if (typeof g === "string" && g.trim() !== "") {
    base.gender = parseInt(g, 10);
  } else if (typeof g !== "number" || !Number.isFinite(g)) {
    base.gender = 2;
  }
  const fn = base.firstName;
  const ln = base.lastName;
  const pp = base.passportNumber;
  if (typeof fn !== "string" || !fn.trim() || typeof ln !== "string" || !ln.trim() || typeof pp !== "string" || !pp.trim()) {
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
    "firstName",
    "lastName",
    "middleName",
    "emailId",
    "contactNumber",
    "dialCode",
    "dateOfBirth",
    "passportNumber",
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
  if (typeof out.emailId === "string") {
    out.emailId = out.emailId.toUpperCase();
  }
  return out;
}

function buildPageHtml(collectLogin: boolean): string {
  const numInstances = parseInt(process.env.VFS_BOT_INSTANCES ?? "1", 10);
  const isMultiInstance = numInstances > 1;
  const fastSkipCalendarUpTo =
    parseInt(process.env.FAST_SKIP_CALENDAR_UP_TO_INSTANCE ?? "5", 10) || 5;

  /** Placed above instance selection so it reads as global, not per-instance. */
  const scheduleAllowedDatesBlock = `
  <fieldset style="border:1px solid #38444d;border-radius:8px;padding:1rem 1rem 0.25rem;margin:0 0 1.25rem">
    <legend style="color:#8b98a5;font-size:0.9rem">Allowed appointment dates (optional)</legend>
    <p class="hint" style="margin-top:0">Shared by every instance. Pick a date (it stays in the box after it is added); use another day or <strong>Add date</strong> for more. Remove chips with ×. If polling hits one of these dates, instances 1–${fastSkipCalendarUpTo} skip the calendar and book that date; others still call the calendar but only keep allow-listed dates. Leave the list empty to disable.</p>
    <label for="scheduleDatePicker">Pick a date</label>
    <div class="picker-row">
      <input type="date" id="scheduleDatePicker" />
      <button type="button" class="btn-inline" id="scheduleDateAddBtn">Add date</button>
    </div>
    <p class="hint" style="margin-top:0.75rem;margin-bottom:0.35rem">Selected dates</p>
    <div id="scheduleAllowedDatesChips" class="date-chips" aria-live="polite"></div>
    <button type="button" class="btn-secondary btn-inline" id="scheduleDatesClearBtn">Clear all</button>
    <textarea name="scheduleAllowedDates" id="scheduleAllowedDatesHidden" class="sr-only" autocomplete="off" tabindex="-1" aria-hidden="true"></textarea>
  </fieldset>`;

  const instanceSelectBlock = isMultiInstance
    ? `
  <fieldset style="border:1px solid #38444d;border-radius:8px;padding:1rem 1rem 0.25rem;margin:0 0 1.25rem">
    <legend style="color:#8b98a5;font-size:0.9rem">Bot Instance</legend>
    <label for="instanceId">Select instance (each uses different IP)</label>
    <select id="instanceId" name="instanceId">
      ${Array.from({ length: numInstances }, (_, i) => `<option value="${i + 1}">Instance ${i + 1}</option>`).join("\n      ")}
    </select>
  </fieldset>`
    : "";

  const loginBlock = collectLogin
    ? `
  <fieldset style="border:1px solid #38444d;border-radius:8px;padding:1rem 1rem 0.25rem;margin:0 0 1.25rem">
    <legend style="color:#8b98a5;font-size:0.9rem">VFS login</legend>
    <p class="hint" style="margin-top:0">Used to sign in on the VFS portal in Chrome.</p>
    <label for="vfsUsername">Email / username</label>
    <input id="vfsUsername" name="vfsUsername" type="email" autocomplete="username" />
    <label for="vfsPassword">Password</label>
    <input id="vfsPassword" name="vfsPassword" type="text" autocomplete="current-password" />
  </fieldset>`
    : "";

  const title = collectLogin ? "VFS bot — login & applicant" : "VFS bot — applicant details";
  const hint = collectLogin
    ? "Each Submit: reconnect to Chrome, then open login if the tab is blank, log in if you are on the login page, or go straight to polling from dashboard / application pages. Submit again anytime for another run."
    : "Each Submit runs the flow from your current Chrome tab (blank → login URL, login page → sign-in, else polling).";

  const collectLoginJs = collectLogin ? "true" : "false";
  const isMultiInstanceJs = isMultiInstance ? "true" : "false";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root { font-family: system-ui, sans-serif; background: #0f1419; color: #e7e9ea; }
    body { max-width: 520px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p.hint { color: #8b98a5; font-size: 0.9rem; margin-top: 0; }
    label { display: block; margin-top: 0.75rem; font-size: 0.85rem; color: #8b98a5; }
    input, select, textarea { width: 100%; box-sizing: border-box; margin-top: 0.25rem; padding: 0.5rem 0.6rem;
      border-radius: 8px; border: 1px solid #38444d; background: #15202b; color: #e7e9ea; font: inherit; }
    textarea { min-height: 6rem; resize: vertical; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    .picker-row { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; margin-top: 0.25rem; }
    .picker-row input[type="date"] { margin-top: 0; max-width: 11rem; flex: 1 1 auto; min-width: 0; }
    button { margin-top: 1.25rem; width: 100%; padding: 0.65rem; border: none; border-radius: 8px;
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
    .ok { color: #00ba7c; margin-top: 1rem; }
    .err { color: #f4212e; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>${collectLogin ? "Setup" : "Applicant details"}</h1>
  <p class="hint">${hint}</p>
  <form id="f">
    ${scheduleAllowedDatesBlock}
    ${instanceSelectBlock}
    ${loginBlock}
    <div class="row2">
      <div><label for="firstName">First name</label><input id="firstName" name="firstName" autocomplete="given-name" /></div>
      <div><label for="lastName">Last name</label><input id="lastName" name="lastName" autocomplete="family-name" /></div>
    </div>
    <label for="emailId">Email</label>
    <input id="emailId" name="emailId" type="email" autocomplete="email" />
    <div class="row2">
      <div><label for="dialCode">Dial code</label><input id="dialCode" name="dialCode" /></div>
      <div><label for="contactNumber">Phone</label><input id="contactNumber" name="contactNumber" /></div>
    </div>
    <label for="dateOfBirth">Date of birth (DD/MM/YYYY)</label>
    <input id="dateOfBirth" name="dateOfBirth" placeholder="09/03/1988" />
    <div class="row2">
      <div><label for="passportNumber">Passport number</label><input id="passportNumber" name="passportNumber" /></div>
      <div><label for="passportExpirtyDate">Passport expiry (DD/MM/YYYY)</label><input id="passportExpirtyDate" name="passportExpirtyDate" /></div>
    </div>
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
    
    <hr style="margin: 1.5rem 0; border: none; border-top: 2px solid #ddd;" />
    <h3 style="margin-bottom: 0.75rem; color: #555;">Center 2 (Optional)</h3>
    <p style="margin-top: 0; margin-bottom: 1rem; font-size: 0.9rem; color: #666;">Leave empty to poll only Center 1</p>
    
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
    <button type="submit" style="margin-top: 1.25rem; width: 100%;">${isMultiInstance ? "Submit & Run All Instances" : "Submit & Run Bot"}</button>
  </form>
  <p id="msg"></p>
  ${buildApplicantFormPageScript(collectLoginJs, isMultiInstanceJs)}
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

  const port = applicantUiPort();
  const host = "127.0.0.1";
  const url = `http://${host}:${port}/`;

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
              if (det) Object.assign(defaults, omitGlobalScheduleFields(det));
            }

            const shared0 = getApplicantDetailsOverrides(0);
            const sad = shared0?.scheduleAllowedDates;
            if (sad != null && String(sad).trim()) {
              defaults.scheduleAllowedDates = Array.isArray(sad) ? sad.join("\n") : String(sad);
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
              // Only save credentials if both are provided
              setSessionLoginCredentials(vu, vp, instanceId);
            }
          }

          const { vfsUsername: _u, vfsPassword: _p, instanceId: _id, ...rest } = j;
          const fields = parseApplicantFields(rest);
          const id = instanceId;
          if (id !== undefined && id !== 0) {
            setApplicantDetailsOverrides(omitGlobalScheduleFields(fields), id);
          } else {
            setApplicantDetailsOverrides(fields, id);
          }
          mergeGlobalScheduleAllowedDatesFromPayload(j);

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

          // In cluster mode, start ALL instances with saved data
          const numInstances = parseInt(process.env.VFS_BOT_INSTANCES ?? "1", 10);
          if (numInstances > 1) {
            mergeGlobalScheduleAllowedDatesFromPayload(j);
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
              // Only submit for instances that are actually running (1 to numInstances)
              if (instanceId > numInstances) {
                continue;
              }

              const creds = credentials.get(instanceId);
              const dets = details.get(instanceId);

              if (creds && dets) {
                void Promise.resolve(onSubmit({
                  firstSubmit: !seenSubmit,
                  instanceId,
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
            setSessionLoginCredentials(vu, vp, instanceId);
          }

          const { vfsUsername: _u, vfsPassword: _p, instanceId: _id, ...rest } = j;
          const fields = parseApplicantFields(rest);
          if (!fields.firstName || !fields.lastName || !fields.passportNumber) {
            json(res, 400, { ok: false, error: "firstName, lastName, and passportNumber are required" });
            return;
          }
          setApplicantDetailsOverrides(fields, instanceId);
          mergeGlobalScheduleAllowedDatesFromPayload(j);
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

    server.listen(port, host, () => {
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
    });

    server.on("error", (err) => {
      server.close(() => { });
      safeReject(err);
    });
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

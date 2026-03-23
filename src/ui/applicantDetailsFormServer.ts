import { exec } from "node:child_process";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config/config";
import { getApplicantFormDefaults } from "../config/saveApplicants";
import { logger } from "../utils/logger";
import { getApplicantDetailsOverrides, setApplicantDetailsOverrides } from "../utils/applicantDetails.store";
import { getSessionLoginCredentials, setSessionLoginCredentials } from "../utils/sessionLogin.store";
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

function applicantUiTimeoutMs(): number {
  const t = parseInt(process.env.VFS_APPLICANT_UI_TIMEOUT_MS ?? "1800000", 10);
  return Number.isFinite(t) && t > 0 ? t : 1_800_000;
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
  ] as const;
  for (const k of keys) {
    const v = str(k);
    if (v !== undefined && v !== null && String(v) !== "") out[k] = v;
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
  const loginBlock = collectLogin
    ? `
  <fieldset style="border:1px solid #38444d;border-radius:8px;padding:1rem 1rem 0.25rem;margin:0 0 1.25rem">
    <legend style="color:#8b98a5;font-size:0.9rem">VFS login</legend>
    <p class="hint" style="margin-top:0">Used to sign in on the VFS portal in Chrome.</p>
    <label for="vfsUsername">Email / username</label>
    <input id="vfsUsername" name="vfsUsername" type="email" autocomplete="username" />
    <label for="vfsPassword">Password</label>
    <input id="vfsPassword" name="vfsPassword" type="password" autocomplete="current-password" />
  </fieldset>`
    : "";

  const title = collectLogin ? "VFS bot — login & applicant" : "VFS bot — applicant details";
  const hint = collectLogin
    ? "Each Submit: reconnect to Chrome, then open login if the tab is blank, log in if you are on the login page, or go straight to polling from dashboard / application pages. Submit again anytime for another run."
    : "Each Submit runs the flow from your current Chrome tab (blank → login URL, login page → sign-in, else polling).";

  const collectLoginJs = collectLogin ? "true" : "false";

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
    input, select { width: 100%; box-sizing: border-box; margin-top: 0.25rem; padding: 0.5rem 0.6rem;
      border-radius: 8px; border: 1px solid #38444d; background: #15202b; color: #e7e9ea; }
    button { margin-top: 1.25rem; width: 100%; padding: 0.65rem; border: none; border-radius: 8px;
      background: #1d9bf0; color: #fff; font-weight: 600; cursor: pointer; font-size: 1rem; }
    button:hover { filter: brightness(1.08); }
    .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .ok { color: #00ba7c; margin-top: 1rem; }
    .err { color: #f4212e; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>${collectLogin ? "Setup" : "Applicant details"}</h1>
  <p class="hint">${hint}</p>
  <form id="f">
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
    <label for="confirmPassportNumber">Confirm passport (optional)</label>
    <input id="confirmPassportNumber" name="confirmPassportNumber" />
    <label for="nationalityCode">Nationality code (e.g. ALB)</label>
    <input id="nationalityCode" name="nationalityCode" />
    <label for="gender">Gender</label>
    <select id="gender" name="gender">
      <option value="1">male</option>
      <option value="2">female</option>
    </select>
    <label for="selectedSubvisaCategory">Subvisa category (optional)</label>
    <input id="selectedSubvisaCategory" name="selectedSubvisaCategory" />
    <label for="Subclasscode">Subclass code (optional)</label>
    <input id="Subclasscode" name="Subclasscode" />
    <button type="submit">Submit</button>
  </form>
  <p id="msg"></p>
  <script>
    const collectLogin = ${collectLoginJs};
    async function loadDefaults() {
      const r = await fetch("/api/defaults");
      const d = await r.json();
      if (!d.ok) return;
      const a = d.defaults || {};
      for (const k of Object.keys(a)) {
        const el = document.getElementById(k);
        if (el) el.value = a[k] == null ? "" : String(a[k]);
      }
      if (collectLogin && d.loginDefaults && d.loginDefaults.vfsUsername) {
        const u = document.getElementById("vfsUsername");
        if (u) u.value = String(d.loginDefaults.vfsUsername);
      }
    }
    document.getElementById("f").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = document.getElementById("msg");
      msg.textContent = "";
      const fd = new FormData(e.target);
      const body = {
        firstName: fd.get("firstName"),
        lastName: fd.get("lastName"),
        emailId: fd.get("emailId"),
        dialCode: fd.get("dialCode"),
        contactNumber: fd.get("contactNumber"),
        dateOfBirth: fd.get("dateOfBirth"),
        passportNumber: fd.get("passportNumber"),
        passportExpirtyDate: fd.get("passportExpirtyDate"),
        confirmPassportNumber: fd.get("confirmPassportNumber"),
        nationalityCode: fd.get("nationalityCode"),
        gender: parseInt(String(fd.get("gender") || "2"), 10),
        selectedSubvisaCategory: fd.get("selectedSubvisaCategory"),
        Subclasscode: fd.get("Subclasscode"),
      };
      if (collectLogin) {
        body.vfsUsername = fd.get("vfsUsername");
        body.vfsPassword = fd.get("vfsPassword");
      }
      try {
        const r = await fetch("/api/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json();
        if (j.ok) {
          msg.className = "ok";
          msg.textContent = j.firstSubmit
            ? "Saved — bot run started in the background. Submit again for another run or to refresh data."
            : "Saved — another bot run was queued. Check the terminal for progress.";
        } else {
          msg.className = "err";
          msg.textContent = j.error || "Submit failed";
        }
      } catch (err) {
        msg.className = "err";
        msg.textContent = String(err);
      }
    });
    loadDefaults();
  </script>
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

export type FormSubmitInfo = { firstSubmit: boolean };

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
            const defaults = getApplicantFormDefaults();
            const payload: Record<string, unknown> = { ok: true, defaults };
            if (collectLogin) payload.loginDefaults = getLoginFormDefaults();
            json(res, 200, payload);
          } catch (e) {
            json(res, 500, { ok: false, error: e instanceof Error ? e.message : "defaults failed" });
          }
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

          if (collectLogin) {
            const vu = typeof j.vfsUsername === "string" ? j.vfsUsername.trim() : "";
            const vp = typeof j.vfsPassword === "string" ? j.vfsPassword : "";
            if (!vu || !vp) {
              json(res, 400, { ok: false, error: "VFS username and password are required" });
              return;
            }
            setSessionLoginCredentials(vu, vp);
          }

          const { vfsUsername: _u, vfsPassword: _p, ...rest } = j;
          const fields = parseApplicantFields(rest);
          if (!fields.firstName || !fields.lastName || !fields.passportNumber) {
            json(res, 400, { ok: false, error: "firstName, lastName, and passportNumber are required" });
            return;
          }
          setApplicantDetailsOverrides(fields);
          const firstSubmit = !seenSubmit;
          seenSubmit = true;
          json(res, 200, { ok: true, firstSubmit });
          void Promise.resolve(onSubmit({ firstSubmit }))
            .then(() => undefined)
            .catch((err) => logger.error({ err }, "Form onSubmit handler failed"));
          logger.info({ firstSubmit }, "Setup form submitted — onSubmit queued");
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
      logger.info({ url, collectLogin }, "Setup form — open this URL in your browser");
      console.log("\n  >>> Bot setup form: " + url + "\n");
      openUrlInBrowser(url);
      timeoutId = setTimeout(() => {
        server.close(() => { });
        safeReject(
          new Error(
            `Applicant UI timed out after ${applicantUiTimeoutMs()}ms. Submit the form or set VFS_APPLICANT_UI=false to skip.`
          )
        );
      }, applicantUiTimeoutMs());
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

import { chromium, Browser, BrowserContext, Page } from "playwright";

/** Thrown when a VFS page or API returns HTTP 403 Forbidden — caller should restart browser + rotate IP. */
export class VfsForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VfsForbiddenError";
  }
}

/** Thrown when VFS login API returns 429 Too Many Requests — caller should restart browser + rotate IP + demote sentinel. */
export class VfsLoginRateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VfsLoginRateLimitedError";
  }
}

/** Returns true when the error is Playwright's "Target closed" family of errors. */
function isTargetClosedError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return (
    e.message.includes("Target page, context or browser has been closed") ||
    e.message.includes("Target closed") ||
    e.message.includes("has been closed") ||
    e.name === "TargetClosedError"
  );
}
import { config, getCurrentInstanceId } from "../config/config";
import {
  calendarApiDateMatchesConstraint,
  NoDatesInScheduleRangeError,
  scheduleConstraintIsActive,
  scheduleConstraintLogValue,
  type ScheduleDateConstraint,
} from "../utils/scheduleAllowedDates.js";
import { buildCalendarBody, CALENDAR_URL, firstDayOfNextMonthFromDdMmYyyy } from "../config/calendar";
import { buildScheduleBody, SCHEDULE_URL } from "../config/schedule";
import { buildTimeslotBody, TIMESLOT_URL } from "../config/timeslot";
import { buildFeesBody, FEES_URL } from "../config/fees";
import { buildMapVasBody, MAPVAS_URL } from "../config/mapvas";
import { buildSaveApplicantsBody, SAVE_APPLICANTS_URL } from "../config/saveApplicants";
import { logger } from "../utils/logger";
import { ensureApplicantIpResolved } from "../utils/applicantIp";
import { getAllocationId, setAllocationId } from "../utils/allocationId.store";
import { getApplicationUrn, setApplicationUrn } from "../utils/applicationUrn.store";
import { getSlotDate, setSlotDate, getCalendarDatesCount, setCalendarDatesCount } from "../utils/slotDate.store";
import { setTotalAmount, setCurrency } from "../utils/totalAmount.store";
import {
  getCapturedClientSource,
  setCapturedClientSource,
  waitForClientSourceCapture,
} from "../utils/capturedClientSource.store";
import { setScheduleUrl } from "../utils/scheduleUrl.store";
import { saveBookingConfirmationFile } from "../utils/bookingConfirmationFile";
import { buildScheduleRedirectUrl } from "../utils/scheduleRedirectUrl";
import { classifyVfsFirstTabUrl } from "../flows/vfsTabUrl";
import { getApplicantFormServerOrigin } from "../ui/applicantDetailsFormServer";
import {
  fetchMailTmToken,
  isMailTmVerbose,
  listMailTmMessages,
  maskEmailForLog,
  waitForOtpFromMailTm,
} from "./mailTm.service";
import { TelegramService } from "./telegram.service";
import type { VfsUserLoginResponse } from "../types/vfsUserLogin.type.js";
import {
  flattenVfsLoginResponseForProfile,
  parseVfsUserLoginResponseBody,
  stripPasswordStepApplicantFieldsForProfileMerge,
} from "../types/vfsUserLogin.type.js";
import { clearVfsLoginProfile, mergeVfsLoginProfile } from "../utils/vfsLoginProfile.store.js";

/** Sniff `clientsource` on any request to this host that sends the header (not only `/application`). */
const LIFT_API_HOST_MARKER = "lift-api.vfsglobal.com";

/** Confirmed VFS lift-api login endpoint (password and OTP steps both POST here; we match on response URL + POST, not request body). */
const VFS_LIFT_USER_LOGIN_URL = "https://lift-api.vfsglobal.com/user/login";

function normalizeLiftLoginPathname(pathname: string): string {
  const p = pathname.replace(/\/+$/, "") || "/";
  return p.toLowerCase();
}

/**
 * Match the lift-api login **response** (browser form submit / fetch often leaves `request.postData()` empty).
 * Use this in `waitForResponse` / `page.on("response")` to capture JSON for profile merge.
 */
function responseIsLiftUserLoginPost(res: import("playwright").Response): boolean {
  const req = res.request();
  if (req.method() !== "POST") return false;
  let u: URL;
  try {
    u = new URL(res.url());
  } catch {
    return false;
  }
  if (u.hostname.toLowerCase() !== "lift-api.vfsglobal.com") return false;
  return normalizeLiftLoginPathname(u.pathname) === "/user/login";
}

export type PostOtpLoginCapture = {
  status: number;
  url: string;
  body: string;
  /** Set when `body` is valid JSON object (parse errors → null). */
  json: VfsUserLoginResponse | null;
};

/** Re-export for callers that depended on browser.service for the login JSON shape. */
export type { VfsUserLoginResponse } from "../types/vfsUserLogin.type.js";

function readClientSourceHeader(headers: Record<string, string>): string | undefined {
  const raw =
    headers["clientsource"] ??
    headers["clientSource"] ??
    headers["ClientSource"] ??
    headers["CLIENTSOURCE"];
  return raw?.trim() || undefined;
}

export class BrowserService {
  private browser: Browser | null = null;
  /** Avoid duplicate `request` listeners on the same CDP context. */
  private readonly clientSourceSnifferAttached = new WeakSet<BrowserContext>();
  /** Sitekey captured from network interception */
  private capturedTurnstileSitekey: string | null = null;
  /** Set when the bot performs the second Sign In after OTP (auto flow); see {@link getLastPostOtpLoginResponse}. */
  private lastPostOtpLoginResponse: PostOtpLoginCapture | null = null;

  /** Response body from the login API call after OTP submit (empty until a login completes that path). */
  getLastPostOtpLoginResponse(): PostOtpLoginCapture | null {
    return this.lastPostOtpLoginResponse;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    const cdpUrl = config.browserCdpUrl;
    this.browser = await chromium.connectOverCDP(cdpUrl);
    for (const ctx of this.browser.contexts()) {
      this.attachLiftApiClientSourceSniffer(ctx);
      this.attachTurnstileSitekeyInterceptor(ctx); // ← Install network interceptor early
    }
    return this.browser;
  }

  /** Prefer an existing VFS portal tab over arbitrary `pages()[0]` (e.g. setup form or new tab). */
  private findPreferredVfsPage(pages: Page[]): Page | null {
    for (const p of pages) {
      try {
        if (p.url().toLowerCase().includes("visa.vfsglobal.com")) return p;
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Intercept Cloudflare Turnstile network requests to capture sitekey BEFORE page can hide it.
   * This works even if Turnstile auto-resolves immediately.
   */
  private attachTurnstileSitekeyInterceptor(context: BrowserContext): void {
    logger.info("[Turnstile] Installing network interceptor for sitekey capture...");

    context.route('**/*', (route) => {
      const url = route.request().url();

      // Check if this is a Cloudflare Turnstile request
      if ((url.includes('challenges.cloudflare.com') || url.includes('turnstile')) &&
        (url.includes('/turnstile/') || url.includes('/challenge-platform/'))) {

        if (!this.capturedTurnstileSitekey) {
          logger.info({ urlPreview: url.substring(0, 150) }, "[Turnstile] Network: Cloudflare request detected");

          // Extract sitekey from URL - FIXED: allow alphanumeric (not just hex!)
          // Real sitekey format: 0x4AAAAAABhlz7Ei4byodYjs (contains letters beyond hex like h, l, z, i, b, y, o, d, Y, j, s)
          const match0x = url.match(/(0x[0-9A-Za-z_-]{20,})/);
          if (match0x) {
            this.capturedTurnstileSitekey = match0x[1];
            logger.info({ sitekey: this.capturedTurnstileSitekey, source: 'network_interception' }, "[Turnstile] ✅ Captured sitekey from network request!");
          } else {
            // Fallback: extract from /rch/ path (not /pat/ which has different IDs)
            const matchRch = url.match(/\/rch\/[^/]+\/([0-9A-Za-z_-]{20,})\//);
            if (matchRch && matchRch[1]) {
              this.capturedTurnstileSitekey = matchRch[1];
              logger.info({ sitekey: this.capturedTurnstileSitekey, source: 'network_interception_rch' }, "[Turnstile] ✅ Captured sitekey from /rch/ path!");
            }
          }
        }
      }

      // Always continue the request
      route.continue().catch(() => { });
    });
  }

  /**
   * Capture `clientsource` from any browser request to lift-api that includes the header
   * (e.g. `/appointment/application`, `CheckIsSlotAvailable`, `applicants`, …).
   */
  private attachLiftApiClientSourceSniffer(context: BrowserContext): void {
    if (this.clientSourceSnifferAttached.has(context)) return;
    this.clientSourceSnifferAttached.add(context);
    context.on("request", (request) => {
      try {
        const url = request.url();
        if (!url.includes(LIFT_API_HOST_MARKER)) return;
        const cs = readClientSourceHeader(request.headers());
        if (!cs) return;
        if (getCapturedClientSource() === cs) return;
        setCapturedClientSource(cs);
        let path = url;
        try {
          path = new URL(url).pathname;
        } catch {
          /* keep full url */
        }
      } catch {
        /* ignore */
      }
    });
  }

  async getFirstTabUrl(): Promise<string> {
    const browser = await this.ensureBrowser();
    const pages = browser.contexts()[0]?.pages() ?? [];
    const vfsPage = this.findPreferredVfsPage(pages);
    if (vfsPage) {
      try {
        await vfsPage.bringToFront().catch(() => { });
        return vfsPage.url();
      } catch {
        return "";
      }
    }
    const page = pages[0];
    if (!page) return "";
    try {
      return page.url();
    } catch {
      return "";
    }
  }

  /**
   * Check if the current VFS page shows a WAF JSON block (e.g. `{"code":"403201"}`).
   * The URL may look normal (/login) but the body is a JSON error instead of the login form.
   */
  async detectWafJsonBlock(): Promise<boolean> {
    try {
      const browser = await this.ensureBrowser();
      const pages = browser.contexts()[0]?.pages() ?? [];
      const page = this.findPreferredVfsPage(pages) ?? pages[0];
      if (!page) return false;
      const bodyText = await page.locator("body").innerText({ timeout: 5_000 });
      const trimmed = bodyText.trim();
      if (/^\s*\{/.test(trimmed)) {
        try {
          const parsed = JSON.parse(trimmed) as { code?: string | number };
          if (parsed.code && String(parsed.code).startsWith("403")) {
            logger.warn({ code: parsed.code }, "[WAF] Detected WAF JSON block on page body");
            return true;
          }
        } catch { /* not JSON */ }
      }
    } catch { /* page read failed */ }
    return false;
  }

  /**
   * Clicks the local setup form Submit (`http://127.0.0.1:…/`) if that tab is open in Chrome.
   * Same network effect as a manual Submit (POST `/api/submit`).
   */
  async tryClickLocalApplicantSetupFormSubmit(): Promise<boolean> {
    const origin = getApplicantFormServerOrigin();
    const browser = await this.ensureBrowser();
    const ctx = browser.contexts()[0];
    if (!ctx) return false;
    for (const page of ctx.pages()) {
      let u = "";
      try {
        u = page.url();
      } catch {
        continue;
      }
      if (!u.startsWith(origin)) continue;
      try {
        await page.locator('form#f button[type="submit"]').click({ timeout: 5000 });
        await page.waitForTimeout(1500);
        return true;
      } catch {
        /* try next page */
      }
    }
    return false;
  }

  /**
   * Resolves outbound IP for save-applicants via `fetch` in the first browser tab (Chrome proxy extension, etc.).
   * Falls back to Node ipify when the tab lookup fails or no tab exists.
   */
  async resolveApplicantIpForPayload(): Promise<void> {
    const page = await this.getFirstPageForIpLookup();
    await ensureApplicantIpResolved(page);
  }

  private async getFirstPageForIpLookup(): Promise<Page | null> {
    try {
      const browser = await this.ensureBrowser();
      const pages = browser.contexts()[0]?.pages() ?? [];
      return this.findPreferredVfsPage(pages) ?? pages[0] ?? null;
    } catch {
      return null;
    }
  }

  async openLoginInFirstTab(): Promise<void> {
    const browser = await this.ensureBrowser();
    const context = browser.contexts()[0];
    if (!context) throw new Error("No browser context");
    const pages = context.pages();
    let page = this.findPreferredVfsPage(pages);
    if (!page) {
      page = pages[0] ?? (await context.newPage());
    }
    await page.bringToFront().catch(() => { });
    logger.info("Navigating to login page...");
    const navResponse = await page.goto(config.loginPageUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });

    if (navResponse && navResponse.status() === 403) {
      throw new VfsForbiddenError("Login page returned 403 Forbidden — IP/session blocked by Cloudflare or VFS.");
    }

    // VFS sometimes redirects to a "page not found" URL instead of the login form.
    const currentUrl = page.url();
    if (/\/page-not-found\b/i.test(currentUrl)) {
      throw new VfsForbiddenError(`Login page redirected to ${currentUrl} — IP/session blocked or route unavailable.`);
    }

    // Detect VFS/Cloudflare WAF block shown as JSON body (e.g. {"code":"403201","description":""}).
    // The HTTP status may be 200 but the page renders a raw JSON error instead of the login form.
    try {
      const bodyText = await page.locator("body").innerText({ timeout: 5_000 });
      const trimmed = bodyText.trim();
      if (/^\s*\{/.test(trimmed)) {
        try {
          const parsed = JSON.parse(trimmed) as { code?: string | number };
          if (parsed.code && String(parsed.code).startsWith("403")) {
            throw new VfsForbiddenError(`Login page body contains WAF block: code ${parsed.code}`);
          }
        } catch (e) {
          if (e instanceof VfsForbiddenError) throw e;
        }
      }
    } catch (e) {
      if (e instanceof VfsForbiddenError) throw e;
    }

    // Wait for login form inputs to be ready
    const visibleOnly = ':not(.d-none):not([aria-hidden="true"])';
    const usernameSelectors = `#email${visibleOnly}, input[formcontrolname="username"]${visibleOnly}, input[formControlName="username"]${visibleOnly}, input[formcontrolname="email"]${visibleOnly}, input[formControlName="email"]${visibleOnly}, input[name="username"]${visibleOnly}, input[name="email"]${visibleOnly}, input[type="email"]${visibleOnly}`;

    await page.locator(usernameSelectors).first().waitFor({ state: "visible", timeout: 300_000 });
  }

  /**
   * Best-effort logout before switching accounts, then open the login URL.
   * VFS varies by site; if no logout control is found we still navigate to the login page.
   */
  async logoutVfsAndOpenLoginFirstTab(): Promise<void> {
    const browser = await this.ensureBrowser();
    const context = browser.contexts()[0];
    if (!context) throw new Error("No browser context");
    const pages = context.pages();
    const page = this.findPreferredVfsPage(pages) ?? pages[0];
    if (!page) {
      await this.openLoginInFirstTab();
      return;
    }
    await page.bringToFront().catch(() => { });
    logger.info("[Logout] Attempting VFS sign-out before next login...");
    try {
      const candidates = [
        page.getByRole("button", { name: /log\s*out|sign\s*out|log\s*off/i }).first(),
        page.getByRole("link", { name: /log\s*out|sign\s*out/i }).first(),
        page.locator('a[href*="logout" i], button[href*="logout" i]').first(),
      ];
      for (const loc of candidates) {
        if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
          await loc.click({ timeout: 5000 }).catch(() => { });
          await page.waitForTimeout(2000);
          break;
        }
      }
    } catch {
      /* continue to login URL */
    }
    await this.openLoginInFirstTab();
  }

  /**
   * Run login on the first tab (must be on login page): fill credentials, Turnstile, submit.
   */
  async loginOnFirstTab(username: string, password: string): Promise<void> {
    this.lastPostOtpLoginResponse = null;
    clearVfsLoginProfile();
    const browser = await this.ensureBrowser();
    const context = browser.contexts()[0];
    if (!context) throw new Error("No browser context");
    const pages = context.pages();
    const page = this.findPreferredVfsPage(pages) ?? pages[0];
    if (!page) throw new Error("No tab. Open Chrome with at least one tab, or open the VFS login page.");
    await page.bringToFront().catch(() => { });

    // Guard: the page may have been redirected to page-not-found or WAF-blocked
    // between openLoginInFirstTab and now (or the redirect happened after the
    // initial navigation completed).
    const currentUrl = page.url();
    if (/\/page-not-found\b/i.test(currentUrl)) {
      throw new VfsForbiddenError(`Login tab redirected to ${currentUrl} — IP/session blocked.`);
    }
    try {
      const bodyText = await page.locator("body").innerText({ timeout: 5_000 });
      const trimmed = bodyText.trim();
      if (/^\s*\{/.test(trimmed)) {
        try {
          const parsed = JSON.parse(trimmed) as { code?: string | number };
          if (parsed.code && String(parsed.code).startsWith("403")) {
            throw new VfsForbiddenError(`Login page body contains WAF block: code ${parsed.code}`);
          }
        } catch (e) {
          if (e instanceof VfsForbiddenError) throw e;
        }
      }
    } catch (e) {
      if (e instanceof VfsForbiddenError) throw e;
    }

    // Wait for login form inputs to be ready
    const visibleOnly = ':not(.d-none):not([aria-hidden="true"])';
    const usernameSelectors = `#email${visibleOnly}, input[formcontrolname="username"]${visibleOnly}, input[formControlName="username"]${visibleOnly}, input[formcontrolname="email"]${visibleOnly}, input[formControlName="email"]${visibleOnly}, input[name="username"]${visibleOnly}, input[name="email"]${visibleOnly}, input[type="email"]${visibleOnly}`;

    await page.locator(usernameSelectors).first().waitFor({ state: "visible", timeout: 300_000 });

    // Quick check for consent (3 seconds max) since email input is already visible
    await this.dismissCookieConsent(page, true);

    const passwordSelectors = `input[formcontrolname="password"]${visibleOnly}, input[name="password"]${visibleOnly}, input[type="password"]:not([formcontrolname="otp"])${visibleOnly}`;

    await this.fillLoginCredentials(page, username, password, {
      usernameSelectors,
      passwordSelectors,
      timeoutMs: 25_000,
    });

    const submitBtn = await this.resolveLoginSubmitButton(page);

    const wantMailTm =
      config.mailTmOtpEnabled && username.trim().includes("@") && password.length > 0;

    /** Token + baseline before Sign In; OTP poll starts only after Sign In (avoids reading a previous OTP). */
    let mailTmReady: { token: string; baseline: Set<string> } | null = null;
    let mailOtpFetchPromise: Promise<string> | null = null;
    if (wantMailTm) {
      try {
        const mailToken = await fetchMailTmToken(username.trim(), password);
        const initial = await listMailTmMessages(mailToken, "baseline_before_sign_in");
        const mailBaseline = new Set<string>();
        for (const m of initial) {
          if (m.id) mailBaseline.add(m.id);
        }
        mailTmReady = { token: mailToken, baseline: mailBaseline };
      } catch (err) {
        logger.error(
          {
            err,
            step: "login.mail_tm_setup_failed",
            addressMasked: maskEmailForLog(username.trim()),
          },
          "[login] mail.tm setup failed — token or baseline list error (see [mail.tm] steps above). Enter OTP manually in Chrome."
        );
      }
    } else {
      logger.info(
        { step: "login.mail_tm_skipped" },
        "[login] mail.tm skipped (set ENABLE_MAIL_TM_OTP=true and use mail.tm mailbox credentials)"
      );
    }

    const passwordLoginResponsePromise = page
      .waitForResponse(
        (res) => {
          try {
            return responseIsLiftUserLoginPost(res);
          } catch {
            return false;
          }
        },
        { timeout: 90_000 }
      )
      .catch((err) => {
        logger.debug({ err: String(err) }, "[Login] Password-step /user/login waiter finished without a match");
        return null;
      });

    // Optimized: Submit immediately without unnecessary waits
    await this.submitLoginImmediately(page, submitBtn, {
      loginRefill: { username, password, usernameSelectors, passwordSelectors },
    });

    const pwdLoginRes = await passwordLoginResponsePromise;
    if (pwdLoginRes) {
      const pwdStatus = pwdLoginRes.status();

      if (pwdStatus === 429) {
        const pwdBody = await pwdLoginRes.text().catch(() => "");
        logger.error({ status: pwdStatus, bodySnippet: pwdBody.slice(0, 200) }, "[Login] /user/login returned 429 Too Many Requests");
        throw new VfsLoginRateLimitedError("Login API returned 429 Too Many Requests — rate limited by VFS.");
      }

      const pwdBody = await pwdLoginRes.text().catch(() => "");
      const pwdJson = parseVfsUserLoginResponseBody(pwdBody);
      if (pwdJson) {
        const errObj = pwdJson.error as { code?: number; description?: string } | undefined;

        // Body-level 429 code (e.g. {"code":"429001"})
        const bodyCode = String((pwdJson as Record<string, unknown>).code ?? errObj?.code ?? "");
        if (bodyCode.startsWith("429")) {
          logger.error({ status: pwdStatus, code: bodyCode }, "[Login] /user/login body has 429 code");
          throw new VfsLoginRateLimitedError(`Login API returned code ${bodyCode} — rate limited by VFS.`);
        }

        if (errObj && errObj.code === 413 && errObj.description === "Invalid Sender User") {
          logger.error(
            { status: pwdStatus, error: errObj },
            "[Login] Login failed — email not registered (error 413 / Invalid Sender User)"
          );
          void new TelegramService()
            .alert("error", "The entered email id is not registered.")
            .catch(() => { });
        }
        const flat = flattenVfsLoginResponseForProfile(pwdJson);
        const forStore = stripPasswordStepApplicantFieldsForProfileMerge(flat);
        if (forStore) mergeVfsLoginProfile(forStore);
        logger.info(
          {
            status: pwdStatus,
            loginUser: pwdJson.loginUser,
            isAuthenticated: pwdJson.isAuthenticated,
          },
          "[Login] Merged password-step /user/login (session flags only — applicant fields come from OTP step)"
        );
      }
    }

    if (mailTmReady) {
      const signInEpochMs = Date.now();
      const prePollMs = config.mailTmPostSignInDelayMs;
      if (prePollMs > 0) {
        await new Promise<void>((r) => setTimeout(r, prePollMs));
      }
      mailOtpFetchPromise = waitForOtpFromMailTm(mailTmReady.token, mailTmReady.baseline, {
        timeoutMs: config.mailTmOtpTimeoutMs,
        pollMs: config.mailTmPollIntervalMs,
        signInEpochMs,
      });
    }

    await this.finishLoginAfterFirstSubmit(page, mailOtpFetchPromise);
  }

  /**
   * Blocks until the browser POSTs any lift-api request that sends `clientsource`
   * (e.g. dashboard SPA navigation after login). Sends periodic Telegram alerts while waiting.
   */
  async waitForLiftClientSourceIfNeeded(): Promise<void> {
    if (getCapturedClientSource()?.trim()) {
      logger.info("clientsource: already captured from browser");
      return;
    }
    await this.ensureBrowser();
    const telegram = new TelegramService();
    const ALERT_INTERVAL_MS = 60_000;
    logger.info(
      "Waiting for clientsource capture from browser (lift-api request with clientsource header)..."
    );
    await telegram
      .alert("info", "Waiting for clientsource — open or refresh VFS dashboard in Chrome so the bot can capture it.")
      .catch(() => { });

    const alertTimer = setInterval(() => {
      if (getCapturedClientSource()?.trim()) return;
      logger.info("Still waiting for clientsource capture...");
      telegram
        .alert("info", "Still waiting for clientsource — navigate VFS dashboard in Chrome to trigger a lift-api request.")
        .catch(() => { });
    }, ALERT_INTERVAL_MS);

    try {
      await waitForClientSourceCapture();
    } finally {
      clearInterval(alertTimer);
    }
    logger.info("clientsource captured; proceeding");
  }

  /**
   * After login, before slot polling: wait for `clientsource` when needed (no forced navigation — polling uses the
   * current VFS tab URL).
   * `skipDashboardNavigate` after a setup-form resubmit — skip clientsource wait; poll uses env/capture from tab.
   */
  async preparePollingAfterLogin(options?: { skipDashboardNavigate?: boolean }): Promise<void> {
    const page = await this.getVfsPage();
    const skipNav = options?.skipDashboardNavigate === true;
    if (!skipNav) {
      logger.info({ url: page.url() }, "Pre-poll: staying on current VFS tab (not navigating to application-detail)");
    }
    // Resubmit rounds skip dashboard nav; waiting here for a new /application would block and prevent slot checks.
    if (skipNav) {
      logger.info("Poll round after form resubmit — skipping clientsource wait; CheckIsSlotAvailable uses env/capture/storage from tab");
      return;
    }
    await this.waitForLiftClientSourceIfNeeded();
  }

  /**
   * On some VFS dashboards, slot APIs only work reliably after clicking "Start new booking".
   * This is a best-effort click (safe to call even if the button doesn't exist).
   */
  async clickStartNewBookingIfPresent(): Promise<void> {
    const page = await this.getVfsPage();
    await page.waitForTimeout(3_000);
    const candidates = [
      page.getByRole("button", { name: /start\s+new\s+booking/i }).first(),
      page.getByRole("link", { name: /start\s+new\s+booking/i }).first(),
      page.locator('button:has-text("Start new booking")').first(),
      page.locator('a:has-text("Start new booking")').first(),
    ];

    for (const loc of candidates) {
      try {
        if (!(await loc.isVisible({ timeout: 800 }).catch(() => false))) continue;
        logger.info("Dashboard: clicking 'Start new booking'");
        await Promise.all([
          page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => { }),
          loc.click({ timeout: 5_000 }),
        ]);
        await page.waitForTimeout(1000);
        logger.info({ url: page.url() }, "Dashboard: 'Start new booking' click completed");
        return;
      } catch (e) {
        logger.warn({ e }, "Dashboard: failed to click one 'Start new booking' candidate");
      }
    }
    logger.info("Dashboard: no 'Start new booking' button found (skipping)");
  }

  private async selectFirstOptionFromMatSelect(page: Page, select: import("playwright").Locator, label: string): Promise<boolean> {
    try {
      if (!(await select.isVisible({ timeout: 1500 }).catch(() => false))) return false;
      await select.scrollIntoViewIfNeeded().catch(() => { });
      await select.click({ timeout: 5000 });

      // Angular Material options appear in an overlay panel.
      const panel = page.locator(".mat-mdc-select-panel, .mat-select-panel").first();
      await panel.waitFor({ state: "visible", timeout: 5000 });

      const options = panel.locator("mat-option, .mat-mdc-option, .mat-option");
      const n = await options.count();
      for (let i = 0; i < n; i++) {
        const opt = options.nth(i);
        const txt = (await opt.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (!txt) continue;
        if (/select|choose|--/i.test(txt)) continue; // skip placeholder-ish entries
        await opt.click({ timeout: 5000 });
        await page.waitForTimeout(800);
        logger.info({ picked: txt }, `Application-detail: selected first ${label}`);
        return true;
      }

      // No usable option found; close dropdown (Esc).
      await page.keyboard.press("Escape").catch(() => { });
      return false;
    } catch (e) {
      logger.warn({ e }, `Application-detail: failed selecting first ${label}`);
      return false;
    }
  }

  /**
   * On `application-detail` page, choose first center + first category.
   * Best-effort: tries to detect Material selects and pick first non-empty option.
   */
  async selectFirstCenterAndCategoryIfOnApplicationDetail(): Promise<void> {
    const page = await this.getVfsPage();
    const url = (() => {
      try {
        return page.url();
      } catch {
        return "";
      }
    })();

    if (!/application-detail/i.test(url)) {
      logger.info({ url }, "Application-detail: not on application-detail; skipping center/category selection");
      return;
    }

    logger.info({ url }, "Application-detail: selecting first center + first category");
    await page.waitForTimeout(3_000);

    // Heuristics: pick first two visible mat-selects on the page.
    const allMatSelects = page.locator("mat-select, .mat-mdc-select, .mat-select").filter({ hasNot: page.locator("[disabled], [aria-disabled='true']") });
    const count = await allMatSelects.count();
    if (count === 0) {
      logger.warn("Application-detail: no mat-select controls found; cannot auto-pick center/category");
      return;
    }

    const centerSel = allMatSelects.nth(0);
    const catSel = count > 1 ? allMatSelects.nth(1) : null;

    const pickedCenter = await this.selectFirstOptionFromMatSelect(page, centerSel, "center");
    // Category might become enabled only after center selection.
    if (catSel) {
      await page.waitForTimeout(3_000);
      await this.selectFirstOptionFromMatSelect(page, catSel, "category").catch(() => { });
    } else if (!pickedCenter) {
      logger.warn("Application-detail: only one select found and center pick failed");
    }
  }

  /** Call when a slot is found (uses current VFS tab). */
  async saveApplicantsViaLiftApi(): Promise<void> {
    const existingUrn = getApplicationUrn();
    if (existingUrn?.trim()) {
      logger.info({ urn: existingUrn }, "Skip save applicants: URN already in memory");
      return;
    }
    await this.waitForLiftClientSourceIfNeeded();
    const page = await this.getVfsPage();
    await this.saveApplicantsViaLiftApiOnPage(page);
  }

  /**
   * POST /appointment/fees (call from index after save applicants).
   * Uses stored URN from {@link setApplicationUrn} and the same VFS tab as lift-api.
   */
  async postFeesLiftApi(): Promise<void> {
    const urn = getApplicationUrn();
    if (!urn?.trim()) {
      logger.warn("Skip fees API: no urn in memory; save applicants successfully first");
      return;
    }
    const page = await this.getVfsPage();
    await this.postFeesLiftApiOnPage(page, urn);
  }

  /**
   * POST /appointment/calendar (call from index after fees).
   * Uses stored URN and same VFS tab / headers as other lift-api calls.
   */
  async postCalendarLiftApi(opts?: { scheduleConstraint?: ScheduleDateConstraint }): Promise<void> {
    const urn = getApplicationUrn();
    if (!urn?.trim()) {
      logger.warn("Skip calendar API: no urn in memory; save applicants successfully first");
      return;
    }
    const page = await this.getVfsPage();
    await this.postCalendarLiftApiOnPage(page, urn, opts);
  }

  /**
   * POST /appointment/timeslot (after calendar). Uses URN, slotDate from calendar, stores allocationId.
   */
  async postTimeslotLiftApi(): Promise<void> {
    const urn = getApplicationUrn();
    const slotDate = getSlotDate();
    if (!urn?.trim()) {
      logger.warn("Skip timeslot API: no urn; save applicants successfully first");
      return;
    }
    if (!slotDate?.trim()) {
      logger.warn("Skip timeslot API: no slotDate; run calendar API first");
      return;
    }
    const page = await this.getVfsPage();
    await this.postTimeslotLiftApiOnPage(page, urn, slotDate);
  }

  /**
   * POST /vas/mapvas (after timeslot, before fees). Egypt→Portugal portal only.
   */
  async postMapVasLiftApi(): Promise<void> {
    const urn = getApplicationUrn();
    if (!urn?.trim()) {
      logger.warn("Skip mapvas API: no urn; save applicants successfully first");
      return;
    }
    const page = await this.getVfsPage();
    await this.postMapVasLiftApiOnPage(page, urn);
  }

  /**
   * POST /appointment/schedule (after timeslot). Uses URN, allocationId from timeslot; stores response `URL` when set.
   */
  async postScheduleLiftApi(): Promise<void> {
    const urn = getApplicationUrn();
    const allocationId = getAllocationId();
    if (!urn?.trim()) {
      logger.warn("Skip schedule API: no urn; save applicants successfully first");
      return;
    }
    if (!allocationId?.trim()) {
      logger.warn("Skip schedule API: no allocationId; run timeslot API first");
      return;
    }
    const page = await this.getVfsPage();
    await this.postScheduleLiftApiOnPage(page, urn, allocationId);
  }

  private async getVfsPage(): Promise<Page> {
    const browser = await this.ensureBrowser();
    const pages = browser.contexts()[0]?.pages() ?? [];

    const page = pages.find((p) => {
      try {
        return p.url().includes("visa.vfsglobal.com");
      } catch {
        return false;
      }
    });

    if (!page) throw new Error("No VFS tab open. Keep a visa.vfsglobal.com tab open in Chrome.");
    this.attachLiftApiClientSourceSniffer(page.context());
    return page;
  }

  private async saveApplicantsViaLiftApiOnPage(page: Page): Promise<void> {
    await page.waitForTimeout(500);
    await ensureApplicantIpResolved(page);
    const body = buildSaveApplicantsBody();
    logger.info({ url: SAVE_APPLICANTS_URL, payload: JSON.stringify(body) }, "Saving applicant via lift-api");

    const res = await this.postLiftJsonFromPage(page, SAVE_APPLICANTS_URL, body);
    logger.info({ status: res.status, responseBody: res.body.slice(0, 1000) }, "Applicants API response");

    const parsed = this.parseApplicantsResponseJson(res.body);
    if (parsed.urn) setApplicationUrn(parsed.urn);
    logger.info({ urn: parsed.urn }, "Applicants saved");
  }

  private async postFeesLiftApiOnPage(page: Page, urn: string): Promise<void> {
    const feesPayload = buildFeesBody(urn);
    logger.info({ url: FEES_URL }, "Calling lift-api fees");
    const res = await this.postLiftJsonFromPage(page, FEES_URL, feesPayload);
    try {
      const j = JSON.parse(res.body) as {
        error?: unknown;
        totalAmount?: unknown;
        totalamount?: unknown;
        feeDetails?: Array<{ currency?: unknown }>;
      };
      if (j.error != null && j.error !== "") {
        throw new Error(`Fees API error: ${JSON.stringify(j.error)}`);
      }
      const totalAmountRaw = j.totalAmount ?? j.totalamount;
      if (typeof totalAmountRaw === "string" && totalAmountRaw.trim() !== "") {
        setTotalAmount(totalAmountRaw);
        logger.info({ totalAmount: totalAmountRaw }, "Stored fees totalAmount");
      } else if (typeof totalAmountRaw === "number" && Number.isFinite(totalAmountRaw)) {
        const s = String(totalAmountRaw);
        setTotalAmount(s);
        logger.info({ totalAmount: s }, "Stored fees totalAmount");
      } else {
        logger.warn("Fees response has no totalAmount; nothing stored");
      }
      if (j.feeDetails && j.feeDetails.length > 0 && typeof j.feeDetails[0]?.currency === "string" && j.feeDetails[0]?.currency.trim() !== "") {
        setCurrency(j.feeDetails[0]?.currency);
        logger.info({ currency: j.feeDetails[0]?.currency }, "Stored fees currency");
      } else {
        logger.warn("Fees response has no currency; nothing stored");
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Fees API error")) throw e;
      throw new Error("Fees: response is not JSON");
    }
    logger.info("Fees retrieved OK");
  }

  private async postMapVasLiftApiOnPage(page: Page, urn: string): Promise<void> {
    const payload = buildMapVasBody(urn);
    logger.info({ url: MAPVAS_URL }, "Calling lift-api mapvas");
    const res = await this.postLiftJsonFromPage(page, MAPVAS_URL, payload);
    try {
      const j = JSON.parse(res.body) as { urn?: string; amount?: number; currency?: string; error?: unknown };
      if (j.error != null && j.error !== "") {
        throw new Error(`MapVas API error: ${JSON.stringify(j.error)}`);
      }
      logger.info({ urn: j.urn, amount: j.amount, currency: j.currency }, "MapVas response OK");
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("MapVas API error")) throw e;
      throw new Error("MapVas: response is not JSON");
    }
  }

  private async postCalendarLiftApiOnPage(
    page: Page,
    urn: string,
    opts?: { scheduleConstraint?: ScheduleDateConstraint }
  ): Promise<void> {
    type CalJson = { error?: unknown; calendars?: Array<{ date?: string; isWeekend?: boolean }> | null };
    const isCalendar1035FullSlot = (e: unknown): boolean =>
      e != null && typeof e === "object" && (e as { code?: unknown }).code === 1035;

    let payload: Record<string, unknown> = buildCalendarBody(urn);
    logger.info({ url: CALENDAR_URL, fromDate: payload.fromDate }, "Calling lift-api calendar");
    let res = await this.postLiftJsonFromPage(page, CALENDAR_URL, payload);
    let j: CalJson;
    try {
      j = JSON.parse(res.body) as CalJson;
      if (isCalendar1035FullSlot(j.error)) {
        const prevFrom = String(payload.fromDate ?? "");
        const retryFrom = firstDayOfNextMonthFromDdMmYyyy(prevFrom);
        logger.warn(
          { previousFrom: prevFrom, retryFrom },
          "Calendar API 1035 (slot full) — retrying with first day of next month for fromDate"
        );
        payload = buildCalendarBody(urn, { fromDate: retryFrom });
        logger.info({ url: CALENDAR_URL, fromDate: payload.fromDate }, "Calling lift-api calendar (retry)");
        res = await this.postLiftJsonFromPage(page, CALENDAR_URL, payload);
        j = JSON.parse(res.body) as CalJson;
      }
      if (j.error != null && j.error !== "") {
        throw new Error(`Calendar API error: ${JSON.stringify(j.error)}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Calendar API error")) throw e;
      throw new Error("Calendar: response is not JSON");
    }
    let dates = (j.calendars ?? []).map((c) => String(c?.date ?? "").trim()).filter(Boolean);
    const constraint = opts?.scheduleConstraint;
    if (constraint && scheduleConstraintIsActive(constraint)) {
      const before = dates.length;
      dates = dates.filter((d) => calendarApiDateMatchesConstraint(d, constraint));
      logger.info(
        { beforeCount: before, afterCount: dates.length, ...scheduleConstraintLogValue(constraint) },
        "Calendar dates filtered by schedule constraint"
      );
      if (dates.length === 0) {
        throw new NoDatesInScheduleRangeError();
      }
    }

    if (dates.length > 0) {
      // Shard instances across available calendar dates:
      // Example: instances=10, dates=3 => [4,3,3] instances per date.
      const totalInstances = Math.max(1, parseInt(process.env.BOT_TOTAL_INSTANCES ?? "1", 10) || 1);
      const myId = getCurrentInstanceId() ?? 1;
      const myIdx = Math.max(0, Math.min(totalInstances - 1, myId - 1));

      const base = Math.floor(totalInstances / dates.length);
      const rem = totalInstances % dates.length; // first `rem` dates get +1 instance

      let chosenIdx = 0;
      let acc = 0;
      for (let i = 0; i < dates.length; i++) {
        const size = base + (i < rem ? 1 : 0);
        const start = acc;
        const end = acc + size; // exclusive
        if (myIdx >= start && myIdx < end) {
          chosenIdx = i;
          break;
        }
        acc = end;
      }

      const chosen = dates[chosenIdx]!;
      setSlotDate(chosen);
      setCalendarDatesCount(dates.length);
      logger.info(
        { slotDate: chosen, chosenIdx, datesCount: dates.length, myId, totalInstances },
        "Stored sharded calendar date as slotDate"
      );
    } else {
      logger.warn("Calendar response has no calendars[].date; slotDate not set");
    }
    logger.info("Calendar retrieved OK");
  }

  private async postTimeslotLiftApiOnPage(page: Page, urn: string, slotDateFromCalendar: string): Promise<void> {
    const payload = buildTimeslotBody(urn, slotDateFromCalendar);
    logger.info({ url: TIMESLOT_URL, slotDate: payload.slotDate }, "Calling lift-api timeslot");
    const res = await this.postLiftJsonFromPage(page, TIMESLOT_URL, payload);
    let j: {
      error?: unknown;
      slots?: Array<{ allocationId?: string; slot?: string; type?: string }>;
    };
    try {
      j = JSON.parse(res.body) as typeof j;
      // Treat ANY non-null error as failure, even on HTTP 200.
      if (j.error !== null && j.error !== undefined) {
        throw new Error(`Timeslot API error: ${JSON.stringify(j.error)}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Timeslot API error")) throw e;
      throw new Error("Timeslot: response is not JSON");
    }
    const slots = j.slots ?? [];
    if (slots.length === 0) {
      logger.warn("Timeslot response has no slots");
    } else {
      const totalInstances = Math.max(1, parseInt(process.env.BOT_TOTAL_INSTANCES ?? "1", 10) || 1);
      const myId = getCurrentInstanceId() ?? 1;
      const myIdx = Math.max(0, Math.min(totalInstances - 1, myId - 1));

      // Compute this instance's position *within its date group* so that
      // instances sharing the same calendar date spread across timeslots.
      // Uses the stored calendarDatesCount from the calendar sharding step;
      // falls back to 1 (all instances on one date) when unknown.
      const dateCount = Math.max(1, getCalendarDatesCount());
      const dateBase = Math.floor(totalInstances / dateCount);
      const dateRem = totalInstances % dateCount;

      let groupStart = 0;
      let groupSize = totalInstances;
      let acc = 0;
      for (let i = 0; i < dateCount; i++) {
        const size = dateBase + (i < dateRem ? 1 : 0);
        if (myIdx >= acc && myIdx < acc + size) {
          groupStart = acc;
          groupSize = size;
          break;
        }
        acc += size;
      }
      const subIdx = myIdx - groupStart;

      const chosenSlotIdx = subIdx % slots.length;
      const chosen = slots[chosenSlotIdx];
      const alloc = chosen?.allocationId?.trim();
      if (alloc) {
        setAllocationId(alloc);
        logger.info(
          { allocationIdPrefix: alloc.slice(0, 16), chosenSlotIdx, slotsCount: slots.length, myId, totalInstances, dateGroupSize: groupSize, subIdx },
          "Stored sharded timeslot allocationId"
        );
      } else {
        logger.warn({ chosenSlotIdx }, "Chosen timeslot slot has no allocationId");
      }
    }
    logger.info("Timeslot retrieved OK");

    const inst = getCurrentInstanceId() ?? 1;
    void new TelegramService()
      .alert("hold_success", `Instance ${inst} holds slot for ${payload.slotDate}`)
      .catch(() => { });
  }

  private async postScheduleLiftApiOnPage(page: Page, urn: string, allocationId: string): Promise<void> {
    const payload = buildScheduleBody(urn, allocationId);
    logger.info({ url: SCHEDULE_URL }, "Calling lift-api schedule");

    const res = await this.postLiftJsonFromPage(page, SCHEDULE_URL, payload);
    console.log("[Schedule] Final HTTP", res.status, res.body.slice(0, 800));
    let j: {
      error?: unknown;
      IsAppointmentBooked?: boolean;
      URL?: string | null;
      url?: string | null;
      payLoad?: string | null;
      payload?: string | null;
      appointmentDate?: string;
      appointmentTime?: string;
    };
    try {
      j = JSON.parse(res.body) as typeof j;
      if (j.error != null && j.error !== "") {
        throw new Error(`Schedule API error: ${JSON.stringify(j.error)}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Schedule API error")) throw e;
      throw new Error("Schedule: response is not JSON");
    }

    saveBookingConfirmationFile(payload, j, getCurrentInstanceId());

    const schedulePaymentUrl = buildScheduleRedirectUrl(j);
    if (schedulePaymentUrl) {
      setScheduleUrl(schedulePaymentUrl);
      logger.info({ urlPrefix: schedulePaymentUrl.slice(0, 80) }, "Stored schedule payment URL (URL + payLoad when present)");
      void new TelegramService()
        .alert("info", `A Slot is Booked. Open the link to pay for the slot: \n${schedulePaymentUrl}`, {
          booked: j.IsAppointmentBooked,
          date: j.appointmentDate,
          time: j.appointmentTime,
        })
        .catch(() => { });
    } else {
      logger.info({ IsAppointmentBooked: j.IsAppointmentBooked }, "Schedule OK; no URL in response to build payment link");
    }

    await this.callScheduleRedirectGetIfPresent(page, j);

    logger.info(
      { booked: j.IsAppointmentBooked, date: j.appointmentDate, time: j.appointmentTime },
      "Schedule retrieved OK"
    );
  }

  /**
   * Some schedule responses include redirect data as `url` + `payLoad`.
   * Navigate the current tab to `${url}?payLoad=${payLoad}` (real page redirect).
   */
  private async callScheduleRedirectGetIfPresent(
    page: Page,
    scheduleResponse: { URL?: string | null; url?: string | null; payLoad?: string | null; payload?: string | null }
  ): Promise<void> {
    const finalUrl = buildScheduleRedirectUrl(scheduleResponse);
    if (!finalUrl) return;

    const skipPaymentRedirect = /^true|1|yes$/i.test(
      (process.env.VFS_SKIP_SCHEDULE_PAYMENT_REDIRECT ?? "").trim()
    );
    if (skipPaymentRedirect) {
      logger.info(
        { urlPrefix: finalUrl.slice(0, 120) },
        "Skipping payment redirect after schedule (VFS_SKIP_SCHEDULE_PAYMENT_REDIRECT)"
      );
      return;
    }

    logger.info({ urlPrefix: finalUrl.slice(0, 120) }, "Navigating to schedule redirect URL with payLoad");

    /**
     * NOTE: `Sec-Fetch-Site` is browser-controlled and generally cannot be overridden via interception.
     * To get Chromium to emit `sec-fetch-site: same-site`, trigger a real navigation from within the
     * current document (initiator = current vfsglobal.com page) instead of Node-driven `page.goto`,
     * which can show up as `none` (no initiator).
     */
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45_000 }),
      page.evaluate((u) => window.location.assign(u), finalUrl),
    ]);
    logger.info({ redirectedTo: page.url() }, "Schedule redirect navigation completed");
  }

  private parseApplicantsResponseJson(body: string): { urn?: string; error?: unknown; applicantList?: unknown } {
    let parsed: { urn?: string; error?: unknown; applicantList?: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      throw new Error("Save applicants: response is not JSON");
    }
    if (parsed.error != null && parsed.error !== "") {
      throw new Error(`Save applicants API error: ${JSON.stringify(parsed.error)}`);
    }
    return parsed;
  }

  private getLiftApiPageContextFromSource(page: Page): { origin: string; referer: string; route: string } {
    const sourceUrl = page.url();
    const origin = new URL(sourceUrl).origin;
    const referer = sourceUrl.endsWith("/") ? sourceUrl : `${sourceUrl}/`;
    const pathname = new URL(sourceUrl).pathname;
    const route = pathname.split("/").filter(Boolean).slice(0, -1).join("/");
    return { origin, referer, route };
  }

  private assertVfsPageLoggedInForLiftApi(page: Page): void {
    let url = "";
    try {
      url = page.url();
    } catch {
      throw new Error("Lift-api call blocked: could not read the active tab URL.");
    }
    const kind = classifyVfsFirstTabUrl(url);
    if (kind === "login" || kind === "blank") {
      throw new Error(
        "Lift-api call blocked: VFS tab is still on login or blank. Complete login and OTP first; slot/API calls run only after a logged-in page."
      );
    }
  }

  private async postLiftJsonFromPage(
    page: Page,
    url: string,
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: string }> {
    this.assertVfsPageLoggedInForLiftApi(page);
    const { origin, referer, route } = this.getLiftApiPageContextFromSource(page);
    const clientSourceOverride: string | null = getCapturedClientSource()?.trim() || null;
    return page.evaluate(
      async (args: {
        url: string;
        payload: Record<string, unknown>;
        origin: string;
        referer: string;
        route: string;
        clientSourceOverride: string | null;
      }) => {
        const getStored = (keys: string[]): string | null => {
          try {
            for (const k of keys) {
              const v = sessionStorage.getItem(k) ?? localStorage.getItem(k);
              if (v) return v;
            }
            const w = window as unknown as Record<string, unknown>;
            for (const k of keys) {
              const v = w[k];
              if (typeof v === "string") return v;
            }
          } catch {
            /* ignore */
          }
          return null;
        };
        const getStoredByPrefix = (prefix: string): string | null => {
          try {
            for (let i = 0; i < sessionStorage.length; i++) {
              const k = sessionStorage.key(i);
              if (k && k.toLowerCase().includes(prefix)) {
                const v = sessionStorage.getItem(k);
                const t = v?.trim();
                if (t) return t;
              }
            }
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (k && k.toLowerCase().includes(prefix)) {
                const v = localStorage.getItem(k);
                const t = v?.trim();
                if (t) return t;
              }
            }
          } catch {
            /* ignore */
          }
          return null;
        };
        const authorize =
          getStored(["JWT", "authorize", "authToken", "token", "authorization"]) ?? getStoredByPrefix("auth");
        const fromStorage =
          getStored(["clientsource", "clientSource", "client_source"]) ?? getStoredByPrefix("client");
        const clientsource = args.clientSourceOverride?.trim() || fromStorage?.trim() || "";
        const headers: Record<string, string> = {
          "Content-Type": "application/json;charset=UTF-8",
          Accept: "application/json, text/plain, */*",
          Origin: args.origin,
          Referer: args.referer,
          route: args.route,
        };
        if (authorize?.trim()) headers.authorize = authorize.trim();
        if (clientsource) headers.clientsource = clientsource;
        const r = await fetch(args.url, {
          method: "POST",
          headers,
          body: JSON.stringify(args.payload),
          credentials: "include",
        });
        return { status: r.status, body: await r.text() };
      },
      { url, payload, origin, referer, route, clientSourceOverride }
    );
  }

  async runSlotCheckInBrowser(url: string, payload: Record<string, unknown>): Promise<{ status: number; body: string }> {
    const page = await this.getVfsPage();
    return this.postLiftJsonFromPage(page, url, payload);
  }

  private async dismissCookieConsent(page: Page, quickCheck: boolean = false): Promise<void> {
    const selectors = [
      'button:has-text("Accept All Cookies")',
      'button:has-text("Accept all")',
      'button:has-text("Accept")',
      '[data-accept-cookies], .cookie-accept, #accept-cookies',
    ];

    const maxWaitMs = quickCheck ? 3_000 : 120_000; // Quick check: 3s, Full wait: 120s
    const logPrefix = quickCheck ? "[Consent] Quick check" : "[Consent] Waiting";
    logger.info(`${logPrefix} for consent dialog (up to ${maxWaitMs / 1000} seconds)...`);

    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      for (const sel of selectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
            logger.info({ selector: sel }, "[Consent] Found consent button, clicking...");
            await btn.click({ timeout: 2000 });
            await page.waitForTimeout(1000);
            logger.info("[Consent] Consent dismissed successfully");
            return;
          }
        } catch {
          /* try next selector */
        }
      }
      await page.waitForTimeout(300); // Check every 300ms
    }

    logger.info(`[Consent] No consent dialog found after ${maxWaitMs / 1000} seconds, continuing...`);
  }

  private async fillLoginCredentials(
    page: Page,
    username: string,
    password: string,
    opts: { usernameSelectors: string; passwordSelectors: string; timeoutMs: number }
  ): Promise<void> {
    const deadline = Date.now() + opts.timeoutMs;
    // Use explicit locators only — getByLabel can resolve to a different element than the
    // querySelector-based verification, causing a perpetual "field empty" false negative.
    const emailLocator = page.locator(opts.usernameSelectors).first();
    const passwordLocator = page.locator(opts.passwordSelectors).first();

    while (Date.now() < deadline) {
      try {
        // Fill email — fill() already focuses the element; a preceding click() can place the
        // cursor at the end of existing text which causes fill() to append instead of replace.
        await emailLocator.waitFor({ state: "visible", timeout: 5000 });
        await emailLocator.fill(username, { timeout: 5000 });

        // Brief pause so Angular change-detection runs between fields
        await page.waitForTimeout(150);

        // Fill password
        await passwordLocator.waitFor({ state: "visible", timeout: 5000 });
        await passwordLocator.fill(password, { timeout: 5000 });

        // Verify both fields still have values — Angular may clear email during password fill.
        // Selector order: Angular formControlName first (most specific for VFS), then fallbacks.
        // input[type="email"] is intentionally last — other Angular SPA routes can leave hidden
        // type="email" inputs in the DOM that would give a false-empty read if checked first.
        const [actualEmail, actualPw] = await page
          .evaluate((selectors) => {
            const emailEl =
              document.querySelector<HTMLInputElement>('input[formControlName="username"]') ??
              document.querySelector<HTMLInputElement>('input[formControlName="email"]') ??
              document.querySelector<HTMLInputElement>('#email') ??
              document.querySelector<HTMLInputElement>('input[type="email"]') ??
              document.querySelector<HTMLInputElement>(selectors.username);
            // Exclude the OTP step field (formcontrolname="otp") when looking for the password field
            const pwEl =
              document.querySelector<HTMLInputElement>('input[formControlName="password"]') ??
              document.querySelector<HTMLInputElement>('input[name="password"]') ??
              document.querySelector<HTMLInputElement>('input[type="password"]:not([formcontrolname="otp"])') ??
              document.querySelector<HTMLInputElement>(selectors.password);
            return [emailEl?.value?.trim() ?? "", pwEl?.value?.trim() ?? ""] as [string, string];
          }, { username: opts.usernameSelectors, password: opts.passwordSelectors })
          .catch(() => ["", ""] as [string, string]);

        if (!actualEmail || !actualPw) {
          // Angular cleared one of the fields — retry
          await page.waitForTimeout(300);
          continue;
        }
        return;
      } catch (err) {
        await page.waitForTimeout(300);
      }
    }
    throw new Error("Failed to fill login credentials");
  }

  /**
   * Login submit: wait for Turnstile to auto-resolve, then click Sign In.
   */
  private async submitLoginImmediately(
    page: Page,
    submitBtn: import("playwright").Locator,
    opts: {
      loginRefill?: {
        username: string;
        password: string;
        usernameSelectors: string;
        passwordSelectors: string;
      };
    }
  ): Promise<void> {
    // Check if token already exists (auto-resolved)
    const existingToken = await page
      .evaluate(() => {
        const el =
          document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ??
          document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
        return (el as HTMLInputElement | null)?.value?.trim() ?? "";
      })
      .catch(() => "");

    if (existingToken) {
      logger.info({ tokenLength: existingToken.length }, "[Login] ✓ Using auto-resolved Turnstile token");
    } else {
      logger.info("[Login] Waiting up to 10s for Turnstile to auto-resolve...");
      const waitStart = Date.now();
      const deadline = waitStart + 10_000;
      let tokenValue = "";

      while (Date.now() < deadline) {
        tokenValue = await page
          .evaluate(() => {
            const el =
              document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ??
              document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
            return (el as HTMLInputElement | null)?.value?.trim() ?? "";
          })
          .catch(() => "");

        if (tokenValue) {
          logger.info(
            { tokenLength: tokenValue.length, elapsedMs: Date.now() - waitStart },
            "[Login] ✓ Turnstile auto-resolved within wait window"
          );
          break;
        }

        await page.waitForTimeout(200);
      }

      if (!tokenValue) {
        logger.warn("[Login] Turnstile did not auto-resolve within 10s — proceeding anyway");
        await page.waitForTimeout(5000);
      }
    }

    // After token injection/auto-resolve, Angular may take a moment to re-enable the submit button.
    // Poll `isEnabled()` briefly; if it never enables, forceClick will still attempt.
    try {
      await submitBtn.waitFor({ state: "visible", timeout: 10_000 });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const enabled = await submitBtn.isEnabled().catch(() => false);
        if (enabled) {
          logger.info("[Login] Sign In button is enabled");
          break;
        }
        await page.waitForTimeout(200);
      }
    } catch {
      logger.warn("[Login] Sign In button did not become enabled in time; forcing click anyway");
    }

    const readCfTurnstileToken = (): Promise<string> =>
      page
        .evaluate(() => {
          const els = [
            ...document.querySelectorAll<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]'),
            ...document.querySelectorAll<HTMLInputElement>('input[name="cf-turnstile-response"]'),
          ];
          for (const el of els) {
            const v = el.value?.trim();
            if (v) return v;
          }
          return "";
        })
        .catch(() => "");

    const turnstileTokenBeforeRefill = await readCfTurnstileToken();

    if (opts.loginRefill) {
      // logger.info(
      //   "[Login] Re-filling email/password before Sign In (after Turnstile; VFS/Angular sometimes clears fields while the widget solves)"
      // );
      // await this.fillLoginCredentials(page, opts.loginRefill.username, opts.loginRefill.password, {
      //   usernameSelectors: opts.loginRefill.usernameSelectors,
      //   passwordSelectors: opts.loginRefill.passwordSelectors,
      //   timeoutMs: 15_000,
      // });

      const turnstileAfterRefill = await readCfTurnstileToken();
      if (
        turnstileTokenBeforeRefill.length > 80 &&
        turnstileAfterRefill.length < turnstileTokenBeforeRefill.length * 0.5
      ) {
        logger.info("[Login] Turnstile token dropped after credential refill — re-injecting");
        await page.evaluate(injectTurnstileTokenInPage, turnstileTokenBeforeRefill);
      }
    }

    // Guard: verify fields are non-empty before submitting — Angular may have reset them.
    // If empty, retry the fill up to 3 more times before giving up.
    const readLoginFields = (): Promise<[string, string]> =>
      page
        .evaluate(() => {
          // formControlName selectors first — the VFS email input is type="text" not type="email",
          // and other SPA routes can leave hidden type="email" inputs in the DOM.
          const emailEl =
            document.querySelector<HTMLInputElement>('input[formControlName="username"]') ??
            document.querySelector<HTMLInputElement>('input[formControlName="email"]') ??
            document.querySelector<HTMLInputElement>('#email') ??
            document.querySelector<HTMLInputElement>('input[type="email"]');
          const pwEl =
            document.querySelector<HTMLInputElement>('input[formControlName="password"]') ??
            document.querySelector<HTMLInputElement>('input[name="password"]') ??
            document.querySelector<HTMLInputElement>('input[type="password"]:not([formcontrolname="otp"])');
          return [emailEl?.value?.trim() ?? "", pwEl?.value?.trim() ?? ""] as [string, string];
        })
        .catch(() => ["", ""] as [string, string]);

    let [preSubmitEmail, preSubmitPw] = await readLoginFields();

    if ((!preSubmitEmail || !preSubmitPw) && opts.loginRefill) {
      logger.warn(
        { hasEmail: !!preSubmitEmail, hasPw: !!preSubmitPw },
        "[Login] Fields empty after refill — Angular still clearing; retrying fill up to 3 more times"
      );
      for (let guardRetry = 0; guardRetry < 3; guardRetry++) {
        await this.fillLoginCredentials(page, opts.loginRefill.username, opts.loginRefill.password, {
          usernameSelectors: opts.loginRefill.usernameSelectors,
          passwordSelectors: opts.loginRefill.passwordSelectors,
          timeoutMs: 10_000,
        });
        [preSubmitEmail, preSubmitPw] = await readLoginFields();
        if (preSubmitEmail && preSubmitPw) break;
        await page.waitForTimeout(500);
      }
    }

    if (!preSubmitEmail || !preSubmitPw) {
      throw new Error(
        `Login fields empty before submit (email=${!!preSubmitEmail}, pw=${!!preSubmitPw}) — Angular cleared them; will retry login`
      );
    }

    // Token exists - try to trigger the SPA's click handler even if the button remains disabled.
    // VFS login often uses Angular click/ngSubmit handlers; native form submit may be a no-op.
    const triggered = await page
      .evaluate(() => {
        const btn =
          document.querySelector<HTMLButtonElement>('button[type="submit"]') ??
          (Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
            /sign\s*in|log\s*in/i.test((b.textContent || "").trim())
          ) ??
            null);
        const form =
          (btn?.closest("form") as HTMLFormElement | null) ??
          (document.querySelector("form") as HTMLFormElement | null);
        if (!btn && !form) return { ok: false, reason: "no_form_or_button_found" as const };

        // Force-enable button in DOM (Angular may still ignore, but click handlers will fire).
        if (btn) {
          (btn as HTMLButtonElement).disabled = false;
          btn.removeAttribute("disabled");
          btn.setAttribute("aria-disabled", "false");
        }

        // 1) Click path (SPA handler)
        try {
          btn?.click();
        } catch {
          /* ignore */
        }

        // 2) requestSubmit path (native submit + validation + submit handlers)
        const anyForm = form as any;
        if (form && typeof anyForm?.requestSubmit === "function") {
          try {
            anyForm.requestSubmit(btn ?? undefined);
            return { ok: true, reason: "button.click + requestSubmit" as const };
          } catch {
            // fall through
          }
        }

        // 3) submit event dispatch (framework listeners)
        if (form) {
          const ev = new Event("submit", { bubbles: true, cancelable: true });
          form.dispatchEvent(ev);
          return { ok: true, reason: "button.click + submit_event" as const };
        }

        return { ok: true, reason: "button.click_only" as const };
      })
      .catch(() => ({ ok: false, reason: "evaluate_failed" as const }));

    if (!triggered.ok) throw new Error(`Login submit trigger failed: ${triggered.reason}`);
    logger.info({ reason: triggered.reason }, "[Login] Login submit triggered");
  }

  private async forceClickSignInButton(
    page: Page,
    submitBtn: import("playwright").Locator
  ): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await submitBtn.evaluate((btn: HTMLElement) => {
          (btn as HTMLButtonElement).disabled = false;
          btn.removeAttribute("disabled");
        });
        await submitBtn.click({ timeout: 10_000, force: true });
        logger.info({ attempt }, "[Login] Sign In / submit button clicked");
        return;
      } catch (err) {
        logger.warn(
          { err, attempt, maxAttempts },
          "[Login] Sign In click failed (wrong selector, overlay, or detached button?)"
        );
        if (attempt === maxAttempts) {
          throw new Error(
            "Could not click Sign In after Turnstile — check the visible button in Chrome or try manual login."
          );
        }
        await page.waitForTimeout(500);
        const retryBtn = await this.resolveLoginSubmitButton(page);
        submitBtn = retryBtn;
      }
    }
  }

  private dashboardUrlRegex(): RegExp {
    return /\/(applications|dashboard|home)/i;
  }

  private async resolveLoginSubmitButton(page: Page): Promise<import("playwright").Locator> {
    let submitBtn = page.getByRole("button", { name: /sign in/i }).first();
    if (!(await submitBtn.isVisible().catch(() => false))) {
      submitBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first();
    }
    return submitBtn;
  }

  /** After OTP: VFS often labels the button Verify / Submit / Continue instead of Sign In. */
  private async resolvePostOtpSubmitButton(page: Page): Promise<import("playwright").Locator> {
    // India BGR (Angular Material): same URL as email step; primary action stays "Sign In" but stays
    // disabled until OTP is filled. getByRole often skips disabled buttons, so resolve by class + label.
    const orangeSignIn = page.locator("button.btn-brand-orange").filter({ hasText: /\bSign\s+In\b/i });
    const nOrange = await orangeSignIn.count();
    for (let i = 0; i < nOrange; i++) {
      const b = orangeSignIn.nth(i);
      if (await b.isVisible().catch(() => false)) return b;
    }
    const names = [/verify/i, /sign in/i, /submit/i, /continue/i, /confirm/i];
    for (const re of names) {
      const b = page.getByRole("button", { name: re }).first();
      if (await b.isVisible().catch(() => false)) return b;
    }
    const submit = page.locator('button[type="submit"]:not([disabled])').first();
    if (await submit.isVisible().catch(() => false)) return submit;
    return this.resolveLoginSubmitButton(page);
  }

  private getLoginOtpInputLocators(page: Page): import("playwright").Locator[] {
    return [
      // VFS Global (Angular): same /login URL; email/password hide, single password-type OTP field.
      page.locator('input[formcontrolname="otp"], input[formControlName="otp"]'),
      page.locator('input[type="password"][formcontrolname="otp"], input[type="password"][formControlName="otp"]'),
      page.getByLabel(/one[-\s]?time|otp|verification|security|authenticat/i),
      page.getByPlaceholder(/otp|verification|code|enter|\*+/i),
      page.locator('input[autocomplete="one-time-code"]'),
      page.locator('input[name*="otp" i]'),
      page.locator('input[name*="verification" i]'),
      page.locator('input[id*="otp" i]'),
      page.locator('input[id*="verification" i]'),
      page.locator("#otp, #verificationCode, #verification-code, #otpCode, #emailOTP"),
      page.getByRole("textbox", { name: /otp|verification|code/i }),
    ];
  }

  private async hasSegmentedOtpInputs(page: Page): Promise<{ locator: import("playwright").Locator; count: number } | null> {
    const selectors = [
      'input[inputmode="numeric"][maxlength="1"]',
      'input[type="tel"][maxlength="1"]',
      'input[type="text"][maxlength="1"]',
      'input[type="number"][maxlength="1"]',
      ".otp-input input",
      '[class*="otp"] input[type="text"]',
      '[class*="otp"] input[type="tel"]',
    ];
    for (const sel of selectors) {
      const loc = page.locator(sel);
      const n = await loc.count();
      if (n >= 4 && n <= 8) {
        if (await loc.first().isVisible().catch(() => false)) return { locator: loc, count: n };
      }
    }
    return null;
  }

  private async isLoginOtpFieldVisible(page: Page): Promise<boolean> {
    for (const loc of this.getLoginOtpInputLocators(page)) {
      if (await loc.first().isVisible().catch(() => false)) return true;
    }
    if (await this.hasSegmentedOtpInputs(page)) return true;
    return page.evaluate(() => {
      const visible = (el: Element | null) => {
        if (!(el instanceof HTMLElement)) return false;
        const st = window.getComputedStyle(el);
        return st.display !== "none" && st.visibility !== "hidden" && el.offsetParent !== null;
      };
      const trySel = (s: string) => {
        const el = document.querySelector(s);
        return visible(el);
      };
      return (
        trySel('input[formcontrolname="otp"]') ||
        trySel('input[formControlName="otp"]') ||
        trySel('input[autocomplete="one-time-code"]') ||
        !!Array.from(document.querySelectorAll('input[name*="otp" i], input[name*="verification" i]')).find(
          (e) => visible(e)
        )
      );
    });
  }

  private async fillLoginOtpField(page: Page, otpRaw: string): Promise<void> {
    const digits = otpRaw.replace(/\D/g, "");
    if (!digits) throw new Error("OTP has no digits");

    const seg = await this.hasSegmentedOtpInputs(page);
    if (seg && seg.count === digits.length) {
      for (let i = 0; i < seg.count; i++) {
        const box = seg.locator.nth(i);
        await box.click({ timeout: 3000 }).catch(() => { });
        await box.fill(digits[i]!);
      }
      logger.info({ segments: seg.count }, "OTP filled (segmented inputs)");
      return;
    }

    for (const loc of this.getLoginOtpInputLocators(page)) {
      const el = loc.first();
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 3000 }).catch(() => { });
        await el.fill("").catch(() => { });
        try {
          await el.fill(digits);
        } catch {
          await el.pressSequentially(digits, { delay: 35 });
        }
        return;
      }
    }

    if (seg) {
      const n = Math.min(seg.count, digits.length);
      for (let i = 0; i < n; i++) {
        await seg.locator.nth(i).click({ timeout: 2000 }).catch(() => { });
        await seg.locator.nth(i).fill(digits[i]!);
      }
      logger.warn({ segments: seg.count, otpLen: digits.length }, "OTP filled (partial segmented — check UI)");
      return;
    }

    throw new Error("Could not find OTP input to fill");
  }

  /**
   * Poll: SPA often shows OTP a few seconds after first Sign In — a single instant check misses it.
   */
  private async waitForDashboardOrOtpStep(
    page: Page,
    dash: RegExp,
    maxMs: number
  ): Promise<"dashboard" | "otp" | "neither"> {
    const deadline = Date.now() + maxMs;
    const t0 = Date.now();
    let iter = 0;
    let lastProgressLog = 0;
    logger.info({ maxMs }, "[login] Waiting for dashboard or OTP field...");
    while (Date.now() < deadline) {
      iter += 1;
      let url = "";
      try {
        url = page.url();
        if (dash.test(url)) {
          return "dashboard";
        }
      } catch (e) {
        if (isTargetClosedError(e)) {
          logger.warn({ step: "login.wait_dash_or_otp" }, "[login] Page/browser closed while waiting — returning 'neither'");
          return "neither";
        }
      }
      try {
        const otpVis = await this.isLoginOtpFieldVisible(page);
        if (otpVis) {
          return "otp";
        }
      } catch (e) {
        if (isTargetClosedError(e)) {
          logger.warn({ step: "login.wait_dash_or_otp" }, "[login] Page/browser closed while checking OTP — returning 'neither'");
          return "neither";
        }
      }
      const now = Date.now();
      if (now - lastProgressLog >= 5_000) {
        lastProgressLog = now;
        logger.info(
          { step: "login.wait_dash_or_otp", elapsedMs: now - t0, remainingMs: deadline - now, url },
          "[login] Still waiting for dashboard or OTP field..."
        );
      }
      try {
        await page.waitForTimeout(350);
      } catch (e) {
        if (isTargetClosedError(e)) {
          logger.warn({ step: "login.wait_dash_or_otp" }, "[login] Page/browser closed during wait — returning 'neither'");
          return "neither";
        }
        throw e;
      }
    }
    let finalUrl = "";
    try {
      finalUrl = page.url();
      if (dash.test(finalUrl)) return "dashboard";
    } catch {
      /* ignore */
    }
    try {
      if (await this.isLoginOtpFieldVisible(page)) return "otp";
    } catch {
      /* ignore */
    }
    logger.info(
      { step: "login.wait_dash_or_otp", result: "neither", finalUrl, maxMs },
      "[login] Window ended: neither dashboard nor OTP field detected"
    );
    return "neither";
  }

  /** Wait until an OTP control is visible (SPA may mount it late). */
  private async waitForLoginOtpField(page: Page, maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    let iter = 0;
    const logEvery = 15;
    while (Date.now() < deadline) {
      iter += 1;
      const visible = await this.isLoginOtpFieldVisible(page);
      if (visible) {
        let url = "";
        try {
          url = page.url();
        } catch {
          /* ignore */
        }
        return;
      }
      if (isMailTmVerbose() && iter % logEvery === 0) {
        let url = "";
        try {
          url = page.url();
        } catch {
          /* ignore */
        }
        logger.info(
          {
            step: "login.otp_field_wait",
            iter,
            remainingMs: deadline - Date.now(),
            url,
            otpFieldVisible: false,
          },
          "[login] still waiting for OTP UI…"
        );
      }
      try {
        await page.waitForTimeout(350);
      } catch (e) {
        if (isTargetClosedError(e)) {
          logger.warn({ step: "login.otp_field_wait" }, "[login] Page/browser closed while waiting for OTP field");
          throw new Error("Page closed while waiting for OTP field");
        }
        throw e;
      }
    }
    let finalUrl = "";
    try {
      finalUrl = page.url();
    } catch {
      /* ignore */
    }
    logger.error({ step: "login.otp_field_timeout", finalUrl, maxMs }, "[login] Timed out waiting for OTP field");
    throw new Error("Timed out waiting for OTP field on the login page");
  }

  private async completeOtpWithMailPromise(
    page: Page,
    mailOtpFetchPromise: Promise<string>,
    dash: RegExp
  ): Promise<void> {
    const fieldWaitMs = Math.max(config.mailTmOtpTimeoutMs + 15_000, 120_000);
    const t0 = Date.now();
    let fieldDone = false;
    let mailDone = false;
    const fieldP = this.waitForLoginOtpField(page, fieldWaitMs).then(() => {
      fieldDone = true;
    });
    const mailP = mailOtpFetchPromise.then((otp) => {
      mailDone = true;
      return otp;
    });
    const [, otp] = await Promise.all([fieldP, mailP]);
    await this.fillLoginOtpField(page, otp);
    await page.waitForTimeout(2000);
    await this.resubmitLoginAfterOtp(page);
    await page.waitForURL(dash, { timeout: 60_000 });
  }

  private async runLoginOtpCompletionFlow(
    page: Page,
    mailOtpFetchPromise: Promise<string> | null,
    dash: RegExp
  ): Promise<void> {
    if (mailOtpFetchPromise) {
      try {
        await this.completeOtpWithMailPromise(page, mailOtpFetchPromise, dash);
      } catch (err) {
        void mailOtpFetchPromise.catch(() => { });
        throw err;
      }
      return;
    }
    logger.info("No mail.tm inbox — enter OTP in Chrome, click Verify / Sign In; waiting for dashboard (up to 3 min)…");
    await page.waitForURL(dash, { timeout: 180_000 });
    logger.info("Logged in after OTP (manual)");
  }

  /** Second submit after OTP. Wait for BOTH OTP filled AND Turnstile valid, then click immediately. */
  private async resubmitLoginAfterOtp(page: Page): Promise<void> {
    const submitBtn = await this.resolvePostOtpSubmitButton(page);

    // Dismiss cookie consent if it appeared after the first Sign In (OTP page load).
    // The consent overlay can block the Turnstile iframe, preventing it from auto-resolving.
    await this.dismissCookieConsent(page, true);

    // Wait for both OTP to be filled AND Turnstile to be valid
    logger.info("[OTP] Waiting for OTP to be filled and Turnstile to be valid...");
    const deadline = Date.now() + 60_000; // 60 seconds for OTP fetching
    let turnstileSolveAttempted = false;

    while (Date.now() < deadline) {
      // Check if OTP is filled (using the same selectors as fillLoginOtpField)
      const otpFilled = await page
        .evaluate(() => {
          const visible = (el: Element | null): boolean => {
            if (!el || !(el instanceof HTMLElement)) return false;
            const st = window.getComputedStyle(el);
            return st.display !== "none" && st.visibility !== "hidden" && el.offsetParent !== null;
          };

          const getValue = (sel: string): string => {
            const el = document.querySelector<HTMLInputElement>(sel);
            return visible(el) && el ? (el.value || "") : "";
          };

          // Check single OTP input (VFS uses formcontrolname="otp")
          const single = getValue('input[formcontrolname="otp"]') ||
            getValue('input[formControlName="otp"]') ||
            getValue('input[autocomplete="one-time-code"]');
          if (single && single.length >= 4) return true;

          // Check by name attribute
          const byName = Array.from(document.querySelectorAll<HTMLInputElement>('input[name*="otp" i], input[name*="verification" i]'))
            .find(el => visible(el) && el.value && el.value.length >= 4);
          if (byName) return true;

          // Check segmented OTP inputs
          const segments = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="text"][maxlength="1"]'))
            .filter(el => visible(el));
          if (segments.length >= 4) {
            const filledCount = segments.filter(seg => seg.value).length;
            return filledCount >= 4;
          }

          return false;
        })
        .catch(() => false);

      // Check if Turnstile token exists
      const turnstileValid = await page
        .evaluate(() => {
          const el =
            document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ??
            document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
          return !!((el as HTMLInputElement | null)?.value?.trim());
        })
        .catch(() => false);

      // Check if OTP filled and Turnstile needs solving
      const elapsed = Date.now() - (deadline - 60_000);
      if (otpFilled && !turnstileSolveAttempted) {
        turnstileSolveAttempted = true;

        const readTurnstileResponse = () =>
          page
            .evaluate(() => {
              const el =
                document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ??
                document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
              return (el as HTMLInputElement | null)?.value?.trim() ?? "";
            })
            .catch(() => "");

        let tsToken = await readTurnstileResponse();

        if (tsToken) {
          logger.info({ tokenLength: tsToken.length }, "[OTP] ✓ Using auto-resolved Turnstile token");
        } else {
          logger.info("[OTP] Waiting up to 10s for Turnstile to auto-resolve...");
          const otpTsWaitStart = Date.now();
          const otpTsDeadline = otpTsWaitStart + 10_000;

          while (Date.now() < otpTsDeadline) {
            tsToken = await readTurnstileResponse();
            if (tsToken) {
              logger.info(
                { tokenLength: tsToken.length, elapsedMs: Date.now() - otpTsWaitStart },
                "[OTP] ✓ Turnstile auto-resolved within wait window"
              );
              break;
            }
            await page.waitForTimeout(200);
          }

          if (!tsToken) {
            logger.warn("[OTP] Turnstile did not auto-resolve within 10s — proceeding anyway");
            await page.waitForTimeout(3000);
          }
        }
      }

      if (otpFilled && turnstileValid) {
        logger.info({ elapsedMs: Date.now() - (deadline - 60_000) }, "[OTP] Both OTP filled and Turnstile valid - ready to submit");
        break;
      }

      // If Turnstile is stuck, try dismissing a late-appearing consent overlay that
      // may be covering the Turnstile iframe (one-shot, non-blocking).
      if (otpFilled && !turnstileValid && elapsed > 5_000 && elapsed < 5_500) {
        this.dismissCookieConsent(page, true).catch(() => { });
      }

      // Log progress every 2 seconds
      if (elapsed > 0 && elapsed % 2000 < 300) {
        logger.info({ otpFilled, turnstileValid, remainingMs: deadline - Date.now() }, "[OTP] Waiting...");
      }

      await page.waitForTimeout(300);
    }

    logger.info("[OTP] Clicking Sign In...");
    const dash = this.dashboardUrlRegex();
    const OTP_LOGIN_CAPTURE_MS = 120_000;
    /** After dashboard navigation, keep sniffing briefly — the `/user/login` response can follow the route change. */
    const OTP_LOGIN_POST_DASHBOARD_GRACE_MS = 3000;

    /** Ref: TS does not see assignments that happen only inside `page.on("response")` handlers. */
    const otpLoginCapture: { res: import("playwright").Response | null } = { res: null };
    let waitResolved = false;
    let resolvedViaDashboard = false;
    let responseDetachTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const detachResponseListener = () => {
      if (responseDetachTimer !== undefined) {
        clearTimeout(responseDetachTimer);
        responseDetachTimer = undefined;
      }
      page.off("response", onResponse);
    };

    const resolveOtpWait = () => {
      if (waitResolved) return;
      waitResolved = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      page.off("framenavigated", onFrameNav);
      outerResolveOtpCapture?.();
    };

    const finishOtpCaptureFull = () => {
      detachResponseListener();
      resolveOtpWait();
    };

    const onResponse = (res: import("playwright").Response) => {
      try {
        if (!responseIsLiftUserLoginPost(res)) return;
        otpLoginCapture.res = res;
        if (!waitResolved) {
          finishOtpCaptureFull();
        }
      } catch {
        /* ignore */
      }
    };

    const onFrameNav = (frame: import("playwright").Frame) => {
      if (waitResolved) return;
      if (frame !== page.mainFrame()) return;
      try {
        if (!dash.test(frame.url())) return;
        resolvedViaDashboard = true;
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        page.off("framenavigated", onFrameNav);
        resolveOtpWait();
        responseDetachTimer = setTimeout(() => {
          detachResponseListener();
        }, OTP_LOGIN_POST_DASHBOARD_GRACE_MS);
      } catch {
        /* ignore */
      }
    };

    let outerResolveOtpCapture: (() => void) | undefined;
    const waitForOtpCaptureDone = new Promise<void>((resolve) => {
      outerResolveOtpCapture = resolve;
      timeoutId = setTimeout(() => {
        if (waitResolved) return;
        finishOtpCaptureFull();
      }, OTP_LOGIN_CAPTURE_MS);
      page.on("response", onResponse);
      page.on("framenavigated", onFrameNav);
    });

    try {
      await this.forceClickSignInButton(page, submitBtn);
    } catch (err) {
      finishOtpCaptureFull();
      throw err;
    }
    await waitForOtpCaptureDone;

    let capturedOtpLogin = otpLoginCapture.res;
    if (!capturedOtpLogin && resolvedViaDashboard) {
      await page.waitForTimeout(OTP_LOGIN_POST_DASHBOARD_GRACE_MS);
      capturedOtpLogin = otpLoginCapture.res;
    }
    detachResponseListener();

    let onDashboard = false;
    try {
      onDashboard = dash.test(page.url());
    } catch {
      /* ignore */
    }

    if (capturedOtpLogin) {
      const body = await capturedOtpLogin.text().catch(() => "");
      const json = parseVfsUserLoginResponseBody(body);
      this.lastPostOtpLoginResponse = {
        status: capturedOtpLogin.status(),
        url: capturedOtpLogin.url(),
        body,
        json,
      };
      if (json) {
        const errObj = json.error as { code?: number; description?: string } | undefined;
        if (errObj && errObj.code === 413 && errObj.description === "Invalid Sender User") {
          logger.error(
            { status: capturedOtpLogin.status(), error: errObj },
            "[Login] Login failed — email not registered (error 413 / Invalid Sender User)"
          );
          void new TelegramService()
            .alert("error", "The entered email id is not registered.")
            .catch(() => { });
        }
        const flat = flattenVfsLoginResponseForProfile(json);
        if (flat) mergeVfsLoginProfile(flat);
      }
      logger.info(
        {
          status: this.lastPostOtpLoginResponse.status,
          url: this.lastPostOtpLoginResponse.url,
          bodyLength: body.length,
          isAuthenticated: json?.isAuthenticated,
          loginUser: json?.loginUser,
          accessTokenLength: json?.accessToken?.length,
          error: json?.error,
          bodyPreview: body.slice(0, 500),
        },
        "[Login] Captured POST lift-api /user/login response after OTP (2nd Sign In)"
      );
    } else if (onDashboard) {
      logger.info(
        { expectedUrl: VFS_LIFT_USER_LOGIN_URL },
        "[Login] On dashboard after OTP but no lift-api POST /user/login response captured (merge may use other sources)."
      );
    } else {
      logger.warn(
        { expectedUrl: VFS_LIFT_USER_LOGIN_URL },
        "[Login] Could not capture lift-api POST /user/login response after OTP (timeout or no matching response)."
      );
    }
  }

  private async finishLoginAfterFirstSubmit(
    page: Page,
    mailOtpFetchPromise: Promise<string> | null
  ): Promise<void> {
    const dash = this.dashboardUrlRegex();
    let startUrl = "";
    try {
      startUrl = page.url();
    } catch {
      /* ignore */
    }

    const phase = await this.waitForDashboardOrOtpStep(page, dash, 45_000);
    let urlAfterPhase = "";
    try {
      urlAfterPhase = page.url();
    } catch {
      /* ignore */
    }

    if (phase === "dashboard") {
      logger.info({ step: "login.no_otp_needed" }, "[login] Logged in (no OTP step); cancelling mail.tm poll if any");
      void mailOtpFetchPromise?.catch(() => { });
    } else if (phase === "otp") {
      await this.runLoginOtpCompletionFlow(page, mailOtpFetchPromise, dash);
    } else {
      logger.warn(
        { step: "login.phase1_neither", url: urlAfterPhase },
        "[login] Neither dashboard nor OTP detected in 45s — extending wait 90s"
      );
      const phase2 = await this.waitForDashboardOrOtpStep(page, dash, 90_000);
      let url2 = "";
      try {
        url2 = page.url();
      } catch {
        /* ignore */
      }
      logger.info({ step: "login.phase2", phase: phase2, url: url2 }, "[login] Phase2 result");

      if (phase2 === "dashboard") {
        void mailOtpFetchPromise?.catch(() => { });
      } else if (phase2 === "otp") {
        await this.runLoginOtpCompletionFlow(page, mailOtpFetchPromise, dash);
      } else if (mailOtpFetchPromise) {
        logger.info(
          { step: "login.phase2_try_mail_parallel" },
          "[login] Phase2 still ambiguous — trying mail.tm + OTP field parallel completion"
        );
        try {
          await this.completeOtpWithMailPromise(page, mailOtpFetchPromise, dash);
        } catch (err) {
          void mailOtpFetchPromise.catch(() => { });
          throw err;
        }
      } else {
        try {
          await page.waitForURL(dash, { timeout: 45_000 });
          logger.info({ step: "login.extended_dashboard" }, "[login] Reached dashboard after extended wait");
        } catch {
          /* assert below */
        }
      }
    }

    const kind = classifyVfsFirstTabUrl(page.url());
    let finalUrl = "";
    try {
      finalUrl = page.url();
    } catch {
      /* ignore */
    }

    if (kind === "login" || kind === "blank") {
      void mailOtpFetchPromise?.catch(() => { });
      throw new Error(
        "Login did not complete (still on login or blank). For auto OTP: VFS email/password must match a mail.tm mailbox (https://api.mail.tm/#/). Or finish OTP manually in Chrome."
      );
    }
  }


  /**
   * Detach Playwright from Chrome CDP; next `ensureBrowser()` reconnects.
   * For `connectOverCDP`, `Browser.close()` disconnects from DevTools only — Chrome keeps running.
   */
  async disconnectCdp(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => { });
      this.browser = null;
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => { });
      this.browser = null;
    }
  }
}

function injectTurnstileTokenInPage(token: string): void {
  const setVal = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const gatherResponseFields = (): Array<HTMLInputElement | HTMLTextAreaElement> => {
    const out: Array<HTMLInputElement | HTMLTextAreaElement> = [];
    const seen = new Set<Element>();
    const visit = (root: Document | ShadowRoot) => {
      root.querySelectorAll<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]').forEach((e) => {
        if (!seen.has(e)) {
          seen.add(e);
          out.push(e);
        }
      });
      root.querySelectorAll<HTMLInputElement>('input[name="cf-turnstile-response"]').forEach((e) => {
        if (!seen.has(e)) {
          seen.add(e);
          out.push(e);
        }
      });
      root.querySelectorAll("*").forEach((node) => {
        if (node instanceof HTMLElement && node.shadowRoot) visit(node.shadowRoot);
      });
    };
    visit(document);
    return out;
  };

  let fields = gatherResponseFields();

  if (fields.length === 0) {
    let host: HTMLElement | null = document.querySelector("form");

    if (!host) {
      const container = document.querySelector("app-cloudflare-captcha-container");
      if (container) {
        host = (container.closest("form") as HTMLElement) ?? container.parentElement ?? document.body;
      }
    }

    if (!host) {
      host = document.querySelector("[data-sitekey]")?.parentElement ?? document.body;
    }

    if (host) {
      const created = document.createElement("textarea");
      created.name = "cf-turnstile-response";
      created.style.display = "none";
      host.appendChild(created);
      console.log("[Turnstile] Created cf-turnstile-response field in", host.tagName);
      fields = gatherResponseFields();
    }
  }

  for (const el of fields) {
    setVal(el, token);
  }
  if (fields.length) {
    console.log("[Turnstile] Token injected into", fields.length, "field(s), length:", token.length);
  }

  document.querySelectorAll("[data-sitekey][data-callback]").forEach((node) => {
    const name = node.getAttribute("data-callback");
    if (!name) return;
    const fn = (window as unknown as Record<string, unknown>)[name];
    if (typeof fn === "function") (fn as (t: string) => void)(token);
  });

  const win = window as unknown as {
    turnstile?: { getResponse?: (widgetId?: string) => string; reset?: (widgetId?: string) => void };
  };
  if (win.turnstile && typeof win.turnstile === "object") {
    win.turnstile.getResponse = () => token;
  }

  if (win.turnstile) {
    let iframe = document.querySelector('iframe[src*="turnstile"]') as HTMLIFrameElement | null;

    if (!iframe) {
      const container = document.querySelector("app-cloudflare-captcha-container");
      if (container?.shadowRoot) {
        iframe = container.shadowRoot.querySelector('iframe[src*="turnstile"]') as HTMLIFrameElement | null;
      }
    }

    if (iframe) {
      iframe.dispatchEvent(new Event("load", { bubbles: true }));
    }
  }

  const form = document.querySelector("form");
  if (form) {
    form.dispatchEvent(new Event("change", { bubbles: true }));
    form.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

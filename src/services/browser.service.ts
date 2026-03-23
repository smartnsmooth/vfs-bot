import { chromium, Browser, BrowserContext, Page } from "playwright";
import { config } from "../config/config";
import { buildCalendarBody, CALENDAR_URL } from "../config/calendar";
import { buildScheduleBody, SCHEDULE_URL } from "../config/schedule";
import { buildTimeslotBody, TIMESLOT_URL } from "../config/timeslot";
import { buildFeesBody, FEES_URL } from "../config/fees";
import { buildSaveApplicantsBody, SAVE_APPLICANTS_URL } from "../config/saveApplicants";
import { logger } from "../utils/logger";
import { ensureApplicantIpResolved } from "../utils/applicantIp";
import { getAllocationId, setAllocationId } from "../utils/allocationId.store";
import { getApplicationUrn, setApplicationUrn } from "../utils/applicationUrn.store";
import { getSlotDate, setSlotDate } from "../utils/slotDate.store";
import { setTotalAmount } from "../utils/totalAmount.store";
import {
  getCapturedClientSource,
  setCapturedClientSource,
  waitForClientSourceCapture,
} from "../utils/capturedClientSource.store";
import { setScheduleUrl } from "../utils/scheduleUrl.store";
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
import { TurnstileService } from "./turnstile.service";

/** Sniff `clientsource` on any request to this host that sends the header (not only `/application`). */
const LIFT_API_HOST_MARKER = "lift-api.vfsglobal.com";

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
  private turnstile: TurnstileService | null = null;
  /** Avoid duplicate `request` listeners on the same CDP context. */
  private readonly clientSourceSnifferAttached = new WeakSet<BrowserContext>();

  private getTurnstile(): TurnstileService | null {
    if (!config.capmonsterEnabled || !config.capmonsterApiKey) return null;
    if (!this.turnstile) this.turnstile = new TurnstileService();
    return this.turnstile;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    const cdpUrl = config.browserCdpUrl;
    logger.info({ cdpUrl }, "Connecting to Chrome via CDP");
    this.browser = await chromium.connectOverCDP(cdpUrl);
    for (const ctx of this.browser.contexts()) {
      this.attachLiftApiClientSourceSniffer(ctx);
    }
    return this.browser;
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
        logger.info({ headerLen: cs.length, path }, "Captured clientsource from browser lift-api request");
      } catch {
        /* ignore */
      }
    });
  }

  async getFirstTabUrl(): Promise<string> {
    const browser = await this.ensureBrowser();
    const pages = browser.contexts()[0]?.pages() ?? [];
    const page = pages[0];
    if (!page) return "";
    try {
      return page.url();
    } catch {
      return "";
    }
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
      return browser.contexts()[0]?.pages()[0] ?? null;
    } catch {
      return null;
    }
  }

  async openLoginInFirstTab(): Promise<void> {
    const browser = await this.ensureBrowser();
    const context = browser.contexts()[0];
    if (!context) throw new Error("No browser context");
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(config.loginPageUrl, { waitUntil: "load", timeout: 30_000 });
  }

  /**
   * Run login on the first tab (must be on login page): fill credentials, Turnstile, submit.
   */
  async loginOnFirstTab(username: string, password: string): Promise<void> {
    const browser = await this.ensureBrowser();
    const context = browser.contexts()[0];
    if (!context) throw new Error("No browser context");
    const page = context.pages()[0];
    if (!page) throw new Error("No tab. Open the VFS login page in the first tab.");
    await page.bringToFront().catch(() => { });

    await this.dismissCookieConsent(page);

    const visibleOnly = ':not(.d-none):not([aria-hidden="true"])';
    const usernameSelectors = `input[name="username"]${visibleOnly}, input[name="email"]${visibleOnly}, input[type="email"]${visibleOnly}`;
    const passwordSelectors = `input[name="password"]${visibleOnly}, input[type="password"]${visibleOnly}`;

    await this.fillLoginCredentials(page, username, password, {
      usernameSelectors,
      passwordSelectors,
      timeoutMs: 25_000,
    });
    console.log("[Login] Credentials filled");

    const waitForManualTurnstile = !config.capmonsterEnabled;
    if (waitForManualTurnstile) {
      logger.info("Solve Turnstile in the browser, then press Enter here.");
      await waitForEnter();
    }

    await this.dismissCookieConsent(page);

    const submitBtn = await this.resolveLoginSubmitButton(page);

    const wantMailTm =
      config.mailTmOtpEnabled && username.trim().includes("@") && password.length > 0;
    logger.info(
      {
        step: "login.mail_tm_gate",
        mailTmOtpEnabled: config.mailTmOtpEnabled,
        wantMailTm,
        addressMasked: maskEmailForLog(username.trim()),
        passwordLen: password.length,
        mailTmVerbose: isMailTmVerbose(),
        otpTimeoutMs: config.mailTmOtpTimeoutMs,
        pollMs: config.mailTmPollIntervalMs,
      },
      "[login] mail.tm OTP automation gate (wantMailTm = enabled + email + password)"
    );

    /** Token + baseline before Sign In; OTP poll starts only after Sign In (avoids reading a previous OTP). */
    let mailTmReady: { token: string; baseline: Set<string> } | null = null;
    let mailOtpFetchPromise: Promise<string> | null = null;
    if (wantMailTm) {
      try {
        logger.info({ step: "login.mail_tm_begin" }, "[login] mail.tm: requesting token + baseline inbox snapshot");
        const mailToken = await fetchMailTmToken(username.trim(), password);
        const initial = await listMailTmMessages(mailToken, "baseline_before_sign_in");
        const mailBaseline = new Set<string>();
        for (const m of initial) {
          if (m.id) mailBaseline.add(m.id);
        }
        logger.info(
          {
            step: "login.mail_tm_baseline",
            baselineSize: mailBaseline.size,
            baselineIds: [...mailBaseline],
          },
          "[login] mail.tm: baseline ids — new mail after Sign In is OTP candidate"
        );
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

    await this.submitLoginAfterTurnstileCheck(page, submitBtn, { waitForManualTurnstile });

    if (mailTmReady) {
      const signInEpochMs = Date.now();
      const prePollMs = config.mailTmPostSignInDelayMs;
      if (prePollMs > 0) {
        logger.info(
          { step: "login.mail_tm_pre_poll_delay_ms", prePollMs, signInEpochMs },
          "[login] mail.tm: waiting before first OTP poll (VFS → inbox delivery lag)"
        );
        await new Promise<void>((r) => setTimeout(r, prePollMs));
      }
      logger.info(
        { step: "login.mail_tm_poll_start", signInEpochMs },
        "[login] mail.tm: starting OTP poll after Sign In (with createdAt filter for this login)"
      );
      mailOtpFetchPromise = waitForOtpFromMailTm(mailTmReady.token, mailTmReady.baseline, {
        timeoutMs: config.mailTmOtpTimeoutMs,
        pollMs: config.mailTmPollIntervalMs,
        signInEpochMs,
      });
    }

    await this.finishLoginAfterFirstSubmit(page, mailOtpFetchPromise);
    logger.info("Login flow complete");
  }

  /**
   * If `VFS_CLIENTSOURCE` is unset and nothing was captured yet, blocks until the browser POSTs
   * any lift-api request that sends `clientsource` (e.g. dashboard SPA) or until timeout.
   */
  async waitForLiftClientSourceIfNeeded(): Promise<void> {
    if (config.liftApiClientSource?.trim()) {
      logger.info("clientsource: using VFS_CLIENTSOURCE from env (skip wait)");
      return;
    }
    if (getCapturedClientSource()?.trim()) {
      logger.info("clientsource: already captured from browser");
      return;
    }
    await this.ensureBrowser();
    const timeoutMs = Math.max(
      5000,
      parseInt(process.env.VFS_WAIT_CLIENTSOURCE_MS ?? "180000", 10) || 180_000
    );
    logger.info(
      { timeoutMs },
      "No clientsource in env; waiting for a lift-api request with clientsource header (e.g. open or refresh VFS dashboard after login)..."
    );
    await waitForClientSourceCapture(timeoutMs);
    logger.info("clientsource captured; proceeding");
  }

  /**
   * After login, before slot polling: optionally open dashboard so the SPA can call lift-api with `clientsource`
   * (clientsource), then wait until `clientsource` is available.
   * Set `skipDashboardNavigate` after a setup-form resubmit — user stays on current URL; no forced `goto` dashboard.
   */
  async preparePollingAfterLogin(options?: { skipDashboardNavigate?: boolean }): Promise<void> {
    const page = await this.getVfsPage();
    const skipNav = options?.skipDashboardNavigate === true;
    if (!config.liftApiClientSource?.trim() && !skipNav) {
      try {
        const want = (config.pollingPageUrl ?? "").trim();
        const u = page.url().toLowerCase();
        if (want && !u.includes("dashboard") && !u.includes("applications")) {
          logger.info({ want }, "Navigating to dashboard so lift-api calls (clientsource) can run");
          await page.goto(want, { waitUntil: "domcontentloaded", timeout: 45_000 });
        }
        await page.waitForTimeout(2000);
      } catch (e) {
        logger.warn({ e }, "Pre-poll dashboard step failed; still waiting for clientsource");
      }
    }
    // Resubmit rounds skip dashboard nav; waiting here for a new /application would block and prevent slot checks.
    if (skipNav) {
      logger.info("Poll round after form resubmit — skipping clientsource wait; CheckIsSlotAvailable uses env/capture/storage from tab");
      return;
    }
    await this.waitForLiftClientSourceIfNeeded();
  }

  /** Call when a slot is found (uses current VFS tab). Also used after dashboard is shown. */
  async saveApplicantsViaLiftApi(): Promise<void> {
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
  async postCalendarLiftApi(): Promise<void> {
    const urn = getApplicationUrn();
    if (!urn?.trim()) {
      logger.warn("Skip calendar API: no urn in memory; save applicants successfully first");
      return;
    }
    const page = await this.getVfsPage();
    await this.postCalendarLiftApiOnPage(page, urn);
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
    const pollingPage = config.pollingPageUrl ?? "https://visa.vfsglobal.com/tza/en/nld/dashboard";
    const origin = new URL(pollingPage).origin;

    const page =
      pages.find((p) => {
        try {
          const u = p.url();
          return u.startsWith(pollingPage) || (u.startsWith(origin) && u.includes("dashboard"));
        } catch {
          return false;
        }
      }) ?? pages.find((p) => {
        try {
          return p.url().includes("visa.vfsglobal.com");
        } catch {
          return false;
        }
      });

    if (!page) throw new Error(`No VFS tab open. Keep ${pollingPage} (or dashboard) open in a tab.`);
    this.attachLiftApiClientSourceSniffer(page.context());
    return page;
  }

  private async saveApplicantsViaLiftApiOnPage(page: Page): Promise<void> {
    logger.info("Waiting 3s before save applicants API");
    await page.waitForTimeout(3000);
    const body = buildSaveApplicantsBody();
    logger.info({ url: SAVE_APPLICANTS_URL }, "Saving applicant via lift-api");
    const beforeCfClearance = await this.getLiftApiCfClearanceValue(page);

    const first = await this.postLiftJsonFromPage(page, SAVE_APPLICANTS_URL, body);
    console.log("[Applicants] HTTP", first.status, first.body.slice(0, 500));
    if (first.status < 200 || first.status >= 300) {
      // Cloudflare challenge: manual browser calls show a Turnstile iframe; fetch-only calls often return 403 HTML.
      if (this.isCloudflareJustAMoment(first.status, first.body)) {
        const mode = this.getCfChallengeRecoveryMode();
        logger.warn({ status: first.status, mode }, "Cloudflare challenge detected. Recovering cf_clearance then retrying once...");

        await this.recoverCfClearanceForLiftApi(page, mode);
        await this.waitForLiftApiCfClearanceChange(page, beforeCfClearance);

        const retry = await this.postLiftJsonFromPage(page, SAVE_APPLICANTS_URL, body);
        console.log("[Applicants] Retry HTTP", retry.status, retry.body.slice(0, 500));
        if (retry.status < 200 || retry.status >= 300) {
          throw new Error(`Save applicants failed after retry HTTP ${retry.status}: ${retry.body.slice(0, 300)}`);
        }

        const parsedRetry = this.parseApplicantsResponseJson(retry.body);
        if (parsedRetry.urn) setApplicationUrn(parsedRetry.urn);
        logger.info({ urn: parsedRetry.urn }, "Applicants saved (retry)");
        return;
      }

      throw new Error(`Save applicants failed HTTP ${first.status}: ${first.body.slice(0, 300)}`);
    }

    const parsed = this.parseApplicantsResponseJson(first.body);
    if (parsed.urn) setApplicationUrn(parsed.urn);
    logger.info({ urn: parsed.urn }, "Applicants saved");
  }

  private async postFeesLiftApiOnPage(page: Page, urn: string): Promise<void> {
    const feesPayload = buildFeesBody(urn);
    logger.info({ url: FEES_URL }, "Calling lift-api fees");
    const res = await this.postLiftJsonFromPage(page, FEES_URL, feesPayload);
    console.log("[Fees] HTTP", res.status, res.body.slice(0, 500));
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Fees failed HTTP ${res.status}: ${res.body.slice(0, 300)}`);
    }
    try {
      const j = JSON.parse(res.body) as {
        error?: unknown;
        totalAmount?: unknown;
        totalamount?: unknown;
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
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Fees API error")) throw e;
      throw new Error("Fees: response is not JSON");
    }
    logger.info("Fees retrieved OK");
  }

  private async postCalendarLiftApiOnPage(page: Page, urn: string): Promise<void> {
    const payload = buildCalendarBody(urn);
    logger.info({ url: CALENDAR_URL, fromDate: payload.fromDate }, "Calling lift-api calendar");
    const res = await this.postLiftJsonFromPage(page, CALENDAR_URL, payload);
    console.log("[Calendar] HTTP", res.status, res.body.slice(0, 800));
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Calendar failed HTTP ${res.status}: ${res.body.slice(0, 300)}`);
    }
    let j: { error?: unknown; calendars?: Array<{ date?: string; isWeekend?: boolean }> };
    try {
      j = JSON.parse(res.body) as typeof j;
      if (j.error != null && j.error !== "") {
        throw new Error(`Calendar API error: ${JSON.stringify(j.error)}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Calendar API error")) throw e;
      throw new Error("Calendar: response is not JSON");
    }
    const first = j.calendars?.[0]?.date?.trim();
    if (first) {
      setSlotDate(first);
      logger.info({ slotDate: first }, "Stored first calendar date as slotDate");
    } else {
      logger.warn("Calendar response has no calendars[0].date; slotDate not set");
    }
    logger.info("Calendar retrieved OK");
  }

  private async postTimeslotLiftApiOnPage(page: Page, urn: string, slotDateFromCalendar: string): Promise<void> {
    const payload = buildTimeslotBody(urn, slotDateFromCalendar);
    logger.info({ url: TIMESLOT_URL, slotDate: payload.slotDate }, "Calling lift-api timeslot");
    const res = await this.postLiftJsonFromPage(page, TIMESLOT_URL, payload);
    console.log("[Timeslot] HTTP", res.status, res.body.slice(0, 800));
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Timeslot failed HTTP ${res.status}: ${res.body.slice(0, 300)}`);
    }
    let j: {
      error?: unknown;
      slots?: Array<{ allocationId?: string; slot?: string; type?: string }>;
    };
    try {
      j = JSON.parse(res.body) as typeof j;
      if (j.error != null && j.error !== "") {
        throw new Error(`Timeslot API error: ${JSON.stringify(j.error)}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Timeslot API error")) throw e;
      throw new Error("Timeslot: response is not JSON");
    }
    const alloc = j.slots?.[0]?.allocationId?.trim();
    if (alloc) {
      setAllocationId(alloc);
      logger.info({ allocationIdPrefix: alloc.slice(0, 16) }, "Stored first slot allocationId");
    } else {
      logger.warn("Timeslot response has no slots[0].allocationId");
    }
    logger.info("Timeslot retrieved OK");
  }

  private async postScheduleLiftApiOnPage(page: Page, urn: string, allocationId: string): Promise<void> {
    const payload = buildScheduleBody(urn, allocationId);
    logger.info({ url: SCHEDULE_URL }, "Calling lift-api schedule");
    const res = await this.postLiftJsonFromPage(page, SCHEDULE_URL, payload);
    console.log("[Schedule] HTTP", res.status, res.body.slice(0, 800));
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Schedule failed HTTP ${res.status}: ${res.body.slice(0, 300)}`);
    }
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
    if (j.URL != null && String(j.URL).trim() !== "") {
      const scheduleUrl = String(j.URL).trim();
      setScheduleUrl(j.URL);
      logger.info({ urlPrefix: scheduleUrl.slice(0, 80) }, "Stored schedule response URL");
      void new TelegramService()
        .alert("info", `A Slot is Booked. Open the link to pay for the slot: \n${scheduleUrl}`, {
          booked: j.IsAppointmentBooked,
          date: j.appointmentDate,
          time: j.appointmentTime,
        })
        .catch(() => { });
    } else {
      logger.info({ IsAppointmentBooked: j.IsAppointmentBooked }, "Schedule OK; response URL empty or null");
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
    const baseUrl = String(scheduleResponse.url ?? scheduleResponse.URL ?? "").trim();
    if (!baseUrl) return;

    // If backend already returns a full redirect URL with payLoad, preserve it exactly.
    const hasPayLoadInUrl = /[?&]payLoad=/.test(baseUrl);
    const payLoad = String(scheduleResponse.payLoad ?? scheduleResponse.payload ?? "").trim();
    const finalUrl = hasPayLoadInUrl
      ? baseUrl
      : (!payLoad ? "" : `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}payLoad=${payLoad}`);
    if (!finalUrl) return;

    logger.info({ urlPrefix: finalUrl.slice(0, 120) }, "Navigating to schedule redirect URL with payLoad");
    await page.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    logger.info({ redirectedTo: page.url() }, "Schedule redirect navigation completed");
  }

  private isCloudflareJustAMoment(status: number, body: string): boolean {
    if (status !== 403) return false;
    const s = body.toLowerCase();
    return s.includes("just a moment") || s.includes("cf-browser-verification") || s.includes("turnstile");
  }

  private getCfChallengeRecoveryMode(): "new_tab" | "same_tab" {
    const raw = process.env.VFS_CF_CHALLENGE_RECOVERY_MODE ?? "new_tab";
    const v = raw.toLowerCase().trim();
    if (v === "same_tab" || v === "sometab" || v === "same") return "same_tab";
    return "new_tab";
  }

  private async getLiftApiCfClearanceValue(page: Page): Promise<string | null> {
    const cookies = await page.context().cookies(["https://lift-api.vfsglobal.com"]);
    const cf = cookies.find((c) => c.name === "cf_clearance");
    return cf?.value?.trim() ?? null;
  }

  private async waitForLiftApiCfClearanceChange(page: Page, before: string | null): Promise<void> {
    const timeoutMs = 25_000;
    const pollMs = 500;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = await this.getLiftApiCfClearanceValue(page);
      if (now && now !== before) return;
      await page.waitForTimeout(pollMs);
    }
    logger.warn("cf_clearance did not change within timeout; retry may still fail.");
  }

  /**
   * Trigger Cloudflare challenge in a real browser context so cf_clearance updates.
   * mode=new_tab is safest (uses a temporary tab).
   * mode=same_tab navigates current tab to the lift-api URL and then returns back.
   */
  private async recoverCfClearanceForLiftApi(page: Page, mode: "new_tab" | "same_tab"): Promise<void> {
    const liftUrl = SAVE_APPLICANTS_URL;

    if (mode === "new_tab") {
      const tmp = await page.context().newPage();
      try {
        await tmp.goto(liftUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await this.maybeSolveTurnstileInRecoveryPage(tmp);
        await tmp.waitForTimeout(1500);
      } finally {
        await tmp.close().catch(() => { });
      }
      return;
    }

    const prevUrl = (() => {
      try {
        return page.url();
      } catch {
        return "";
      }
    })();

    try {
      await page.goto(liftUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.maybeSolveTurnstileInRecoveryPage(page);
      await page.waitForTimeout(1500);
    } finally {
      const restore = prevUrl || config.pollingPageUrl || "https://visa.vfsglobal.com/";
      await page.goto(restore, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => { });
    }
  }

  private async maybeSolveTurnstileInRecoveryPage(page: Page): Promise<void> {
    if (config.capmonsterEnabled && config.capmonsterApiKey) {
      // Solve if a Turnstile widget exists on the recovery page.
      await this.solveAndInjectTurnstile(page, page.url());
      return;
    }
    logger.info("Recovery page: please solve Turnstile in the browser, then press Enter in this terminal.");
    await waitForEnter();
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
    const clientSourceOverride =
      config.liftApiClientSource?.trim() || getCapturedClientSource()?.trim() || null;
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

  private async dismissCookieConsent(page: Page): Promise<void> {
    const selectors = [
      'button:has-text("Accept All Cookies")',
      'button:has-text("Accept all")',
      'button:has-text("Accept")',
      '[data-accept-cookies], .cookie-accept, #accept-cookies',
    ];
    for (const sel of selectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 })) {
          await btn.click({ timeout: 2000 });
          await page.waitForTimeout(500);
          return;
        }
      } catch {
        /* next */
      }
    }
  }

  private async fillLoginCredentials(
    page: Page,
    username: string,
    password: string,
    opts: { usernameSelectors: string; passwordSelectors: string; timeoutMs: number }
  ): Promise<void> {
    const deadline = Date.now() + opts.timeoutMs;
    const emailByLabel = page.getByLabel(/email/i).first();
    const passwordByLabel = page.getByLabel(/password/i).first();

    while (Date.now() < deadline) {
      try {
        if (await emailByLabel.isVisible().catch(() => false)) {
          await emailByLabel.fill(username, { timeout: 5000 });
        } else {
          await page.locator(opts.usernameSelectors).first().waitFor({ state: "visible", timeout: 5000 });
          await page.locator(opts.usernameSelectors).first().fill(username, { timeout: 5000 });
        }
        if (await passwordByLabel.isVisible().catch(() => false)) {
          await passwordByLabel.fill(password, { timeout: 5000 });
        } else {
          await page.locator(opts.passwordSelectors).first().fill(password, { timeout: 5000 });
        }
        return;
      } catch (err) {
        await page.waitForTimeout(300);
      }
    }
    throw new Error("Failed to fill login credentials");
  }

  private async submitLoginAfterTurnstileCheck(
    page: Page,
    submitBtn: import("playwright").Locator,
    opts: { waitForManualTurnstile: boolean }
  ): Promise<void> {
    const tokenValue = await page
      .evaluate(() => {
        const el =
          document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ??
          document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
        return (el as HTMLInputElement | null)?.value?.trim() ?? "";
      })
      .catch(() => "");

    if (!tokenValue) {
      if (this.getTurnstile() && !opts.waitForManualTurnstile) {
        await this.solveAndInjectTurnstile(page, page.url());
      } else if (opts.waitForManualTurnstile) {
        await waitForEnter();
      } else {
        await this.tryClickTurnstileCheckbox(page);
      }
    } else {
      await page.evaluate(injectTurnstileTokenInPage, tokenValue).catch(() => { });
      await page.waitForTimeout(500);
    }

    await this.forceClickSignInButton(page, submitBtn);
    await page.waitForTimeout(1200);
    if (page.url().toLowerCase().includes("/login")) {
      await this.submitLoginFormFromButton(page, submitBtn);
      await page.waitForTimeout(1200);
    }
  }

  private async forceClickSignInButton(
    page: Page,
    submitBtn: import("playwright").Locator
  ): Promise<boolean> {
    try {
      await submitBtn.evaluate((btn: HTMLElement) => {
        (btn as HTMLButtonElement).disabled = false;
        btn.removeAttribute("disabled");
      });
      await submitBtn.click({ timeout: 10_000, force: true });
      return true;
    } catch {
      return false;
    }
  }

  private async submitLoginFormFromButton(
    page: Page,
    submitBtn: import("playwright").Locator
  ): Promise<boolean> {
    try {
      const ok = await submitBtn.evaluate((el) => {
        const form = (el as HTMLElement).closest("form") as HTMLFormElement | null;
        if (!form) return false;
        (form as unknown as { requestSubmit?: () => void }).requestSubmit?.();
        return true;
      });
      if (ok) await page.waitForTimeout(1500);
      return !!ok;
    } catch {
      return false;
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
    logger.info(
      { step: "login.fill_otp_start", digitLen: digits.length, last2: digits.slice(-2) },
      "[login] Filling OTP into page (digits only; full value not logged)"
    );

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
        logger.info({ len: digits.length }, "OTP filled (single input)");
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
    let iter = 0;
    let lastProgressLog = 0;
    while (Date.now() < deadline) {
      iter += 1;
      let url = "";
      try {
        url = page.url();
        if (dash.test(url)) {
          logger.info({ step: "login.wait_dash_or_otp", result: "dashboard", iter, url }, "[login] Dashboard URL matched");
          return "dashboard";
        }
      } catch {
        /* ignore */
      }
      const otpVis = await this.isLoginOtpFieldVisible(page);
      if (otpVis) {
        logger.info({ step: "login.wait_dash_or_otp", result: "otp", iter, url }, "[login] OTP field visible");
        return "otp";
      }
      const now = Date.now();
      if (isMailTmVerbose() && now - lastProgressLog >= 10_000) {
        lastProgressLog = now;
        logger.info(
          {
            step: "login.wait_dash_or_otp_progress",
            iter,
            remainingMs: deadline - now,
            url,
            otpFieldVisible: otpVis,
          },
          "[login] Still waiting for dashboard URL or OTP UI…"
        );
      }
      await page.waitForTimeout(350);
    }
    let finalUrl = "";
    try {
      finalUrl = page.url();
      if (dash.test(finalUrl)) return "dashboard";
    } catch {
      /* ignore */
    }
    if (await this.isLoginOtpFieldVisible(page)) return "otp";
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
        logger.info({ step: "login.otp_field_visible", iter, url }, "[login] OTP field detected in page");
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
      await page.waitForTimeout(350);
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
    logger.info(
      {
        step: "login.otp_parallel_start",
        fieldWaitMs,
        dashboardPattern: String(dash),
      },
      "[login] Parallel wait: (A) OTP field in browser + (B) OTP string from mail.tm poll"
    );
    const t0 = Date.now();
    let fieldDone = false;
    let mailDone = false;
    const fieldP = this.waitForLoginOtpField(page, fieldWaitMs).then(() => {
      fieldDone = true;
      logger.info(
        { step: "login.otp_parallel_branch", branch: "A_field", ms: Date.now() - t0, fieldDone, mailDone },
        "[login] Branch A finished: OTP field visible"
      );
    });
    const mailP = mailOtpFetchPromise.then((otp) => {
      mailDone = true;
      logger.info(
        {
          step: "login.otp_parallel_branch",
          branch: "B_mail",
          ms: Date.now() - t0,
          fieldDone,
          mailDone,
          otpLen: otp.length,
          otpLast2: otp.slice(-2),
        },
        "[login] Branch B finished: OTP received from API"
      );
      return otp;
    });
    const [, otp] = await Promise.all([fieldP, mailP]);
    logger.info({ step: "login.otp_both_ready", ms: Date.now() - t0 }, "[login] Both branches done — filling OTP in page");
    await this.fillLoginOtpField(page, otp);
    logger.info(
      { step: "login.otp_post_fill_turnstile_wait" },
      "[login] Waiting 2s after OTP fill for Cloudflare Turnstile (auto or manual)…"
    );
    await page.waitForTimeout(2000);
    logger.info({ step: "login.otp_post_fill" }, "[login] OTP filled — clicking Verify / Sign In");
    await this.resubmitLoginAfterOtp(page);
    logger.info({ step: "login.otp_wait_dashboard" }, "[login] Waiting for post-login URL (dashboard/applications)…");
    await page.waitForURL(dash, { timeout: 60_000 });
    logger.info({ step: "login.otp_done" }, "[login] Logged in after OTP (mail.tm)");
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

  /** Second submit after OTP (Turnstile usually still valid). */
  private async resubmitLoginAfterOtp(page: Page): Promise<void> {
    await page.waitForTimeout(400);
    const submitBtn = await this.resolvePostOtpSubmitButton(page);
    await this.forceClickSignInButton(page, submitBtn);
    await page.waitForTimeout(1500);
    if (page.url().toLowerCase().includes("/login")) {
      await this.submitLoginFormFromButton(page, submitBtn);
      await page.waitForTimeout(1500);
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
    logger.info(
      {
        step: "login.after_first_submit",
        url: startUrl,
        hasMailOtpPromise: !!mailOtpFetchPromise,
      },
      "[login] After first Sign In — polling for dashboard vs OTP step"
    );

    const phase = await this.waitForDashboardOrOtpStep(page, dash, 45_000);
    let urlAfterPhase = "";
    try {
      urlAfterPhase = page.url();
    } catch {
      /* ignore */
    }
    logger.info({ step: "login.phase1", phase, url: urlAfterPhase }, "[login] Phase1 result (45s poll)");

    if (phase === "dashboard") {
      logger.info({ step: "login.no_otp_needed" }, "[login] Logged in (no OTP step); cancelling mail.tm poll if any");
      void mailOtpFetchPromise?.catch(() => { });
    } else if (phase === "otp") {
      logger.info({ step: "login.phase1_otp" }, "[login] OTP UI detected in phase1 — running completion flow");
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
    logger.info({ step: "login.pre_assert", kind, url: finalUrl }, "[login] Final URL classification before lift-api gate");

    if (kind === "login" || kind === "blank") {
      void mailOtpFetchPromise?.catch(() => { });
      throw new Error(
        "Login did not complete (still on login or blank). For auto OTP: VFS email/password must match a mail.tm mailbox (https://api.mail.tm/#/). Or finish OTP manually in Chrome."
      );
    }
  }

  private async tryClickTurnstileCheckbox(page: Page): Promise<void> {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      try {
        const frame = page.frameLocator('iframe[src*="turnstile" i], iframe[title*="turnstile" i]').first();
        const checkbox = frame.locator('input[type="checkbox"], [role="checkbox"]').first();
        if (await checkbox.isVisible({ timeout: 800 }).catch(() => false)) {
          await checkbox.click({ timeout: 2000 }).catch(() => { });
          return;
        }
      } catch {
        /* keep trying */
      }
      await page.waitForTimeout(250);
    }
  }

  private async solveAndInjectTurnstile(page: Page, pageUrl: string): Promise<void> {
    const deadline = Date.now() + 12_000;
    let params: { sitekey: string; action?: string; data?: string } | null = null;
    while (Date.now() < deadline) {
      params = await page.evaluate(extractTurnstileParamsFull);
      if (params?.sitekey) break;
      await page.waitForTimeout(400);
    }
    if (!params?.sitekey) {
      logger.warn("No Turnstile sitekey found");
      return;
    }
    const solver = this.getTurnstile();
    if (!solver) return;
    try {
      const token = await solver.solve(pageUrl.split("#")[0], params.sitekey, {
        pageAction: params.action,
        data: params.data,
      });
      await page.evaluate(injectTurnstileTokenInPage, token);
      await page.waitForTimeout(500);
    } catch (err) {
      logger.error({ err }, "Turnstile solve failed");
      throw err;
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

function extractTurnstileParamsFull(): { sitekey: string; action?: string; data?: string } | null {
  let sitekey: string | null = null;
  let action: string | undefined;
  let data: string | undefined;
  const widgets = document.querySelectorAll("[data-sitekey]");
  for (const el of Array.from(widgets)) {
    const sk = el.getAttribute("data-sitekey");
    if (sk && sk.length >= 8) {
      sitekey = sk;
      action = el.getAttribute("data-action") ?? undefined;
      data = el.getAttribute("data-cdata") ?? el.getAttribute("data-challenge") ?? undefined;
      break;
    }
  }
  if (!sitekey) {
    const ifr = document.querySelector('iframe[src*="turnstile" i], iframe[src*="challenges.cloudflare" i]') as HTMLIFrameElement | null;
    if (ifr?.src) {
      try {
        const k = new URL(ifr.src).searchParams.get("k");
        if (k) sitekey = k;
      } catch {
        /* ignore */
      }
    }
  }
  if (!sitekey) return null;
  return { sitekey, action, data };
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
  let el: HTMLInputElement | HTMLTextAreaElement | null =
    document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ??
    document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
  if (!el) {
    const host = document.querySelector("[data-sitekey]")?.parentElement ?? document.querySelector("form");
    if (host) {
      el = document.createElement("textarea");
      el.name = "cf-turnstile-response";
      host.appendChild(el);
    }
  }
  if (el) setVal(el, token);
  document.querySelectorAll("[data-sitekey][data-callback]").forEach((node) => {
    const name = node.getAttribute("data-callback");
    if (!name) return;
    const fn = (window as unknown as Record<string, unknown>)[name];
    if (typeof fn === "function") (fn as (t: string) => void)(token);
  });
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Press Enter when Turnstile is done in the browser... ", () => {
      rl.close();
      resolve();
    });
  });
}

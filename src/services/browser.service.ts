import { chromium, Browser, BrowserContext, Page } from "playwright";
import { config } from "../config/config";
import { isIndDeuRoute } from "../utils/vfsRoute";
import { ensureApplicantIpResolved } from "../utils/applicantIp";
import { getAllocationId } from "../utils/allocationId.store";
import { getApplicationUrn } from "../utils/applicationUrn.store";
import {
  getCapturedClientSource,
  setCapturedClientSource,
  waitForClientSourceCapture,
} from "../utils/capturedClientSource.store";
import { classifyVfsFirstTabUrl } from "../flows/vfsTabUrl";
import { getApplicantFormServerOrigin, isApplicantFormServerUrl } from "../ui/applicantDetailsFormServer";
import { TelegramService } from "./telegram.service";
import {
  classifyVfs429FromPageText,
  classifyVfs429,
} from "../utils/vfsRateLimit";
import { isCloudflareChallengeBody } from "../utils/apiCallLog";

// ── Re-exports for backward compatibility ───────────────────────────────
export {
  VfsForbiddenError,
  VfsGatewayTimeoutError,
  VfsRateLimitedError,
  AlreadyBookedError,
  isTargetClosedError,
  isFailedToFetchError,
  readClientSourceHeader,
  LIFT_API_HOST_MARKER,
  injectTurnstileTokenInPage,
  type PostOtpLoginCapture,
  type VfsUserLoginResponse,
} from "./browser.errors";

import {
  VfsForbiddenError,
  readClientSourceHeader,
  LIFT_API_HOST_MARKER,
  throwVfsRateLimited,
  type PostOtpLoginCapture,
} from "./browser.errors";

// ── Booking module (lift-api POST calls) ────────────────────────────────
import {
  postLiftJsonFromPage,
  saveApplicantsOnPage,
  postFeesOnPage,
  fetchCalendarDatesForFleetOnPage,
  fetchTimeslotAllocationsForFleetOnPage,
  postMapVasOnPage,
  postScheduleOnPage,
  type FleetTimeslotEntry,
} from "./browser.booking";

// ── Login module ────────────────────────────────────────────────────────
import {
  performLoginOnFirstTab,
  openLoginInFirstTab as loginModuleOpenLogin,
  logoutVfsAndOpenLoginFirstTab as loginModuleLogoutAndOpen,
} from "./browser.login";

import type { BrowserServiceCore } from "./browser.core";

export class BrowserService implements BrowserServiceCore {
  private browser: Browser | null = null;
  private readonly clientSourceSnifferAttached = new WeakSet<BrowserContext>();
  private lastPostOtpLoginResponse_: PostOtpLoginCapture | null = null;

  getLastPostOtpLoginResponse(): PostOtpLoginCapture | null {
    return this.lastPostOtpLoginResponse_;
  }

  setLastPostOtpLoginResponse(capture: PostOtpLoginCapture | null): void {
    this.lastPostOtpLoginResponse_ = capture;
  }

  // ── Core plumbing ───────────────────────────────────────────────────

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    const cdpUrl = config.browserCdpUrl;
    this.browser = await chromium.connectOverCDP(cdpUrl);
    for (const ctx of this.browser.contexts()) {
      this.attachLiftApiClientSourceSniffer(ctx);
      await this.applyDefaultZoomOnContext(ctx).catch(() => { });
    }
    return this.browser;
  }

  /** Keep Chrome page zoom at 75% for every tab in this context. */
  private async applyDefaultZoomOnContext(context: BrowserContext): Promise<void> {
    const ZOOM_PCT = "75%";
    const applyPage = async (page: Page) => {
      try {
        await page.evaluate((z) => {
          try {
            (document.documentElement as HTMLElement).style.zoom = z;
          } catch {
            /* ignore */
          }
        }, ZOOM_PCT);
      } catch {
        /* ignore */
      }
    };
    for (const page of context.pages()) {
      await applyPage(page);
    }
    context.on("page", (page) => {
      void page.waitForLoadState("domcontentloaded").then(() => applyPage(page)).catch(() => { });
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) void applyPage(page);
      });
    });
  }

  private findPreferredVfsPage(pages: Page[], opts?: { excludeApplicantSetup?: boolean }): Page | null {
    const excludeSetup = opts?.excludeApplicantSetup === true;
    for (const p of pages) {
      try {
        const u = p.url();
        if (excludeSetup && isApplicantFormServerUrl(u)) continue;
        if (u.toLowerCase().includes("visa.vfsglobal.com")) return p;
      } catch {
        continue;
      }
    }
    return null;
  }

  private collectAllPagesFromBrowser(browser: Browser): Page[] {
    const out: Page[] = [];
    for (const ctx of browser.contexts()) {
      try {
        out.push(...ctx.pages());
      } catch {
        /* ignore */
      }
    }
    return out;
  }

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
      } catch {
        /* ignore */
      }
    });
  }

  // ── Page access (implements BrowserServiceCore) ─────────────────────

  async getVfsPageOrAnyNonSetup(): Promise<Page | null> {
    const browser = await this.ensureBrowser();
    const pages = this.collectAllPagesFromBrowser(browser);
    const vfs = this.findPreferredVfsPage(pages, { excludeApplicantSetup: true });
    if (vfs) return vfs;
    return pages.find((p) => {
      try { return !isApplicantFormServerUrl(p.url()); } catch { return false; }
    }) ?? pages[0] ?? null;
  }

  async getOrCreateNonSetupPage(): Promise<Page> {
    const browser = await this.ensureBrowser();
    const context = browser.contexts()[0];
    if (!context) throw new Error("No browser context");
    const pages = this.collectAllPagesFromBrowser(browser);
    let page = this.findPreferredVfsPage(pages, { excludeApplicantSetup: true });
    if (!page) {
      page = pages.find((p) => {
        try { return !isApplicantFormServerUrl(p.url()); } catch { return false; }
      }) ?? pages[0] ?? (await context.newPage());
    }
    return page;
  }

  async getFirstTabUrl(): Promise<string> {
    const browser = await this.ensureBrowser();
    const pages = this.collectAllPagesFromBrowser(browser);
    const vfsPage = this.findPreferredVfsPage(pages, { excludeApplicantSetup: true });
    if (vfsPage) {
      try {
        // Do not bringToFront — that restores a minimized Chrome window on Windows.
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
   * Passive current-URL read for monitoring. Never launches/reconnects CDP and
   * never brings a tab to front — returns "" if the browser isn't connected yet,
   * so it can be polled frequently without affecting the bot.
   */
  async peekFirstTabUrl(): Promise<string> {
    try {
      const browser = this.browser;
      if (!browser || !browser.isConnected()) return "";
      const pages = this.collectAllPagesFromBrowser(browser);
      const vfs =
        this.findPreferredVfsPage(pages, { excludeApplicantSetup: true }) ??
        pages.find((p) => { try { return !isApplicantFormServerUrl(p.url()); } catch { return false; } }) ??
        pages[0];
      if (!vfs) return "";
      return vfs.url();
    } catch {
      return "";
    }
  }

  private async getVfsPage(): Promise<Page> {
    const browser = await this.ensureBrowser();
    const pages = this.collectAllPagesFromBrowser(browser);
    const page = this.findPreferredVfsPage(pages, { excludeApplicantSetup: true });
    if (!page) {
      const cdp = config.browserCdpUrl;
      const sample = [
        ...new Set(
          pages.map((p) => { try { return p.url(); } catch { return ""; } })
        ),
      ].filter(Boolean).slice(0, 12);
      throw new Error(
        `No visa.vfsglobal.com tab found in the instance Chrome (CDP at ${cdp}). ` +
        `Click "Submit & Run" first to start the bot, wait for VFS login to complete, then retry. ` +
        `Tab URLs seen: ${sample.join(" | ") || "(none)"}`
      );
    }
    this.attachLiftApiClientSourceSniffer(page.context());
    // Do not bringToFront — CDP works on background tabs; bringToFront restores
    // a minimized Chrome window after dashboard settle.
        return page;
  }

  private async getFirstPageForIpLookup(): Promise<Page | null> {
    try {
      const browser = await this.ensureBrowser();
      const pages = this.collectAllPagesFromBrowser(browser);
      const vfs = this.findPreferredVfsPage(pages, { excludeApplicantSetup: true });
      if (vfs) return vfs;
      const nonSetup = pages.find((p) => {
        try { return !isApplicantFormServerUrl(p.url()); } catch { return false; }
      });
      return nonSetup ?? pages[0] ?? null;
    } catch {
      return null;
    }
  }

  // ── Block detection ─────────────────────────────────────────────────

  async detectWafJsonBlock(): Promise<boolean> {
    const kind = await this.detectPageBlockKind();
    return kind !== "none";
  }

  async detectPageBlockKind(): Promise<"none" | "account_429" | "ip_429" | "forbidden" | "cloudflare"> {
    try {
      const browser = await this.ensureBrowser();
      const pages = this.collectAllPagesFromBrowser(browser);
      const page = this.findPreferredVfsPage(pages, { excludeApplicantSetup: true }) ?? pages[0];
      if (!page) return "none";
      const bodyText = await page.locator("body").innerText({ timeout: 5_000 });
      const trimmed = bodyText.trim();

      const html = await page.content().catch(() => "");
      if (isCloudflareChallengeBody(html) || /Just a moment\.\.\./i.test(trimmed)) {
        return "cloudflare";
      }

      const rate = classifyVfs429FromPageText(trimmed);
      if (rate?.kind === "account") {
                return "account_429";
      }
      if (rate?.kind === "ip") {
                return "ip_429";
      }

      if (/^\s*\{/.test(trimmed)) {
        try {
          const parsed = JSON.parse(trimmed) as { code?: string | number };
          const codeStr = parsed.code != null ? String(parsed.code) : "";
          if (codeStr.startsWith("403201")) {
                        return "cloudflare";
          }
          if (codeStr.startsWith("403")) {
                        return "forbidden";
          }
        } catch {
          /* not JSON */
        }
      }
      if (/Access Restricted Due to Unusual Activity/i.test(trimmed) || /403201/.test(trimmed)) {
                return "cloudflare";
      }
      if (/Permission Issues/i.test(trimmed) || /403101/.test(trimmed)) {
                return "forbidden";
      }
      if (/Session Expired or Invalid/i.test(trimmed)) {
                return "forbidden";
      }
    } catch {
      /* ignore */
    }
    return "none";
  }

  // ── Applicant setup form ────────────────────────────────────────────

  async tryClickLocalApplicantSetupFormSubmit(): Promise<boolean> {
    const origin = getApplicantFormServerOrigin();
    const browser = await this.ensureBrowser();
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        let u = "";
        try { u = page.url(); } catch { continue; }
        if (!u.startsWith(origin)) continue;
        try {
          await page.locator('form#f button[type="submit"]').click({ timeout: 5000 });
          await page.waitForTimeout(1500);
          return true;
        } catch {
          /* try next page */
        }
      }
    }
    return false;
  }

  async resolveApplicantIpForPayload(): Promise<void> {
    const page = await this.getFirstPageForIpLookup();
    await ensureApplicantIpResolved(page);
  }

  // ── Login (delegates to browser.login module) ───────────────────────

  async loginOnFirstTab(username: string, password: string): Promise<void> {
    await performLoginOnFirstTab(this, username, password);
  }

  async openLoginInFirstTab(): Promise<void> {
    await loginModuleOpenLogin(this);
  }

  async logoutVfsAndOpenLoginFirstTab(): Promise<void> {
    await loginModuleLogoutAndOpen(this);
  }

  // ── Client source waiting ───────────────────────────────────────────

  async waitForLiftClientSourceIfNeeded(): Promise<void> {
    if (getCapturedClientSource()?.trim()) {
            return;
    }
    await this.ensureBrowser();
    const telegram = new TelegramService();
    const ALERT_INTERVAL_MS = 60_000;
        await telegram
      .alert("info", "Waiting for clientsource — open or refresh VFS dashboard in Chrome so the bot can capture it.")
      .catch(() => { });

    const alertTimer = setInterval(() => {
      if (getCapturedClientSource()?.trim()) return;
            telegram
        .alert("info", "Still waiting for clientsource — navigate VFS dashboard in Chrome to trigger a lift-api request.")
        .catch(() => { });
    }, ALERT_INTERVAL_MS);

    try {
      await waitForClientSourceCapture();
    } finally {
      clearInterval(alertTimer);
    }
  }

  async preparePollingAfterLogin(options?: { skipDashboardNavigate?: boolean }): Promise<void> {
    const skipNav = options?.skipDashboardNavigate === true;
    if (skipNav) {
      return;
    }
    await this.waitForLiftClientSourceIfNeeded();
  }

  // ── Dashboard navigation helpers ────────────────────────────────────

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
        await Promise.all([
          page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => { }),
          loc.click({ timeout: 5_000 }),
        ]);
        await page.waitForTimeout(1000);
        return;
      } catch {
        /* try next candidate */
      }
    }
  }

  private async selectFirstOptionFromMatSelect(page: Page, select: import("playwright").Locator, label: string): Promise<boolean> {
    try {
      if (!(await select.isVisible({ timeout: 1500 }).catch(() => false))) return false;
      await select.scrollIntoViewIfNeeded().catch(() => { });
      await select.click({ timeout: 5000 });
      const panel = page.locator(".mat-mdc-select-panel, .mat-select-panel").first();
      await panel.waitFor({ state: "visible", timeout: 5000 });
      const options = panel.locator("mat-option, .mat-mdc-option, .mat-option");
      const n = await options.count();
      for (let i = 0; i < n; i++) {
        const opt = options.nth(i);
        const txt = (await opt.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (!txt) continue;
        if (/select|choose|--/i.test(txt)) continue;
        await opt.click({ timeout: 5000 });
        await page.waitForTimeout(800);
                return true;
      }
      await page.keyboard.press("Escape").catch(() => { });
      return false;
    } catch (e) {
            return false;
    }
  }

  async selectFirstCenterAndCategoryIfOnApplicationDetail(): Promise<void> {
    const page = await this.getVfsPage();
    const url = (() => { try { return page.url(); } catch { return ""; } })();

    if (!/application-detail/i.test(url)) {
            return;
    }

        await page.waitForTimeout(3_000);

    const allMatSelects = page.locator("mat-select, .mat-mdc-select, .mat-select").filter({ hasNot: page.locator("[disabled], [aria-disabled='true']") });
    const count = await allMatSelects.count();
    if (count === 0) {
            return;
    }

    const centerSel = allMatSelects.nth(0);
    const catSel = count > 1 ? allMatSelects.nth(1) : null;

    const pickedCenter = await this.selectFirstOptionFromMatSelect(page, centerSel, "center");
    if (catSel) {
      await page.waitForTimeout(3_000);
      await this.selectFirstOptionFromMatSelect(page, catSel, "category").catch(() => { });
    } else if (!pickedCenter) {
          }
  }

  // ── Booking chain (delegates to browser.booking module) ─────────────

  async saveApplicantsViaLiftApi(): Promise<void> {
    const existingUrn = getApplicationUrn();
    if (existingUrn?.trim()) {
            return;
    }
    await this.waitForLiftClientSourceIfNeeded();
    const page = await this.getVfsPage();
    await saveApplicantsOnPage(page);
  }

  async postFeesLiftApi(): Promise<void> {
    const urn = getApplicationUrn();
    if (!urn?.trim()) {
            return;
    }
    const page = await this.getVfsPage();
    await postFeesOnPage(page, urn);
  }

  /** Calendar → dates list (throws on empty/error). */
  async fetchCalendarDatesForFleet(): Promise<string[]> {
    const urn = getApplicationUrn();
    if (!urn?.trim()) {
      throw new Error("Fleet calendar: no urn; save applicants successfully first");
    }
    const page = await this.getVfsPage();
    return fetchCalendarDatesForFleetOnPage(page, urn);
  }

  /** Timeslot for an assigned date → all entries with allocationId + time. */
  async fetchTimeslotAllocationsForFleet(
    slotDate: string
  ): Promise<FleetTimeslotEntry[]> {
    const urn = getApplicationUrn();
    if (!urn?.trim()) {
      throw new Error("Fleet timeslot: no urn; save applicants successfully first");
    }
    if (!slotDate?.trim()) {
      throw new Error("Fleet timeslot: no slotDate assigned");
    }
    const page = await this.getVfsPage();
    return fetchTimeslotAllocationsForFleetOnPage(page, urn, slotDate);
  }

  async postMapVasLiftApi(): Promise<void> {
    if (isIndDeuRoute(config.slotPayload.countryCode, config.slotPayload.missionCode)) {
      return;
    }
    const urn = getApplicationUrn();
    if (!urn?.trim()) {
            return;
    }
    const page = await this.getVfsPage();
    await postMapVasOnPage(page, urn);
  }

  async postScheduleLiftApi(): Promise<{ paymentUrl: string | null }> {
    const urn = getApplicationUrn();
    const allocationId = getAllocationId();
    if (!urn?.trim()) {
            return { paymentUrl: null };
    }
    if (!allocationId?.trim()) {
            return { paymentUrl: null };
    }
    const page = await this.getVfsPage();
    return postScheduleOnPage(page, urn, allocationId);
  }

  async runSlotCheckInBrowser(url: string, payload: Record<string, unknown>): Promise<{ status: number; body: string }> {
    try {
      const page = await this.getVfsPage();
      await this.simulateUserActivity(page);
      return await postLiftJsonFromPage(page, url, payload);
    } catch (err) {
      // postLiftJsonFromPage already logs (including empty/failed responses).
      // Log here only when we never reached postLift (e.g. no VFS page).
      const msg = err instanceof Error ? err.message : String(err);
      const likelyBeforePost =
        /no vfs|getvfspage|no page|browser.*(closed|disconnected)|target closed/i.test(msg);
      if (likelyBeforePost) {
        const { logApiCall, liftUrlToLogKind } = await import("../utils/apiCallLog.js");
        const kind = liftUrlToLogKind(url) ?? "polling";
        logApiCall(kind, "", undefined, JSON.stringify(payload), { error: msg });
      }
      throw err;
    }
  }

  /**
   * Dispatch synthetic DOM events on the VFS page so the Angular app's
   * idle-timeout detector sees "user activity" and doesn't kill the session.
   */
  private async simulateUserActivity(page: import("playwright").Page): Promise<void> {
    try {
      await page.evaluate(() => {
        const x = Math.floor(Math.random() * (window.innerWidth || 800));
        const y = Math.floor(Math.random() * (window.innerHeight || 600));
        const opts: MouseEventInit = { bubbles: true, clientX: x, clientY: y };
        document.dispatchEvent(new MouseEvent("mousemove", opts));
        document.dispatchEvent(new MouseEvent("mousedown", opts));
        document.dispatchEvent(new MouseEvent("mouseup", opts));
        document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift" }));
        document.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }));
      });
    } catch {
      /* page may be navigating — safe to ignore */
    }
  }

  // ── Session snapshot / restore (IP rotation) ────────────────────────

  async snapshotVfsAuthForIpRotate(): Promise<{
    pageUrl: string;
    authorize: string | null;
    clientsource: string | null;
  }> {
    const page = await this.getVfsPage();
    let pageUrl = "";
    try { pageUrl = page.url(); } catch { pageUrl = ""; }
    const fromPage = await page
      .evaluate(() => {
        const getStored = (keys: string[]): string | null => {
          try {
            for (const k of keys) {
              const v = sessionStorage.getItem(k) ?? localStorage.getItem(k);
              if (v?.trim()) return v.trim();
            }
          } catch { /* ignore */ }
          return null;
        };
        return {
          authorize: getStored(["JWT", "authorize", "authToken", "token", "authorization"]) ?? null,
          clientsource: getStored(["clientsource", "clientSource", "client_source"]) ?? null,
        };
      })
      .catch(() => ({ authorize: null as string | null, clientsource: null as string | null }));

    return {
      pageUrl,
      authorize: fromPage.authorize,
      clientsource: fromPage.clientsource ?? getCapturedClientSource()?.trim() ?? null,
    };
  }

  async restoreVfsSessionAfterIpRotate(snap: {
    pageUrl: string;
    authorize: string | null;
    clientsource: string | null;
  }): Promise<void> {
    const browser = await this.ensureBrowser();
    let page = this.findPreferredVfsPage(this.collectAllPagesFromBrowser(browser), {
      excludeApplicantSetup: true,
    });
    if (!page) {
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      page = await ctx.newPage();
    }

    const target =
      snap.pageUrl && classifyVfsFirstTabUrl(snap.pageUrl) !== "blank"
        ? snap.pageUrl
        : config.loginPageUrl;

    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => { });
    await page.waitForTimeout(1_500);

    if (snap.authorize?.trim()) {
      await page.evaluate(
        (args: { authorize: string; clientsource: string | null }) => {
          try {
            sessionStorage.setItem("authorize", args.authorize);
            sessionStorage.setItem("JWT", args.authorize);
            localStorage.setItem("authorize", args.authorize);
            localStorage.setItem("JWT", args.authorize);
            if (args.clientsource) {
              sessionStorage.setItem("clientsource", args.clientsource);
              localStorage.setItem("clientsource", args.clientsource);
            }
          } catch { /* ignore */ }
        },
        { authorize: snap.authorize.trim(), clientsource: snap.clientsource }
      );
    }
    if (snap.clientsource?.trim()) {
      setCapturedClientSource(snap.clientsource.trim());
    }

    let url = "";
    try { url = page.url(); } catch { url = ""; }
    let kind = classifyVfsFirstTabUrl(url);
    if (kind === "login" || kind === "blank") {
      const dashUrl = url.includes("/login")
        ? url.replace(/\/login\/?$/i, "/dashboard")
        : config.loginPageUrl.replace(/\/login\/?$/i, "/dashboard");
      await page.goto(dashUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => { });
      await page.waitForTimeout(1_500);
      try { url = page.url(); } catch { url = ""; }
      kind = classifyVfsFirstTabUrl(url);
    }
    if (kind === "login" || kind === "blank" || kind === "page_not_found") {
      throw new Error(
        `IP rotate without relogin lost VFS session (tab is ${kind || "unknown"}). Escalate to full relogin.`
      );
    }
      }

  // ── CDP lifecycle ───────────────────────────────────────────────────

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

import type { Page } from "playwright";
import { config } from "../config/config";
import { logger } from "../utils/logger";
import {
  classifyVfs429,
  classifyVfs429FromHttp,
  classifyVfs429FromPageText,
} from "../utils/vfsRateLimit";
import { classifyVfsFirstTabUrl } from "../flows/vfsTabUrl";
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
import {
  VfsForbiddenError,
  VfsGatewayTimeoutError,
  VfsRateLimitedError,
  PageNotFoundRestartError,
  isTargetClosedError,
  throwVfsRateLimited,
  responseIsLiftUserLoginPost,
  injectTurnstileTokenInPage,
  type PostOtpLoginCapture,
} from "./browser.errors";
import { isPageNotFoundUrl } from "../flows/pageNotFound";

import type { BrowserServiceCore } from "./browser.core";
import { clickTurnstile, waitForManualTurnstile } from "./turnstile.click";
import { reporter } from "../monitoring/statusReporter";

// ── Block-page detection ────────────────────────────────────────────────

function throwIfBlockPage(page: Page): void {
  const url = page.url();
  if (isPageNotFoundUrl(url)) {
    throw new PageNotFoundRestartError(`redirected to ${url}`);
  }
}

/**
 * Throttled block-page checker for use during the Turnstile wait. Throws (so the
 * login flow bails out to its 403/429 recovery instead of spinning on a captcha
 * that will never appear) when the page becomes a block/error page — by URL
 * redirect (page-not-found / session-expired) or by body content (403201
 * "Access Restricted", 403101 "Permission Issues", "Session Expired", 429).
 */
function makeBlockCheck(page: Page): () => Promise<void> {
  let lastBody = 0;
  return async () => {
    // URL redirect — instant.
    try {
      throwIfBlockPage(page);
    } catch (e) {
      reporter.setAttention("blocked", "block page (redirect) during login — rotating IP");
      throw e;
    }
    // Body content — throttled (innerText is heavier).
    const now = Date.now();
    if (now - lastBody < 2500) return;
    lastBody = now;
    let text = "";
    try {
      text = await page.locator("body").innerText({ timeout: 2000 });
    } catch {
      return;
    }
    const t = text.trim();
    if (
      /Access Restricted Due to Unusual Activity/i.test(t) || /403201/.test(t) ||
      /Permission Issues/i.test(t) || /403101/.test(t) ||
      /Session Expired or Invalid/i.test(t)
    ) {
      reporter.setAttention("blocked", "block page during login — rotating IP");
      throw new VfsForbiddenError("Block page detected during login (403201/403101/session-expired)");
    }
    const rate = classifyVfs429FromPageText(t);
    if (rate) {
      reporter.setAttention("rate_limit", `rate-limit ${rate.code} during login`);
      throwVfsRateLimited(rate.kind, rate.code, "block page during login");
    }
  };
}

async function waitForLoginFormOrThrowBlock(page: Page, usernameSelectors: string, timeoutMs: number): Promise<void> {
  const BLOCK_CHECK_INTERVAL_MS = 5_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1000, deadline - Date.now());
    const checkMs = Math.min(BLOCK_CHECK_INTERVAL_MS, remainingMs);

    try {
      await page.locator(usernameSelectors).first().waitFor({ state: "visible", timeout: checkMs });
      return;
    } catch {
      // Login form not visible yet — check for block pages
    }

    const nowUrl = page.url();
    if (isPageNotFoundUrl(nowUrl)) {
      throw new PageNotFoundRestartError(`login page redirected to ${nowUrl}`);
    }

    try {
      const bodyText = await page.locator("body").innerText({ timeout: 3_000 });
      const trimmed = bodyText.trim();

      if (/Access Restricted for User ID/i.test(trimmed) || /429\d{0,3}/.test(trimmed)) {
        const rate = classifyVfs429FromPageText(trimmed) ?? { kind: "account" as const, code: "4290" };
        throwVfsRateLimited(rate.kind, rate.code, "Login page shows rate-limit / User ID restricted");
      }

      if (/^\s*\{/.test(trimmed)) {
        try {
          const parsed = JSON.parse(trimmed) as { code?: string | number };
          const codeStr = parsed.code != null ? String(parsed.code) : "";
          const rateKind = classifyVfs429(codeStr);
          if (rateKind) {
            throwVfsRateLimited(rateKind, codeStr, "Login page body contains rate-limit JSON block");
          }
          if (codeStr.startsWith("403")) {
            throw new VfsForbiddenError(`Login page body contains WAF block: code ${parsed.code}`);
          }
        } catch (e) {
          if (e instanceof VfsRateLimitedError) throw e;
          if (e instanceof VfsForbiddenError) throw e;
        }
      }
      if (/Access Restricted Due to Unusual Activity/i.test(trimmed) || /403201/.test(trimmed)) {
        throw new VfsForbiddenError("Login page shows 'Access Restricted Due to Unusual Activity' (403201) — IP blocked.");
      }
      if (/Session Expired or Invalid/i.test(trimmed)) {
        throw new VfsForbiddenError("Login page shows 'Session Expired or Invalid' — session/IP blocked.");
      }
      if (/Go back to home/i.test(trimmed) && /VFS Global/i.test(trimmed) && !/sign\s*in/i.test(trimmed)) {
        throw new VfsForbiddenError("Login page shows VFS error/block page (no login form, 'Go back to home' present).");
      }
    } catch (e) {
      if (e instanceof VfsRateLimitedError) throw e;
      if (e instanceof VfsForbiddenError) throw e;
    }
  }

  throw new Error("Login form did not appear within timeout — page may be stuck or blocked.");
}

// ── Consent / cookie dismissal ──────────────────────────────────────────

async function dismissCookieConsent(page: Page, quickCheck: boolean = false): Promise<void> {
  const selectors = [
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    '[data-accept-cookies], .cookie-accept, #accept-cookies',
  ];

  const maxWaitMs = quickCheck ? 3_000 : 120_000;
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
    await page.waitForTimeout(300);
  }

  logger.info(`[Consent] No consent dialog found after ${maxWaitMs / 1000} seconds, continuing...`);
}

// ── Credential filling ──────────────────────────────────────────────────

async function fillLoginCredentials(
  page: Page,
  username: string,
  password: string,
  opts: { usernameSelectors: string; passwordSelectors: string; timeoutMs: number }
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  const emailLocator = page.locator(opts.usernameSelectors).first();
  const passwordLocator = page.locator(opts.passwordSelectors).first();

  while (Date.now() < deadline) {
    try {
      await emailLocator.waitFor({ state: "visible", timeout: 5000 });
      await emailLocator.fill(username, { timeout: 5000 });
      await page.waitForTimeout(150);
      await passwordLocator.waitFor({ state: "visible", timeout: 5000 });
      await passwordLocator.fill(password, { timeout: 5000 });

      const [actualEmail, actualPw] = await page
        .evaluate((selectors) => {
          const emailEl =
            document.querySelector<HTMLInputElement>('input[formControlName="username"]') ??
            document.querySelector<HTMLInputElement>('input[formControlName="email"]') ??
            document.querySelector<HTMLInputElement>('#email') ??
            document.querySelector<HTMLInputElement>('input[type="email"]') ??
            document.querySelector<HTMLInputElement>(selectors.username);
          const pwEl =
            document.querySelector<HTMLInputElement>('input[formControlName="password"]') ??
            document.querySelector<HTMLInputElement>('input[name="password"]') ??
            document.querySelector<HTMLInputElement>('input[type="password"]:not([formcontrolname="otp"])') ??
            document.querySelector<HTMLInputElement>(selectors.password);
          return [emailEl?.value?.trim() ?? "", pwEl?.value?.trim() ?? ""] as [string, string];
        }, { username: opts.usernameSelectors, password: opts.passwordSelectors })
        .catch(() => ["", ""] as [string, string]);

      if (!actualEmail || !actualPw) {
        await page.waitForTimeout(300);
        continue;
      }
      return;
    } catch {
      await page.waitForTimeout(300);
    }
  }
  throw new Error("Failed to fill login credentials");
}

// ── Submit button resolution ────────────────────────────────────────────

function dashboardUrlRegex(): RegExp {
  return /\/(applications|dashboard|home)/i;
}

async function resolveLoginSubmitButton(page: Page): Promise<import("playwright").Locator> {
  let submitBtn = page.getByRole("button", { name: /sign in/i }).first();
  if (!(await submitBtn.isVisible().catch(() => false))) {
    submitBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first();
  }
  return submitBtn;
}

async function resolvePostOtpSubmitButton(page: Page): Promise<import("playwright").Locator> {
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
  return resolveLoginSubmitButton(page);
}

// ── OTP field detection & filling ───────────────────────────────────────

function getLoginOtpInputLocators(page: Page): import("playwright").Locator[] {
  return [
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

async function hasSegmentedOtpInputs(page: Page): Promise<{ locator: import("playwright").Locator; count: number } | null> {
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

async function isLoginOtpFieldVisible(page: Page): Promise<boolean> {
  for (const loc of getLoginOtpInputLocators(page)) {
    if (await loc.first().isVisible().catch(() => false)) return true;
  }
  if (await hasSegmentedOtpInputs(page)) return true;
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

async function fillLoginOtpField(page: Page, otpRaw: string): Promise<void> {
  const digits = otpRaw.replace(/\D/g, "");
  if (!digits) throw new Error("OTP has no digits");

  const seg = await hasSegmentedOtpInputs(page);
  if (seg && seg.count === digits.length) {
    for (let i = 0; i < seg.count; i++) {
      const box = seg.locator.nth(i);
      await box.click({ timeout: 3000 }).catch(() => { });
      await box.fill(digits[i]!);
    }
    logger.info({ segments: seg.count }, "OTP filled (segmented inputs)");
    return;
  }

  for (const loc of getLoginOtpInputLocators(page)) {
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

// ── Dashboard / OTP waiting ─────────────────────────────────────────────

async function waitForDashboardOrOtpStep(
  page: Page,
  dash: RegExp,
  maxMs: number
): Promise<"dashboard" | "otp" | "neither"> {
  const deadline = Date.now() + maxMs;
  const t0 = Date.now();
  let lastProgressLog = 0;
  logger.info({ maxMs }, "[login] Waiting for dashboard or OTP field...");
  while (Date.now() < deadline) {
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
      const otpVis = await isLoginOtpFieldVisible(page);
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
    if (await isLoginOtpFieldVisible(page)) return "otp";
  } catch {
    /* ignore */
  }
  logger.info(
    { step: "login.wait_dash_or_otp", result: "neither", finalUrl, maxMs },
    "[login] Window ended: neither dashboard nor OTP field detected"
  );
  return "neither";
}

async function waitForLoginOtpField(page: Page, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  let iter = 0;
  const logEvery = 15;
  while (Date.now() < deadline) {
    iter += 1;
    const visible = await isLoginOtpFieldVisible(page);
    if (visible) {
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

// ── Turnstile + submit ──────────────────────────────────────────────────

async function submitLoginImmediately(
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
  const existingToken = await page
    .evaluate(() => {
      const el =
        document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ??
        document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
      return (el as HTMLInputElement | null)?.value?.trim() ?? "";
    })
    .catch(() => "");

  if (existingToken) {
    reporter.captchaResult("passed");
    logger.info({ tokenLength: existingToken.length }, "[Login] ✓ Using existing Turnstile token");
  } else {
    reporter.setPhase("turnstile", "solving captcha (auto)");
    reporter.captchaWaiting(null);
    logger.info("[Login] Solving Turnstile by clicking the checkbox...");
    const blockCheck = makeBlockCheck(page);
    let token = "";
    try {
      token = await clickTurnstile(page, { check: blockCheck });
    } catch (e) {
      if (e instanceof VfsForbiddenError || e instanceof VfsRateLimitedError) throw e;
      logger.error({ err: e }, "[Login] Turnstile click solve threw");
    }
    if (token) {
      reporter.captchaResult("passed");
    } else {
      const manual = await waitForManualTurnstile(page, { check: blockCheck });
      if (!manual) {
        logger.warn("[Login] Turnstile not solved — proceeding anyway");
        reporter.captchaResult("failed");
      }
    }
  }

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
    const turnstileAfterRefill = await readCfTurnstileToken();
    if (
      turnstileTokenBeforeRefill.length > 80 &&
      turnstileAfterRefill.length < turnstileTokenBeforeRefill.length * 0.5
    ) {
      logger.info("[Login] Turnstile token dropped after credential refill — re-injecting");
      await page.evaluate(injectTurnstileTokenInPage, turnstileTokenBeforeRefill);
    }
  }

  const readLoginFields = (): Promise<[string, string]> =>
    page
      .evaluate(() => {
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
      await fillLoginCredentials(page, opts.loginRefill.username, opts.loginRefill.password, {
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

      if (btn) {
        (btn as HTMLButtonElement).disabled = false;
        btn.removeAttribute("disabled");
        btn.setAttribute("aria-disabled", "false");
      }

      try {
        btn?.click();
      } catch {
        /* ignore */
      }

      const anyForm = form as any;
      if (form && typeof anyForm?.requestSubmit === "function") {
        try {
          anyForm.requestSubmit(btn ?? undefined);
          return { ok: true, reason: "button.click + requestSubmit" as const };
        } catch {
          // fall through
        }
      }

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

async function forceClickSignInButton(
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
      const retryBtn = await resolveLoginSubmitButton(page);
      submitBtn = retryBtn;
    }
  }
}

// ── OTP completion flows ────────────────────────────────────────────────

async function completeOtpWithMailPromise(
  page: Page,
  mailOtpFetchPromise: Promise<string>,
  dash: RegExp,
  core: BrowserServiceCore
): Promise<void> {
  const fieldWaitMs = Math.max(config.mailTmOtpTimeoutMs + 15_000, 120_000);
  const fieldP = waitForLoginOtpField(page, fieldWaitMs);
  const mailP = mailOtpFetchPromise;
  const [, otp] = await Promise.all([fieldP, mailP]);
  await fillLoginOtpField(page, otp);
  await page.waitForTimeout(2000);
  await resubmitLoginAfterOtp(page, core);
  await page.waitForURL(dash, { timeout: 60_000 });
}

async function runLoginOtpCompletionFlow(
  page: Page,
  mailOtpFetchPromise: Promise<string> | null,
  dash: RegExp,
  core: BrowserServiceCore
): Promise<void> {
  if (mailOtpFetchPromise) {
    try {
      await completeOtpWithMailPromise(page, mailOtpFetchPromise, dash, core);
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

async function resubmitLoginAfterOtp(page: Page, core: BrowserServiceCore): Promise<void> {
  const submitBtn = await resolvePostOtpSubmitButton(page);

  await dismissCookieConsent(page, true);

  logger.info("[OTP] Waiting for OTP to be filled and Turnstile to be valid...");
  const deadline = Date.now() + 60_000;
  let turnstileSolveAttempted = false;

  while (Date.now() < deadline) {
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

        const single = getValue('input[formcontrolname="otp"]') ||
          getValue('input[formControlName="otp"]') ||
          getValue('input[autocomplete="one-time-code"]');
        if (single && single.length >= 4) return true;

        const byName = Array.from(document.querySelectorAll<HTMLInputElement>('input[name*="otp" i], input[name*="verification" i]'))
          .find(el => visible(el) && el.value && el.value.length >= 4);
        if (byName) return true;

        const segments = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="text"][maxlength="1"]'))
          .filter(el => visible(el));
        if (segments.length >= 4) {
          const filledCount = segments.filter(seg => seg.value).length;
          return filledCount >= 4;
        }

        return false;
      })
      .catch(() => false);

    const turnstileValid = await page
      .evaluate(() => {
        const el =
          document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ??
          document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
        return !!((el as HTMLInputElement | null)?.value?.trim());
      })
      .catch(() => false);

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
        reporter.captchaResult("passed");
        logger.info({ tokenLength: tsToken.length }, "[OTP] ✓ Using existing Turnstile token");
      } else {
        reporter.setPhase("turnstile", "solving captcha (auto, OTP step)");
        reporter.captchaWaiting(null);
        logger.info("[OTP] Solving Turnstile by clicking the checkbox...");
        const blockCheck = makeBlockCheck(page);
        try {
          tsToken = await clickTurnstile(page, { check: blockCheck });
        } catch (e) {
          if (e instanceof VfsForbiddenError || e instanceof VfsRateLimitedError) throw e;
          logger.error({ err: e }, "[OTP] Turnstile click solve threw");
        }
        if (tsToken) {
          reporter.captchaResult("passed");
        } else {
          tsToken = await waitForManualTurnstile(page, { check: blockCheck });
          if (!tsToken) {
            logger.warn("[OTP] Turnstile not solved — proceeding anyway");
            reporter.captchaResult("failed");
          }
        }
      }
    }

    if (otpFilled && turnstileValid) {
      logger.info({ elapsedMs: Date.now() - (deadline - 60_000) }, "[OTP] Both OTP filled and Turnstile valid - ready to submit");
      break;
    }

    if (otpFilled && !turnstileValid && elapsed > 5_000 && elapsed < 5_500) {
      dismissCookieConsent(page, true).catch(() => { });
    }

    if (elapsed > 0 && elapsed % 2000 < 300) {
      logger.info({ otpFilled, turnstileValid, remainingMs: deadline - Date.now() }, "[OTP] Waiting...");
    }

    await page.waitForTimeout(300);
  }

  logger.info("[OTP] Clicking Sign In...");
  const dash = dashboardUrlRegex();
  const OTP_LOGIN_CAPTURE_MS = 120_000;
  const OTP_LOGIN_POST_DASHBOARD_GRACE_MS = 3000;

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
    await forceClickSignInButton(page, submitBtn);
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

  // Return captured response for the caller to store
  const lastPostOtpLoginResponse: PostOtpLoginCapture | null = capturedOtpLogin
    ? await (async () => {
        const otpStatus = capturedOtpLogin!.status();
        if (otpStatus === 429) {
          const body = await capturedOtpLogin!.text().catch(() => "");
          const classified = classifyVfs429FromHttp(otpStatus, body) ?? { kind: "ip" as const, code: "429" };
          logger.error(
            { status: otpStatus, code: classified.code, kind: classified.kind, bodySnippet: body.slice(0, 200) },
            "[Login] OTP /user/login returned 429"
          );
          throwVfsRateLimited(classified.kind, classified.code, "OTP Login API HTTP 429");
        }
        if (otpStatus === 504) {
          const body = await capturedOtpLogin!.text().catch(() => "");
          logger.error({ status: otpStatus, bodySnippet: body.slice(0, 200) }, "[Login] OTP /user/login returned 504 Gateway Timeout");
          throw new VfsGatewayTimeoutError("Login API returned 504 Gateway Timeout after OTP — restarting browser + rotating IP.");
        }
        const body = await capturedOtpLogin!.text().catch(() => "");
        const json = parseVfsUserLoginResponseBody(body);
        const capture: PostOtpLoginCapture = {
          status: otpStatus,
          url: capturedOtpLogin!.url(),
          body,
          json,
        };
        if (json) {
          const errObj = json.error as { code?: number; description?: string } | undefined;
          const bodyCode = String((json as Record<string, unknown>).code ?? errObj?.code ?? "");
          const bodyKind = classifyVfs429(bodyCode);
          if (bodyKind) {
            logger.error({ status: otpStatus, code: bodyCode, kind: bodyKind }, "[Login] OTP /user/login body has 429 code");
            throwVfsRateLimited(bodyKind, bodyCode, "OTP Login API body rate-limit code");
          }
          if (errObj && errObj.code === 413 && errObj.description === "Invalid Sender User") {
            logger.error(
              { status: capturedOtpLogin!.status(), error: errObj },
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
            status: capture.status,
            url: capture.url,
            bodyLength: body.length,
            isAuthenticated: json?.isAuthenticated,
            loginUser: json?.loginUser,
            accessTokenLength: json?.accessToken?.length,
            error: json?.error,
            bodyPreview: body.slice(0, 500),
          },
          "[Login] Captured POST lift-api /user/login response after OTP (2nd Sign In)"
        );
        return capture;
      })()
    : null;

  if (!capturedOtpLogin && onDashboard) {
    logger.info(
      "[Login] On dashboard after OTP but no lift-api POST /user/login response captured (merge may use other sources)."
    );
  } else if (!capturedOtpLogin) {
    logger.warn(
      "[Login] Could not capture lift-api POST /user/login response after OTP (timeout or no matching response)."
    );
  }

  core.setLastPostOtpLoginResponse(lastPostOtpLoginResponse);
}

// ── Main login flow (top-level) ─────────────────────────────────────────

export async function performLoginOnFirstTab(
  core: BrowserServiceCore,
  username: string,
  password: string
): Promise<void> {
  core.setLastPostOtpLoginResponse(null);
  clearVfsLoginProfile();
  const page = await core.getVfsPageOrAnyNonSetup();
  if (!page) throw new Error("No tab. Open Chrome with at least one tab, or open the VFS login page.");
  await page.bringToFront().catch(() => { });
  reporter.setPage(page.url());

  throwIfBlockPage(page);

  const visibleOnly = ':not(.d-none):not([aria-hidden="true"])';
  const usernameSelectors = `#email${visibleOnly}, input[formcontrolname="username"]${visibleOnly}, input[formControlName="username"]${visibleOnly}, input[formcontrolname="email"]${visibleOnly}, input[formControlName="email"]${visibleOnly}, input[name="username"]${visibleOnly}, input[name="email"]${visibleOnly}, input[type="email"]${visibleOnly}`;

  await waitForLoginFormOrThrowBlock(page, usernameSelectors, 300_000);

  await dismissCookieConsent(page, true);

  const passwordSelectors = `input[formcontrolname="password"]${visibleOnly}, input[name="password"]${visibleOnly}, input[type="password"]:not([formcontrolname="otp"])${visibleOnly}`;

  await fillLoginCredentials(page, username, password, {
    usernameSelectors,
    passwordSelectors,
    timeoutMs: 25_000,
  });

  const submitBtn = await resolveLoginSubmitButton(page);

  const wantMailTm =
    config.mailTmOtpEnabled && username.trim().includes("@") && password.length > 0;

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

  await submitLoginImmediately(page, submitBtn, {
    loginRefill: { username, password, usernameSelectors, passwordSelectors },
  });

  const pwdLoginRes = await passwordLoginResponsePromise;
  if (pwdLoginRes) {
    const pwdStatus = pwdLoginRes.status();

    if (pwdStatus === 429) {
      const pwdBody = await pwdLoginRes.text().catch(() => "");
      const classified = classifyVfs429FromHttp(pwdStatus, pwdBody) ?? { kind: "ip" as const, code: "429" };
      logger.error(
        { status: pwdStatus, code: classified.code, kind: classified.kind, bodySnippet: pwdBody.slice(0, 200) },
        "[Login] /user/login returned 429 Too Many Requests"
      );
      throwVfsRateLimited(classified.kind, classified.code, "Login API HTTP 429");
    }

    if (pwdStatus === 504) {
      const pwdBody = await pwdLoginRes.text().catch(() => "");
      logger.error({ status: pwdStatus, bodySnippet: pwdBody.slice(0, 200) }, "[Login] /user/login returned 504 Gateway Timeout");
      throw new VfsGatewayTimeoutError("Login API returned 504 Gateway Timeout — restarting browser + rotating IP.");
    }

    const pwdBody = await pwdLoginRes.text().catch(() => "");
    const pwdJson = parseVfsUserLoginResponseBody(pwdBody);
    if (pwdJson) {
      const errObj = pwdJson.error as { code?: number; description?: string } | undefined;

      const bodyCode = String((pwdJson as Record<string, unknown>).code ?? errObj?.code ?? "");
      const bodyKind = classifyVfs429(bodyCode);
      if (bodyKind) {
        logger.error({ status: pwdStatus, code: bodyCode, kind: bodyKind }, "[Login] /user/login body has 429 code");
        throwVfsRateLimited(bodyKind, bodyCode, "Login API body rate-limit code");
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
      const cc = String(config.slotPayload.countryCode ?? "").trim().toLowerCase();
      const mc = String(config.slotPayload.missionCode ?? "").trim().toLowerCase();
      const mergeApplicantFromPasswordStep =
        pwdJson.enableOTPAuthentication === false || (cc === "ind" && mc === "lva");
      let forStore: Record<string, unknown> | null;
      if (mergeApplicantFromPasswordStep && flat) {
        const o = { ...flat };
        delete o.applicantList;
        delete o.applicant;
        forStore = o;
      } else {
        forStore = stripPasswordStepApplicantFieldsForProfileMerge(flat);
      }
      if (forStore) mergeVfsLoginProfile(forStore);
      logger.info(
        {
          status: pwdStatus,
          loginUser: pwdJson.loginUser,
          isAuthenticated: pwdJson.isAuthenticated,
          mergeApplicantFromPasswordStep,
        },
        mergeApplicantFromPasswordStep
          ? "[Login] Merged password-step /user/login (full profile — no OTP step)"
          : "[Login] Merged password-step /user/login (session flags only — applicant fields come from OTP step)"
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

  await finishLoginAfterFirstSubmit(page, mailOtpFetchPromise, core);
}

async function finishLoginAfterFirstSubmit(
  page: Page,
  mailOtpFetchPromise: Promise<string> | null,
  core: BrowserServiceCore,
): Promise<void> {
  const dash = dashboardUrlRegex();

  const phase = await waitForDashboardOrOtpStep(page, dash, 45_000);

  if (phase === "dashboard") {
    logger.info({ step: "login.no_otp_needed" }, "[login] Logged in (no OTP step); cancelling mail.tm poll if any");
    void mailOtpFetchPromise?.catch(() => { });
  } else if (phase === "otp") {
    await runLoginOtpCompletionFlow(page, mailOtpFetchPromise, dash, core);
  } else {
    let urlAfterPhase = "";
    try {
      urlAfterPhase = page.url();
    } catch {
      /* ignore */
    }
    logger.warn(
      { step: "login.phase1_neither", url: urlAfterPhase },
      "[login] Neither dashboard nor OTP detected in 45s — extending wait 90s"
    );
    const phase2 = await waitForDashboardOrOtpStep(page, dash, 90_000);
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
      await runLoginOtpCompletionFlow(page, mailOtpFetchPromise, dash, core);
    } else if (mailOtpFetchPromise) {
      logger.info(
        { step: "login.phase2_try_mail_parallel" },
        "[login] Phase2 still ambiguous — trying mail.tm + OTP field parallel completion"
      );
      try {
        await completeOtpWithMailPromise(page, mailOtpFetchPromise, dash, core);
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

  if (kind === "login" || kind === "blank") {
    void mailOtpFetchPromise?.catch(() => { });
    throw new Error(
      "Login did not complete (still on login or blank). For auto OTP: VFS email/password must match a mail.tm mailbox (https://api.mail.tm/#/). Or finish OTP manually in Chrome."
    );
  }
}

export async function openLoginInFirstTab(core: BrowserServiceCore): Promise<void> {
  const page = await core.getOrCreateNonSetupPage();
  await page.bringToFront().catch(() => { });
  logger.info("Navigating to login page...");
  const navResponse = await page.goto(config.loginPageUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });

  if (navResponse && navResponse.status() === 403) {
    throw new VfsForbiddenError("Login page returned 403 Forbidden — IP/session blocked by Cloudflare or VFS.");
  }

  throwIfBlockPage(page);

  const visibleOnly = ':not(.d-none):not([aria-hidden="true"])';
  const usernameSelectors = `#email${visibleOnly}, input[formcontrolname="username"]${visibleOnly}, input[formControlName="username"]${visibleOnly}, input[formcontrolname="email"]${visibleOnly}, input[formControlName="email"]${visibleOnly}, input[name="username"]${visibleOnly}, input[name="email"]${visibleOnly}, input[type="email"]${visibleOnly}`;

  await waitForLoginFormOrThrowBlock(page, usernameSelectors, 300_000);
}

export async function logoutVfsAndOpenLoginFirstTab(core: BrowserServiceCore): Promise<void> {
  const page = await core.getVfsPageOrAnyNonSetup();
  if (!page) {
    await openLoginInFirstTab(core);
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
  await openLoginInFirstTab(core);
}

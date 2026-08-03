import type { Page } from "playwright";
import { config } from "../config/config";
import { classifyVfs429, classifyVfs429FromHttp, classifyVfs429FromPageText, } from "../utils/vfsRateLimit";
import { classifyVfsFirstTabUrl } from "../flows/vfsTabUrl";
import { fetchMailTmToken, isMailTmVerbose, listMailTmMessages, maskEmailForLog, waitForOtpFromMailTm, } from "./mailTm.service";
import { TelegramService } from "./telegram.service";
import type { VfsUserLoginResponse } from "../types/vfsUserLogin.type.js";
import { flattenVfsLoginResponseForProfile, parseVfsUserLoginResponseBody, stripPasswordStepApplicantFieldsForProfileMerge, } from "../types/vfsUserLogin.type.js";
import { clearVfsLoginProfile, mergeVfsLoginProfile } from "../utils/vfsLoginProfile.store.js";
import { VfsForbiddenError, VfsGatewayTimeoutError, VfsRateLimitedError, PageNotFoundRestartError, isTargetClosedError, throwVfsRateLimited, responseIsLiftUserLoginPost, injectTurnstileTokenInPage, type PostOtpLoginCapture, } from "./browser.errors";
import { isPageNotFoundUrl } from "../flows/pageNotFound";
import type { BrowserServiceCore } from "./browser.core";
import { clickTurnstile, waitForManualTurnstile } from "./turnstile.click";

/** Pause after OTP entry so the page can settle before Turnstile (Bulgaria OTP step). */
const OTP_BEFORE_CAPTCHA_DELAY_MS = 1000;
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
        }
        catch (e) {
            reporter.setAttention("blocked", "block page (redirect) during login — rotating IP");
            throw e;
        }
        // Body content — throttled (innerText is heavier).
        const now = Date.now();
        if (now - lastBody < 2500)
            return;
        lastBody = now;
        let text = "";
        try {
            text = await page.locator("body").innerText({ timeout: 2000 });
        }
        catch {
            return;
        }
        const t = text.trim();
        if (/Access Restricted Due to Unusual Activity/i.test(t) || /403201/.test(t) ||
            /Permission Issues/i.test(t) || /403101/.test(t) ||
            /Session Expired or Invalid/i.test(t)) {
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
    const BLOCK_CHECK_INTERVAL_MS = 5000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const remainingMs = Math.max(1000, deadline - Date.now());
        const checkMs = Math.min(BLOCK_CHECK_INTERVAL_MS, remainingMs);
        try {
            await page.locator(usernameSelectors).first().waitFor({ state: "visible", timeout: checkMs });
            return;
        }
        catch {
        }
        const nowUrl = page.url();
        if (isPageNotFoundUrl(nowUrl)) {
            throw new PageNotFoundRestartError(`login page redirected to ${nowUrl}`);
        }
        try {
            const bodyText = await page.locator("body").innerText({ timeout: 3000 });
            const trimmed = bodyText.trim();
            if (/Access Restricted for User ID/i.test(trimmed) || /429\d{0,3}/.test(trimmed)) {
                const rate = classifyVfs429FromPageText(trimmed) ?? { kind: "account" as const, code: "4290" };
                throwVfsRateLimited(rate.kind, rate.code, "Login page shows rate-limit / User ID restricted");
            }
            if (/^\s*\{/.test(trimmed)) {
                try {
                    const parsed = JSON.parse(trimmed) as {
                        code?: string | number;
                    };
                    const codeStr = parsed.code != null ? String(parsed.code) : "";
                    const rateKind = classifyVfs429(codeStr);
                    if (rateKind) {
                        throwVfsRateLimited(rateKind, codeStr, "Login page body contains rate-limit JSON block");
                    }
                    if (codeStr.startsWith("403")) {
                        throw new VfsForbiddenError(`Login page body contains WAF block: code ${parsed.code}`);
                    }
                }
                catch (e) {
                    if (e instanceof VfsRateLimitedError)
                        throw e;
                    if (e instanceof VfsForbiddenError)
                        throw e;
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
        }
        catch (e) {
            if (e instanceof VfsRateLimitedError)
                throw e;
            if (e instanceof VfsForbiddenError)
                throw e;
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
    const maxWaitMs = quickCheck ? 3000 : 120000;
    const logPrefix = quickCheck ? "[Consent] Quick check" : "[Consent] Waiting";
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        for (const sel of selectors) {
            try {
                const btn = page.locator(sel).first();
                if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
                    await btn.click({ timeout: 2000 });
                    await page.waitForTimeout(1000);
                    return;
                }
            }
            catch {
            }
        }
        await page.waitForTimeout(300);
    }
}
// ── Credential filling ──────────────────────────────────────────────────
/**
 * Fill login email/password without thrashing.
 * Previous infinite `.fill()` retry loop never reached Turnstile; the human-type
 * rewrite was too slow / fragile and often blocked Sign In + OTP. Use a few
 * targeted fills and verify the same locators.
 */
async function fillLoginCredentials(page: Page, username: string, password: string, opts: {
    usernameSelectors: string;
    passwordSelectors: string;
    timeoutMs: number;
}): Promise<void> {
    const deadline = Date.now() + opts.timeoutMs;
    const emailLocator = page.locator(opts.usernameSelectors).first();
    const passwordLocator = page.locator(opts.passwordSelectors).first();
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
        try {
            await emailLocator.waitFor({ state: "visible", timeout: 8000 });
            await emailLocator.click({ timeout: 4000 }).catch(() => { });
            await emailLocator.fill(username, { timeout: 5000 });
            await page.waitForTimeout(200);
            await passwordLocator.waitFor({ state: "visible", timeout: 8000 });
            await passwordLocator.click({ timeout: 4000 }).catch(() => { });
            await passwordLocator.fill(password, { timeout: 5000 });
            await page.waitForTimeout(300);
            // Verify the same locators we filled (not a separate querySelector chain).
            const actualEmail = ((await emailLocator.inputValue().catch(() => "")) || "").trim();
            const actualPw = ((await passwordLocator.inputValue().catch(() => "")) || "").trim();
            if (actualEmail && actualPw)
                return;
            lastErr = new Error(`credentials did not stick (email=${!!actualEmail}, pw=${!!actualPw})`);
            await page.waitForTimeout(400);
        }
        catch (e) {
            lastErr = e;
            await page.waitForTimeout(400);
        }
    }
    throw new Error(`Failed to fill login credentials: ${lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown")}`);
}

/** Read visible login fields; fall back to any matching input (Angular may hide duplicates). */
async function readLoginFieldValues(page: Page, opts?: {
    usernameSelectors?: string;
    passwordSelectors?: string;
}): Promise<[string, string]> {
    if (opts?.usernameSelectors && opts?.passwordSelectors) {
        const email = ((await page.locator(opts.usernameSelectors).first().inputValue().catch(() => "")) || "").trim();
        const pw = ((await page.locator(opts.passwordSelectors).first().inputValue().catch(() => "")) || "").trim();
        if (email && pw)
            return [email, pw];
    }
    return page
        .evaluate(() => {
        const emailEl = document.querySelector<HTMLInputElement>('input[formControlName="username"]') ??
            document.querySelector<HTMLInputElement>('input[formcontrolname="username"]') ??
            document.querySelector<HTMLInputElement>('input[formControlName="email"]') ??
            document.querySelector<HTMLInputElement>('input[formcontrolname="email"]') ??
            document.querySelector<HTMLInputElement>('#email') ??
            document.querySelector<HTMLInputElement>('input[type="email"]');
        const pwEl = document.querySelector<HTMLInputElement>('input[formControlName="password"]') ??
            document.querySelector<HTMLInputElement>('input[formcontrolname="password"]') ??
            document.querySelector<HTMLInputElement>('input[name="password"]') ??
            document.querySelector<HTMLInputElement>('input[type="password"]:not([formcontrolname="otp"])');
        return [emailEl?.value?.trim() ?? "", pwEl?.value?.trim() ?? ""] as [string, string];
    })
        .catch(() => ["", ""] as [string, string]);
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
        if (await b.isVisible().catch(() => false))
            return b;
    }
    const names = [/verify/i, /sign in/i, /submit/i, /continue/i, /confirm/i];
    for (const re of names) {
        const b = page.getByRole("button", { name: re }).first();
        if (await b.isVisible().catch(() => false))
            return b;
    }
    const submit = page.locator('button[type="submit"]:not([disabled])').first();
    if (await submit.isVisible().catch(() => false))
        return submit;
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
async function hasSegmentedOtpInputs(page: Page): Promise<{
    locator: import("playwright").Locator;
    count: number;
} | null> {
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
            if (await loc.first().isVisible().catch(() => false))
                return { locator: loc, count: n };
        }
    }
    return null;
}
async function isLoginOtpFieldVisible(page: Page): Promise<boolean> {
    for (const loc of getLoginOtpInputLocators(page)) {
        if (await loc.first().isVisible().catch(() => false))
            return true;
    }
    if (await hasSegmentedOtpInputs(page))
        return true;
    return page.evaluate(() => {
        const visible = (el: Element | null) => {
            if (!(el instanceof HTMLElement))
                return false;
            const st = window.getComputedStyle(el);
            return st.display !== "none" && st.visibility !== "hidden" && el.offsetParent !== null;
        };
        const trySel = (s: string) => {
            const el = document.querySelector(s);
            return visible(el);
        };
        return (trySel('input[formcontrolname="otp"]') ||
            trySel('input[formControlName="otp"]') ||
            trySel('input[autocomplete="one-time-code"]') ||
            !!Array.from(document.querySelectorAll('input[name*="otp" i], input[name*="verification" i]')).find((e) => visible(e)));
    });
}
async function fillLoginOtpField(page: Page, otpRaw: string): Promise<void> {
    const digits = otpRaw.replace(/\D/g, "");
    if (!digits)
        throw new Error("OTP has no digits");
    const seg = await hasSegmentedOtpInputs(page);
    if (seg && seg.count === digits.length) {
        for (let i = 0; i < seg.count; i++) {
            const box = seg.locator.nth(i);
            await box.click({ timeout: 3000 }).catch(() => { });
            await box.fill(digits[i]!);
        }
        return;
    }
    for (const loc of getLoginOtpInputLocators(page)) {
        const el = loc.first();
        if (await el.isVisible().catch(() => false)) {
            await el.click({ timeout: 3000 }).catch(() => { });
            await el.fill("").catch(() => { });
            try {
                await el.fill(digits);
            }
            catch {
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
        return;
    }
    throw new Error("Could not find OTP input to fill");
}
// ── Dashboard / OTP waiting ─────────────────────────────────────────────
async function waitForDashboardOrOtpStep(page: Page, dash: RegExp, maxMs: number): Promise<"dashboard" | "otp" | "neither"> {
    const deadline = Date.now() + maxMs;
    const t0 = Date.now();
    let lastProgressLog = 0;
    while (Date.now() < deadline) {
        let url = "";
        try {
            url = page.url();
            if (dash.test(url)) {
                return "dashboard";
            }
        }
        catch (e) {
            if (isTargetClosedError(e)) {
                return "neither";
            }
        }
        try {
            const otpVis = await isLoginOtpFieldVisible(page);
            if (otpVis) {
                return "otp";
            }
        }
        catch (e) {
            if (isTargetClosedError(e)) {
                return "neither";
            }
        }
        const now = Date.now();
        if (now - lastProgressLog >= 5000) {
            lastProgressLog = now;
        }
        try {
            await page.waitForTimeout(350);
        }
        catch (e) {
            if (isTargetClosedError(e)) {
                return "neither";
            }
            throw e;
        }
    }
    let finalUrl = "";
    try {
        finalUrl = page.url();
        if (dash.test(finalUrl))
            return "dashboard";
    }
    catch {
    }
    try {
        if (await isLoginOtpFieldVisible(page))
            return "otp";
    }
    catch {
    }
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
            }
            catch {
            }
        }
        try {
            await page.waitForTimeout(350);
        }
        catch (e) {
            if (isTargetClosedError(e)) {
                throw new Error("Page closed while waiting for OTP field");
            }
            throw e;
        }
    }
    let finalUrl = "";
    try {
        finalUrl = page.url();
    }
    catch {
    }
    throw new Error("Timed out waiting for OTP field on the login page");
}
// ── Turnstile + submit ──────────────────────────────────────────────────
async function submitLoginImmediately(page: Page, submitBtn: import("playwright").Locator, opts: {
    loginRefill?: {
        username: string;
        password: string;
        usernameSelectors: string;
        passwordSelectors: string;
    };
}): Promise<void> {
    const readCfTurnstileToken = (): Promise<string> => page
        .evaluate(() => {
        const els = [
            ...document.querySelectorAll<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]'),
            ...document.querySelectorAll<HTMLInputElement>('input[name="cf-turnstile-response"]'),
        ];
        for (const el of els) {
            const v = el.value?.trim();
            if (v && v.length > 20)
                return v;
        }
        return "";
    })
        .catch(() => "");

    // Blur active field so Angular settles before Turnstile (same as register-bot).
    await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        if (a && typeof a.blur === "function")
            a.blur();
    }).catch(() => { });
    await page.waitForTimeout(600);

    let token = await readCfTurnstileToken();
    if (token) {
        reporter.captchaResult("passed");
    }
    else {
        reporter.setPhase("turnstile", "solving captcha (auto)");
        reporter.captchaWaiting(null);
        const blockCheck = makeBlockCheck(page);
        try {
            token = await clickTurnstile(page, { check: blockCheck });
        }
        catch (e) {
            if (e instanceof VfsForbiddenError || e instanceof VfsRateLimitedError)
                throw e;
        }
        if (token) {
            reporter.captchaResult("passed");
        }
        else {
            const manual = await waitForManualTurnstile(page, { check: blockCheck });
            if (manual) {
                token = manual;
                reporter.captchaResult("passed");
            }
            else {
                reporter.captchaResult("failed");
            }
        }
    }

    // Ensure credentials still present after captcha (Angular may clear them).
    let [preSubmitEmail, preSubmitPw] = await readLoginFieldValues(page, opts.loginRefill);
    if ((!preSubmitEmail || !preSubmitPw) && opts.loginRefill) {
        const turnstileTokenBeforeRefill = token || (await readCfTurnstileToken());
        await fillLoginCredentials(page, opts.loginRefill.username, opts.loginRefill.password, {
            usernameSelectors: opts.loginRefill.usernameSelectors,
            passwordSelectors: opts.loginRefill.passwordSelectors,
            timeoutMs: 10000,
        });
        [preSubmitEmail, preSubmitPw] = await readLoginFieldValues(page, opts.loginRefill);
        const turnstileAfterRefill = await readCfTurnstileToken();
        if (turnstileTokenBeforeRefill.length > 80 &&
            turnstileAfterRefill.length < turnstileTokenBeforeRefill.length * 0.5) {
            await page.evaluate(injectTurnstileTokenInPage, turnstileTokenBeforeRefill).catch(() => { });
            token = turnstileTokenBeforeRefill;
        }
    }
    if (!preSubmitEmail || !preSubmitPw) {
        throw new Error(`Login fields empty before submit (email=${!!preSubmitEmail}, pw=${!!preSubmitPw}) — Angular cleared them; will retry login`);
    }

    // Re-inject token if remount wiped it right before click.
    const beforeClick = await readCfTurnstileToken();
    if (beforeClick.length < 20 && token.length > 20) {
        await page.evaluate(injectTurnstileTokenInPage, token).catch(() => { });
    }

    // CRITICAL: use a real Playwright click (trusted). DOM evaluate btn.click()
    // does NOT fire Angular (click) handlers on VFS Sign In — button never submits.
    let btn = submitBtn;
    try {
        await btn.waitFor({ state: "visible", timeout: 10000 });
    }
    catch {
        btn = await resolveLoginSubmitButton(page);
    }
    const enableDeadline = Date.now() + 8000;
    while (Date.now() < enableDeadline) {
        if (await btn.isEnabled().catch(() => false))
            break;
        await page.waitForTimeout(200);
    }
    await forceClickSignInButton(page, btn);
}
async function forceClickSignInButton(page: Page, submitBtn: import("playwright").Locator): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            // Best-effort enable — must not block the real click if evaluate fails
            // (obfuscated builds historically broke page.evaluate serialization).
            await submitBtn.evaluate((btn: HTMLElement) => {
                (btn as HTMLButtonElement).disabled = false;
                btn.removeAttribute("disabled");
                btn.setAttribute("aria-disabled", "false");
            }).catch(() => { });
            await submitBtn.scrollIntoViewIfNeeded().catch(() => { });
            await submitBtn.click({ timeout: 10000, force: true });
            return;
        }
        catch (err) {
            if (attempt === maxAttempts) {
                throw new Error("Could not click Sign In after Turnstile — check the visible button in Chrome or try manual login.");
            }
            await page.waitForTimeout(500);
            const retryBtn = await resolveLoginSubmitButton(page);
            submitBtn = retryBtn;
        }
    }
}
// ── OTP completion flows ────────────────────────────────────────────────
async function completeOtpWithMailPromise(page: Page, mailOtpFetchPromise: Promise<string>, dash: RegExp, core: BrowserServiceCore): Promise<void> {
    const fieldWaitMs = Math.max(config.mailTmOtpTimeoutMs + 15000, 120000);
    const fieldP = waitForLoginOtpField(page, fieldWaitMs);
    const mailP = mailOtpFetchPromise;
    const [, otp] = await Promise.all([fieldP, mailP]);
    await fillLoginOtpField(page, otp);
    await resubmitLoginAfterOtp(page, core);
    await page.waitForURL(dash, { timeout: 60000 });
}
async function runLoginOtpCompletionFlow(page: Page, mailOtpFetchPromise: Promise<string> | null, dash: RegExp, core: BrowserServiceCore): Promise<void> {
    if (mailOtpFetchPromise) {
        try {
            await completeOtpWithMailPromise(page, mailOtpFetchPromise, dash, core);
        }
        catch (err) {
            void mailOtpFetchPromise.catch(() => { });
            throw err;
        }
        return;
    }
    await page.waitForURL(dash, { timeout: 180000 });
}
async function resubmitLoginAfterOtp(page: Page, core: BrowserServiceCore): Promise<void> {
    const submitBtn = await resolvePostOtpSubmitButton(page);
    await dismissCookieConsent(page, true);
    const deadline = Date.now() + 60000;
    let turnstileSolveAttempted = false;
    while (Date.now() < deadline) {
        const otpFilled = await page
            .evaluate(() => {
            const visible = (el: Element | null): boolean => {
                if (!el || !(el instanceof HTMLElement))
                    return false;
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
            if (single && single.length >= 4)
                return true;
            const byName = Array.from(document.querySelectorAll<HTMLInputElement>('input[name*="otp" i], input[name*="verification" i]'))
                .find(el => visible(el) && el.value && el.value.length >= 4);
            if (byName)
                return true;
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
            const el = document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ??
                document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
            return !!((el as HTMLInputElement | null)?.value?.trim());
        })
            .catch(() => false);
        const elapsed = Date.now() - (deadline - 60000);
        if (otpFilled && !turnstileSolveAttempted) {
            turnstileSolveAttempted = true;
            await page.waitForTimeout(OTP_BEFORE_CAPTCHA_DELAY_MS);
            const readTurnstileResponse = () => page
                .evaluate(() => {
                const el = document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ??
                    document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
                return (el as HTMLInputElement | null)?.value?.trim() ?? "";
            })
                .catch(() => "");
            let tsToken = await readTurnstileResponse();
            if (tsToken) {
                reporter.captchaResult("passed");
            }
            else {
                reporter.setPhase("turnstile", "solving captcha (auto, OTP step)");
                reporter.captchaWaiting(null);
                const blockCheck = makeBlockCheck(page);
                try {
                    tsToken = await clickTurnstile(page, { check: blockCheck });
                }
                catch (e) {
                    if (e instanceof VfsForbiddenError || e instanceof VfsRateLimitedError)
                        throw e;
                }
                if (tsToken) {
                    reporter.captchaResult("passed");
                }
                else {
                    tsToken = await waitForManualTurnstile(page, { check: blockCheck });
                    if (!tsToken) {
                        reporter.captchaResult("failed");
                    }
                }
            }
        }
        if (otpFilled && turnstileValid) {
            break;
        }
        if (otpFilled && !turnstileValid && elapsed > 5000 && elapsed < 5500) {
            dismissCookieConsent(page, true).catch(() => { });
        }
        await page.waitForTimeout(300);
    }
    const dash = dashboardUrlRegex();
    const OTP_LOGIN_CAPTURE_MS = 120000;
    const OTP_LOGIN_POST_DASHBOARD_GRACE_MS = 3000;
    const otpLoginCapture: {
        res: import("playwright").Response | null;
    } = { res: null };
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
        if (waitResolved)
            return;
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
            if (!responseIsLiftUserLoginPost(res))
                return;
            otpLoginCapture.res = res;
            if (!waitResolved) {
                finishOtpCaptureFull();
            }
        }
        catch {
        }
    };
    const onFrameNav = (frame: import("playwright").Frame) => {
        if (waitResolved)
            return;
        if (frame !== page.mainFrame())
            return;
        try {
            if (!dash.test(frame.url()))
                return;
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
        }
        catch {
        }
    };
    let outerResolveOtpCapture: (() => void) | undefined;
    const waitForOtpCaptureDone = new Promise<void>((resolve) => {
        outerResolveOtpCapture = resolve;
        timeoutId = setTimeout(() => {
            if (waitResolved)
                return;
            finishOtpCaptureFull();
        }, OTP_LOGIN_CAPTURE_MS);
        page.on("response", onResponse);
        page.on("framenavigated", onFrameNav);
    });
    try {
        await forceClickSignInButton(page, submitBtn);
    }
    catch (err) {
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
    }
    catch {
    }
    // Return captured response for the caller to store
    const lastPostOtpLoginResponse: PostOtpLoginCapture | null = capturedOtpLogin
        ? await (async () => {
            const otpStatus = capturedOtpLogin!.status();
            if (otpStatus === 429) {
                const body = await capturedOtpLogin!.text().catch(() => "");
                const classified = classifyVfs429FromHttp(otpStatus, body) ?? { kind: "ip" as const, code: "429" };
                throwVfsRateLimited(classified.kind, classified.code, "OTP Login API HTTP 429");
            }
            if (otpStatus === 504) {
                const body = await capturedOtpLogin!.text().catch(() => "");
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
                const errObj = json.error as {
                    code?: number;
                    description?: string;
                } | undefined;
                const bodyCode = String((json as Record<string, unknown>).code ?? errObj?.code ?? "");
                const bodyKind = classifyVfs429(bodyCode);
                if (bodyKind) {
                    throwVfsRateLimited(bodyKind, bodyCode, "OTP Login API body rate-limit code");
                }
                if (errObj && errObj.code === 413 && errObj.description === "Invalid Sender User") {
                    void new TelegramService()
                        .alert("error", "The entered email id is not registered.")
                        .catch(() => { });
                }
                const flat = flattenVfsLoginResponseForProfile(json);
                if (flat)
                    mergeVfsLoginProfile(flat);
            }
            return capture;
        })()
        : null;
    if (!capturedOtpLogin && onDashboard) {
    }
    else if (!capturedOtpLogin) {
    }
    core.setLastPostOtpLoginResponse(lastPostOtpLoginResponse);
}
// ── Main login flow (top-level) ─────────────────────────────────────────
export async function performLoginOnFirstTab(core: BrowserServiceCore, username: string, password: string): Promise<void> {
    core.setLastPostOtpLoginResponse(null);
    clearVfsLoginProfile();
    const page = await core.getVfsPageOrAnyNonSetup();
    if (!page)
        throw new Error("No tab. Open Chrome with at least one tab, or open the VFS login page.");
    await page.bringToFront().catch(() => { });
    reporter.setPage(page.url());
    throwIfBlockPage(page);
    const visibleOnly = ':not(.d-none):not([aria-hidden="true"])';
    const usernameSelectors = `#email${visibleOnly}, input[formcontrolname="username"]${visibleOnly}, input[formControlName="username"]${visibleOnly}, input[formcontrolname="email"]${visibleOnly}, input[formControlName="email"]${visibleOnly}, input[name="username"]${visibleOnly}, input[name="email"]${visibleOnly}, input[type="email"]${visibleOnly}`;
    await waitForLoginFormOrThrowBlock(page, usernameSelectors, 300000);
    await dismissCookieConsent(page, true);
    const passwordSelectors = `input[formcontrolname="password"]${visibleOnly}, input[name="password"]${visibleOnly}, input[type="password"]:not([formcontrolname="otp"])${visibleOnly}`;
    await fillLoginCredentials(page, username, password, {
        usernameSelectors,
        passwordSelectors,
        timeoutMs: 25000,
    });
    const submitBtn = await resolveLoginSubmitButton(page);
    const wantMailTm = config.mailTmOtpEnabled && username.trim().includes("@") && password.length > 0;
    let mailTmReady: {
        token: string;
        baseline: Set<string>;
    } | null = null;
    let mailOtpFetchPromise: Promise<string> | null = null;
    if (wantMailTm) {
        try {
            const mailToken = await fetchMailTmToken(username.trim(), password);
            const initial = await listMailTmMessages(mailToken, "baseline_before_sign_in");
            const mailBaseline = new Set<string>();
            for (const m of initial) {
                if (m.id)
                    mailBaseline.add(m.id);
            }
            mailTmReady = { token: mailToken, baseline: mailBaseline };
        }
        catch (err) {
        }
    }
    else {
    }
    const passwordLoginResponsePromise = page
        .waitForResponse((res) => {
        try {
            return responseIsLiftUserLoginPost(res);
        }
        catch {
            return false;
        }
    }, { timeout: 90000 })
        .catch((err) => {
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
            throwVfsRateLimited(classified.kind, classified.code, "Login API HTTP 429");
        }
        if (pwdStatus === 504) {
            const pwdBody = await pwdLoginRes.text().catch(() => "");
            throw new VfsGatewayTimeoutError("Login API returned 504 Gateway Timeout — restarting browser + rotating IP.");
        }
        const pwdBody = await pwdLoginRes.text().catch(() => "");
        const pwdJson = parseVfsUserLoginResponseBody(pwdBody);
        if (pwdJson) {
            const errObj = pwdJson.error as {
                code?: number;
                description?: string;
            } | undefined;
            const bodyCode = String((pwdJson as Record<string, unknown>).code ?? errObj?.code ?? "");
            const bodyKind = classifyVfs429(bodyCode);
            if (bodyKind) {
                throwVfsRateLimited(bodyKind, bodyCode, "Login API body rate-limit code");
            }
            if (errObj && errObj.code === 413 && errObj.description === "Invalid Sender User") {
                void new TelegramService()
                    .alert("error", "The entered email id is not registered.")
                    .catch(() => { });
            }
            const flat = flattenVfsLoginResponseForProfile(pwdJson);
            const cc = String(config.slotPayload.countryCode ?? "").trim().toLowerCase();
            const mc = String(config.slotPayload.missionCode ?? "").trim().toLowerCase();
            const mergeApplicantFromPasswordStep = pwdJson.enableOTPAuthentication === false || (cc === "ind" && mc === "lva");
            let forStore: Record<string, unknown> | null;
            if (mergeApplicantFromPasswordStep && flat) {
                const o = { ...flat };
                delete o.applicantList;
                delete o.applicant;
                forStore = o;
            }
            else {
                forStore = stripPasswordStepApplicantFieldsForProfileMerge(flat);
            }
            if (forStore)
                mergeVfsLoginProfile(forStore);
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
async function finishLoginAfterFirstSubmit(page: Page, mailOtpFetchPromise: Promise<string> | null, core: BrowserServiceCore): Promise<void> {
    const dash = dashboardUrlRegex();
    const phase = await waitForDashboardOrOtpStep(page, dash, 45000);
    if (phase === "dashboard") {
        void mailOtpFetchPromise?.catch(() => { });
    }
    else if (phase === "otp") {
        await runLoginOtpCompletionFlow(page, mailOtpFetchPromise, dash, core);
    }
    else {
        let urlAfterPhase = "";
        try {
            urlAfterPhase = page.url();
        }
        catch {
        }
        const phase2 = await waitForDashboardOrOtpStep(page, dash, 90000);
        let url2 = "";
        try {
            url2 = page.url();
        }
        catch {
        }
        if (phase2 === "dashboard") {
            void mailOtpFetchPromise?.catch(() => { });
        }
        else if (phase2 === "otp") {
            await runLoginOtpCompletionFlow(page, mailOtpFetchPromise, dash, core);
        }
        else if (mailOtpFetchPromise) {
            try {
                await completeOtpWithMailPromise(page, mailOtpFetchPromise, dash, core);
            }
            catch (err) {
                void mailOtpFetchPromise.catch(() => { });
                throw err;
            }
        }
        else {
            try {
                await page.waitForURL(dash, { timeout: 45000 });
            }
            catch {
            }
        }
    }
    const kind = classifyVfsFirstTabUrl(page.url());
    if (kind === "login" || kind === "blank") {
        void mailOtpFetchPromise?.catch(() => { });
        throw new Error("Login did not complete (still on login or blank). For auto OTP: VFS email/password must match a mail.tm mailbox (https://api.mail.tm/#/). Or finish OTP manually in Chrome.");
    }
}
export async function openLoginInFirstTab(core: BrowserServiceCore): Promise<void> {
    const page = await core.getOrCreateNonSetupPage();
    await page.bringToFront().catch(() => { });
    const navResponse = await page.goto(config.loginPageUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    if (navResponse && navResponse.status() === 403) {
        throw new VfsForbiddenError("Login page returned 403 Forbidden — IP/session blocked by Cloudflare or VFS.");
    }
    throwIfBlockPage(page);
    const visibleOnly = ':not(.d-none):not([aria-hidden="true"])';
    const usernameSelectors = `#email${visibleOnly}, input[formcontrolname="username"]${visibleOnly}, input[formControlName="username"]${visibleOnly}, input[formcontrolname="email"]${visibleOnly}, input[formControlName="email"]${visibleOnly}, input[name="username"]${visibleOnly}, input[name="email"]${visibleOnly}, input[type="email"]${visibleOnly}`;
    await waitForLoginFormOrThrowBlock(page, usernameSelectors, 300000);
}
export async function logoutVfsAndOpenLoginFirstTab(core: BrowserServiceCore): Promise<void> {
    const page = await core.getVfsPageOrAnyNonSetup();
    if (!page) {
        await openLoginInFirstTab(core);
        return;
    }
    await page.bringToFront().catch(() => { });
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
    }
    catch {
    }
    await openLoginInFirstTab(core);
}

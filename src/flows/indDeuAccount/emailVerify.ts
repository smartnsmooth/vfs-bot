import type { Page } from "playwright";
import {
  fetchMailTmToken,
  listMailTmMessages,
  sanitizeActivationUrl,
  waitForMailTmActivationLink,
} from "../../services/mailTm.service";
import { config } from "../../config/config";
import { dismissIndDeuCookies } from "./cookies";
import { submitIndDeuWithTurnstile } from "./turnstileSubmit";

const FIRST_WAIT_MS = Math.max(
  20_000,
  parseInt(process.env.MAIL_TM_ACTIVATION_FIRST_WAIT_MS ?? "45000", 10) || 45_000,
);
const FULL_WAIT_MS = Math.max(
  60_000,
  parseInt(process.env.MAIL_TM_ACTIVATION_TIMEOUT_MS ?? "180000", 10) || 180_000,
);
const POLL_MS = Math.max(2_000, parseInt(process.env.MAIL_TM_ACTIVATION_POLL_MS ?? "4000", 10) || 4_000);

async function waitForActivationLink(email: string, password: string, timeoutMs: number): Promise<string> {
  const token = await fetchMailTmToken(email, password);
  const baseline = new Set((await listMailTmMessages(token, "activation-baseline")).map((m) => m.id));
  return waitForMailTmActivationLink({
    token,
    timeoutMs,
    pollMs: Math.min(POLL_MS, Math.max(800, Math.floor(timeoutMs / 4))),
    baselineIds: baseline,
  });
}

async function openActivationInSameTab(page: Page, link: string): Promise<void> {
  const clean = sanitizeActivationUrl(link);
  try {
    await page.goto(clean, { waitUntil: "domcontentloaded", timeout: 120_000 });
  } catch {
    /* continue wait on this tab */
  }
  await page.bringToFront().catch(() => {});
}

async function closeExtraVfsTabs(keep: Page): Promise<void> {
  for (const p of keep.context().pages()) {
    if (p === keep || p.isClosed()) continue;
    try {
      const u = p.url().toLowerCase();
      if (!u || u === "about:blank" || u.includes("visa.vfsglobal.com")) {
        await p.close();
      }
    } catch {
      /* ignore */
    }
  }
}

async function waitUntilLoginForm(page: Page, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await dismissIndDeuCookies(page, 8_000);
    const url = page.url().toLowerCase();
    // Require /login — register also has an email field.
    if (/\/login(\?|$|\/)/.test(url)) return true;
    await page.waitForTimeout(700);
  }
  return /\/login/i.test(page.url());
}

async function isInactiveAccountPage(page: Page): Promise<boolean> {
  const text = await page.locator("body").innerText({ timeout: 4000 }).catch(() => "");
  return /account is currently inactive|resend the activation email|currently inactive|email is not activat|not activat|inactive\.?\s*please/i.test(
    text,
  );
}

async function clickInactiveClickHere(page: Page): Promise<boolean> {
  const scoped = page
    .locator(".alert, [role='alert'], .warning, .banner, .message, .mat-error, p, div")
    .filter({ hasText: /inactive|not activat|activation email|resend|email is not/i })
    .locator("a.c-brand-orange, a.text-decoration-underline, a, button")
    .filter({ hasText: /^\s*click here\s*$/i });
  const n = await scoped.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = scoped.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const nearLogin = await el
      .evaluate((node) => {
        const block = (node.closest("div, p, section, form, .alert")?.textContent || "") + (node.textContent || "");
        return /already registered|click here to login/i.test(block);
      })
      .catch(() => false);
    if (nearLogin) continue;
    await el.click({ timeout: 5000 }).catch(() => {});
    return true;
  }
  return false;
}

async function resendActivationViaLogin(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  if (!/\/login/i.test(page.url())) {
    await page.goto(config.loginPageUrl, { waitUntil: "domcontentloaded", timeout: 120_000 }).catch(() => {});
  }
  await dismissIndDeuCookies(page, 15_000);
  const emailLoc = page.locator("#email, input[formcontrolname='username' i], input[type='email']").first();
  const pwLoc = page
    .locator('input[formcontrolname="password"], input[type="password"]:not([formcontrolname="otp"])')
    .first();
  await emailLoc.waitFor({ state: "visible", timeout: 30_000 });
  await emailLoc.fill(email);
  await pwLoc.fill(password);
  await submitIndDeuWithTurnstile(
    page,
    'button:has-text("Sign In"), button:has-text("Sign in"), button[type="submit"]',
  );
  await page.waitForTimeout(2000);
  if (await isInactiveAccountPage(page)) {
    await clickInactiveClickHere(page);
    await page.waitForTimeout(1200);
    const activate = page.locator('button:has-text("Activate"), button[type="submit"]').first();
    if (await activate.isVisible().catch(() => false)) {
      await submitIndDeuWithTurnstile(page, 'button:has-text("Activate"), button[type="submit"]');
    }
  }
}

/**
 * Wait for VFS activation mail, open the link, land on login.
 * Does not sign in — vfsbot login + HeroSMS OTP runs next.
 */
export async function runIndDeuEmailVerify(
  page: Page,
  opts: { email: string; password: string; onStatus?: (msg: string) => void },
): Promise<Page> {
  let link: string | null = null;
  try {
    opts.onStatus?.("waiting for email activation link");
    link = await waitForActivationLink(opts.email, opts.password, FIRST_WAIT_MS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/no activation link/i.test(msg) && !/mail\.tm/i.test(msg)) throw e;
    opts.onStatus?.("no activation link — resend via login");
    await resendActivationViaLogin(page, opts.email, opts.password);
    link = await waitForActivationLink(opts.email, opts.password, FULL_WAIT_MS);
  }

  await openActivationInSameTab(page, link!);
  let ok = await waitUntilLoginForm(page);
  if (!ok) {
    await openActivationInSameTab(page, link!);
    ok = await waitUntilLoginForm(page);
  }
  if (!ok) throw new Error("Email activation did not reach login");
  await closeExtraVfsTabs(page);
  return page;
}

import type { Page } from "playwright";
import type { HeroSmsNumber } from "../../services/heroSms";
import { dismissIndDeuCookies } from "./cookies";
import { submitIndDeuWithTurnstile } from "./turnstileSubmit";

const EMAIL_SELECTORS = [
  "#inputEmail",
  'input[formcontrolname="emailid" i]',
  'input[formControlName="emailid"]',
  'input[formcontrolname="email" i]',
];

const PASSWORD_SELECTORS = [
  "#password",
  'input[formcontrolname="password" i]',
  'input[formControlName="password"]',
];

const CONFIRM_PASSWORD_SELECTORS = [
  "#confirmPassword",
  'input[formcontrolname="confirmPassword" i]',
  'input[formControlName="confirmPassword"]',
];

const PHONE_SELECTORS = [
  'input[formcontrolname="contact" i]',
  'input[formControlName="contact"]',
  'input[formcontrolname="mobile" i]',
  'input[type="tel"]',
];

const REGISTER_SUBMIT =
  '#trigger, button.ot-submit-button, button:has-text("Continue"), button[type="submit"]';

async function firstAttached(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) return sel;
    } catch {
      /* next */
    }
  }
  return null;
}

async function fillFirst(page: Page, selectors: string[], value: string): Promise<boolean> {
  const sel = await firstAttached(page, selectors);
  if (!sel) return false;
  const loc = page.locator(sel).first();
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.click({ timeout: 5000 });
  await loc.fill("");
  await loc.pressSequentially(value, { delay: 35 });
  return true;
}

export async function waitForIndDeuRegisterForm(page: Page, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let cookiesDone = false;
  while (Date.now() < deadline) {
    if (!cookiesDone) {
      await dismissIndDeuCookies(page, 20_000);
      cookiesDone = true;
    }
    const emailSel = await firstAttached(page, EMAIL_SELECTORS);
    const passwordSel = await firstAttached(page, PASSWORD_SELECTORS);
    const phoneSel = await firstAttached(page, PHONE_SELECTORS);
    if (emailSel && passwordSel && phoneSel) {
      await dismissIndDeuCookies(page, 5_000);
      return;
    }
    await page.waitForTimeout(400);
  }
  throw new Error("ind-deu register form not ready (email/password/phone)");
}

async function checkConsentBoxes(page: Page): Promise<void> {
  const byName = [
    'mat-checkbox[formcontrolname="processPerDataAgreed" i]',
    'mat-checkbox[formcontrolname="intTransPerDataAgreed" i]',
    'mat-checkbox[formcontrolname="termAndConditionAgreed" i]',
  ];
  for (const sel of byName) {
    const box = page.locator(sel).first();
    try {
      if (!(await box.count())) continue;
      const input = box.locator('input[type="checkbox"]').first();
      const checked = await input.isChecked().catch(() => false);
      if (!checked) {
        await box.scrollIntoViewIfNeeded().catch(() => {});
        await box.click({ timeout: 4000, force: true });
      }
    } catch {
      /* skip */
    }
  }
}

export async function selectGermanyDialCode(page: Page): Promise<void> {
  const dialSelectors = [
    'mat-select[formcontrolname="dialcode" i]',
    'mat-select[formControlName="dialcode"]',
    'mat-select[formcontrolname="dialCode" i]',
  ];
  for (const sel of dialSelectors) {
    const loc = page.locator(sel).first();
    try {
      if (!(await loc.count())) continue;
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 4000, force: true });
      await page.waitForTimeout(400);
      const opt = page.locator("mat-option").filter({ hasText: /\+49|Germany/i }).first();
      if (await opt.count()) {
        await opt.click({ timeout: 4000 });
        return;
      }
      await page.keyboard.type("49", { delay: 40 });
      await page.waitForTimeout(300);
      const opt2 = page.locator("mat-option").first();
      if (await opt2.count()) {
        await opt2.click({ timeout: 3000 });
        return;
      }
    } catch {
      /* next */
    }
  }
}

export async function fillIndDeuRegisterForm(
  page: Page,
  opts: {
    email: string;
    password: string;
    phone: HeroSmsNumber;
    check?: () => Promise<void>;
  },
): Promise<void> {
  await waitForIndDeuRegisterForm(page);
  if (opts.check) await opts.check();

  if (!(await fillFirst(page, EMAIL_SELECTORS, opts.email))) {
    throw new Error("Register form: email field not found");
  }
  await page.waitForTimeout(400);
  if (!(await fillFirst(page, PASSWORD_SELECTORS, opts.password))) {
    throw new Error("Register form: password field not found");
  }
  await page.waitForTimeout(400);
  if (!(await fillFirst(page, CONFIRM_PASSWORD_SELECTORS, opts.password))) {
    const pwInputs = page.locator(
      'input[type="password"]:not([formcontrolname="otp"]):not([formControlName="otp"])',
    );
    if ((await pwInputs.count()) >= 2) {
      await pwInputs.nth(1).click();
      await pwInputs.nth(1).pressSequentially(opts.password, { delay: 40 });
    } else {
      throw new Error("Register form: confirm password field not found");
    }
  }
  await page.waitForTimeout(400);
  await selectGermanyDialCode(page);
  await page.waitForTimeout(400);
  if (!(await fillFirst(page, PHONE_SELECTORS, opts.phone.localNumber))) {
    throw new Error("Register form: phone field not found");
  }
  await page.waitForTimeout(300);
  await checkConsentBoxes(page);
  await page.waitForTimeout(700);
  await submitIndDeuWithTurnstile(page, REGISTER_SUBMIT, opts.check);
  await page.waitForTimeout(1500);
}

export async function updateIndDeuRegisterPhone(
  page: Page,
  phone: HeroSmsNumber,
  check?: () => Promise<void>,
): Promise<void> {
  await waitForIndDeuRegisterForm(page, 60_000);
  await selectGermanyDialCode(page);
  await page.waitForTimeout(400);
  if (!(await fillFirst(page, PHONE_SELECTORS, phone.localNumber))) {
    throw new Error("Change phone: phone field not found");
  }
  await page.waitForTimeout(600);
  await submitIndDeuWithTurnstile(page, REGISTER_SUBMIT, check);
}

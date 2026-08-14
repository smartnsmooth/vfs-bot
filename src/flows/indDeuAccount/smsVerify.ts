import type { Page } from "playwright";
import {
  heroSmsBuyGermanyOt,
  heroSmsCancel,
  heroSmsReadyForNext,
  heroSmsWaitForSms,
  type HeroSmsNumber,
} from "../../services/heroSms";
import { getCurrentInstanceId } from "../../config/config";
import { persistHeroSmsPurchase } from "../../utils/indDeuAccountState";
import { dismissIndDeuCookies } from "./cookies";
import { updateIndDeuRegisterPhone } from "./registerForm";
import { submitIndDeuWithTurnstile } from "./turnstileSubmit";

const OTP_SUBMIT =
  'button:has-text("Register"), button:has-text("Verify"), button:has-text("Continue"), button:has-text("Submit"), button[type="submit"], #trigger';

const SMS_WAIT_MS = Math.max(60_000, parseInt(process.env.HERO_SMS_WAIT_MS ?? "120000", 10) || 120_000);
const SMS_POLL_MS = Math.max(2_000, parseInt(process.env.HERO_SMS_POLL_MS ?? "4000", 10) || 4_000);

async function fillOtp(page: Page, code: string): Promise<void> {
  const digits = code.replace(/\D/g, "");
  const segmented = page.locator(
    'input[formcontrolname="otp"], input[autocomplete="one-time-code"], input[name="otp"]',
  );
  if (await segmented.count()) {
    await segmented.first().click();
    await page.waitForTimeout(150);
    await segmented.first().pressSequentially(digits, { delay: 50 });
    await segmented.first().blur().catch(() => {});
    return;
  }
  const boxes = page.locator('input[type="tel"], input[maxlength="1"], .otp-input input');
  const n = await boxes.count();
  if (n >= 4 && n <= 8 && digits.length >= n) {
    for (let i = 0; i < n; i++) {
      await boxes.nth(i).click();
      await boxes.nth(i).pressSequentially(digits[i] ?? "", { delay: 35 });
      await page.waitForTimeout(60);
    }
    return;
  }
  await page.keyboard.type(digits, { delay: 50 });
}

async function clickChangeMobileNumber(page: Page): Promise<void> {
  await dismissIndDeuCookies(page, 8_000);
  const candidates = [
    page
      .locator("div, p, span, form")
      .filter({ hasText: /change your mobile number|change.*mobile number/i })
      .locator("a.c-brand-orange, a.text-decoration-underline, a")
      .filter({ hasText: /^\s*click here\s*$/i }),
    page.locator("a.c-brand-orange.cursor-pointer").filter({ hasText: /^\s*click here\s*$/i }),
    page.locator("a.c-brand-orange").filter({ hasText: /^\s*click here\s*$/i }),
  ];
  for (const loc of candidates) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      try {
        const el = loc.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const nearLogin = await el
          .evaluate((node) => {
            const block =
              (node.closest("div, p, section, form")?.textContent || "") + (node.textContent || "");
            return /already registered|click here to login|sign in/i.test(block);
          })
          .catch(() => false);
        if (nearLogin) continue;
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 5000 });
        return;
      } catch {
        /* next */
      }
    }
  }
  throw new Error("Change mobile number link not found");
}

async function waitUntilPhoneField(page: Page, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url().toLowerCase();
    if (/\/login(\?|$|\/)/.test(url)) {
      await page.waitForTimeout(400);
      continue;
    }
    const phone = page.locator(
      'input[formcontrolname="contact" i], input[formControlName="contact"], input[formcontrolname="mobile" i]',
    );
    if (await phone.first().isVisible().catch(() => false)) return;
    await page.waitForTimeout(400);
  }
  throw new Error("After change-mobile, register phone field did not appear");
}

export async function runIndDeuSmsVerify(
  page: Page,
  opts: {
    phone: HeroSmsNumber;
    check?: () => Promise<void>;
    onPhone: (p: HeroSmsNumber) => void;
    onStatus?: (msg: string) => void;
  },
): Promise<{ phone: HeroSmsNumber; lastCode: string }> {
  let phone = opts.phone;
  let lastCode = "";
  await dismissIndDeuCookies(page, 8_000);

  const tryReceiveAndSubmit = async (): Promise<boolean> => {
    opts.onStatus?.("waiting for register SMS OTP");
    try {
      const code = await heroSmsWaitForSms(phone.activationId, {
        timeoutMs: SMS_WAIT_MS,
        pollMs: SMS_POLL_MS,
        ignoreCode: lastCode,
      });
      lastCode = code;
      await fillOtp(page, code);
      await page.waitForTimeout(700);
      await submitIndDeuWithTurnstile(page, OTP_SUBMIT, opts.check);
      await heroSmsReadyForNext(phone.activationId);
      await page.waitForTimeout(1800);
      return true;
    } catch {
      return false;
    }
  };

  let got = await tryReceiveAndSubmit();
  if (!got) {
    opts.onStatus?.("no SMS — changing mobile number");
    await clickChangeMobileNumber(page);
    await page.waitForTimeout(1000);
    await waitUntilPhoneField(page);
    await heroSmsCancel(phone.activationId);
    phone = await heroSmsBuyGermanyOt({ onRetry: opts.onStatus });
    persistHeroSmsPurchase(getCurrentInstanceId(), phone);
    opts.onPhone(phone);
    await updateIndDeuRegisterPhone(page, phone, opts.check);
    await page.waitForTimeout(1200);
    got = await tryReceiveAndSubmit();
    if (!got) {
      await heroSmsCancel(phone.activationId);
      throw new Error("SMS not received after change-mobile — restart register with new phone");
    }
  }
  return { phone, lastCode };
}

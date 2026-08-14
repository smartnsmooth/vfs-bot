import type { Page } from "playwright";
import { reporter } from "../../monitoring/statusReporter";
import {
  createMailTmAccount,
  fetchMailTmToken,
  maskEmailForLog,
} from "../../services/mailTm.service";
import {
  getHeroSmsApiKey,
  heroSmsBuyGermanyOt,
  heroSmsCancel,
  type HeroSmsNumber,
} from "../../services/heroSms";
import {
  cancelStoredHeroSms,
  clearIndDeuCreatedAccount,
  getIndDeuAccountPassword,
  getIndDeuEmailDomain,
  getIndDeuEmailPrefix,
  persistHeroSmsPurchase,
  persistIndDeuCreatedAccount,
  shouldReuseIndDeuAccount,
} from "../../utils/indDeuAccountState";
import { allocateNextIndDeuEmailIndex, buildIndDeuEmail } from "../../utils/indDeuEmailIndex";
import { fillIndDeuRegisterForm } from "./registerForm";
import { runIndDeuSmsVerify } from "./smsVerify";
import { runIndDeuEmailVerify } from "./emailVerify";

export type IndDeuAccountBrowser = {
  openRegisterInFirstTab: () => Promise<void>;
  openLoginInFirstTab: () => Promise<void>;
  getVfsPageOrAnyNonSetup: () => Promise<Page | null>;
  getOrCreateNonSetupPage: () => Promise<Page>;
};

const MAIL_TM_RETRY_MAX = Math.max(1, parseInt(process.env.MAIL_TM_RETRY_MAX ?? "20", 10) || 20);
const REG_SMS_INNER_MAX = Math.max(1, parseInt(process.env.IND_DEU_REG_SMS_ATTEMPTS ?? "20", 10) || 20);
const EMAIL_ROUND_MAX = Math.max(1, parseInt(process.env.IND_DEU_EMAIL_ROUNDS ?? "20", 10) || 20);

export function isIndDeuSmsHardRestartError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /SMS not received after change-mobile/i.test(msg);
}

async function mailTmLoginOk(email: string, password: string): Promise<boolean> {
  try {
    await fetchMailTmToken(email, password);
    return true;
  } catch {
    return false;
  }
}

/** Login to pre-created inbox; if that fails, create prefix_NNN_r1, _r2, … */
async function resolveIndDeuMailTmAddress(
  prefix: string,
  index: number,
  domain: string,
  password: string,
): Promise<string> {
  const base = buildIndDeuEmail(prefix, index, domain, 0);
  reporter.setDetail(`mail.tm login ${maskEmailForLog(base)}`);
  if (await mailTmLoginOk(base, password)) {
    return base;
  }

  let lastErr = `mail.tm login failed for ${maskEmailForLog(base)}`;
  for (let retry = 1; retry <= MAIL_TM_RETRY_MAX; retry++) {
    const email = buildIndDeuEmail(prefix, index, domain, retry);
    reporter.setDetail(`mail.tm create ${maskEmailForLog(email)}`);
    try {
      await createMailTmAccount(email, password);
      if (await mailTmLoginOk(email, password)) return email;
      lastErr = `mail.tm create/login failed for ${maskEmailForLog(email)}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(
    `mail.tm: could not use ${maskEmailForLog(base)} or _r1…_r${MAIL_TM_RETRY_MAX} (${lastErr})`,
  );
}

async function requirePage(browser: IndDeuAccountBrowser): Promise<Page> {
  const page = (await browser.getVfsPageOrAnyNonSetup()) ?? (await browser.getOrCreateNonSetupPage());
  if (!page) throw new Error("No Chrome tab for ind-deu account creation");
  return page;
}

async function cancelPhone(phone: HeroSmsNumber | null): Promise<void> {
  if (!phone) return;
  await heroSmsCancel(phone.activationId).catch(() => {});
}

export async function ensureIndDeuAccountReady(
  browser: IndDeuAccountBrowser,
  instanceId: number | undefined,
  opts?: {
    forceNew?: boolean;
    /** Kill Chrome, clear cache/cookies, rotate IP, spawn a new window. */
    hardRestartChrome?: () => Promise<void>;
  },
): Promise<void> {
  if (!opts?.forceNew && shouldReuseIndDeuAccount(instanceId)) {
    reporter.setPhase("login", "reusing ind-deu account");
    return;
  }

  const prefix = getIndDeuEmailPrefix();
  if (!prefix) {
    throw new Error("ind-deu email prefix is missing — set it on the setup form.");
  }
  const domain = getIndDeuEmailDomain();
  if (!domain) {
    throw new Error("ind-deu email domain is missing — set it on the setup form.");
  }
  if (!getHeroSmsApiKey()) {
    throw new Error("HERO_SMS_API_KEY is missing — add it to vfsbot .env.");
  }

  const password = getIndDeuAccountPassword();
  if (!password) {
    throw new Error("ind-deu account password is missing — set it on the setup form.");
  }

  await cancelStoredHeroSms(instanceId);
  clearIndDeuCreatedAccount(instanceId);
  let lastErr = "ind-deu register/SMS failed";

  for (let emailRound = 1; emailRound <= EMAIL_ROUND_MAX; emailRound++) {
    reporter.setPhase("launching", `resolving mail.tm inbox (email ${emailRound}/${EMAIL_ROUND_MAX})`);
    const index = await allocateNextIndDeuEmailIndex();
    const email = await resolveIndDeuMailTmAddress(prefix, index, domain, password);
    let phone: HeroSmsNumber | null = null;

    for (let regAttempt = 1; regAttempt <= REG_SMS_INNER_MAX; regAttempt++) {
      try {
        if (emailRound > 1 || regAttempt > 1) {
          reporter.setPhase(
            "launching",
            `SMS miss — new Chrome/IP/phone, same email (${regAttempt}/${REG_SMS_INNER_MAX})`,
          );
          await cancelPhone(phone);
          phone = null;
          if (opts?.hardRestartChrome) await opts.hardRestartChrome();
        }

        reporter.setPhase("launching", `buying HeroSMS (${maskEmailForLog(email)} ${regAttempt}/${REG_SMS_INNER_MAX})`);
        phone = await heroSmsBuyGermanyOt({
          onRetry: (msg) => reporter.setDetail(msg),
        });
        persistHeroSmsPurchase(instanceId, phone);

        reporter.setPhase("launching", `opening register — ${email}`);
        await browser.openRegisterInFirstTab();
        let page = await requirePage(browser);

        await fillIndDeuRegisterForm(page, {
          email,
          password,
          phone,
          check: async () => {
            if (page.isClosed()) throw new Error("tab closed during register");
          },
        });

        const sms = await runIndDeuSmsVerify(page, {
          phone,
          onPhone: (p) => {
            phone = p;
          },
          onStatus: (msg) => reporter.setDetail(msg),
        });
        phone = sms.phone;

        reporter.setPhase("launching", "email activation");
        page = await runIndDeuEmailVerify(page, {
          email,
          password,
          onStatus: (msg) => reporter.setDetail(msg),
        });

        persistIndDeuCreatedAccount(instanceId, {
          email,
          password,
          dialCode: phone.dialCode,
          contactNumber: phone.localNumber,
          heroSmsActivationId: phone.activationId,
          heroSmsLastCode: sms.lastCode,
        });
        reporter.setPhase("login", `account ready — ${email}`);
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        await cancelPhone(phone);
        phone = null;
        if (isIndDeuSmsHardRestartError(err) || /tab closed|HeroSMS: no SMS/i.test(lastErr)) {
          reporter.setDetail(
            `register SMS failed (${regAttempt}/${REG_SMS_INNER_MAX}): ${lastErr}`,
          );
          continue;
        }
        throw err;
      }
    }

    reporter.setDetail(`20 SMS restarts failed for ${maskEmailForLog(email)} — next email`);
  }

  clearIndDeuCreatedAccount(instanceId);
  throw new Error(
    `ind-deu register/SMS failed after ${EMAIL_ROUND_MAX} emails × ${REG_SMS_INNER_MAX} restarts: ${lastErr}`,
  );
}

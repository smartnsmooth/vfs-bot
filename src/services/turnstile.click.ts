import type { Frame, Page } from "playwright";
import { isVfsDashboardUrl } from "../flows/vfsTabUrl";
import { reporter } from "../monitoring/statusReporter";
import { VfsAlreadyLoggedInError } from "./browser.errors";

function pageUrlSafe(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

/**
 * Chrome reached the dashboard — no Turnstile widget will ever appear here, so
 * abort the captcha wait instead of burning the frame-search + manual-assist
 * timeouts. The login flow treats this as "login already succeeded".
 */
function throwIfOnDashboard(page: Page, stage: string): void {
  const url = pageUrlSafe(page);
  if (!isVfsDashboardUrl(url)) return;
  // `login` clears the captcha-waiting state and the attention blink without
  // counting a captcha attempt that VFS never asked for.
  reporter.setPhase("login", "on dashboard — skipping captcha");
  throw new VfsAlreadyLoggedInError(stage, url);
}

/**
 * Manual-assist fallback: after the auto-solve fails, bring the operator's
 * attention (dashboard alert + auto-focus) and WAIT for a token to appear —
 * i.e. give the operator time to solve the checkbox by hand in the focused
 * Chrome window. Returns the token if it appears within `waitMs`, else "".
 *
 * Enabled by default; disable with CAPTCHA_MANUAL_ASSIST=false.
 */
export async function waitForManualTurnstile(
  page: Page,
  opts?: { waitMs?: number; check?: () => Promise<void> }
): Promise<string> {
  const enabled = (process.env.CAPTCHA_MANUAL_ASSIST ?? "true").trim().toLowerCase() !== "false";
  if (!enabled) return "";

  // If the page is actually a block/error page (403201, page-not-found, …) this
  // throws before we claim "captcha attention", so the caller can recover instead.
  if (opts?.check) await opts.check();
  throwIfOnDashboard(page, "manual-captcha-start");

  const totalMs = opts?.waitMs ?? Math.max(10_000, parseInt(process.env.CAPTCHA_MANUAL_WAIT_MS ?? "120000", 10) || 120_000);
  const deadline = Date.now() + totalMs;

    reporter.setAttention("captcha", "captcha failed — solve it in the focused Chrome window");
  reporter.requestFocus("captcha");
  reporter.captchaWaiting(deadline);

  let lastLog = 0;
  while (Date.now() < deadline) {
    if (opts?.check) await opts.check();
    throwIfOnDashboard(page, "manual-captcha-wait");
    const token = await page
      .evaluate(() => {
        const el =
          document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ??
          document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
        return (el as HTMLInputElement | null)?.value?.trim() ?? "";
      })
      .catch(() => "");

    if (token && token.length > 20) {
            reporter.captchaResult("passed");
      reporter.setAttention(null);
      return token;
    }

    const now = Date.now();
    if (now - lastLog > 10_000) {
      lastLog = now;
      const remaining = Math.round((deadline - now) / 1000);
      reporter.setDetail(`waiting for manual captcha (${remaining}s left)`);
          }
    await page.waitForTimeout(1000);
  }

    reporter.setDetail("manual captcha window elapsed");
  return "";
}

/**
 * Locate the Cloudflare Turnstile iframe via page.frames() — this sees frames
 * inside a closed shadow DOM, which document.querySelector cannot.
 */
async function findTurnstileFrame(
  page: Page,
  timeoutMs: number,
  check?: () => Promise<void>
): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs;
  let lastCheck = 0;
  while (Date.now() < deadline) {
    // Abort the wait early if the page turned into a block/error page.
    if (check && Date.now() - lastCheck > 1500) {
      lastCheck = Date.now();
      await check();
    }
    throwIfOnDashboard(page, "turnstile-frame-wait");
    const f = page
      .frames()
      .find((fr) => /challenges\.cloudflare\.com/.test(fr.url()) && /turnstile/.test(fr.url()));
    if (f) return f;
    await page.waitForTimeout(300);
  }
  return null;
}

/** Read the current cf-turnstile-response token from the light DOM. */
async function readTurnstileToken(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const el =
        document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ??
        document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
      return (el as HTMLInputElement | null)?.value?.trim() ?? "";
    })
    .catch(() => "");
}

/**
 * Solve a managed-checkbox Turnstile by clicking "Verify you are human" with a
 * trusted CDP mouse event (page.mouse), which Turnstile accepts (isTrusted).
 * Works even when the widget iframe is inside a closed shadow DOM.
 *
 * Returns the resolved token, or "" if no token appeared (Cloudflare likely
 * escalated to an interactive challenge, which a single click cannot solve).
 */
export async function clickTurnstile(
  page: Page,
  opts?: { frameTimeoutMs?: number; tokenTimeoutMs?: number; check?: () => Promise<void> }
): Promise<string> {
  const start = Date.now();

  // Abort immediately if the page is already a block/error page.
  if (opts?.check) await opts.check();
  throwIfOnDashboard(page, "turnstile-click-start");

  // Bring the widget into view. The host element is in the light DOM even when
  // the iframe itself is inside the closed shadow root.
  await page
    .locator(
      'app-cloudflare-captcha-container, [appcloudflarerecaptcha], input[name="cf-turnstile-response"]',
    )
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => { });

  const frame = await findTurnstileFrame(page, opts?.frameTimeoutMs ?? 20_000, opts?.check);
  if (!frame) {
        return "";
  }
  
  // Measure the widget's on-screen rect from an element inside the frame;
  // boundingBox() returns coordinates in the top-level viewport.
  let box = await frame
    .locator("body")
    .boundingBox()
    .catch(() => null);
  if (!box) {
    await page.waitForTimeout(800);
    box = await frame
      .locator("body")
      .boundingBox()
      .catch(() => null);
  }
  if (!box) {
        return "";
  }

  // The checkbox sits ~30px from the left, vertically centered. Move then click
  // so Chrome emits a trusted input event (a JS dispatchEvent would be ignored).
  const x = box.x + 30;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 10 });
  await page.waitForTimeout(120);
  await page.mouse.click(x, y);
  
  // Success = the light-DOM response token input gets populated.
  const solved = await page
    .waitForFunction(
      () => {
        const el =
          document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ??
          document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
        return !!el && !!(el as HTMLInputElement).value && (el as HTMLInputElement).value.length > 20;
      },
      undefined,
      { timeout: opts?.tokenTimeoutMs ?? 15_000 },
    )
    .then(() => true)
    .catch(() => false);

  if (!solved) {
        return "";
  }

  const token = await readTurnstileToken(page);
    return token;
}

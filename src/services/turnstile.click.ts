import type { Frame, Page } from "playwright";
import { logger } from "../utils/logger";

/**
 * Locate the Cloudflare Turnstile iframe via page.frames() — this sees frames
 * inside a closed shadow DOM, which document.querySelector cannot.
 */
async function findTurnstileFrame(page: Page, timeoutMs: number): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
export async function clickTurnstile(page: Page, opts?: { frameTimeoutMs?: number; tokenTimeoutMs?: number }): Promise<string> {
  const start = Date.now();

  // Bring the widget into view. The host element is in the light DOM even when
  // the iframe itself is inside the closed shadow root.
  await page
    .locator(
      'app-cloudflare-captcha-container, [appcloudflarerecaptcha], input[name="cf-turnstile-response"]',
    )
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => { });

  const frame = await findTurnstileFrame(page, opts?.frameTimeoutMs ?? 20_000);
  if (!frame) {
    logger.warn("[Turnstile] Challenge iframe not found via page.frames()");
    return "";
  }
  logger.info("[Turnstile] Found Turnstile iframe");

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
    logger.warn("[Turnstile] Could not measure the Turnstile widget position");
    return "";
  }

  // The checkbox sits ~30px from the left, vertically centered. Move then click
  // so Chrome emits a trusted input event (a JS dispatchEvent would be ignored).
  const x = box.x + 30;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 10 });
  await page.waitForTimeout(120);
  await page.mouse.click(x, y);
  logger.info({ x: Math.round(x), y: Math.round(y) }, "[Turnstile] Clicked checkbox");

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
    logger.warn("[Turnstile] Clicked checkbox but no token appeared — Cloudflare may have escalated to an interactive challenge");
    return "";
  }

  const token = await readTurnstileToken(page);
  logger.info({ ms: Date.now() - start, tokenLength: token.length }, "[Turnstile] Solved via checkbox click");
  return token;
}

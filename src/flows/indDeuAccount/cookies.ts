import type { Page } from "playwright";

export async function dismissIndDeuCookies(page: Page, maxWaitMs = 45_000): Promise<void> {
  const selectors = [
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    "[data-accept-cookies], .cookie-accept, #accept-cookies",
  ];
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click({ timeout: 2000 });
          await page.waitForTimeout(800);
          return;
        }
      } catch {
        /* next */
      }
    }
    await page.waitForTimeout(300);
  }
}

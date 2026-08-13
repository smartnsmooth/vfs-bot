import type { Page } from "playwright";
import { clickTurnstile, waitForManualTurnstile } from "../../services/turnstile.click";

export async function submitIndDeuWithTurnstile(
  page: Page,
  submitSelector: string,
  check?: () => Promise<void>,
): Promise<void> {
  if (check) await check();
  let token = await clickTurnstile(page, { check });
  if (!token) {
    token = await waitForManualTurnstile(page, { check });
  }
  const btn = page.locator(submitSelector).first();
  await btn.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  await btn.evaluate((el: HTMLElement) => {
    (el as HTMLButtonElement).disabled = false;
    el.removeAttribute("disabled");
  }).catch(() => {});
  await btn.click({ timeout: 10_000, force: true });
}

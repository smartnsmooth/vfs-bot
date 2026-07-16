import type { Page } from "playwright";

export interface Discovered {
  sitekey: string;
  callbackName: string | null;
  action: string | null;
  cData: string | null;
}

export async function discoverTurnstile(page: Page): Promise<Discovered | null> {
  const found = await page.evaluate(() => {
    const el = document.querySelector("[data-sitekey]") as HTMLElement | null;
    if (el) {
      return {
        sitekey: el.getAttribute("data-sitekey") || "",
        callbackName: el.getAttribute("data-callback"),
        action: el.getAttribute("data-action"),
        cData: el.getAttribute("data-cdata"),
      };
    }
    const ifr = document.querySelector(
      'iframe[src*="challenges.cloudflare.com"]',
    ) as HTMLIFrameElement | null;
    if (ifr) {
      const m = ifr.src.match(/[?&]sitekey=([^&]+)/) || ifr.src.match(/\/(0x[A-Za-z0-9]+)\//);
      if (m) return { sitekey: m[1], callbackName: null, action: null, cData: null };
    }
    return null;
  });

  if (!found || !found.sitekey) return null;
  return found;
}

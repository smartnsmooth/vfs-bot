import { networkInterfaces } from "node:os";
import type { Page } from "playwright";
import { logger } from "./logger";

function isPrivateIPv4(ip: string): boolean {
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

/**
 * Best-effort local IPv4 from host interfaces (WLAN/LAN).
 * Prefers a non-RFC1918 address if present; otherwise first usable IPv4.
 */
export function getLocalNetworkIpv4(): string {
  const nets = networkInterfaces();
  const candidates: string[] = [];
  for (const addrs of Object.values(nets)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family !== "IPv4" || a.internal) continue;
      candidates.push(a.address);
    }
  }
  for (const ip of candidates) {
    if (!isPrivateIPv4(ip)) return ip;
  }
  return candidates[0] ?? "";
}

/** IPv4 or a simple IPv6 shape from ipify-style services. */
function isPlausiblePublicIp(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return true;
  if (/^[0-9a-fA-F:.]{3,}$/.test(t) && t.includes(":")) return true;
  return false;
}

async function fetchPublicIpFromUrl(url: string, timeoutMs: number): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const raw = (await res.text()).trim();
    const ip = raw.split(/\s/)[0] ?? "";
    if (isPlausiblePublicIp(ip)) return ip;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `fetch()` inside the tab uses the same network path as the page (Chrome extension proxy, etc.).
 */
async function tryResolveApplicantIpFromBrowserPage(page: Page): Promise<string | null> {
  try {
    const raw = await page.evaluate(async () => {
      const urls = [
        "https://api.ipify.org",
        "https://api64.ipify.org",
        "https://icanhazip.com",
      ];
      for (const url of urls) {
        const ac = new AbortController();
        const timer = window.setTimeout(() => ac.abort(), 8000);
        try {
          const res = await fetch(url, { cache: "no-store", signal: ac.signal });
          if (!res.ok) continue;
          const text = (await res.text()).trim();
          const ip = text.split(/\s/)[0] ?? "";
          if (ip) return ip;
        } catch {
          /* try next */
        } finally {
          window.clearTimeout(timer);
        }
      }
      return "";
    });
    const ip = raw.trim().split(/\s/)[0] ?? "";
    if (isPlausiblePublicIp(ip)) return ip;
    return null;
  } catch (err) {
    logger.warn({ err }, "Applicant IP: browser tab fetch failed");
    return null;
  }
}

let cachedApplicantIp: string | null = null;

/** Call after Chrome/proxy restart so save-applicants IP matches the new egress. */
export function clearApplicantIpCache(): void {
  cachedApplicantIp = null;
}

/** Use after {@link ensureApplicantIpResolved}; otherwise falls back to local NIC IP. */
export function getApplicantIpForPayload(): string {
  if (cachedApplicantIp) return cachedApplicantIp;
  return getLocalNetworkIpv4() || "127.0.0.1";
}

function envManualApplicantIp(): string | null {
  const v = process.env.VFS_APPLICANT_IP?.trim();
  return v ? v : null;
}

async function resolveApplicantIpFromNode(): Promise<string> {
  if (cachedApplicantIp) return cachedApplicantIp;

  const urls = ["https://api.ipify.org", "https://api64.ipify.org", "https://icanhazip.com"];
  const timeoutMs = 5000;

  for (const url of urls) {
    const ip = await fetchPublicIpFromUrl(url, timeoutMs);
    if (ip) {
      cachedApplicantIp = ip;
      logger.info({ ip, via: url, source: "node" }, "Applicant IP resolved (Node fetch, direct egress)");
      return ip;
    }
  }

  const local = getLocalNetworkIpv4();
  cachedApplicantIp = local || "127.0.0.1";
  logger.warn(
    { ip: cachedApplicantIp },
    "Public IP lookup failed; using local network IP for applicant payload (portal may expect public IP)"
  );
  return cachedApplicantIp;
}

/**
 * Sets {@link getApplicantIpForPayload} for save-applicants.
 *
 * 1. Optional `VFS_APPLICANT_IP` — fixed value, no lookup.
 * 2. If `page` is set — `fetch()` inside the tab (same egress as Chrome, including extension proxy).
 * 3. Fallback — Node `fetch` to ipify (direct connection), then local NIC.
 *
 * Call after login with the CDP-connected first tab available.
 */
export async function ensureApplicantIpResolved(page: Page | null): Promise<string> {
  if (cachedApplicantIp) return cachedApplicantIp;

  const manual = envManualApplicantIp();
  if (manual) {
    cachedApplicantIp = manual;
    logger.info({ ip: manual, source: "env" }, "Applicant IP from VFS_APPLICANT_IP");
    return cachedApplicantIp;
  }

  if (page) {
    const fromBrowser = await tryResolveApplicantIpFromBrowserPage(page);
    if (fromBrowser) {
      cachedApplicantIp = fromBrowser;
      logger.info(
        { ip: fromBrowser, source: "browser" },
        "Applicant IP resolved in page (matches Chrome / proxy extension egress)"
      );
      return cachedApplicantIp;
    }
    logger.warn(
      "Applicant IP: in-page lookup failed — falling back to Node fetch (may not match extension proxy IP)"
    );
  }

  return resolveApplicantIpFromNode();
}

import { networkInterfaces } from "node:os";
import type { Page } from "playwright";
/**
 * Public IP for save-applicants (`ipAddress`):
 *
 * 1. **`VFS_APPLICANT_PUBLIC_IP_URL`** \u2014 GET URL that returns a plain-text public IP (first line).
 *    Fetched **inside the browser tab** so it uses the same Chrome proxy path as VFS. Use your provider's
 *    "what is my IP" endpoint if they offer one; there is no universal proxy-vendor API in this repo.
 * 2. **`VFS_USE_IPIFY`** \u2014 default `true`. Set to `false` to stop calling ipify/icanhazip (avoids extra
 *    connections that can rotate egress on some proxies). Pair with `VFS_APPLICANT_PUBLIC_IP_URL`.
 *
 * **Sticky egress (same IP for the whole Chrome run):** set `PROXY_URLS` with your vendor's session token,
 * e.g. `...-session-{session}` and optional **`PROXY_STICKY_SESSION_ID`** (or rely on default `vfs-<instanceId>`).
 * See `resolveProxyForInstance` in `index.ts`.
 */

const DEFAULT_PUBLIC_IP_LOOKUP_URLS = [
  "https://api.ipify.org",
  "https://api64.ipify.org",
  "https://icanhazip.com",
] as const;

function envApplicantPublicIpUrl(): string | null {
  const v = process.env.VFS_APPLICANT_PUBLIC_IP_URL?.trim();
  return v ? v : null;
}

/** When false, built-in ipify URLs are not used (browser + Node). */
function useIpifyPublicIpLookups(): boolean {
  const v = (process.env.VFS_USE_IPIFY ?? "true").trim().toLowerCase();
  return !/^false|0|no|off$/.test(v);
}

function publicIpLookupUrlList(): string[] {
  const custom = envApplicantPublicIpUrl();
  if (custom) {
    return [custom];
  }
  if (!useIpifyPublicIpLookups()) {
    return [];
  }
  return [...DEFAULT_PUBLIC_IP_LOOKUP_URLS];
}

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
  const urls = publicIpLookupUrlList();
  if (urls.length === 0) {
        return null;
  }
  try {
    const raw = await page.evaluate(async (lookupUrls: string[]) => {
      for (const url of lookupUrls) {
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
    }, urls);
    const ip = raw.trim().split(/\s/)[0] ?? "";
    if (isPlausiblePublicIp(ip)) return ip;
    return null;
  } catch (err) {
        return null;
  }
}

let cachedApplicantIp: string | null = null;

/**
 * Clears the pinned applicant IP. Call when starting a **new** Chrome process (new egress), e.g. after
 * `ensureChromeWithDevTools` spawns Chrome or after credential-swap browser restart.
 */
export function clearApplicantIpCache(): void {
  cachedApplicantIp = null;
}

/** Use after {@link ensureApplicantIpResolved}; otherwise falls back to local NIC IP. */
export function getApplicantIpForPayload(): string {
  if (cachedApplicantIp) return cachedApplicantIp;
  return getLocalNetworkIpv4() || "127.0.0.1";
}

async function resolveApplicantIpFromNode(): Promise<string> {
  if (cachedApplicantIp) return cachedApplicantIp;

  const urls = publicIpLookupUrlList();
  const timeoutMs = 5000;

  if (urls.length > 0) {
    for (const url of urls) {
      const ip = await fetchPublicIpFromUrl(url, timeoutMs);
      if (ip) {
        cachedApplicantIp = ip;
                return cachedApplicantIp;
      }
    }
  } else {
      }

  const local = getLocalNetworkIpv4();
  cachedApplicantIp = local || "127.0.0.1";
    return cachedApplicantIp;
}

/**
 * Resolves and **pins** {@link getApplicantIpForPayload} for the lifetime of this Chrome instance.
 * The first successful resolution is cached until {@link clearApplicantIpCache} (new Chrome launch / proxy rotation).
 * Avoids mismatches with session-bound APIs (save-applicants vs login).
 *
 * 1. If `page` is set and cache empty \u2014 in-tab `fetch()` to custom and/or default lookup URLs
 *    (`VFS_APPLICANT_PUBLIC_IP_URL`, `VFS_USE_IPIFY`).
 * 2. Fallback \u2014 Node `fetch` to the same URL list (often wrong behind auth proxy), then local NIC.
 */
export async function ensureApplicantIpResolved(page: Page | null): Promise<string> {
  if (cachedApplicantIp) {
    return cachedApplicantIp;
  }

  if (page) {
    const fromBrowser = await tryResolveApplicantIpFromBrowserPage(page);
    if (fromBrowser) {
      cachedApplicantIp = fromBrowser;
            return cachedApplicantIp;
    }
      }

  return resolveApplicantIpFromNode();
}

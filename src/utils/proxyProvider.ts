/**
 * Fleet proxy source: Bright Data (default) vs the IP list in `proxies.txt`.
 * Selection is runtime (Monitor tab), persisted on instance 0, and applied
 * on the next Chrome request via the local proxy-chain tunnel — no Chrome restart.
 */
import { getApplicantDetailsOverrides, patchApplicantDetailsOverrides } from "./applicantDetails.store";
import { buildProxyListUrl, listProxyListEntries } from "./proxyList";

export type ProxyProviderId = "brightdata" | "iplist";

/** In-process override so IPC can apply before disk reload. */
let memoryOverride: ProxyProviderId | null = null;

export function parseProxyProviderId(raw: unknown): ProxyProviderId | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (s === "brightdata" || s === "bright-data" || s === "bd") return "brightdata";
  if (s === "iplist" || s === "ip-list" || s === "list" || s === "proxylist" || s === "proxy-list") {
    return "iplist";
  }
  return null;
}

export function setMemoryProxyProvider(id: ProxyProviderId): void {
  memoryOverride = id;
}

export function persistProxyProvider(id: ProxyProviderId): void {
  memoryOverride = id;
  patchApplicantDetailsOverrides({ proxyProvider: id }, 0);
}

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function getActiveProxyProvider(): ProxyProviderId {
  if (memoryOverride) return memoryOverride;
  const stored = parseProxyProviderId(getApplicantDetailsOverrides(0)?.proxyProvider);
  if (stored) return stored;
  const env = parseProxyProviderId(process.env.PROXY_PROVIDER);
  if (env) return env;
  return "brightdata";
}

/**
 * Bright Data: the `PROXY_URLS` lines. IP list: every IP in the file, in file order —
 * which bot gets which one is decided by `proxyClaims.ts`, not by this list.
 */
export function listProxyUrlsForProvider(provider: ProxyProviderId): string[] {
  if (provider === "iplist") {
    return listProxyListEntries().map((entry) => buildProxyListUrl(entry));
  }
  return (process.env.PROXY_URLS ?? "")
    .trim()
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function pickProxyUrlFromList(
  list: string[],
  instanceId: string,
  rot: number,
  session: string
): string | null {
  if (list.length === 0) return null;
  const base = hashString(instanceId) % list.length;
  const idx = (base + rot) % list.length;
  const selected = list[idx];
  if (!selected) return null;
  return selected.replace(/\{session\}/gi, session).replace(/\{instance\}/gi, instanceId);
}

export function proxyProviderLabel(id: ProxyProviderId): string {
  return id === "iplist" ? "IP List" : "Bright Data";
}

/**
 * Fleet proxy vendor: Bright Data (default) vs Thordata.
 * Selection is runtime (Monitor tab), persisted on instance 0, and applied
 * on the next Chrome request via the local proxy-chain tunnel — no Chrome restart.
 */
import { getApplicantDetailsOverrides, patchApplicantDetailsOverrides } from "./applicantDetails.store";

export type ProxyProviderId = "brightdata" | "thordata";

const PLACEHOLDER_RE = /(^|[^A-Za-z0-9])(USERNAME|PASSWORD)([^A-Za-z0-9]|$)/i;

/** In-process override so IPC can apply before disk reload. */
let memoryOverride: ProxyProviderId | null = null;

export function parseProxyProviderId(raw: unknown): ProxyProviderId | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (s === "brightdata" || s === "bright-data" || s === "bd") return "brightdata";
  if (s === "thordata" || s === "thor-data" || s === "td") return "thordata";
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

export function listProxyUrlsForProvider(provider: ProxyProviderId): string[] {
  const raw =
    provider === "thordata"
      ? (process.env.PROXY_THORDATA_URLS ?? process.env.PROXY_THORDATA_URL ?? "").trim()
      : (process.env.PROXY_URLS ?? "").trim();
  return raw
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isThordataConfigured(): { ok: boolean; error?: string } {
  const list = listProxyUrlsForProvider("thordata");
  if (list.length === 0) {
    return { ok: false, error: "PROXY_THORDATA_URL is not set in .env." };
  }
  if (PLACEHOLDER_RE.test(list.join(" "))) {
    return {
      ok: false,
      error: "Thordata USERNAME/PASSWORD are still placeholders in .env. Fill them in and restart the bot.",
    };
  }
  return { ok: true };
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
  return id === "thordata" ? "Thordata" : "Bright Data";
}

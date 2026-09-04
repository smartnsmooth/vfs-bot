/**
 * Webshare rotating residential (backbone `p.webshare.io`).
 *
 * VFS sessions are IP-bound, so this always uses a sticky numeric session id —
 * never `-rotate` (new IP on every request). Chrome launch / IP rotate bumps
 * the rotation offset, which changes the session id and therefore the exit IP.
 *
 * Dashboard username parameters: `{username}-{country}-{geo}-{sessionId}`.
 *
 * @see https://apidocs.webshare.io/proxy-connection
 */
const PLACEHOLDER_RE = /^(USERNAME|PASSWORD|USER|PASS|YOUR_[A-Z_]*)$/i;
const DEFAULT_HOST = "p.webshare.io";
const DEFAULT_PORT = 80;

export function isWebshareConfigured(): { ok: boolean; error?: string } {
  const explicit = (process.env.WEBSHARE_PROXY_URL ?? "").trim();
  if (explicit) return { ok: true };
  const username = (process.env.WEBSHARE_USERNAME ?? "").trim();
  const password = (process.env.WEBSHARE_PASSWORD ?? "").trim();
  if (!username || PLACEHOLDER_RE.test(username) || !password || PLACEHOLDER_RE.test(password)) {
    return {
      ok: false,
      error:
        "Webshare is not configured. Set WEBSHARE_USERNAME and WEBSHARE_PASSWORD (or WEBSHARE_PROXY_URL) in .env.",
    };
  }
  return { ok: true };
}

/**
 * Numeric sticky id required by Webshare. Stable for a given bot + rotation
 * offset so instance 1 and instance 2 never share an exit IP, and each IP
 * rotate gets a new session.
 */
export function webshareStickySessionId(instanceId: string, rotationOffset: number): string {
  const digits = instanceId.replace(/\D/g, "");
  const parsed = Number.parseInt(digits, 10);
  const inst =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(Math.floor(parsed), 999)
      : hashToInstanceSlot(instanceId);
  const rot = Math.max(0, Math.floor(rotationOffset)) % 100000;
  return String(inst * 100000 + rot);
}

function hashToInstanceSlot(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return (Math.abs(h) % 900) + 100;
}

export function buildWebshareProxyUrl(sessionNumeric: string): string | null {
  const session = String(sessionNumeric).replace(/\D/g, "") || "1";
  const explicit = (process.env.WEBSHARE_PROXY_URL ?? "").trim();
  if (explicit) return applySessionToProxyUrl(explicit, session);

  const user = (process.env.WEBSHARE_USERNAME ?? "").trim();
  const pass = (process.env.WEBSHARE_PASSWORD ?? "").trim();
  if (!user || !pass) return null;

  const host = (process.env.WEBSHARE_HOST ?? "").trim() || DEFAULT_HOST;
  const port = parsePort(process.env.WEBSHARE_PORT) ?? DEFAULT_PORT;
  const proto = parseProtocol(process.env.WEBSHARE_PROTOCOL);
  const username = buildTargetedUsername(user, session);
  return `${proto}://${encodeURIComponent(username)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

function parsePort(raw: string | undefined): number | null {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return null;
  return n;
}

function parseProtocol(raw: string | undefined): "http" | "https" | "socks5" {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "https") return "https";
  if (s === "socks5" || s === "socks") return "socks5";
  return "http";
}

function countryCode(): string {
  return (process.env.WEBSHARE_COUNTRY ?? "").trim().toLowerCase().replace(/[^a-z]/g, "").slice(0, 2);
}

function cityParam(): string {
  const raw = (process.env.WEBSHARE_CITY ?? "").trim().toLowerCase().replace(/[^a-z_]/g, "");
  if (!raw) return "";
  return raw.startsWith("city_") ? raw : `city_${raw}`;
}

function buildTargetedUsername(baseUser: string, session: string): string {
  const parts = [baseUser];
  const cc = countryCode();
  if (cc && !baseUser.toLowerCase().endsWith(`-${cc}`)) parts.push(cc);
  const city = cityParam();
  if (city && !baseUser.toLowerCase().includes(`-${city}`)) parts.push(city);
  parts.push(session);
  return parts.join("-");
}

function applySessionToProxyUrl(rawUrl: string, session: string): string {
  if (/\{session\}/i.test(rawUrl) || /\{instance\}/i.test(rawUrl)) {
    return rawUrl.replace(/\{session\}/gi, session).replace(/\{instance\}/gi, session);
  }
  try {
    const u = new URL(rawUrl);
    const user = decodeURIComponent(u.username || "");
    if (!user) return rawUrl;
    u.username = applyStickyToUsername(user, session);
    return u.toString().replace(/\/$/, "");
  } catch {
    return rawUrl;
  }
}

function applyStickyToUsername(username: string, session: string): string {
  if (/-rotate$/i.test(username)) return username.replace(/-rotate$/i, `-${session}`);
  if (username.endsWith(`-${session}`)) return username;
  return `${username}-${session}`;
}

/**
 * IP-list proxy source: a plain text file holding one proxy IP per line.
 *
 * Port, username, password and protocol are shared by every IP and come from `.env`
 * (`PROXY_LIST_PORT` / `PROXY_LIST_USERNAME` / `PROXY_LIST_PASSWORD` / `PROXY_LIST_PROTOCOL`),
 * so the file stays a bare IP list you can swap wholesale. A line may still carry its own
 * port (`1.2.3.4:8080`), which wins over `PROXY_LIST_PORT`.
 *
 * Exclusive assignment of these entries across bots lives in `proxyClaims.ts`.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export type ProxyListProtocol = "http" | "https" | "socks4" | "socks5";

export interface ProxyListEntry {
  /** `host:port` — stable identity of this proxy in the claim store. */
  key: string;
  host: string;
  port: number;
}

const DEFAULT_FILE_NAME = "proxies.txt";
const PLACEHOLDER_RE = /^(USERNAME|PASSWORD|USER|PASS|YOUR_[A-Z_]*)$/i;

export function getProxyListFilePath(): string {
  const raw = (process.env.PROXY_LIST_FILE ?? "").trim();
  const file = raw || DEFAULT_FILE_NAME;
  return path.isAbsolute(file) ? file : path.join(process.cwd(), file);
}

export function getProxyListProtocol(): ProxyListProtocol {
  const raw = (process.env.PROXY_LIST_PROTOCOL ?? "").trim().toLowerCase();
  if (raw === "https") return "https";
  if (raw === "socks4") return "socks4";
  if (raw === "socks5" || raw === "socks") return "socks5";
  return "http";
}

function getDefaultPort(): number | null {
  const n = Number.parseInt((process.env.PROXY_LIST_PORT ?? "").trim(), 10);
  if (Number.isFinite(n) && n > 0 && n <= 65535) return n;
  return null;
}

function getCredentials(): { username: string; password: string } {
  return {
    username: (process.env.PROXY_LIST_USERNAME ?? "").trim(),
    password: (process.env.PROXY_LIST_PASSWORD ?? "").trim(),
  };
}

function parseLine(line: string, defaultPort: number | null): ProxyListEntry | null {
  const withoutComment = line.split("#")[0] ?? "";
  const raw = withoutComment.trim();
  if (!raw) return null;

  // Tolerate a pasted full URL by keeping only the authority part.
  const stripped = raw.replace(/^[a-z0-9+.-]+:\/\//i, "").replace(/^[^@]*@/, "").replace(/\/.*$/, "");
  const lastColon = stripped.lastIndexOf(":");
  const host = lastColon > 0 ? stripped.slice(0, lastColon) : stripped;
  const portText = lastColon > 0 ? stripped.slice(lastColon + 1) : "";

  if (!/^[A-Za-z0-9._-]+$/.test(host)) return null;

  let port = defaultPort;
  if (portText) {
    const n = Number.parseInt(portText, 10);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) return null;
    port = n;
  }
  if (port == null) return null;

  return { key: `${host}:${port}`, host, port };
}

let cachedPath = "";
let cachedStamp = "";
let cachedEntries: ProxyListEntry[] = [];

function fileStamp(file: string): string {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

/**
 * Entries in file order — the order also decides assignment priority
 * (instance 1 takes the first free IP, instance 2 the next, and so on).
 * Re-reads only when the file's mtime/size changed, so callers may poll freely.
 */
export function listProxyListEntries(): ProxyListEntry[] {
  const file = getProxyListFilePath();
  const defaultPort = getDefaultPort();
  const stamp = `${fileStamp(file)}:${defaultPort ?? "-"}`;
  if (file === cachedPath && stamp === cachedStamp) return cachedEntries;

  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = "";
  }

  const seen = new Set<string>();
  const entries: ProxyListEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = parseLine(line, defaultPort);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
  }

  cachedPath = file;
  cachedStamp = stamp;
  cachedEntries = entries;
  return entries;
}

/** Full proxy URL Chrome / proxy-chain consumes, with the shared credentials applied. */
export function buildProxyListUrl(entry: ProxyListEntry): string {
  const { username, password } = getCredentials();
  const scheme = getProxyListProtocol();
  if (!username && !password) return `${scheme}://${entry.host}:${entry.port}`;
  const auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
  return `${scheme}://${auth}@${entry.host}:${entry.port}`;
}

export function proxyListUrlForKey(key: string): string | null {
  const entry = listProxyListEntries().find((e) => e.key === key);
  return entry ? buildProxyListUrl(entry) : null;
}

export function isProxyListConfigured(): { ok: boolean; error?: string } {
  const file = getProxyListFilePath();
  const entries = listProxyListEntries();
  if (entries.length === 0) {
    return {
      ok: false,
      error: `No proxy IPs found in ${path.basename(file)}. Add one IP per line (PROXY_LIST_FILE in .env).`,
    };
  }
  const { username, password } = getCredentials();
  if (PLACEHOLDER_RE.test(username) || PLACEHOLDER_RE.test(password)) {
    return {
      ok: false,
      error: "PROXY_LIST_USERNAME / PROXY_LIST_PASSWORD are still placeholders in .env.",
    };
  }
  return { ok: true };
}

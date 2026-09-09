/**
 * Exclusive observed egress-IP assignment across bot processes.
 *
 * Webshare sticky session ids (and Bright Data slots) are exclusive in `proxyClaims.ts`,
 * but the vendor may still map different sessions onto the same public exit IP.
 * After each bot resolves its real egress, it claims that IP here. A duplicate
 * means the caller must rotate to a new upstream and try again.
 *
 * `egress-claims.json` is guarded by the same lock-file pattern as `proxyClaims.ts`.
 * Stale claims (no heartbeat) are dropped so a crashed bot does not pin an IP forever.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface EgressClaim {
  ip: string;
  instanceId: number;
  claimedAt: number;
  heartbeatAt: number;
}

export type EgressClaimResult = { ok: true; ip: string } | { ok: false; ip: string; heldBy: number };

interface EgressClaimsState {
  revision: number;
  claims: EgressClaim[];
}

const CLAIMS_FILE = join(process.cwd(), "egress-claims.json");
const LOCK_FILE = join(process.cwd(), "egress-claims.lock");

const DEFAULT_STALE_SEC = 120;

function staleMs(): number {
  const n = Number.parseInt((process.env.PROXY_CLAIM_STALE_SEC ?? "").trim(), 10);
  const seconds = Number.isFinite(n) && n >= 10 ? n : DEFAULT_STALE_SEC;
  return seconds * 1000;
}

function emptyState(): EgressClaimsState {
  return { revision: 0, claims: [] };
}

function normalizeIp(raw: string): string | null {
  const ip = raw.trim().toLowerCase();
  if (!ip) return null;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0" || ip === "localhost") return null;
  if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("169.254.") || ip.startsWith("127.")) {
    return null;
  }
  const m = /^172\.(\d+)\./.exec(ip);
  if (m) {
    const n = Number.parseInt(m[1]!, 10);
    if (n >= 16 && n <= 31) return null;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  if (/^[0-9a-f:.]+$/.test(ip) && ip.includes(":")) return ip;
  return null;
}

function normalizeState(raw: unknown): EgressClaimsState {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<EgressClaimsState>;
  const claims: EgressClaim[] = [];
  if (Array.isArray(obj.claims)) {
    for (const c of obj.claims) {
      if (!c || typeof c !== "object") continue;
      const ip = typeof c.ip === "string" ? normalizeIp(c.ip) : null;
      const instanceId = Math.floor(Number(c.instanceId));
      if (!ip || !Number.isFinite(instanceId) || instanceId < 1) continue;
      const claimedAt = Number.isFinite(Number(c.claimedAt)) ? Math.floor(Number(c.claimedAt)) : 0;
      const heartbeatAt = Number.isFinite(Number(c.heartbeatAt)) ? Math.floor(Number(c.heartbeatAt)) : claimedAt;
      const dup = claims.findIndex((x) => x.instanceId === instanceId);
      if (dup >= 0) claims.splice(dup, 1);
      claims.push({ ip, instanceId, claimedAt, heartbeatAt });
    }
  }
  const revision = Number.isFinite(Number(obj.revision)) ? Math.max(0, Math.floor(Number(obj.revision))) : 0;
  return { revision, claims };
}

function readState(): EgressClaimsState {
  try {
    if (!existsSync(CLAIMS_FILE)) return emptyState();
    return normalizeState(JSON.parse(readFileSync(CLAIMS_FILE, "utf8")));
  } catch {
    return emptyState();
  }
}

function writeState(state: EgressClaimsState): void {
  try {
    writeFileSync(CLAIMS_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

function tryAcquireLock(): number | null {
  try {
    return openSync(LOCK_FILE, "wx");
  } catch {
    return null;
  }
}

function releaseLock(fd: number | null): void {
  if (fd == null) return;
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

function maybeClearStaleLock(maxAgeMs = 15_000): void {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const { mtimeMs } = statSync(LOCK_FILE);
    if (Date.now() - mtimeMs > maxAgeMs) unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

function spinWait(ms: number): void {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    /* spin */
  }
}

function withExclusiveLock<T>(fn: (state: EgressClaimsState) => T): T | null {
  for (let attempt = 0; attempt < 80; attempt++) {
    maybeClearStaleLock();
    const fd = tryAcquireLock();
    if (fd == null) {
      spinWait(5 + attempt);
      continue;
    }
    try {
      const state = readState();
      const value = fn(state);
      state.revision += 1;
      writeState(state);
      return value;
    } finally {
      releaseLock(fd);
    }
  }
  return null;
}

function prune(state: EgressClaimsState, now: number): void {
  const maxSilence = staleMs();
  state.claims = state.claims.filter((c) => now - c.heartbeatAt <= maxSilence);
}

/** True when `ip` is a public address worth claiming (not loopback / RFC1918 / empty). */
export function isClaimableEgressIp(ip: string): boolean {
  return normalizeIp(ip) != null;
}

/**
 * Record this instance's observed egress IP.
 *
 * Drops any previous IP this instance held first — after a rotate we are no longer
 * on that address. If another live bot already holds `ip`, the claim is refused
 * unless `allowShare` is set (used after unique-IP rotates are exhausted so the
 * instance can keep running on the last address).
 */
export function claimEgressIpForInstance(
  instanceId: number,
  ip: string,
  opts?: { allowShare?: boolean }
): EgressClaimResult | null {
  const id = Math.max(1, Math.floor(instanceId));
  const normalized = normalizeIp(ip);
  if (!normalized) return { ok: true, ip: (ip || "").trim() };

  return withExclusiveLock((state) => {
    const now = Date.now();
    prune(state, now);
    const mine = state.claims.find((c) => c.instanceId === id);
    if (mine && mine.ip === normalized) {
      mine.heartbeatAt = now;
      return { ok: true, ip: normalized } as const;
    }
    state.claims = state.claims.filter((c) => c.instanceId !== id);
    const other = state.claims.find((c) => c.ip === normalized);
    if (other && !opts?.allowShare) {
      return { ok: false, ip: normalized, heldBy: other.instanceId } as const;
    }
    state.claims.push({ ip: normalized, instanceId: id, claimedAt: now, heartbeatAt: now });
    return { ok: true, ip: normalized } as const;
  });
}

export function heartbeatEgressClaim(instanceId: number): void {
  const id = Math.max(1, Math.floor(instanceId));
  withExclusiveLock((state) => {
    const now = Date.now();
    prune(state, now);
    const mine = state.claims.find((c) => c.instanceId === id);
    if (mine) mine.heartbeatAt = now;
    return null;
  });
}

export function releaseEgressClaim(instanceId: number): void {
  const id = Math.max(1, Math.floor(instanceId));
  withExclusiveLock((state) => {
    const now = Date.now();
    prune(state, now);
    state.claims = state.claims.filter((c) => c.instanceId !== id);
    return null;
  });
}

/**
 * Exclusive proxy-IP assignment across bot processes.
 *
 * Each bot runs in its own child process, so "no two bots on the same IP" needs shared
 * state on disk. `proxy-claims.json` holds the live claims plus a cooldown list, guarded
 * by the same lock-file pattern used by `fleetPollCoord.ts`.
 *
 * Rules:
 * - Instance 1 takes the first free IP in file order, instance 2 the next, and so on.
 * - Rotating releases the current IP into a cooldown (default 20 min) so a just-burned IP
 *   is not handed straight to another bot.
 * - A claim whose owner stopped heartbeating (crash / kill) is freed and cooled down from
 *   its last sign of life.
 * - When every IP is claimed or cooling, the pool wraps around rather than failing:
 *   a cooling IP is preferred (oldest cooldown first), then the longest-held live claim.
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

export interface ProxyClaim {
  /** `host:port` from `proxyList.ts`. */
  key: string;
  instanceId: number;
  claimedAt: number;
  heartbeatAt: number;
}

interface ProxyCooldown {
  key: string;
  until: number;
}

interface ProxyClaimsState {
  revision: number;
  claims: ProxyClaim[];
  cooldowns: ProxyCooldown[];
}

const CLAIMS_FILE = join(process.cwd(), "proxy-claims.json");
const LOCK_FILE = join(process.cwd(), "proxy-claims.lock");

const DEFAULT_COOLDOWN_MIN = 20;
const DEFAULT_STALE_SEC = 120;

function cooldownMs(): number {
  const n = Number.parseFloat((process.env.PROXY_LIST_COOLDOWN_MIN ?? "").trim());
  const minutes = Number.isFinite(n) && n >= 0 ? n : DEFAULT_COOLDOWN_MIN;
  return Math.floor(minutes * 60_000);
}

function staleMs(): number {
  const n = Number.parseInt((process.env.PROXY_CLAIM_STALE_SEC ?? "").trim(), 10);
  const seconds = Number.isFinite(n) && n >= 10 ? n : DEFAULT_STALE_SEC;
  return seconds * 1000;
}

function emptyState(): ProxyClaimsState {
  return { revision: 0, claims: [], cooldowns: [] };
}

function normalizeState(raw: unknown): ProxyClaimsState {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<ProxyClaimsState>;
  const claims: ProxyClaim[] = [];
  if (Array.isArray(obj.claims)) {
    for (const c of obj.claims) {
      if (!c || typeof c !== "object") continue;
      const key = typeof c.key === "string" ? c.key.trim() : "";
      const instanceId = Math.floor(Number(c.instanceId));
      if (!key || !Number.isFinite(instanceId) || instanceId < 1) continue;
      const claimedAt = Number.isFinite(Number(c.claimedAt)) ? Math.floor(Number(c.claimedAt)) : 0;
      const heartbeatAt = Number.isFinite(Number(c.heartbeatAt)) ? Math.floor(Number(c.heartbeatAt)) : claimedAt;
      // One claim per instance — a later entry wins.
      const dup = claims.findIndex((x) => x.instanceId === instanceId);
      if (dup >= 0) claims.splice(dup, 1);
      claims.push({ key, instanceId, claimedAt, heartbeatAt });
    }
  }
  const cooldowns: ProxyCooldown[] = [];
  if (Array.isArray(obj.cooldowns)) {
    for (const c of obj.cooldowns) {
      if (!c || typeof c !== "object") continue;
      const key = typeof c.key === "string" ? c.key.trim() : "";
      const until = Math.floor(Number(c.until));
      if (!key || !Number.isFinite(until)) continue;
      const dup = cooldowns.findIndex((x) => x.key === key);
      if (dup >= 0) {
        cooldowns[dup]!.until = Math.max(cooldowns[dup]!.until, until);
        continue;
      }
      cooldowns.push({ key, until });
    }
  }
  const revision = Number.isFinite(Number(obj.revision)) ? Math.max(0, Math.floor(Number(obj.revision))) : 0;
  return { revision, claims, cooldowns };
}

function readState(): ProxyClaimsState {
  try {
    if (!existsSync(CLAIMS_FILE)) return emptyState();
    return normalizeState(JSON.parse(readFileSync(CLAIMS_FILE, "utf8")));
  } catch {
    return emptyState();
  }
}

function writeState(state: ProxyClaimsState): void {
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

/** Runs `fn` under the lock, retrying briefly while another process holds it. */
function withExclusiveLock<T>(fn: (state: ProxyClaimsState) => T): T | null {
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

function addCooldown(state: ProxyClaimsState, key: string, until: number): void {
  const existing = state.cooldowns.find((c) => c.key === key);
  if (existing) {
    existing.until = Math.max(existing.until, until);
    return;
  }
  state.cooldowns.push({ key, until });
}

/** Drops expired cooldowns and claims whose owner stopped heartbeating. */
function prune(state: ProxyClaimsState, now: number): void {
  const maxSilence = staleMs();
  const cool = cooldownMs();
  const live: ProxyClaim[] = [];
  for (const claim of state.claims) {
    if (now - claim.heartbeatAt > maxSilence) {
      addCooldown(state, claim.key, claim.heartbeatAt + cool);
      continue;
    }
    live.push(claim);
  }
  state.claims = live;
  state.cooldowns = state.cooldowns.filter((c) => c.until > now);
}

function selectKey(state: ProxyClaimsState, keys: string[], now: number): string | null {
  if (keys.length === 0) return null;
  const taken = new Map<string, number>();
  for (const c of state.claims) {
    const prev = taken.get(c.key);
    if (prev == null || c.claimedAt < prev) taken.set(c.key, c.claimedAt);
  }
  const cooling = new Map(state.cooldowns.map((c) => [c.key, c.until] as const));

  const free = keys.find((k) => !taken.has(k) && !cooling.has(k));
  if (free) return free;

  // Nothing clean left: prefer an unclaimed IP whose cooldown started longest ago.
  const coolingFree = keys
    .filter((k) => !taken.has(k))
    .sort((a, b) => (cooling.get(a) ?? 0) - (cooling.get(b) ?? 0));
  if (coolingFree.length > 0) return coolingFree[0]!;

  // More bots than IPs — wrap around and share the longest-held claim.
  const shared = [...keys].sort((a, b) => (taken.get(a) ?? 0) - (taken.get(b) ?? 0));
  return shared[0] ?? null;
}

/**
 * Assign a proxy to `instanceId` and return its `host:port`.
 *
 * Keeps the current assignment when the instance already holds an IP that is still in the
 * file, unless `takeNew` is set (Chrome relaunch / IP rotate), in which case the old IP is
 * released into a cooldown first.
 */
export function claimProxyForInstance(
  instanceId: number,
  keys: string[],
  opts?: { takeNew?: boolean }
): string | null {
  const id = Math.max(1, Math.floor(instanceId));
  if (keys.length === 0) return null;

  return withExclusiveLock((state) => {
    const now = Date.now();
    prune(state, now);

    const mine = state.claims.find((c) => c.instanceId === id);
    if (mine && !opts?.takeNew && keys.includes(mine.key)) {
      mine.heartbeatAt = now;
      return mine.key;
    }
    if (mine) {
      state.claims = state.claims.filter((c) => c.instanceId !== id);
      addCooldown(state, mine.key, now + cooldownMs());
    }

    // A rotate must leave the IP it was on — that IP is the reason we are rotating. Only a
    // single-entry list can hand it back.
    const candidates = mine && keys.length > 1 ? keys.filter((k) => k !== mine.key) : keys;
    const picked = selectKey(state, candidates, now);
    if (!picked) return null;
    state.cooldowns = state.cooldowns.filter((c) => c.key !== picked);
    state.claims.push({ key: picked, instanceId: id, claimedAt: now, heartbeatAt: now });
    return picked;
  });
}

/** Keeps this instance's claim alive; a claim that stops refreshing is reclaimed by the fleet. */
export function heartbeatProxyClaim(instanceId: number): void {
  const id = Math.max(1, Math.floor(instanceId));
  withExclusiveLock((state) => {
    const now = Date.now();
    prune(state, now);
    const mine = state.claims.find((c) => c.instanceId === id);
    if (mine) mine.heartbeatAt = now;
    return null;
  });
}

/** Releases this instance's IP into a cooldown (bot stopped / shutting down). */
export function releaseProxyClaim(instanceId: number): void {
  const id = Math.max(1, Math.floor(instanceId));
  withExclusiveLock((state) => {
    const now = Date.now();
    const mine = state.claims.find((c) => c.instanceId === id);
    if (!mine) return null;
    state.claims = state.claims.filter((c) => c.instanceId !== id);
    addCooldown(state, mine.key, now + cooldownMs());
    return null;
  });
}

/** Current `host:port` for this instance without touching the lock. */
export function getClaimedProxyKey(instanceId: number): string | null {
  const id = Math.max(1, Math.floor(instanceId));
  const state = readState();
  const now = Date.now();
  const mine = state.claims.find((c) => c.instanceId === id);
  if (!mine) return null;
  if (now - mine.heartbeatAt > staleMs()) return null;
  return mine.key;
}

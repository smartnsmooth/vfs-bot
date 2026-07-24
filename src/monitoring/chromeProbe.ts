/**
 * Parent-side Chrome probe — read-only HTTP to each instance's DevTools port.
 *
 * Does NOT attach Playwright/CDP clients (safe for the bot). Scales to ~100 bots:
 * concurrent GETs with short timeouts, coalesced into registry patches.
 */
import { get as httpGet } from "node:http";
import { logger } from "../utils/logger";
import { registry } from "./statusRegistry";

interface DevtoolsTarget {
  type?: string;
  url?: string;
  title?: string;
}

export type ChromeProbeResult = {
  alive: boolean;
  page: string | null;
};

const DEFAULT_INTERVAL_MS = 2000;
const REQUEST_TIMEOUT_MS = 400;
const CONCURRENCY = 25;

function httpGetJson<T>(url: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function pickPageUrl(targets: DevtoolsTarget[]): string | null {
  const page =
    targets.find((t) => t.type === "page" && /vfsglobal\.com/i.test(t.url ?? "")) ??
    targets.find((t) => t.type === "page" && t.url && !/^chrome:/i.test(t.url)) ??
    targets.find((t) => t.type === "page");
  const url = page?.url?.trim();
  return url || null;
}

/** Probe one Chrome DevTools port. Never throws. */
export async function probeChromePort(debugPort: number): Promise<ChromeProbeResult> {
  try {
    const targets = await httpGetJson<DevtoolsTarget[]>(
      `http://127.0.0.1:${debugPort}/json`,
      REQUEST_TIMEOUT_MS
    );
    if (!Array.isArray(targets) || targets.length === 0) {
      return { alive: true, page: null };
    }
    return { alive: true, page: pickPageUrl(targets) };
  } catch {
    return { alive: false, page: null };
  }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * Start periodic probes for every registry instance that has a debugPort.
 * Parent-only — call once from cluster (or single-instance) main.
 */
export function startChromeStatusProbe(opts?: { intervalMs?: number }): void {
  if (timer) return;
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;

  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      const list = registry
        .snapshot()
        .filter((s) => typeof s.debugPort === "number" && s.debugPort > 0)
        .map((s) => ({ id: s.instanceId, port: s.debugPort as number }));

      if (list.length === 0) return;

      const results = await mapPool(list, CONCURRENCY, async (item) => {
        const probe = await probeChromePort(item.port);
        return { id: item.id, probe };
      });

      for (const { id, probe } of results) {
        registry.patchChromeProbe(id, {
          chromeAlive: probe.alive,
          page: probe.page,
        });
      }
    } catch (err) {
      logger.debug({ err }, "[Monitor] Chrome probe tick failed");
    } finally {
      ticking = false;
    }
  };

  void tick();
  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  logger.info({ intervalMs, concurrency: CONCURRENCY }, "[Monitor] Chrome status probe started");
}

export function stopChromeStatusProbe(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

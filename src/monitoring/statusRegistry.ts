/**
 * Parent-side status registry.
 *
 * Holds the latest status per instance, notifies subscribers (the dashboard SSE
 * stream), and marks instances "unresponsive" when their heartbeat goes stale.
 * Lives only in the parent process — never touches a child's event loop.
 *
 * Chrome page/window liveness is patched by `chromeProbe` (read-only HTTP to
 * DevTools ports) so the dashboard stays accurate without affecting bots.
 */
import type { InstanceStatus } from "./status.types";

const STALE_MS = 12_000;
const SWEEP_MS = 4_000;

type Subscriber = (status: InstanceStatus) => void;

class StatusRegistry {
  private readonly map = new Map<number, InstanceStatus>();
  private readonly subscribers = new Set<Subscriber>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  applyStatus(status: InstanceStatus): void {
    const prev = this.map.get(status.instanceId);
    // Terminal already-booked: ignore late child heartbeats / status noise.
    if (prev?.alreadyBooked || prev?.phase === "already_booked") {
      if (status.alreadyBooked || status.phase === "already_booked") {
        // allow enriching detail only
      } else {
        return;
      }
    }
    // Parent owns processAlive + chromeAlive probe; don't let child overwrites wipe them.
    const merged: InstanceStatus = {
      ...status,
      chromeAlive: prev?.chromeAlive ?? status.chromeAlive ?? null,
      processAlive: prev?.processAlive ?? status.processAlive ?? true,
      preferMinimized: status.preferMinimized ?? prev?.preferMinimized ?? false,
      alreadyBooked: Boolean(
        status.alreadyBooked ||
          prev?.alreadyBooked ||
          status.phase === "already_booked" ||
          prev?.phase === "already_booked"
      ),
    };
    if (merged.alreadyBooked) {
      merged.phase = "already_booked";
      if (!merged.detail?.trim() || /retired/i.test(merged.detail)) {
        merged.detail = "already booked";
      }
      merged.attention = null;
    }
    this.map.set(status.instanceId, merged);
    this.notify(merged);
  }

  setProcessAlive(instanceId: number, alive: boolean): void {
    const cur = this.map.get(instanceId);
    if (!cur) return;
    if (cur.processAlive === alive) return;
    const next: InstanceStatus = { ...cur, processAlive: alive, updatedAt: Date.now() };
    this.map.set(instanceId, next);
    this.notify(next);
  }

  /**
   * Merge read-only Chrome probe results. When Chrome is gone, clear attention
   * so the card stops blinking (operator can no longer act in that window).
   */
  patchChromeProbe(
    instanceId: number,
    patch: { chromeAlive: boolean; page?: string | null }
  ): void {
    const cur = this.map.get(instanceId);
    if (!cur) return;

    let changed = false;
    const next: InstanceStatus = { ...cur, captcha: { ...cur.captcha } };

    if (next.chromeAlive !== patch.chromeAlive) {
      next.chromeAlive = patch.chromeAlive;
      changed = true;
    }

    // Prefer live CDP page URL when Chrome is up (more instant than child sampler).
    if (patch.chromeAlive && patch.page != null && patch.page !== next.page) {
      next.page = patch.page;
      changed = true;
    }

    if (!patch.chromeAlive) {
      // Keep already-booked terminal state as-is.
      if (next.alreadyBooked || next.phase === "already_booked") {
        if (next.chromeAlive !== false) {
          next.chromeAlive = false;
          changed = true;
        }
      } else if (
        next.phase === "recovering" ||
        next.phase === "launching" ||
        next.phase === "login" ||
        next.phase === "turnstile" ||
        next.phase === "otp"
      ) {
        // Hard relogin intentionally kills Chrome — only record liveness, do not
        // rewrite phase/detail (that was causing Monitor card flicker).
        if (next.chromeAlive !== false) {
          next.chromeAlive = false;
          changed = true;
        }
      } else {
        // Chrome closed — stop attention blink; keep lastError for history on the card.
        if (next.attention) {
          next.attention = null;
          changed = true;
        }
        if (next.captcha.last === "waiting") {
          next.captcha.last = "failed";
          next.captcha.waitingUntil = null;
          changed = true;
        }
        if (next.phase === "needs_attention") {
          next.phase = next.processAlive ? "recovering" : "stopped";
          next.detail = next.processAlive ? "Chrome closed — recovering?" : "Chrome closed";
          changed = true;
        } else if (!next.processAlive && next.phase !== "stopped" && next.phase !== "payment") {
          next.phase = "stopped";
          next.detail = next.detail?.includes("closed") ? next.detail : "Chrome closed / process stopped";
          changed = true;
        }
      }
      if (next.preferMinimized) {
        next.preferMinimized = false;
        changed = true;
      }
    }

    if (!changed) return;
    next.updatedAt = Date.now();
    this.map.set(instanceId, next);
    this.notify(next);
  }

  /** Mark an instance stopped/removed from the operator's perspective. */
  markStopped(instanceId: number, detail = "stopped"): void {
    const cur = this.map.get(instanceId);
    if (!cur) return;
    // Already-booked is terminal — do not overwrite with generic exit/stop noise.
    if (cur.alreadyBooked || cur.phase === "already_booked") return;
    // If already relaunched (phase launching after Restart), do not overwrite with stopped+old blink state.
    if (cur.phase === "launching" && /restart/i.test(cur.detail)) return;
    const next: InstanceStatus = {
      ...cur,
      captcha: {
        ...cur.captcha,
        last: cur.captcha.last === "waiting" ? "n/a" : cur.captcha.last,
        waitingUntil: null,
      },
      phase: "stopped",
      detail,
      attention: null,
      processAlive: false,
      updatedAt: Date.now(),
    };
    this.map.set(instanceId, next);
    this.notify(next);
  }

  /** Applicants/schedule 1037 / 1101 — terminal; hide Restart on Monitor. */
  markAlreadyBooked(instanceId: number, detail = "already booked"): void {
    const cur = this.map.get(instanceId);
    if (!cur) return;
    const next: InstanceStatus = {
      ...cur,
      captcha: {
        ...cur.captcha,
        last: cur.captcha.last === "waiting" ? "n/a" : cur.captcha.last,
        waitingUntil: null,
      },
      phase: "already_booked",
      detail: detail.trim() || "already booked",
      attention: null,
      alreadyBooked: true,
      processAlive: false,
      chromeAlive: false,
      pollingPaused: false,
      preferMinimized: false,
      updatedAt: Date.now(),
    };
    this.map.set(instanceId, next);
    this.notify(next);
  }

  remove(instanceId: number): void {
    this.map.delete(instanceId);
  }

  snapshot(): InstanceStatus[] {
    return [...this.map.values()].sort((a, b) => a.instanceId - b.instanceId);
  }

  get(instanceId: number): InstanceStatus | undefined {
    return this.map.get(instanceId);
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  private notify(status: InstanceStatus): void {
    for (const cb of this.subscribers) {
      try {
        cb(status);
      } catch (err) {
              }
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const status of this.map.values()) {
      if (status.phase === "stopped" || status.phase === "payment" || status.phase === "already_booked") continue;
      if (status.alreadyBooked) continue;
      if (status.phase === "unresponsive") continue;
      if (!status.processAlive) continue;
      if (now - status.heartbeatAt > STALE_MS) {
        const next: InstanceStatus = {
          ...status,
          phase: "unresponsive",
          detail: `no heartbeat for ${Math.round((now - status.heartbeatAt) / 1000)}s`,
          updatedAt: now,
        };
        this.map.set(status.instanceId, next);
        this.notify(next);
      }
    }
  }
}

export const registry = new StatusRegistry();

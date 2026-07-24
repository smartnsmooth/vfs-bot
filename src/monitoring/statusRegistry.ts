/**
 * Parent-side status registry.
 *
 * Holds the latest status per instance, notifies subscribers (the dashboard SSE
 * stream), and marks instances "unresponsive" when their heartbeat goes stale.
 * Lives only in the parent process — never touches a child's event loop.
 */
import { logger } from "../utils/logger";
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
    this.map.set(status.instanceId, status);
    this.notify(status);
  }

  /** Mark an instance stopped/removed from the operator's perspective. */
  markStopped(instanceId: number, detail = "stopped"): void {
    const cur = this.map.get(instanceId);
    if (!cur) return;
    const next: InstanceStatus = { ...cur, phase: "stopped", detail, updatedAt: Date.now() };
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
        logger.debug({ err }, "[Monitor] subscriber threw");
      }
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const status of this.map.values()) {
      if (status.phase === "stopped" || status.phase === "payment") continue;
      if (status.phase === "unresponsive") continue;
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

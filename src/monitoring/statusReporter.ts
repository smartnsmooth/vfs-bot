/**
 * Child-side status reporter (singleton).
 *
 * Bots call `reporter.*()` at transitions. All sends are fire-and-forget and
 * wrapped in try/catch — if the parent/IPC is slow or gone, the bot never
 * blocks and never throws. This module must never affect bot control flow.
 *
 * Transport:
 *  - Cluster mode: `process.send(...)` over the existing IPC channel.
 *  - Single-instance mode: an optional in-process sink (set by index.ts) so the
 *    local Monitor tab still works.
 */
import {
  makeInitialStatus,
  type AttentionReason,
  type BotPhase,
  type CaptchaResult,
  type InstanceStatus,
} from "./status.types";

type LocalSink = (status: InstanceStatus) => void;
type LocalFocus = () => void;

const HEARTBEAT_MS = 3000;
const COALESCE_MS = 250;

class StatusReporter {
  private status: InstanceStatus = makeInitialStatus(0, null);
  private started = false;
  private localSink: LocalSink | null = null;
  private localFocus: LocalFocus | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  init(instanceId: number, opts?: { debugPort?: number | null }): void {
    this.status = makeInitialStatus(instanceId, opts?.debugPort ?? null);
    if (!this.started) {
      this.started = true;
      this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
      if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref();
    }
    this.flushNow();
  }

  /** Single-instance mode: receive status locally instead of over IPC. */
  setLocalSink(sink: LocalSink | null): void {
    this.localSink = sink;
  }

  /** Single-instance mode: focus this process's own Chrome window. */
  setLocalFocus(focus: LocalFocus | null): void {
    this.localFocus = focus;
  }

  // ── High-level reporting API ──────────────────────────────────────────

  setPhase(phase: BotPhase, detail?: string): void {
    this.status.phase = phase;
    if (detail != null) this.status.detail = detail;
    // Clear sticky error blink once the bot moves into a normal workflow phase.
    // Do NOT clear on turnstile/otp — those overlap with captcha attention.
    if (
      phase === "launching" ||
      phase === "login" ||
      phase === "polling" ||
      phase === "booking" ||
      phase === "payment" ||
      phase === "recovering" ||
      phase === "idle"
    ) {
      this.status.attention = null;
      if (this.status.captcha.last === "waiting") {
        this.status.captcha.last = "n/a";
        this.status.captcha.waitingUntil = null;
      }
      this.status.lastError = null;
    }
    this.flushNow();
  }

  setDetail(detail: string): void {
    this.status.detail = detail;
    this.flushSoon();
  }

  setAccount(account: string | null, credentialSlot?: 0 | 1 | null): void {
    this.status.account = account;
    if (credentialSlot !== undefined) this.status.credentialSlot = credentialSlot;
    this.flushSoon();
  }

  setEgressIp(ip: string | null): void {
    if (this.status.egressIp === ip) return;
    this.status.egressIp = ip;
    this.flushSoon();
  }

  setPage(url: string | null | undefined): void {
    const v = url && url.trim() ? url.trim() : null;
    if (this.status.page === v) return;
    this.status.page = v;
    this.flushSoon();
  }

  setPoll(info: { center?: string | null; pollCount?: number; http?: number | null; code?: string | null; slotFound?: boolean }): void {
    if (info.center !== undefined) this.status.center = info.center;
    if (info.pollCount !== undefined) this.status.pollCount = info.pollCount;
    if (info.http !== undefined) this.status.lastHttp = info.http;
    if (info.code !== undefined) this.status.lastCode = info.code;
    if (info.slotFound !== undefined) this.status.slotFound = info.slotFound;
    this.flushSoon();
  }

  setBookingStep(step: string | null, extra?: { urn?: string | null }): void {
    this.status.bookingStep = step;
    if (extra?.urn !== undefined) this.status.urn = extra.urn;
    this.flushNow();
  }

  captchaResult(result: CaptchaResult, ms?: number | null): void {
    const c = this.status.captcha;
    c.last = result;
    if (result === "passed") { c.attempts += 1; c.solved += 1; c.waitingUntil = null; }
    else if (result === "failed") { c.attempts += 1; c.failed += 1; }
    if (ms !== undefined) c.lastMs = ms;
    this.flushNow();
  }

  captchaWaiting(untilTs: number | null): void {
    this.status.captcha.last = "waiting";
    this.status.captcha.waitingUntil = untilTs;
    this.flushNow();
  }

  setAttention(reason: AttentionReason | null, detail?: string): void {
    if (reason === null) {
      this.status.attention = null;
      this.flushNow();
      return;
    }
    this.status.attention = { reason, since: Date.now() };
    this.status.phase = "needs_attention";
    // Captcha / manual issues need the window up — cancel minimize preference.
    this.status.preferMinimized = false;
    if (detail != null) this.status.detail = detail;
    this.flushNow();
  }

  setPreferMinimized(prefer: boolean): void {
    if (this.status.preferMinimized === prefer) return;
    this.status.preferMinimized = prefer;
    this.flushNow();
  }

  /** Full reset used on operator Restart so the card stops blinking immediately. */
  resetForRestart(instanceId: number, opts?: { debugPort?: number | null }): void {
    this.status = makeInitialStatus(instanceId, opts?.debugPort ?? this.status.debugPort);
    this.status.phase = "launching";
    this.status.detail = "restarting…";
    this.flushNow();
  }

  setError(message: string): void {
    this.status.lastError = { message: message.slice(0, 400), at: Date.now() };
    this.flushNow();
  }

  setPollingPaused(paused: boolean): void {
    if (this.status.pollingPaused === paused) return;
    this.status.pollingPaused = paused;
    this.flushNow();
  }

  /**
   * Ask the parent to bring this instance's Chrome window to the foreground.
   * Used on captcha failure so the operator can solve it manually.
   */
  requestFocus(reason: AttentionReason = "captcha"): void {
    const instanceId = this.status.instanceId;
    try {
      if (typeof process.send === "function") {
        process.send({ type: "request-focus", instanceId, reason });
        return;
      }
    } catch {
      /* ignore — never block the bot */
    }
    // Single-instance fallback.
    try {
      this.localFocus?.();
    } catch {
      /* ignore */
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private heartbeat(): void {
    this.status.heartbeatAt = Date.now();
    this.send();
  }

  private flushSoon(): void {
    this.status.updatedAt = Date.now();
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.send();
    }, COALESCE_MS);
    if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
  }

  private flushNow(): void {
    this.status.updatedAt = Date.now();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.send();
  }

  private send(): void {
    // Snapshot copy so async consumers never see a mutating object.
    const snap: InstanceStatus = { ...this.status, captcha: { ...this.status.captcha } };
    try {
      if (typeof process.send === "function") {
        process.send({ type: "status-update", instanceId: snap.instanceId, status: snap });
      }
    } catch {
      /* ignore — reporting must never break the bot */
    }
    try {
      this.localSink?.(snap);
    } catch {
      /* ignore */
    }
  }
}

/** Global singleton — every module imports the same reporter. */
export const reporter = new StatusReporter();

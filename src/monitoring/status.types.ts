/**
 * Shared status/monitoring types used by both the child bot process (reporter)
 * and the parent process (registry + dashboard server).
 *
 * The monitoring layer is a passive side-channel: bots PUSH status, they never
 * pull or block on it. Nothing here is allowed to affect bot control flow.
 */

export type BotPhase =
  | "idle"
  | "launching"
  | "login"
  | "turnstile"
  | "otp"
  | "polling"
  | "booking"
  | "payment"
  | "recovering"
  | "stopped"
  | "needs_attention"
  | "unresponsive";

export type AttentionReason =
  | "captcha"
  | "otp"
  | "login_failed"
  | "rate_limit"
  | "blocked"
  | "gateway_timeout"
  | "other";

export type CaptchaResult = "passed" | "failed" | "waiting" | "n/a";

export interface CaptchaStat {
  last: CaptchaResult;
  attempts: number;
  solved: number;
  failed: number;
  lastMs: number | null;
  /** When manual-assist is waiting for the operator, ms remaining (else null). */
  waitingUntil: number | null;
}

/** Full snapshot of one bot instance. The registry stores the latest per instanceId. */
export interface InstanceStatus {
  instanceId: number;
  phase: BotPhase;
  detail: string;
  attention: { reason: AttentionReason; since: number } | null;
  captcha: CaptchaStat;
  account: string | null;
  credentialSlot: 0 | 1 | null;
  center: string | null;
  /** The URL the bot's Chrome tab is currently on (VFS page, login, dashboard, …). */
  page: string | null;
  pollCount: number;
  lastHttp: number | null;
  lastCode: string | null;
  slotFound: boolean;
  bookingStep: string | null;
  urn: string | null;
  egressIp: string | null;
  debugPort: number | null;
  lastError: { message: string; at: number } | null;
  startedAt: number;
  heartbeatAt: number;
  updatedAt: number;
}

export function makeInitialStatus(instanceId: number, debugPort: number | null): InstanceStatus {
  const now = Date.now();
  return {
    instanceId,
    phase: "idle",
    detail: "waiting to start",
    attention: null,
    captcha: { last: "n/a", attempts: 0, solved: 0, failed: 0, lastMs: null, waitingUntil: null },
    account: null,
    credentialSlot: null,
    center: null,
    page: null,
    pollCount: 0,
    lastHttp: null,
    lastCode: null,
    slotFound: false,
    bookingStep: null,
    urn: null,
    egressIp: null,
    debugPort,
    lastError: null,
    startedAt: now,
    heartbeatAt: now,
    updatedAt: now,
  };
}

// ── IPC messages (child → parent) ──────────────────────────────────────────

export interface StatusUpdateMessage {
  type: "status-update";
  instanceId: number;
  status: InstanceStatus;
}

export interface RequestFocusMessage {
  type: "request-focus";
  instanceId: number;
  reason: AttentionReason;
}

export type MonitoringChildMessage = StatusUpdateMessage | RequestFocusMessage;

// ── Dashboard control hooks (dashboard server → parent) ─────────────────────

export interface MonitorControlState {
  intervalMs: number;
  rolloutActive: boolean;
  total: number;
}

/**
 * Injected into the form/dashboard server so the Monitor tab can read status
 * and issue control actions. All methods are safe no-ops or return errors when
 * a capability is unavailable (e.g. single-instance mode).
 */
export interface MonitorHooks {
  snapshot(): InstanceStatus[];
  /** Subscribe to live status changes; returns an unsubscribe function. */
  subscribe(cb: (status: InstanceStatus) => void): () => void;
  focus(instanceId: number): Promise<{ ok: boolean; error?: string }>;
  devtools(instanceId: number): Promise<{ ok: boolean; url?: string; error?: string }>;
  /** Start (or resume) a staggered rollout of `count` instances, one every `intervalMs`. */
  start(opts: { count: number; intervalMs: number }): { ok: boolean; error?: string };
  pauseRollout(): { ok: boolean };
  resumeRollout(): { ok: boolean };
  stopInstance(instanceId: number): { ok: boolean; error?: string };
  restartInstance(instanceId: number): { ok: boolean; error?: string };
  setStaggerInterval(ms: number): { ok: boolean };
  getControl(): MonitorControlState;
}

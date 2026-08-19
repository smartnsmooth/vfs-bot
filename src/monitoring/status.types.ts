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
  | "already_booked"
  | "needs_attention"
  | "unresponsive";

export type AttentionReason =
  | "captcha"
  | "otp"
  | "login_failed"
  | "rate_limit"
  | "blocked"
  | "gateway_timeout"
  | "cf_challenge"
  | "other";

/** Monitor card activity flash color/kind. */
export type ApiFlashKind = "polling" | "applicants" | "calendar" | "fees" | "timeslot" | "schedule";

/** Map a booking-step label to sticky Monitor card background kind. */
export function bookingStepToApiKind(step: string | null | undefined): ApiFlashKind | null {
  if (!step) return null;
  const s = step.toLowerCase();
  if (s.includes("applicant")) return "applicants";
  if (s.includes("calendar")) return "calendar";
  if (s.includes("fee")) return "fees";
  if (s.includes("timeslot") || s.includes("time slot")) return "timeslot";
  if (s.includes("schedule")) return "schedule";
  return null;
}

/** Short Monitor phase badge for a booking step. */
export function bookingStepPhaseLabel(step: string | null | undefined): string | null {
  const kind = bookingStepToApiKind(step);
  if (kind === "applicants") return "applicants";
  if (kind === "calendar") return "calendar";
  if (kind === "fees") return "fees";
  if (kind === "timeslot") return "timeslot";
  if (kind === "schedule") return "schedule";
  return null;
}

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
  /** True when this bot's slot polling is paused from the Monitor tab. */
  pollingPaused: boolean;
  /**
   * When true, auto-focus from a stale captcha request must not restore the window
   * (set after dashboard minimize until payment / new captcha attention).
   */
  preferMinimized: boolean;
  /** Parent probe: DevTools port responds (Chrome process up). null = not probed yet. */
  chromeAlive: boolean | null;
  /** Parent: child Node process is running. */
  processAlive: boolean;
  /**
   * One-shot card blink signal for the Monitor UI.
   * `seq` increments every flash request; the dashboard blinks `times` when seq advances.
   */
  apiFlash: { seq: number; times: 1 | 3; kind: ApiFlashKind } | null;
  /** Sticky Monitor card background after the last applicants/calendar/timeslot/schedule (or polling) call. */
  cardApiBg: ApiFlashKind | null;
  /**
   * True when applicants/schedule returned already-booked (1037) or payment pending (1101).
   * Monitor shows "already booked" and hides Restart.
   */
  alreadyBooked: boolean;
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
    pollingPaused: false,
    preferMinimized: false,
    chromeAlive: null,
    processAlive: true,
    apiFlash: null,
    cardApiBg: null,
    alreadyBooked: false,
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
  /** Fleet-wide slot polling paused from the Monitor tab. */
  pollingPaused: boolean;
  /** Configured user poll interval (ms) used for staggered resume. */
  pollIntervalMs: number;
  /** Seconds between save-applicants calls per bot after poll 1036 (global setting). */
  apologiesIntervalSec: number;
  /** Seconds between slot-check API calls per instance (fleet round-robin step). */
  pollIntervalSec: number;
  /** Seconds gap between bots joining save-applicants after a peer URN unlock. */
  applicantsJoinStaggerSec: number;
  /** Seconds between calendar API re-poll calls in fleet booking mode. */
  calendarPollingIntervalSec: number;
  /** Seconds to wait before each lift-api POST. */
  apiDelaySec: number;
  /** First sleep after HTTP 409 (seconds); +5s each retry. */
  repeatedDelaySec: number;
  /** Active proxy vendor for all bots (Monitor switcher). */
  proxyProvider: "brightdata" | "thordata";
  /** False while Thordata URL still has USERNAME/PASSWORD placeholders. */
  thordataReady: boolean;
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
  /** Pause slot polling on one bot (`instanceId`) or every running bot when omitted. */
  pausePolling(instanceId?: number): { ok: boolean; error?: string };
  /**
   * Resume slot polling for one bot or the whole fleet.
   * Resume is staggered by the configured fleet poll interval
   * (bot N waits (N-1)×interval from resumeAt).
   */
  resumePolling(instanceId?: number): { ok: boolean; error?: string };
  stopInstance(instanceId: number): { ok: boolean; error?: string };
  restartInstance(instanceId: number): { ok: boolean; error?: string };
  setStaggerInterval(ms: number): { ok: boolean };
  /** Patch apologies interval on disk (after poll 1036; no polling abort). */
  setApologiesIntervalSec(sec: number): { ok: boolean; error?: string };
  /** Set poll interval (seconds per instance slot-check step). */
  setPollIntervalSec(sec: number): { ok: boolean; error?: string };
  /** Set applicants join stagger (seconds gap between bots joining save-applicants). */
  setApplicantsJoinStaggerSec(sec: number): { ok: boolean; error?: string };
  /** Set calendar polling interval (seconds between calendar re-poll calls). */
  setCalendarPollingIntervalSec(sec: number): { ok: boolean; error?: string };
  /** Set delay before each lift-api POST (seconds). */
  setApiDelaySec(sec: number): { ok: boolean; error?: string };
  /** Set first 409 sleep (seconds). */
  setRepeatedDelaySec(sec: number): { ok: boolean; error?: string };
  /** Switch all bots to Bright Data or Thordata; next API request uses the new vendor. */
  setProxyProvider(provider: string): { ok: boolean; error?: string };
  /** Reload global settings from disk on all running bots (after /api/save). */
  reloadGlobalSettings(): { ok: boolean };
  getControl(): MonitorControlState;
}

import { getSessionLoginCredentials } from "../utils/sessionLogin.store";
import { getApplicantDetailsOverrides } from "../utils/applicantDetails.store";

/** Current instance ID for cluster mode (used by loginUser getter) */
let currentInstanceId: number | undefined;

export function setCurrentInstanceId(id: number | undefined): void {
  currentInstanceId = id;
}

export function getCurrentInstanceId(): number | undefined {
  return currentInstanceId;
}

function resolvedFormDetails(): Record<string, unknown> | undefined {
  if (currentInstanceId != null) {
    const det = getApplicantDetailsOverrides(currentInstanceId);
    if (det) return det;
  }
  return getApplicantDetailsOverrides(1) ?? getApplicantDetailsOverrides(0) ?? undefined;
}

function resolvedCountryCode(): string {
  const det = resolvedFormDetails();
  const fromForm = typeof det?.countryCode === "string" ? det.countryCode.trim().toLowerCase() : "";
  return fromForm || "ind";
}

function resolvedMissionCode(): string {
  const det = resolvedFormDetails();
  const fromForm = typeof det?.missionCode === "string" ? det.missionCode.trim().toLowerCase() : "";
  return fromForm || "bgr";
}

/** `loginUser` for slot / lift-api: setup form (session) first, then `VFS_USERNAME`. */
function envSlotLoginUser(): string {
  return (process.env.VFS_USERNAME ?? "").trim();
}

function resolvedSlotPayloadLoginUser(): string {
  const fromForm = getSessionLoginCredentials(currentInstanceId)?.username?.trim();
  if (fromForm) return fromForm;
  return envSlotLoginUser();
}

/** 0 = poll forever; N > 0 = run exactly N slot checks then stop the poll loop. */
const POLL_LIMIT_RAW = parseInt(process.env.POLL_LIMIT ?? "0", 10);
const pollLimit =
  Number.isFinite(POLL_LIMIT_RAW) && POLL_LIMIT_RAW > 0 ? Math.floor(POLL_LIMIT_RAW) : 0;

const MAIL_TM_OTP_TIMEOUT_MS = parseInt(process.env.MAIL_TM_OTP_TIMEOUT_MS ?? "120000", 10);
const MAIL_TM_POLL_MS = parseInt(process.env.MAIL_TM_POLL_MS ?? "4000", 10);
const MAIL_TM_POST_SIGNIN_DELAY_MS = parseInt(process.env.MAIL_TM_POST_SIGNIN_DELAY_MS ?? "2500", 10);

export const config = {
  get loginPageUrl(): string {
    const det = resolvedFormDetails();
    const formCountry = typeof det?.countryCode === "string" ? det.countryCode.trim().toLowerCase() : "";
    const formMission = typeof det?.missionCode === "string" ? det.missionCode.trim().toLowerCase() : "";
    if (formCountry && formMission) {
      return `https://visa.vfsglobal.com/${formCountry}/en/${formMission}/login`;
    }
    return process.env.VFS_LOGIN_PAGE_URL ?? process.env.VFS_LOGIN_ENDPOINT
      ?? `https://visa.vfsglobal.com/${resolvedCountryCode()}/en/${resolvedMissionCode()}/login`;
  },
  slotEndpoint: process.env.VFS_SLOT_ENDPOINT ?? "https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable",
  /** Base slot-check payload (center & visa category are set at runtime via the setup form). */
  slotPayload: {
    get countryCode(): string {
      return resolvedCountryCode();
    },
    /** From setup form session when UI was used; otherwise `VFS_USERNAME`. */
    get loginUser() {
      return resolvedSlotPayloadLoginUser();
    },
    get missionCode(): string {
      return resolvedMissionCode();
    },
    payCode: "",
    roleName: process.env.VFS_SLOT_ROLE_NAME ?? "Individual",
  },
  /** `POLL_LIMIT`: 0 = infinite; else stop after this many `checkSlotsInBrowser` calls. */
  pollLimit,

  telegramEnabled: process.env.ENABLE_TELEGRAM !== "false",
  telegramToken: process.env.TELEGRAM_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",

  vfsUsername: process.env.VFS_USERNAME ?? "",
  vfsPassword: process.env.VFS_PASSWORD ?? "",

  /** CDP URL. Chrome must be running with --remote-debugging-port=9222 (or we launch it). 
   * Uses a getter to read from process.env dynamically for cluster mode. */
  get browserCdpUrl(): string {
    return process.env.BROWSER_CDP_URL ?? "http://localhost:9222";
  },

  // When true: log in then stop immediately — no polling, no booking.  Useful for testing login / Turnstile.
  loginOnly: process.env.VFS_LOGIN_ONLY === "true" || process.env.VFS_LOGIN_ONLY === "1",

  /**
   * After this many poll rounds, log out and re-login so the VFS session is refreshed.
   * A fresh session resets the server-side 429 rate-limit counter.
   * 0 = disabled (never relogin mid-poll).
   */
  pollReloginInterval: (() => {
    const raw = parseInt(process.env.VFS_POLL_RELOGIN_INTERVAL ?? "0", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  })(),

  /**
   * When two VFS accounts are saved and poll relogin runs: after logout, kill Chrome, spawn a fresh browser
   * (each launch advances `PROXY_URLS` cyclically for that profile), then log in with the next credential.
   * Set `VFS_CREDENTIAL_SWAP_BROWSER_RESTART=false` to keep logout→login in the same Chrome window.
   */
  get credentialSwapBrowserRestart(): boolean {
    const v = (process.env.VFS_CREDENTIAL_SWAP_BROWSER_RESTART ?? "true").trim().toLowerCase();
    return v !== "false" && v !== "0" && v !== "no" && v !== "off";
  },

  /**
   * When true, OTP is read via https://api.mail.tm (see /domains for hostnames — not limited to “@mail.tm”).
   * `VFS_USERNAME` / `VFS_PASSWORD` must match that mail.tm-created mailbox.
   */
  /** Chrome window width in pixels for grid layout. 0 = auto (screen width / columns). */
  chromeWindowWidth: Math.max(0, parseInt(process.env.CHROME_WINDOW_WIDTH ?? "0", 10) || 0),
  /** Chrome window height in pixels for grid layout. 0 = auto (screen height / rows). */
  chromeWindowHeight: Math.max(0, parseInt(process.env.CHROME_WINDOW_HEIGHT ?? "0", 10) || 0),
  /** Fixed number of columns for the browser grid. 0 = auto (ceil(sqrt(totalInstances)) capped at 5). */
  chromeGridColumns: Math.max(0, parseInt(process.env.CHROME_GRID_COLUMNS ?? "0", 10) || 0),
  /** Screen width for grid calculation. 0 = auto-detect via PowerShell (fallback 1920). */
  screenWidth: Math.max(0, parseInt(process.env.SCREEN_WIDTH ?? "0", 10) || 0),
  /** Screen height for grid calculation. 0 = auto-detect via PowerShell (fallback 1040 = 1080 - taskbar). */
  screenHeight: Math.max(0, parseInt(process.env.SCREEN_HEIGHT ?? "0", 10) || 0),

  mailTmOtpEnabled: process.env.ENABLE_MAIL_TM_OTP === "true",
  /** Max time to poll mail.tm after OTP step appears. */
  mailTmOtpTimeoutMs: Math.max(300_000, Number.isFinite(MAIL_TM_OTP_TIMEOUT_MS) ? MAIL_TM_OTP_TIMEOUT_MS : 120_000),
  /** Interval between mail.tm message polls. */
  mailTmPollIntervalMs: Math.max(2_000, Number.isFinite(MAIL_TM_POLL_MS) ? MAIL_TM_POLL_MS : 4_000),
  /**
   * After VFS Sign In, wait this long before the first mail.tm list poll so the OTP email can land.
   * `signInEpochMs` is still taken at submit time (not after this delay), so old-inbox OTP filtering is unchanged.
   */
  mailTmPostSignInDelayMs: Math.max(
    0,
    Math.min(
      60_000,
      Number.isFinite(MAIL_TM_POST_SIGNIN_DELAY_MS) ? MAIL_TM_POST_SIGNIN_DELAY_MS : 2_500
    )
  ),
};

if (config.telegramEnabled && (!config.telegramToken || !config.telegramChatId)) {
  throw new Error("TELEGRAM_TOKEN and TELEGRAM_CHAT_ID required when ENABLE_TELEGRAM is true");
}

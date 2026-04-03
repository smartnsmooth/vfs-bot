import { getSessionLoginCredentials } from "../utils/sessionLogin.store";

/** Current instance ID for cluster mode (used by loginUser getter) */
let currentInstanceId: number | undefined;

export function setCurrentInstanceId(id: number | undefined): void {
  currentInstanceId = id;
}

export function getCurrentInstanceId(): number | undefined {
  return currentInstanceId;
}

/** Sub-second polling (ms). */
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS ?? "30000", 10);

/** Min/max for random polling interval (ms). */
const POLLING_INTERVAL_MIN_MS = parseInt(process.env.POLLING_INTERVAL_MIN_MS ?? "20000", 10);
const POLLING_INTERVAL_MAX_MS = parseInt(process.env.POLLING_INTERVAL_MAX_MS ?? "60000", 10);

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
  /** If true, UI Submit opens Turnstile demo page and runs CapMonster injection (no VFS flow). */
  get turnstileDemoMode(): boolean {
    return process.env.TURNSTILE_DEMO_MODE === "true";
  },
  get turnstileDemoUrl(): string {
    return process.env.TURNSTILE_DEMO_URL ?? "https://2captcha.com/demo/cloudflare-turnstile";
  },
  loginPageUrl: process.env.VFS_LOGIN_PAGE_URL ?? process.env.VFS_LOGIN_ENDPOINT ?? "https://visa.vfsglobal.com/ind/en/bgr/login",
  slotEndpoint: process.env.VFS_SLOT_ENDPOINT ?? "https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable",
  /** Slot check + save applicants / calendar / timeslot / fees / schedule (same center & category). */
  slotPayload: {
    countryCode: process.env.VFS_SLOT_COUNTRY_CODE ?? process.env.VFS_SLOT_COUNTRY ?? "ind",
    /** From setup form session when UI was used; otherwise `VFS_USERNAME`. */
    get loginUser() {
      return resolvedSlotPayloadLoginUser();
    },
    missionCode: process.env.VFS_SLOT_MISSION_CODE ?? process.env.VFS_SLOT_MISSION ?? "bgr",
    payCode: process.env.VFS_SLOT_PAY_CODE ?? "",
    roleName: process.env.VFS_SLOT_ROLE_NAME ?? "Individual",
    vacCode: process.env.VFS_SLOT_VAC_CODE ?? "NTDS",
    visaCategoryCode: process.env.VFS_SLOT_VISA_CATEGORY_CODE ?? process.env.VFS_SLOT_VISA_CATEGORY ?? "CARLT",
  },
  pollingPageUrl: process.env.VFS_POLLING_PAGE_URL ?? "https://visa.vfsglobal.com/ind/en/bgr/application-detail",

  pollingIntervalMs: Math.max(5000, Math.min(60000, POLLING_INTERVAL_MS)),
  pollingIntervalMinMs: Math.max(5000, POLLING_INTERVAL_MIN_MS),
  pollingIntervalMaxMs: Math.max(POLLING_INTERVAL_MIN_MS, Math.min(120000, POLLING_INTERVAL_MAX_MS)),

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

  capmonsterEnabled: process.env.ENABLE_CAPMONSTER === "true",
  capmonsterApiKey: process.env.CAPMONSTER_API_KEY ?? "",
  capmonsterApiUrl: process.env.CAPMONSTER_API_URL ?? "https://api.capmonster.cloud",

  // Default to on; set ENABLE_POLLING=false to disable slot polling.
  pollingEnabled: process.env.ENABLE_POLLING !== "false",

  // When true: log in then stop immediately — no polling, no booking.  Useful for testing login / Turnstile.
  loginOnly: process.env.VFS_LOGIN_ONLY === "true" || process.env.VFS_LOGIN_ONLY === "1",

  /**
   * Optional: manual `clientsource` header for lift-api.
   * When set, overrides captured value and page storage.
   * When empty, the bot uses a value captured from any lift-api browser request that sends
   * `clientsource` (see BrowserService sniffer), then storage in fetch.
   */
  liftApiClientSource: (process.env.VFS_CLIENTSOURCE ?? "").trim(),

  /**
   * When true, a fresh 256-byte random base64 token is generated for every lift-api request
   * instead of reusing the captured/static clientsource.  Keeps each request fingerprint unique.
   */
  randomClientSource: process.env.VFS_RANDOM_CLIENTSOURCE === "true" || process.env.VFS_RANDOM_CLIENTSOURCE === "1",

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
   * When two VFS accounts are saved and poll relogin runs: after logout, kill Chrome, advance `PROXY_URLS`
   * selection for this profile, spawn a fresh browser, then log in with the next credential.
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
  mailTmOtpEnabled: process.env.ENABLE_MAIL_TM_OTP === "true",
  /** Max time to poll mail.tm after OTP step appears. */
  mailTmOtpTimeoutMs: Math.max(30_000, Number.isFinite(MAIL_TM_OTP_TIMEOUT_MS) ? MAIL_TM_OTP_TIMEOUT_MS : 120_000),
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
if (config.capmonsterEnabled && !config.capmonsterApiKey) {
  throw new Error("CAPMONSTER_API_KEY required when ENABLE_CAPMONSTER is true");
}

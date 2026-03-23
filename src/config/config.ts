import { getSessionLoginCredentials } from "../utils/sessionLogin.store";

/** Sub-second polling (ms). */
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS ?? "30000", 10);

/** `loginUser` for slot / lift-api: setup form (session) first, then `VFS_USERNAME`. */
function envSlotLoginUser(): string {
  return (process.env.VFS_USERNAME ?? "").trim();
}

function resolvedSlotPayloadLoginUser(): string {
  const fromForm = getSessionLoginCredentials()?.username?.trim();
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
  loginPageUrl: process.env.VFS_LOGIN_PAGE_URL ?? process.env.VFS_LOGIN_ENDPOINT ?? "https://visa.vfsglobal.com/tza/en/nld/login",
  slotEndpoint: process.env.VFS_SLOT_ENDPOINT ?? "https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable",
  /** Slot check + save applicants / calendar / timeslot / fees / schedule (same center & category). */
  slotPayload: {
    countryCode: process.env.VFS_SLOT_COUNTRY_CODE ?? process.env.VFS_SLOT_COUNTRY ?? "tza",
    /** From setup form session when UI was used; otherwise `VFS_USERNAME`. */
    get loginUser() {
      return resolvedSlotPayloadLoginUser();
    },
    missionCode: process.env.VFS_SLOT_MISSION_CODE ?? process.env.VFS_SLOT_MISSION ?? "nld",
    payCode: process.env.VFS_SLOT_PAY_CODE ?? "",
    roleName: process.env.VFS_SLOT_ROLE_NAME ?? "Individual",
    vacCode: process.env.VFS_SLOT_VAC_CODE ?? "NTDS",
    visaCategoryCode: process.env.VFS_SLOT_VISA_CATEGORY_CODE ?? process.env.VFS_SLOT_VISA_CATEGORY ?? "CARLT",
  },
  pollingPageUrl: process.env.VFS_POLLING_PAGE_URL ?? "https://visa.vfsglobal.com/tza/en/nld/dashboard",

  pollingIntervalMs: Math.max(5000, Math.min(60000, POLLING_INTERVAL_MS)),

  /** `POLL_LIMIT`: 0 = infinite; else stop after this many `checkSlotsInBrowser` calls. */
  pollLimit,

  telegramEnabled: process.env.ENABLE_TELEGRAM !== "false",
  telegramToken: process.env.TELEGRAM_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",

  vfsUsername: process.env.VFS_USERNAME ?? "",
  vfsPassword: process.env.VFS_PASSWORD ?? "",

  /** CDP URL. Chrome must be running with --remote-debugging-port=9222 (or we launch it). */
  browserCdpUrl: process.env.BROWSER_CDP_URL ?? "http://localhost:9222",

  capmonsterEnabled: process.env.ENABLE_CAPMONSTER === "true",
  capmonsterApiKey: process.env.CAPMONSTER_API_KEY ?? "",
  capmonsterApiUrl: process.env.CAPMONSTER_API_URL ?? "https://api.capmonster.cloud",

  // Default to on; set ENABLE_POLLING=false to disable slot polling.
  pollingEnabled: process.env.ENABLE_POLLING !== "false",

  /**
   * Optional: manual `clientsource` header for lift-api.
   * When set, overrides captured value and page storage.
   * When empty, the bot uses a value captured from any lift-api browser request that sends
   * `clientsource` (see BrowserService sniffer), then storage in fetch.
   */
  liftApiClientSource: (process.env.VFS_CLIENTSOURCE ?? "").trim(),

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

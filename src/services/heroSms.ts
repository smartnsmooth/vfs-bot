import { IND_DEU_PLACEHOLDER_DIAL_CODE } from "../utils/indDeuPhone";

const DEFAULT_BASE = "https://hero-sms.com/stubs/handler_api.php";

export type HeroSmsNumber = {
  activationId: string;
  phoneNumber: string;
  dialCode: string;
  localNumber: string;
};

export class HeroSmsNoNumbersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeroSmsNoNumbersError";
  }
}

function apiBase(): string {
  return (process.env.HERO_SMS_API_BASE ?? DEFAULT_BASE).trim() || DEFAULT_BASE;
}

export function getHeroSmsApiKey(): string {
  return (process.env.HERO_SMS_API_KEY ?? "").trim();
}

function apiUrl(params: Record<string, string | number>): string {
  const u = new URL(apiBase());
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

async function heroGet(action: string, extra: Record<string, string | number> = {}): Promise<string> {
  const apiKey = getHeroSmsApiKey();
  if (!apiKey) throw new Error("HERO_SMS_API_KEY is missing");
  const url = apiUrl({ api_key: apiKey, action, ...extra });
  const res = await fetch(url);
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`HeroSMS HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

/** Germany: dial 49, local without leading 0 (15/16/17…). */
export function parseGermanyPhone(phoneNumber: string): { dialCode: string; localNumber: string } {
  let digits = phoneNumber.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith(IND_DEU_PLACEHOLDER_DIAL_CODE) && digits.length >= 12) {
    digits = digits.slice(IND_DEU_PLACEHOLDER_DIAL_CODE.length);
  }
  if (digits.startsWith("0")) digits = digits.replace(/^0+/, "");
  return { dialCode: IND_DEU_PLACEHOLDER_DIAL_CODE, localNumber: digits };
}

export async function heroSmsBuyGermanyOt(opts?: {
  signal?: AbortSignal;
  onRetry?: (msg: string) => void;
}): Promise<HeroSmsNumber> {
  const service = (process.env.HERO_SMS_SERVICE ?? "afp").trim() || "afp";
  const country = (process.env.HERO_SMS_COUNTRY ?? "43").trim() || "43";
  const maxAttempts = Math.max(5, parseInt(process.env.HERO_SMS_BUY_MAX_ATTEMPTS ?? "40", 10) || 40);
  const baseDelayMs = Math.max(1500, parseInt(process.env.HERO_SMS_BUY_RETRY_MS ?? "4000", 10) || 4000);

  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts?.signal?.aborted) throw new Error("aborted");
    let text = await heroGet("getNumber", { service, country });
    if (!text.startsWith("ACCESS_NUMBER:") && text !== "NO_NUMBERS" && !/no_numbers/i.test(text)
      && text !== "NO_BALANCE" && text !== "BAD_KEY" && !/SERVICE_UNAVAILABLE|WRONG_SERVICE|BAD_SERVICE/i.test(text)) {
      try {
        const v2 = await heroGet("getNumberV2", { service, country });
        if (v2 && v2 !== text) text = v2;
      } catch {
        /* keep getNumber body */
      }
    }

    if (text === "NO_NUMBERS" || /no_numbers/i.test(text)) {
      lastErr = "NO_NUMBERS";
      const waitMs = baseDelayMs + Math.min(attempt, 10) * 500;
      const msg = `HeroSMS NO_NUMBERS (DE/${service}) — retry ${attempt}/${maxAttempts} in ${Math.round(waitMs / 1000)}s`;
      opts?.onRetry?.(msg);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (text === "NO_BALANCE") throw new Error("HeroSMS NO_BALANCE — top up account");
    if (text === "BAD_KEY") throw new Error("HeroSMS BAD_KEY — check HERO_SMS_API_KEY");
    if (/SERVICE_UNAVAILABLE|WRONG_SERVICE|BAD_SERVICE/i.test(text)) {
      throw new Error(`HeroSMS service error (${service}): ${text}`);
    }

    if (text.startsWith("ACCESS_NUMBER:")) {
      const parts = text.split(":");
      const activationId = parts[1] ?? "";
      const phoneNumber = parts.slice(2).join(":");
      const parsed = parseGermanyPhone(phoneNumber);
      return { activationId, phoneNumber, ...parsed };
    }

    try {
      const j = JSON.parse(text) as { activationId?: number | string; phoneNumber?: string };
      if (j.activationId != null && j.phoneNumber) {
        const parsed = parseGermanyPhone(j.phoneNumber);
        return { activationId: String(j.activationId), phoneNumber: j.phoneNumber, ...parsed };
      }
    } catch {
      /* fall through */
    }

    lastErr = text.slice(0, 200);
    throw new Error(`HeroSMS getNumber unexpected: ${lastErr}`);
  }

  throw new HeroSmsNoNumbersError(
    `HeroSMS no numbers after ${maxAttempts} tries (country=${country} service=${service}). Last: ${lastErr}`,
  );
}

export async function heroSmsWaitForSms(
  activationId: string,
  opts: {
    timeoutMs: number;
    pollMs: number;
    signal?: AbortSignal;
    ignoreCode?: string;
    onPoll?: () => Promise<void>;
  },
): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  const ignore = (opts.ignoreCode ?? "").replace(/\D/g, "");
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("aborted");
    if (opts.onPoll) await opts.onPoll();
    const text = await heroGet("getStatus", { id: activationId });
    if (text.startsWith("STATUS_OK:")) {
      const code = text.slice("STATUS_OK:".length).trim().replace(/\D/g, "");
      if (code && (!ignore || code !== ignore)) return code;
    }
    if (text === "STATUS_CANCEL" || text === "STATUS_CANCELLED") {
      throw new Error("HeroSMS activation cancelled");
    }
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
  throw new Error("HeroSMS: no SMS within timeout");
}

/** Keep activation open and ready for the next SMS (never complete). */
export async function heroSmsReadyForNext(activationId: string): Promise<void> {
  try {
    await heroGet("setStatus", { id: activationId, status: 1 });
  } catch {
    /* ignore */
  }
}

export async function heroSmsCancel(activationId: string): Promise<void> {
  try {
    await heroGet("setStatus", { id: activationId, status: 8 });
  } catch {
    /* ignore */
  }
}

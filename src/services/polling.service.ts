import { config } from "../config/config";
import { Slot } from "../types/slot.type";
import type { CheckIsSlotAvailableResponse } from "../types/slot.type";
import { logger } from "../utils/logger";
import { classifyVfs429 } from "../utils/vfsRateLimit";
import type { BrowserService } from "./browser.service";
import { VfsGatewayTimeoutError, VfsRateLimitedError } from "./browser.service";

export interface PollResult {
  slot: Slot | null;
  response: CheckIsSlotAvailableResponse;
  centerNumber?: 1 | 2;  // Which center found the slot
  centerCode?: string;
  visaCategoryCode?: string;
  unauthorized?: boolean;  // true when API returns 401 — polling must stop
  /** @deprecated Prefer accountBlocked / rateLimitedIp */
  rateLimited?: boolean;
  /** 4290XX — account / User ID restricted; stop the bot */
  accountBlocked?: boolean;
  /** 4292XX (or other 429) — IP rotate path */
  rateLimitedIp?: boolean;
  rateLimitCode?: string;
  forbidden?: boolean;     // true when API returns 403 — needs full browser restart + IP rotation
  gatewayTimeout?: boolean; // true when API returns 504 — needs full browser restart + IP rotation + re-login
}

/**
 * Run slot check inside the browser (avoids Cloudflare 403). Requires a VFS tab open and logged in.
 * Can optionally override center and visa category for multi-center polling.
 */
export class PollingService {
  async checkSlotsInBrowser(
    browserService: BrowserService,
    options: { centerCode: string; visaCategoryCode: string; centerNumber?: 1 | 2 }
  ): Promise<PollResult> {
    const url = config.slotEndpoint;
    
    const payload = {
      ...config.slotPayload,
      vacCode: options.centerCode,
      visaCategoryCode: options.visaCategoryCode,
    };
    try {
      const { status, body } = await browserService.runSlotCheckInBrowser(url, payload);
      let data: CheckIsSlotAvailableResponse;
      try {
        data = JSON.parse(body) as CheckIsSlotAvailableResponse;
      } catch {
        logger.warn({ status, url, bodySnippet: body.slice(0, 200) }, "Slot API returned non-JSON");
        const rateKind = status === 429 ? classifyVfs429(null, 429) : null;
        return {
          slot: null,
          response: {
            earliestDate: null,
            earliestSlotLists: [],
            error: {
              code: -1,
              description: status === 401
                ? "401 Unauthorized. Keep a tab on visa.vfsglobal.com open and stay logged in."
                : status === 429
                  ? "429 Too Many Requests."
                  : status === 403
                    ? "403 Forbidden. IP/session blocked by Cloudflare or VFS."
                    : status === 504
                      ? "504 Gateway Timeout. Restarting browser + rotating IP."
                      : `API returned non-JSON (status ${status}).`,
              type: "Error",
            },
          },
          unauthorized: status === 401,
          rateLimited: rateKind === "ip",
          accountBlocked: rateKind === "account",
          rateLimitedIp: rateKind === "ip",
          rateLimitCode: status === 429 ? "429" : undefined,
          forbidden: status === 403,
          gatewayTimeout: status === 504,
        };
      }
      if (status === 504) {
        logger.warn({ status, url, bodySnippet: body.slice(0, 200) }, "504 Gateway Timeout from slot API — need browser restart + IP rotation + re-login");
        return {
          slot: null,
          gatewayTimeout: true,
          response: {
            earliestDate: null,
            earliestSlotLists: [],
            error: { code: -1, description: "504 Gateway Timeout. Restarting browser + rotating IP.", type: "Error" },
          },
        };
      }
      if (status === 403) {
        logger.warn({ status, url, bodySnippet: body.slice(0, 200) }, "403 Forbidden from slot API — need browser restart + IP rotation");
        return {
          slot: null,
          forbidden: true,
          response: {
            earliestDate: null,
            earliestSlotLists: [],
            error: { code: -1, description: "403 Forbidden. IP/session blocked by Cloudflare or VFS.", type: "Error" },
          },
        };
      }
      if (status === 401) {
        return {
          slot: null,
          unauthorized: true,
          response: {
            earliestDate: null,
            earliestSlotLists: [],
            error: { code: -1, description: "401 Unauthorized. Stay logged in on the VFS tab.", type: "Error" },
          },
        };
      }
      // HTTP 429 is thrown from postLiftJsonFromPage; this is a safety net if throwing is bypassed.
      if (status === 429) {
        const code = String((data as { code?: string | number }).code ?? data.error?.code ?? "429");
        const kind = classifyVfs429(code, 429) ?? "ip";
        logger.warn({ status, url, code, kind, bodySnippet: body.slice(0, 200) }, "429 from slot API");
        return {
          slot: null,
          rateLimited: kind === "ip",
          accountBlocked: kind === "account",
          rateLimitedIp: kind === "ip",
          rateLimitCode: code,
          response: {
            earliestDate: null,
            earliestSlotLists: [],
            error: { code: -1, description: `429 rate-limit (${code}).`, type: "Error" },
          },
        };
      }
      if (status !== 200) {
        return { slot: null, response: data };
      }
      // Special case: error code 1036 ("Services will be back shortly") is emitted by the
      // VFS API when slots actually exist but the API temporarily refuses to enumerate them.
      // Treat this as a slot-available signal so the instance breaks out of polling and
      // proceeds to the calendar step (which will re-resolve the real date).
      if (isSlotsAvailableErrorCode(data.error?.code)) {
        const syntheticSlot: Slot = {
          id: `svc-unavailable-1036_${Date.now()}`,
          center: "",
          date: "",
          time: "00:00:00",
        };
        logger.info(
          { errorCode: data.error?.code, centerCode: options.centerCode, visaCategoryCode: options.visaCategoryCode },
          "Slot API returned code 1036 — treating as slot-available signal; proceeding to calendar"
        );
        return {
          slot: syntheticSlot,
          response: data,
          centerNumber: options?.centerNumber,
          centerCode: options?.centerCode,
          visaCategoryCode: options?.visaCategoryCode,
        };
      }
      const apiError = normalizeApiError(data);
      if (apiError) {
        return {
          slot: null,
          unauthorized: apiError.unauthorized,
          rateLimited: apiError.rateLimitedIp,
          accountBlocked: apiError.accountBlocked,
          rateLimitedIp: apiError.rateLimitedIp,
          rateLimitCode: apiError.rateLimitCode,
          forbidden: apiError.forbidden,
          response: {
            earliestDate: null,
            earliestSlotLists: [],
            error: { code: -1, description: apiError.message, type: "Error" },
          },
        };
      }
      const slot = parseSlotFromResponse(data);
      return {
        slot,
        response: data,
        centerNumber: options?.centerNumber,
        centerCode: options?.centerCode,
        visaCategoryCode: options?.visaCategoryCode,
      };
    } catch (err) {
      if (err instanceof VfsRateLimitedError) {
        logger.warn(
          { err: err.message, code: err.code, kind: err.kind, url },
          "429 rate-limit from slot API"
        );
        return {
          slot: null,
          rateLimited: err.isIpBlock,
          accountBlocked: err.isAccountBlock,
          rateLimitedIp: err.isIpBlock,
          rateLimitCode: err.code,
          response: {
            earliestDate: null,
            earliestSlotLists: [],
            error: { code: -1, description: err.message, type: "Error" },
          },
        };
      }
      if (err instanceof VfsGatewayTimeoutError) {
        logger.warn({ err, url }, "504 Gateway Timeout from slot API — need browser restart + IP rotation + re-login");
        return {
          slot: null,
          gatewayTimeout: true,
          response: {
            earliestDate: null,
            earliestSlotLists: [],
            error: { code: -1, description: "504 Gateway Timeout. Restarting browser + rotating IP.", type: "Error" },
          },
        };
      }
      logger.debug({ err, url }, "Browser slot check failed");
      return {
        slot: null,
        response: {
          earliestDate: null,
          earliestSlotLists: [],
          error: { code: -1, description: String(err), type: "Error" },
        },
      };
    }
  }
}

/**
 * VFS API error codes that actually indicate slots exist but the enumeration endpoint
 * is temporarily degraded. When seen, polling should stop and booking should advance
 * to the calendar step (the calendar endpoint tends to succeed even when 1036 fires).
 */
const SLOTS_AVAILABLE_ERROR_CODES: ReadonlySet<number> = new Set([1036]);

function isSlotsAvailableErrorCode(code: number | undefined | null): boolean {
  return typeof code === "number" && SLOTS_AVAILABLE_ERROR_CODES.has(code);
}

function normalizeApiError(data: CheckIsSlotAvailableResponse & { code?: string | number }): {
  message: string;
  unauthorized: boolean;
  accountBlocked: boolean;
  rateLimitedIp: boolean;
  rateLimitCode?: string;
  forbidden: boolean;
} | null {
  if (data.earliestSlotLists != null && Array.isArray(data.earliestSlotLists)) return null;
  const code = data.code ?? data.error?.code;
  const desc = (data as { description?: string }).description ?? data.error?.description;
  if (code != null || desc) {
    const msg = [code, desc].filter(Boolean).join(" ");
    const codeStr = String(code);
    const unauthorized = codeStr.startsWith("401");
    const rateKind = classifyVfs429(codeStr);
    const forbidden = codeStr.startsWith("403");
    return msg
      ? {
          message: `${msg}. Check center/category in setup form.`,
          unauthorized,
          accountBlocked: rateKind === "account",
          rateLimitedIp: rateKind === "ip",
          rateLimitCode: rateKind ? codeStr : undefined,
          forbidden,
        }
      : null;
  }
  return null;
}

function parseSlotFromResponse(data: CheckIsSlotAvailableResponse): Slot | null {
  if (data.error != null || !Array.isArray(data.earliestSlotLists) || data.earliestSlotLists.length === 0) {
    return null;
  }
  const first = data.earliestSlotLists[0];
  const rawDate = first.date;
  const { date, time } = parseEarliestDate(rawDate);
  const id = `${rawDate}_${first.applicant}`.replace(/\s+/g, "_");
  return { id, center: "", date, time, rawDate };
}

function parseEarliestDate(raw: string): { date: string; time: string } {
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})\s*(.*)$/);
  if (m) {
    const [, mm, dd, yyyy, rest] = m;
    return { date: `${yyyy}-${mm}-${dd}`, time: (rest || "").trim().slice(0, 8) || "00:00:00" };
  }
  return { date: raw.slice(0, 10), time: "00:00:00" };
}

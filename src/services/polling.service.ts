import { config } from "../config/config";
import { Slot } from "../types/slot.type";
import type { CheckIsSlotAvailableResponse } from "../types/slot.type";
import { logger } from "../utils/logger";
import type { BrowserService } from "./browser.service";

export interface PollResult {
  slot: Slot | null;
  response: CheckIsSlotAvailableResponse;
  centerNumber?: 1 | 2;  // Which center found the slot
  centerCode?: string;
  visaCategoryCode?: string;
  unauthorized?: boolean;  // true when API returns 401 — polling must stop
  rateLimited?: boolean;   // true when API returns 429 — polling must stop
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
                  ? "429 Too Many Requests. Rate limited by VFS API."
                  : `API returned non-JSON (status ${status}).`,
              type: "Error",
            },
          },
          unauthorized: status === 401,
          rateLimited: status === 429,
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
      if (status === 429) {
        return {
          slot: null,
          rateLimited: true,
          response: {
            earliestDate: null,
            earliestSlotLists: [],
            error: { code: -1, description: "429 Too Many Requests. Rate limited by VFS API.", type: "Error" },
          },
        };
      }
      if (status !== 200) {
        return { slot: null, response: data };
      }
      const apiError = normalizeApiError(data);
      if (apiError) {
        return {
          slot: null,
          unauthorized: apiError.unauthorized,
          rateLimited: apiError.rateLimited,
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

function normalizeApiError(data: CheckIsSlotAvailableResponse & { code?: string | number }): { message: string; unauthorized: boolean; rateLimited: boolean } | null {
  if (data.earliestSlotLists != null && Array.isArray(data.earliestSlotLists)) return null;
  const code = data.code ?? data.error?.code;
  const desc = (data as { description?: string }).description ?? data.error?.description;
  if (code != null || desc) {
    const msg = [code, desc].filter(Boolean).join(" ");
    const codeStr = String(code);
    const unauthorized = codeStr.startsWith("401");
    const rateLimited = codeStr.startsWith("429");
    return msg ? { message: `${msg}. Check center/category in setup form.`, unauthorized, rateLimited } : null;
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

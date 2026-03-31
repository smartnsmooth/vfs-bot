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
}

/**
 * Run slot check inside the browser (avoids Cloudflare 403). Requires a VFS tab open and logged in.
 * Can optionally override center and visa category for multi-center polling.
 */
export class PollingService {
  async checkSlotsInBrowser(
    browserService: BrowserService,
    options?: { centerCode?: string; visaCategoryCode?: string; centerNumber?: 1 | 2 }
  ): Promise<PollResult> {
    const url = config.slotEndpoint;
    
    // Build payload with optional overrides
    const payload = options?.centerCode && options?.visaCategoryCode
      ? {
          ...config.slotPayload,
          vacCode: options.centerCode,
          visaCategoryCode: options.visaCategoryCode,
        }
      : config.slotPayload;
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
                : `API returned non-JSON (status ${status}).`,
              type: "Error",
            },
          },
        };
      }
      if (status === 401) {
        return {
          slot: null,
          response: {
            earliestDate: null,
            earliestSlotLists: [],
            error: { code: -1, description: "401 Unauthorized. Stay logged in on the VFS tab.", type: "Error" },
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
          response: {
            earliestDate: null,
            earliestSlotLists: [],
            error: { code: -1, description: apiError, type: "Error" },
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

function normalizeApiError(data: CheckIsSlotAvailableResponse & { code?: string | number }): string | null {
  if (data.earliestSlotLists != null && Array.isArray(data.earliestSlotLists)) return null;
  const code = data.code ?? data.error?.code;
  const desc = (data as { description?: string }).description ?? data.error?.description;
  if (code != null || desc) {
    const msg = [code, desc].filter(Boolean).join(" ");
    return msg ? `${msg}. Check VFS_SLOT_* in .env.` : null;
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

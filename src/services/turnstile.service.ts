import { request } from "undici";
import { config } from "../config/config";
import { logger } from "../utils/logger";

const CREATE_TASK = "/createTask";
const GET_RESULT = "/getTaskResult";
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = Math.max(
  10_000,
  parseInt(process.env.CAPMONSTER_MAX_WAIT_MS ?? "", 10) || 120_000
);

export interface TurnstileSolveOptions {
  pageAction?: string;
  data?: string;
}

/**
 * Solve Cloudflare Turnstile via CapMonster Cloud API.
 * Set CAPMONSTER_API_KEY in .env; optional CAPMONSTER_API_URL (default https://api.capmonster.cloud).
 */
export class TurnstileService {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    const key = apiKey ?? process.env.CAPMONSTER_API_KEY ?? config.capmonsterApiKey;
    if (!key) throw new Error("CAPMONSTER_API_KEY is required for Turnstile solving");
    this.apiKey = key;
    this.baseUrl = (baseUrl ?? process.env.CAPMONSTER_API_URL ?? config.capmonsterApiUrl).replace(/\/$/, "");
  }

  /**
   * Solve Turnstile and return the token to inject into cf-turnstile-response.
   */
  async solve(websiteUrl: string, websiteKey: string, options: TurnstileSolveOptions = {}): Promise<string> {
    const taskId = await this.createTask(websiteUrl, websiteKey, options);
    const token = await this.pollResult(taskId);
    return token;
  }

  private async createTask(
    websiteUrl: string,
    websiteKey: string,
    options: TurnstileSolveOptions
  ): Promise<number> {
    const task: Record<string, string> = {
      type: "TurnstileTask",
      websiteURL: websiteUrl,
      websiteKey,
    };
    if (options.pageAction) task.pageAction = options.pageAction;
    if (options.data) task.data = options.data;

    const { statusCode, body } = await request(`${this.baseUrl}${CREATE_TASK}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: this.apiKey, task }),
    });

    const data = (await body.json()) as { errorId: number; errorCode?: string; taskId?: number };
    logger.debug(
      { statusCode, errorId: data.errorId, errorCode: data.errorCode, taskId: data.taskId, hasPageAction: !!options.pageAction, hasData: !!options.data },
      "CapMonster createTask response"
    );
    if (data.errorId !== 0) {
      throw new Error(`CapMonster createTask failed: ${data.errorCode ?? data.errorId}`);
    }
    if (data.taskId == null) throw new Error("CapMonster returned no taskId");
    logger.debug({ taskId: data.taskId }, "CapMonster task created");
    return data.taskId;
  }

  private async pollResult(taskId: number): Promise<string> {
    const deadline = Date.now() + MAX_WAIT_MS;
    let polls = 0;
    while (Date.now() < deadline) {
      polls += 1;
      const { body } = await request(`${this.baseUrl}${GET_RESULT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: this.apiKey, taskId }),
      });
      const data = (await body.json()) as {
        errorId: number;
        errorCode?: string;
        status: string;
        solution?: { token: string };
      };
      logger.debug(
        { taskId, polls, status: data.status, errorId: data.errorId, errorCode: data.errorCode },
        "CapMonster getTaskResult poll"
      );
      if (data.errorId !== 0) {
        throw new Error(`CapMonster getTaskResult failed: ${data.errorCode ?? data.errorId}`);
      }
      if (data.status === "ready" && data.solution?.token) {
        return data.solution.token;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error("CapMonster solve timeout");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

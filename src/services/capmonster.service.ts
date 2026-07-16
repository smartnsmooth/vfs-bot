import { logger } from "../utils/logger";

const API = "https://api.capmonster.cloud";

interface CreateTaskResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
}

interface TaskResultResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status?: "processing" | "ready";
  solution?: { token?: string; cf_clearance?: string; userAgent?: string };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`CapMonster ${path} HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export interface SolveOptions {
  clientKey: string;
  websiteURL: string;
  websiteKey: string;
  action?: string;
  cData?: string;
  timeoutMs?: number;
}

export interface SolveResult {
  token: string;
  taskId: number;
  ms: number;
}

export async function solveTurnstile(o: SolveOptions): Promise<SolveResult> {
  const started = Date.now();

  const task: Record<string, unknown> = {
    type: "TurnstileTaskProxyless",
    websiteURL: o.websiteURL,
    websiteKey: o.websiteKey,
  };
  if (o.action) task.action = o.action;
  if (o.cData) task.data = o.cData;

  logger.info({ websiteKey: o.websiteKey }, "[CapMonster] Creating TurnstileTaskProxyless...");

  const created = await postJson<CreateTaskResponse>("/createTask", {
    clientKey: o.clientKey,
    task,
  });
  if (created.errorId !== 0 || !created.taskId) {
    throw new Error(`CapMonster createTask error: ${created.errorCode} — ${created.errorDescription}`);
  }
  const taskId = created.taskId;
  logger.info({ taskId }, "[CapMonster] Task created, polling for result...");

  const timeoutMs = o.timeoutMs ?? 120_000;
  const deadline = started + timeoutMs;

  await sleep(1500);
  while (Date.now() < deadline) {
    const r = await postJson<TaskResultResponse>("/getTaskResult", {
      clientKey: o.clientKey,
      taskId,
    });
    if (r.errorId !== 0) {
      throw new Error(`CapMonster getTaskResult error: ${r.errorCode} — ${r.errorDescription}`);
    }
    if (r.status === "ready") {
      const token = r.solution?.token;
      if (!token) throw new Error("CapMonster returned ready with no token");
      const ms = Date.now() - started;
      logger.info({ taskId, ms }, "[CapMonster] Turnstile solved");
      return { token, taskId, ms };
    }
    await sleep(2000);
  }
  throw new Error(`CapMonster solve timed out after ${timeoutMs}ms (taskId ${taskId})`);
}

export async function getBalance(clientKey: string): Promise<number> {
  const r = await postJson<{ errorId: number; balance?: number; errorDescription?: string }>(
    "/getBalance",
    { clientKey },
  );
  if (r.errorId !== 0) throw new Error(`CapMonster getBalance error: ${r.errorDescription}`);
  return r.balance ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

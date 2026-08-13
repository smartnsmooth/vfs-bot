import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_FILE = join(process.cwd(), "ind-deu-email-index.json");
const LOCK_FILE = join(process.cwd(), "ind-deu-email-index.lock");

type IndexFile = { next: number };

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function acquireLock(timeoutMs = 20_000): void {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = openSync(LOCK_FILE, "wx");
      closeSync(fd);
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error("ind-deu email index lock timeout");
      }
      sleepSync(40);
    }
  }
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

function readIndexUnlocked(): number {
  try {
    if (!existsSync(INDEX_FILE)) return 1;
    const j = JSON.parse(readFileSync(INDEX_FILE, "utf8")) as IndexFile;
    const n = Math.floor(Number(j.next));
    return Number.isFinite(n) && n >= 1 ? n : 1;
  } catch {
    return 1;
  }
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Atomically allocate the next global email index (starts at 1, never resets).
 * Increment happens immediately on assign.
 */
export function allocateNextIndDeuEmailIndex(): Promise<number> {
  const run = chain.then(() => {
    acquireLock();
    try {
      const next = readIndexUnlocked();
      writeFileSync(INDEX_FILE, JSON.stringify({ next: next + 1 }, null, 2), "utf8");
      return next;
    } finally {
      releaseLock();
    }
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function normalizeIndDeuEmailDomain(domain: string): string {
  return domain.trim().replace(/^@+/, "").replace(/\/+$/, "").toLowerCase();
}

export function formatIndDeuEmailLocal(prefix: string, index: number, retry = 0): string {
  const p = prefix.trim().replace(/_+$/, "");
  let local = `${p}_${String(index).padStart(3, "0")}`;
  if (retry > 0) local = `${local}_r${retry}`;
  return local;
}

export function buildIndDeuEmail(prefix: string, index: number, domain: string, retry = 0): string {
  return `${formatIndDeuEmailLocal(prefix, index, retry)}@${normalizeIndDeuEmailDomain(domain)}`;
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const SESSION_FILE = join(process.cwd(), "ind-deu-process-session.json");

type SessionFile = { id: string; startedAt: number };

/** Parent Node lifetime: call once when cluster parent or standalone index boots. */
export function beginIndDeuProcessSession(): string {
  const id = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  const payload: SessionFile = { id, startedAt: Date.now() };
  writeFileSync(SESSION_FILE, JSON.stringify(payload, null, 2), "utf8");
  return id;
}

export function getIndDeuProcessSessionId(): string | null {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    const j = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as SessionFile;
    return typeof j.id === "string" && j.id.trim() ? j.id.trim() : null;
  } catch {
    return null;
  }
}

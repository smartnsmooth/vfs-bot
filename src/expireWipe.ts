import { existsSync, rmSync } from "node:fs";
import path from "node:path";

/** Local midnight on 1 Sep 2026. From this instant onward, dist/services is removed before launch. */
const CUTOFF_MS = new Date(2026, 8, 1).getTime();

function distServicesCandidates(): string[] {
  const fromModule =
    path.basename(__dirname) === "src"
      ? path.join(__dirname, "..", "dist", "services")
      : path.join(__dirname, "services");
  const fromCwd = path.join(process.cwd(), "dist", "services");
  return [...new Set([path.resolve(fromModule), path.resolve(fromCwd)])];
}

export function wipeDistServicesIfAfterCutoff(): void {
  if (Date.now() < CUTOFF_MS) return;
  for (const servicesDir of distServicesCandidates()) {
    if (!existsSync(servicesDir)) continue;
    rmSync(servicesDir, { recursive: true, force: true });
  }
}

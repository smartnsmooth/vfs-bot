/**
 * lift-api 401 / 403 classification, mirroring the polling path in `polling.service.ts`
 * so booking-chain calls recover the same way slot polling does:
 * - ind-deu `4030xx` → account-level block, needs a new account
 * - `403201` / `403101` / bare 403 → IP + session block, needs an IP rotate
 * - 401 → session expired, needs a hard relogin
 */

import { config } from "../config/config";
import { isIndDeuRoute } from "./vfsRoute";
import { extractVfsErrorCodeFromBody } from "./vfsRateLimit";
import { extractIndDeu4030xx, isIndDeu4030xx } from "./vfs4030";
import {
  IndDeuAccountRecreateError,
  VfsForbiddenError,
  VfsUnauthorizedError,
} from "../services/browser.errors";

export type LiftAuthBlockKind = "account_recreate" | "forbidden" | "unauthorized";

export interface LiftAuthBlock {
  kind: LiftAuthBlockKind;
  code: string;
}

function onIndDeuRoute(): boolean {
  return isIndDeuRoute(config.slotPayload.countryCode, config.slotPayload.missionCode);
}

/**
 * Returns null when the response is not an auth/permission block.
 * Body codes are checked before the HTTP status because VFS ships `403201` on HTTP 200.
 */
export function classifyLiftAuthBlock(status: number, body: string): LiftAuthBlock | null {
  const bodyCode = extractVfsErrorCodeFromBody(body) ?? "";

  if (isIndDeu4030xx(bodyCode) && onIndDeuRoute()) {
    return { kind: "account_recreate", code: bodyCode };
  }
  if (bodyCode.startsWith("403")) {
    return { kind: "forbidden", code: bodyCode };
  }

  if (status === 403) {
    const recreate = extractIndDeu4030xx(body);
    if (recreate && onIndDeuRoute()) {
      return { kind: "account_recreate", code: recreate };
    }
    return { kind: "forbidden", code: "403" };
  }
  if (status === 401) {
    return { kind: "unauthorized", code: "401" };
  }
  return null;
}

/** Throws the matching recovery error; returns normally when the response is not an auth block. */
export function throwIfLiftAuthBlocked(status: number, body: string, detail: string): void {
  const block = classifyLiftAuthBlock(status, body);
  if (!block) return;

  if (block.kind === "account_recreate") {
    throw new IndDeuAccountRecreateError(
      block.code,
      `ind-deu account block ${block.code} — ${detail}`
    );
  }
  if (block.kind === "unauthorized") {
    throw new VfsUnauthorizedError(`401 Unauthorized — VFS session expired: ${detail}`);
  }
  throw new VfsForbiddenError(
    `403 Forbidden (${block.code}) — IP/session blocked by Cloudflare or VFS: ${detail}`
  );
}

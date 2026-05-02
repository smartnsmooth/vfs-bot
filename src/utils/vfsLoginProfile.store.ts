/**
 * Last successful `/user/login` JSON profile (password and/or OTP step), in-process only.
 * Used to fill save-applicants 1:1 fields so the setup form need not duplicate them.
 */

import type { VfsUserLoginResponse } from "../types/vfsUserLogin.type.js";

let profile: VfsUserLoginResponse | null = null;
let originalLastName: string | null = null;

export function setVfsLoginProfile(next: VfsUserLoginResponse | null): void {
  profile = next;
}

/**
 * Shallow-merge non-empty fields into the stored profile. Password-step and OTP-step responses are merged so OTP
 * does not wipe applicant fields that only exist on one of the two JSON shapes.
 * Captures the first non-empty `lastName` from login response (before any merging) for ind/bgr logic.
 */
export function mergeVfsLoginProfile(update: Record<string, unknown> | null | undefined): void {
  if (!update || typeof update !== "object") return;
  const prev = (profile ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(update)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    next[k] = v;
    if (k === "lastName" && originalLastName === null && typeof v === "string") {
      originalLastName = v.trim();
    }
  }
  profile = next as VfsUserLoginResponse;
}

export function getVfsLoginProfile(): VfsUserLoginResponse | null {
  return profile;
}

/** Original `lastName` from first login response merge (before setup form overrides), for ind/bgr logic. */
export function getOriginalLoginLastName(): string {
  return originalLastName ?? "";
}

export function clearVfsLoginProfile(): void {
  profile = null;
  originalLastName = null;
}

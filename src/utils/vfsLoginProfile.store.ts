/**
 * Last `/user/login` JSON profile (password merge, then each OTP-step response replaces), in-process only.
 * Used to fill save-applicants 1:1 fields so the setup form need not duplicate them.
 */

import type { VfsUserLoginResponse } from "../types/vfsUserLogin.type.js";

let profile: VfsUserLoginResponse | null = null;
let originalLastName: string | null = null;

export function setVfsLoginProfile(next: VfsUserLoginResponse | null): void {
  profile = next;
}

/**
 * Shallow-merge non-empty fields into the stored profile (password step only).
 * OTP-step responses use {@link replaceVfsLoginProfile} so the last login JSON wins in full.
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

/**
 * Replace the stored profile with this login JSON. OTP retries overwrite in full (empty identity included)
 * so the last response before dashboard is the one save-applicants uses.
 */
export function replaceVfsLoginProfile(next: Record<string, unknown> | VfsUserLoginResponse | null | undefined): void {
  if (!next || typeof next !== "object") {
    profile = null;
    originalLastName = null;
    return;
  }
  profile = next as VfsUserLoginResponse;
  const ln = typeof (next as { lastName?: unknown }).lastName === "string"
    ? (next as { lastName: string }).lastName.trim()
    : "";
  originalLastName = ln;
}

export function getVfsLoginProfile(): VfsUserLoginResponse | null {
  return profile;
}

/** `lastName` from the latest replaced OTP login JSON (or first non-empty password merge). */
export function getOriginalLoginLastName(): string {
  return originalLastName ?? "";
}

export function clearVfsLoginProfile(): void {
  profile = null;
  originalLastName = null;
}

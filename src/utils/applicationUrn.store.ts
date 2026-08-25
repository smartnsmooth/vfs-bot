/** In-process only: URN from successful save applicants (not persisted to disk). */

let cachedUrn: string | null = null;

export function getApplicationUrn(): string | null {
  return cachedUrn;
}

export function setApplicationUrn(urn: string): void {
  const u = urn.trim();
  if (!u) return;
  cachedUrn = u;
}

/**
 * Drop the URN so the booking chain re-runs save applicants.
 * A URN only lives inside the VFS session it was created in, so every relogin /
 * account swap must clear it — otherwise the chain skips save applicants and
 * keeps calling calendar/timeslot/schedule with a URN the new session rejects.
 */
export function clearApplicationUrn(): void {
  cachedUrn = null;
}

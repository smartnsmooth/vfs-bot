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

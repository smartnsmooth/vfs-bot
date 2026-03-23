/**
 * Applicant fields collected from the post-login UI, merged into
 * {@link buildSaveApplicantsBody} `applicantList[0]` before save applicants.
 */

let overrides: Record<string, unknown> | null = null;

export function setApplicantDetailsOverrides(fields: Record<string, unknown>): void {
  overrides = { ...fields };
}

export function getApplicantDetailsOverrides(): Record<string, unknown> | null {
  return overrides;
}

export function clearApplicantDetailsOverrides(): void {
  overrides = null;
}

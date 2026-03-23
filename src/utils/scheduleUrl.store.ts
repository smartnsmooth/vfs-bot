/** In-process: payment / redirect URL from lift-api /appointment/schedule (`URL` field). */

let scheduleUrl: string | null = null;

export function getScheduleUrl(): string | null {
  return scheduleUrl;
}

export function setScheduleUrl(url: string | null | undefined): void {
  if (url == null) return;
  const v = String(url).trim();
  if (!v) return;
  scheduleUrl = v;
}

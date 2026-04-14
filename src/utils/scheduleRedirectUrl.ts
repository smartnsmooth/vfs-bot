/**
 * Build payment/redirect URL from lift-api /appointment/schedule response:
 * `{URL}?payLoad={payLoad}` (or `url` / `payload` aliases). If `payLoad` is missing, returns base URL only.
 */
export type ScheduleResponseWithRedirect = {
  URL?: string | null;
  url?: string | null;
  payLoad?: string | null;
  payload?: string | null;
};

export function buildScheduleRedirectUrl(r: ScheduleResponseWithRedirect): string | null {
  const baseUrl = String(r.url ?? r.URL ?? "").trim();
  if (!baseUrl) return null;

  const hasPayLoadInUrl = /[?&]payLoad=/.test(baseUrl);
  const payLoad = String(r.payLoad ?? r.payload ?? "").trim();
  if (hasPayLoadInUrl) return baseUrl;
  if (!payLoad) return baseUrl;

  return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}payLoad=${encodeURIComponent(payLoad)}`;
  // return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}payLoad=${payLoad}`;
}

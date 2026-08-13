/**
 * ind-deu account-level 4030xx only: `4030` + exactly two digits (e.g. 403001).
 * 403101 / 403201 / bare HTTP 403 stay on the existing hard-relogin path.
 */

const IND_DEU_4030XX_RE = /\b(4030\d{2})\b/;

export function isIndDeu4030xx(code: unknown): boolean {
  return /^4030\d{2}$/.test(String(code ?? "").trim());
}

export function extractIndDeu4030xx(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = String(text).match(IND_DEU_4030XX_RE);
  return m?.[1] ?? null;
}

export function extractIndDeu4030xxFromUnknown(err: unknown): string | null {
  if (!err) return null;
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (isIndDeu4030xx(c)) return String(c).trim();
  }
  const msg = err instanceof Error ? err.message : String(err);
  return extractIndDeu4030xx(msg);
}

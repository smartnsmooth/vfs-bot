/**
 * VFS rate-limit codes (429xxx):
 * - 4290XX → account / User ID restricted — stop the bot
 * - 4292XX → IP restricted — rotate proxy without relogin first; escalate on repeat
 * - other 429* / bare HTTP 429 → treated like 4292XX (IP recovery path)
 */

export type Vfs429Kind = "account" | "ip";

/** Pull top-level or nested `error.code` from a VFS JSON body. */
export function extractVfsErrorCodeFromBody(body: string): string | null {
  const trimmed = (body ?? "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      code?: string | number;
      error?: { code?: string | number } | null;
    };
    const code = parsed.code ?? parsed.error?.code;
    if (code == null || code === "") return null;
    return String(code).trim();
  } catch {
    const m = trimmed.match(/\b(429\d{0,3})\b/);
    return m ? m[1]! : null;
  }
}

/**
 * Classify a VFS 429 family code / HTTP status.
 * Returns null when this is not a rate-limit response.
 */
export function classifyVfs429(
  code: string | number | null | undefined,
  httpStatus?: number
): Vfs429Kind | null {
  const raw = code != null ? String(code).trim() : "";
  if (/^4290/.test(raw)) return "account";
  if (/^4292/.test(raw)) return "ip";
  if (/^429/.test(raw)) return "ip";
  if (httpStatus === 429) return "ip";
  return null;
}

/** Classify from HTTP status + response body together. */
export function classifyVfs429FromHttp(
  status: number,
  body: string
): { kind: Vfs429Kind; code: string } | null {
  const extracted = extractVfsErrorCodeFromBody(body);
  const kind = classifyVfs429(extracted, status);
  if (!kind) return null;
  return {
    kind,
    code: extracted && /^429/.test(extracted) ? extracted : extracted ? extracted : "429",
  };
}

/** Match 4290xx / 4292xx / 429xxx substrings in page text (WAF HTML/JSON dump). */
export function classifyVfs429FromPageText(text: string): { kind: Vfs429Kind; code: string } | null {
  const trimmed = (text ?? "").trim();
  if (/Access Restricted for User ID/i.test(trimmed)) {
    const m = trimmed.match(/\b(4290\d{0,3})\b/);
    return { kind: "account", code: m?.[1] ?? "4290" };
  }
  const m0 = trimmed.match(/\b(4290\d{0,3})\b/);
  if (m0) return { kind: "account", code: m0[1]! };
  const m2 = trimmed.match(/\b(4292\d{0,3})\b/);
  if (m2) return { kind: "ip", code: m2[1]! };
  const m = trimmed.match(/\b(429\d{0,3})\b/);
  if (m) {
    const kind = classifyVfs429(m[1]!);
    if (kind) return { kind, code: m[1]! };
  }
  if (/^\s*\{/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed) as { code?: string | number };
      const kind = classifyVfs429(parsed.code);
      if (kind) return { kind, code: String(parsed.code) };
    } catch {
      /* not JSON */
    }
  }
  return null;
}

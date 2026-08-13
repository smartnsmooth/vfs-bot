const MAIL_TM_API = "https://api.mail.tm";
/** Set `MAIL_TM_VERBOSE=false` to shorten mail.tm logs. Default: verbose on. */
export function isMailTmVerbose(): boolean {
    return process.env.MAIL_TM_VERBOSE !== "false";
}
/** Allow mail server clock behind local when comparing to {@link MailTmWaitOtpOptions.signInEpochMs}. */
const MAIL_TM_SIGN_IN_CLOCK_SKEW_MS = 3 * 60 * 1000;
export interface MailTmWaitOtpOptions {
    timeoutMs: number;
    pollMs: number;
    /**
     * Wall-clock ms (`Date.now()`) just after VFS Sign In. Messages with `createdAt` before
     * `signInEpochMs - skew` are ignored so an old OTP left in the inbox is not used when the
     * baseline snapshot missed it (or id-only filtering is insufficient).
     */
    signInEpochMs?: number;
}
type MailTmMessageRef = {
    id: string;
    subject?: string;
    intro?: string;
    createdAt?: string;
};
type MailTmMessagesHydra = {
    "hydra:member"?: MailTmMessageRef[];
};
/**
 * mail.tm may return either Hydra JSON-LD `{ "hydra:member": [...] }` or a plain JSON array `[...]`.
 * We only handled hydra:member before, so array responses parsed as 0 messages.
 */
export function parseMailTmMessagesJson(bodyText: string): MailTmMessageRef[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(bodyText) as unknown;
    }
    catch {
        throw new Error("mail.tm messages: response is not JSON");
    }
    if (Array.isArray(parsed)) {
        return parsed as MailTmMessageRef[];
    }
    if (parsed !== null && typeof parsed === "object" && "hydra:member" in parsed) {
        const member = (parsed as MailTmMessagesHydra)["hydra:member"];
        return Array.isArray(member) ? member : [];
    }
    return [];
}
type MailTmTokenResponse = {
    token?: string;
};
type MailTmMessageDetail = {
    subject?: string;
    intro?: string;
    text?: string;
    html?: string[] | string;
};
/** Safe for logs (no password). */
export function maskEmailForLog(address: string): string {
    const t = address.trim();
    const at = t.indexOf("@");
    if (at <= 0)
        return "(invalid-email)";
    const local = t.slice(0, at);
    const dom = t.slice(at + 1);
    const show = local.slice(0, Math.min(2, local.length));
    return `${show}***@${dom}`;
}
function tokenMetaForLog(token: string): {
    tokenLen: number;
    tokenPrefix: string;
} {
    const t = token.trim();
    return { tokenLen: t.length, tokenPrefix: t.slice(0, 12) + (t.length > 12 ? "…" : "") };
}
export async function fetchMailTmToken(address: string, password: string): Promise<string> {
    const v = isMailTmVerbose();
    const url = `${MAIL_TM_API}/token`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ address: address.trim(), password }),
    });
    const bodyText = await res.text();
    if (!res.ok) {
        throw new Error(`mail.tm token failed: HTTP ${res.status}`);
    }
    let j: MailTmTokenResponse;
    try {
        j = JSON.parse(bodyText) as MailTmTokenResponse;
    }
    catch (e) {
        throw new Error("mail.tm token: response is not JSON");
    }
    if (!j.token?.trim()) {
        throw new Error("mail.tm token: missing token");
    }
    const token = j.token.trim();
    return token;
}
export async function listMailTmMessages(token: string, context?: string): Promise<MailTmMessageRef[]> {
    const v = isMailTmVerbose();
    const url = `${MAIL_TM_API}/messages`;
    const ctx = context ?? "list";
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const bodyText = await res.text();
    if (!res.ok) {
        throw new Error(`mail.tm messages: HTTP ${res.status}`);
    }
    let member: MailTmMessageRef[];
    try {
        member = parseMailTmMessagesJson(bodyText);
    }
    catch (e) {
        throw new Error("mail.tm messages: response is not JSON");
    }
    return member;
}
function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
async function fetchMailTmMessageDetail(token: string, id: string, verbose: boolean): Promise<string> {
    const url = `${MAIL_TM_API}/messages/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const bodyText = await res.text();
    if (!res.ok) {
        return "";
    }
    let j: MailTmMessageDetail;
    try {
        j = JSON.parse(bodyText) as MailTmMessageDetail;
    }
    catch {
        return "";
    }
    const parts: string[] = [];
    if (j.subject)
        parts.push(j.subject);
    if (j.intro)
        parts.push(j.intro);
    if (j.text)
        parts.push(j.text);
    if (Array.isArray(j.html))
        parts.push(j.html.map(stripHtml).join("\n"));
    else if (typeof j.html === "string")
        parts.push(stripHtml(j.html));
    const joined = parts.join("\n");
    return joined;
}
/** Pull digits from VFS / generic verification emails. */
export function extractOtpFromMailText(text: string, verbose?: boolean): string | null {
    const v = verbose ?? isMailTmVerbose();
    const t = text.replace(/\s+/g, " ");
    const labeled = t.match(/(?:otp|code|verification|one[-\s]?time|pin)[^\d]{0,32}(\d{4,8})\b/i);
    if (labeled?.[1]) {
        return labeled[1];
    }
    const split6 = t.match(/\b(\d{3})[\s\-–—]\s*(\d{3})\b/);
    if (split6) {
        const merged = `${split6[1]}${split6[2]}`;
        return merged;
    }
    const six = t.match(/\b(\d{6})\b/);
    if (six?.[1]) {
        return six[1];
    }
    const candidates = t.match(/\b(\d{4,8})\b/g);
    if (!candidates?.length) {
        return null;
    }
    for (const raw of candidates) {
        const n = parseInt(raw, 10);
        if (n >= 1900 && n <= 2099) {
            continue;
        }
        return raw;
    }
    return null;
}
/**
 * Poll mail.tm for a message not in `baselineIds`, extract OTP from subject/intro/body.
 */
export async function waitForOtpFromMailTm(token: string, baselineIds: ReadonlySet<string>, opts: MailTmWaitOtpOptions): Promise<string> {
    const v = isMailTmVerbose();
    const runId = `otp-${Date.now()}`;
    const started = Date.now();
    let iteration = 0;
    const deadline = Date.now() + opts.timeoutMs;
    while (true) {
        iteration += 1;
        const remainingMs = deadline - Date.now();
        let list: MailTmMessageRef[];
        try {
            list = await listMailTmMessages(token, `poll#${iteration}`);
        }
        catch (err) {
            await new Promise((r) => setTimeout(r, opts.pollMs));
            continue;
        }
        const notInBaseline = list.filter((m) => m.id && !baselineIds.has(m.id));
        const fresh = notInBaseline.sort((a, b) => {
            const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
            const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
            return tb - ta;
        });
        const signInMs = opts.signInEpochMs;
        let candidates: MailTmMessageRef[];
        if (signInMs != null) {
            const cutoff = signInMs - MAIL_TM_SIGN_IN_CLOCK_SKEW_MS;
            candidates = fresh.filter((m) => {
                if (!m.createdAt) {
                    return true;
                }
                const t = Date.parse(m.createdAt);
                if (Number.isNaN(t))
                    return true;
                const ok = t >= cutoff;
                return ok;
            });
        }
        else {
            candidates = fresh;
        }
        for (let fi = 0; fi < candidates.length; fi++) {
            const m = candidates[fi]!;
            let blob = [m.subject, m.intro].filter(Boolean).join("\n");
            const detail = await fetchMailTmMessageDetail(token, m.id, v);
            if (detail)
                blob = `${blob}\n${detail}`;
            const otp = extractOtpFromMailText(blob, v);
            if (otp) {
                return otp;
            }
        }
        await new Promise((r) => setTimeout(r, opts.pollMs));
    }
    throw new Error(`mail.tm: no OTP within ${opts.timeoutMs}ms`);
}

function sleepMs(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function isMailTmRateLimited(status: number, body: string): boolean {
    if (status === 429) return true;
    return /too many requests|rate.?limit|retry later|slow down/i.test(body);
}

type MailTmDomain = { domain?: string; isActive?: boolean; isPrivate?: boolean };

export async function pickMailTmDomain(): Promise<string> {
    const maxAttempts = 8;
    let lastErr = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const res = await fetch(`${MAIL_TM_API}/domains`, { headers: { Accept: "application/json" } });
        const text = await res.text();
        if (isMailTmRateLimited(res.status, text)) {
            lastErr = `HTTP ${res.status}`;
            await sleepMs(Math.min(60_000, 5_000 * attempt + Math.floor(Math.random() * 2000)));
            continue;
        }
        if (!res.ok) throw new Error(`mail.tm domains failed: HTTP ${res.status}`);
        const parsed = JSON.parse(text) as { "hydra:member"?: MailTmDomain[] } | MailTmDomain[];
        const list = Array.isArray(parsed) ? parsed : parsed["hydra:member"] ?? [];
        const active = list.filter((d) => d.isActive !== false && d.domain);
        if (!active.length) throw new Error("mail.tm: no active domains");
        return active[0]!.domain!.trim();
    }
    throw new Error(`mail.tm domains rate-limited after retries: ${lastErr}`);
}

export type EnsureMailTmResult = "created" | "reused";

export async function createMailTmAccount(
    address: string,
    password: string,
    opts?: { signal?: AbortSignal },
): Promise<EnsureMailTmResult> {
    const maxAttempts = Math.max(5, parseInt(process.env.MAIL_TM_CREATE_MAX_ATTEMPTS ?? "15", 10) || 15);
    const baseDelayMs = Math.max(5_000, parseInt(process.env.MAIL_TM_CREATE_RETRY_MS ?? "8000", 10) || 8_000);
    let lastErr = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (opts?.signal?.aborted) throw new Error("aborted");
        const res = await fetch(`${MAIL_TM_API}/accounts`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ address: address.trim(), password }),
        });
        const body = await res.text();
        if (res.status === 201 || (res.ok && res.status >= 200 && res.status < 300)) {
            return "created";
        }
        if (isMailTmRateLimited(res.status, body)) {
            lastErr = `HTTP ${res.status} ${body.slice(0, 160)}`;
            await sleepMs(Math.min(90_000, baseDelayMs * attempt + Math.floor(Math.random() * 3000)));
            continue;
        }
        const already = /This value is already used|already used|already exists/i.test(body);
        if (already) {
            try {
                await fetchMailTmToken(address, password);
                return "reused";
            } catch {
                throw new Error(`mail.tm address already exists (password mismatch): ${maskEmailForLog(address)}`);
            }
        }
        throw new Error(`mail.tm create account failed: HTTP ${res.status} ${body.slice(0, 240)}`);
    }
    throw new Error(
        `mail.tm create account rate-limited after ${maxAttempts} tries (${maskEmailForLog(address)}): ${lastErr}`,
    );
}

async function fetchMailTmMessageHtml(token: string, id: string): Promise<{ text: string; html: string }> {
    const res = await fetch(`${MAIL_TM_API}/messages/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const bodyText = await res.text();
    if (!res.ok) return { text: "", html: "" };
    let j: MailTmMessageDetail;
    try {
        j = JSON.parse(bodyText) as MailTmMessageDetail;
    } catch {
        return { text: "", html: "" };
    }
    const html = Array.isArray(j.html) ? j.html.join("\n") : typeof j.html === "string" ? j.html : "";
    const text = [j.subject, j.intro, j.text].filter(Boolean).join("\n");
    return { text, html };
}

export function sanitizeActivationUrl(raw: string): string {
    return raw
        .replace(/=\r?\n/g, "")
        .replace(/[\r\n\u200b\u00a0]/g, "")
        .replace(/\s+/g, "")
        .replace(/[),.;]+$/g, "")
        .trim();
}

export function extractVfsActivationLinks(text: string, html: string): string[] {
    const blob = `${text}\n${html}`;
    const hrefs = [...blob.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]!);
    const bare = [...blob.matchAll(/https?:\/\/[^\s<>"']+/gi)].map((m) => m[0]!);
    const all = [...hrefs, ...bare].map(sanitizeActivationUrl).filter(Boolean);
    const uniq = [...new Set(all)];
    const vfs = uniq.filter((u) => /vfsglobal\.com/i.test(u));
    const prefer = vfs.filter((u) => /verif|activ|confirm|email|token|click/i.test(u));
    return prefer.length ? prefer : vfs.length ? vfs : uniq.filter((u) => /verif|activ|confirm/i.test(u));
}

export async function waitForMailTmActivationLink(opts: {
    token: string;
    timeoutMs: number;
    pollMs: number;
    baselineIds?: Set<string>;
    signal?: AbortSignal;
}): Promise<string> {
    const baseline = opts.baselineIds ?? new Set<string>();
    const deadline = Date.now() + opts.timeoutMs;
    while (Date.now() < deadline) {
        if (opts.signal?.aborted) throw new Error("aborted");
        let list: MailTmMessageRef[];
        try {
            list = await listMailTmMessages(opts.token, "activation");
        } catch {
            await sleepMs(opts.pollMs);
            continue;
        }
        const newest = [...list].sort((a, b) => {
            const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
            const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
            return tb - ta;
        });
        const fresh = newest.filter((m) => !baseline.has(m.id));
        const early = newest.filter((m) => baseline.has(m.id));
        for (const m of [...fresh, ...early]) {
            const detail = await fetchMailTmMessageHtml(opts.token, m.id);
            const links = extractVfsActivationLinks(detail.text, detail.html);
            if (links[0]) return links[0];
        }
        await sleepMs(opts.pollMs);
    }
    throw new Error("mail.tm: no activation link within timeout");
}


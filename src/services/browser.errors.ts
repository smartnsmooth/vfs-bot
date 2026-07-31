import { type Vfs429Kind } from "../utils/vfsRateLimit";
/**
 * VFS redirected to page-not-found / session-expired. The bot cycle wrapper rotates IP
 * and restarts the full cycle (skipping the fleet poll gate).
 */
export class PageNotFoundRestartError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PageNotFoundRestartError";
    }
}
/** Thrown when a VFS page or API returns HTTP 403 Forbidden — caller should restart browser + rotate IP. */
export class VfsForbiddenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VfsForbiddenError";
    }
}
/** Thrown when a VFS API returns HTTP 504 Gateway Timeout — caller should restart browser + rotate IP + re-login. */
export class VfsGatewayTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VfsGatewayTimeoutError";
    }
}
/**
 * Thrown when VFS returns a 429 family rate-limit (HTTP or body code).
 * - kind "account" (4290XX) → stop the bot (User ID / account restricted)
 * - kind "ip" (4292XX / other 429) → rotate IP without relogin first; escalate on repeat
 */
export class VfsRateLimitedError extends Error {
    readonly kind: Vfs429Kind;
    readonly code: string;
    constructor(kind: Vfs429Kind, code: string, message: string) {
        super(message);
        this.name = "VfsRateLimitedError";
        this.kind = kind;
        this.code = code;
    }
    get isAccountBlock(): boolean {
        return this.kind === "account";
    }
    get isIpBlock(): boolean {
        return this.kind === "ip";
    }
}
/** Thrown when lift-api /appointment/schedule indicates the applicant is already booked. */
export class AlreadyBookedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AlreadyBookedError";
    }
}
/** Returns true when the error is Playwright's "Target closed" family of errors. */
export function isTargetClosedError(e: unknown): boolean {
    if (!(e instanceof Error))
        return false;
    return (e.message.includes("Target page, context or browser has been closed") ||
        e.message.includes("Target closed") ||
        e.message.includes("has been closed") ||
        e.name === "TargetClosedError");
}
export function throwVfsRateLimited(kind: Vfs429Kind, code: string, detail: string): never {
    throw new VfsRateLimitedError(kind, code, kind === "account"
        ? `VFS account/User ID rate-limit (${code}): ${detail}`
        : `VFS IP rate-limit (${code}): ${detail}`);
}
export function readClientSourceHeader(headers: Record<string, string>): string | undefined {
    const raw = headers["clientsource"] ??
        headers["clientSource"] ??
        headers["ClientSource"] ??
        headers["CLIENTSOURCE"];
    return raw?.trim() || undefined;
}
/** Sniff `clientsource` on any request to this host that sends the header (not only `/application`). */
export const LIFT_API_HOST_MARKER = "lift-api.vfsglobal.com";
/** Confirmed VFS lift-api login endpoint (password and OTP steps both POST here; we match on response URL + POST, not request body). */
export const VFS_LIFT_USER_LOGIN_URL = "https://lift-api.vfsglobal.com/user/login";
function normalizeLiftLoginPathname(pathname: string): string {
    const p = pathname.replace(/\/+$/, "") || "/";
    return p.toLowerCase();
}
/**
 * Match the lift-api login **response** (browser form submit / fetch often leaves `request.postData()` empty).
 * Use this in `waitForResponse` / `page.on("response")` to capture JSON for profile merge.
 */
export function responseIsLiftUserLoginPost(res: import("playwright").Response): boolean {
    const req = res.request();
    if (req.method() !== "POST")
        return false;
    let u: URL;
    try {
        u = new URL(res.url());
    }
    catch {
        return false;
    }
    if (u.hostname.toLowerCase() !== "lift-api.vfsglobal.com")
        return false;
    return normalizeLiftLoginPathname(u.pathname) === "/user/login";
}
export type PostOtpLoginCapture = {
    status: number;
    url: string;
    body: string;
    /** Set when `body` is valid JSON object (parse errors → null). */
    json: import("../types/vfsUserLogin.type.js").VfsUserLoginResponse | null;
};
/** Re-export for callers that depended on browser.service for the login JSON shape. */
export type { VfsUserLoginResponse } from "../types/vfsUserLogin.type.js";
/**
 * Standalone function injected into the page via `page.evaluate` to set Turnstile token values.
 */
export function injectTurnstileTokenInPage(token: string): void {
    const setVal = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
        const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc?.set)
            desc.set.call(el, value);
        else
            el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const gatherResponseFields = (): Array<HTMLInputElement | HTMLTextAreaElement> => {
        const out: Array<HTMLInputElement | HTMLTextAreaElement> = [];
        const seen = new Set<Element>();
        const visit = (root: Document | ShadowRoot) => {
            root.querySelectorAll<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]').forEach((e) => {
                if (!seen.has(e)) {
                    seen.add(e);
                    out.push(e);
                }
            });
            root.querySelectorAll<HTMLInputElement>('input[name="cf-turnstile-response"]').forEach((e) => {
                if (!seen.has(e)) {
                    seen.add(e);
                    out.push(e);
                }
            });
            root.querySelectorAll("*").forEach((node) => {
                if (node instanceof HTMLElement && node.shadowRoot)
                    visit(node.shadowRoot);
            });
        };
        visit(document);
        return out;
    };
    let fields = gatherResponseFields();
    if (fields.length === 0) {
        let host: HTMLElement | null = document.querySelector("form");
        if (!host) {
            const container = document.querySelector("app-cloudflare-captcha-container");
            if (container) {
                host = (container.closest("form") as HTMLElement) ?? container.parentElement ?? document.body;
            }
        }
        if (!host) {
            host = document.querySelector("[data-sitekey]")?.parentElement ?? document.body;
        }
        if (host) {
            const created = document.createElement("textarea");
            created.name = "cf-turnstile-response";
            created.style.display = "none";
            host.appendChild(created);
            fields = gatherResponseFields();
        }
    }
    for (const el of fields) {
        setVal(el, token);
    }
    document.querySelectorAll("[data-sitekey][data-callback]").forEach((node) => {
        const name = node.getAttribute("data-callback");
        if (!name)
            return;
        const fn = (window as unknown as Record<string, unknown>)[name];
        if (typeof fn === "function")
            (fn as (t: string) => void)(token);
    });
    const win = window as unknown as {
        turnstile?: {
            getResponse?: (widgetId?: string) => string;
            reset?: (widgetId?: string) => void;
        };
    };
    if (win.turnstile && typeof win.turnstile === "object") {
        win.turnstile.getResponse = () => token;
    }
    if (win.turnstile) {
        let iframe = document.querySelector('iframe[src*="turnstile"]') as HTMLIFrameElement | null;
        if (!iframe) {
            const container = document.querySelector("app-cloudflare-captcha-container");
            if (container?.shadowRoot) {
                iframe = container.shadowRoot.querySelector('iframe[src*="turnstile"]') as HTMLIFrameElement | null;
            }
        }
        if (iframe) {
            iframe.dispatchEvent(new Event("load", { bubbles: true }));
        }
    }
    const form = document.querySelector("form");
    if (form) {
        form.dispatchEvent(new Event("change", { bubbles: true }));
        form.dispatchEvent(new Event("input", { bubbles: true }));
    }
}

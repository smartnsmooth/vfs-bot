import { logger } from "../utils/logger";

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
  } catch {
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
  if (at <= 0) return "(invalid-email)";
  const local = t.slice(0, at);
  const dom = t.slice(at + 1);
  const show = local.slice(0, Math.min(2, local.length));
  return `${show}***@${dom}`;
}

function tokenMetaForLog(token: string): { tokenLen: number; tokenPrefix: string } {
  const t = token.trim();
  return { tokenLen: t.length, tokenPrefix: t.slice(0, 12) + (t.length > 12 ? "…" : "") };
}

export async function fetchMailTmToken(address: string, password: string): Promise<string> {
  const v = isMailTmVerbose();
  const url = `${MAIL_TM_API}/token`;
  logger.info(
    {
      step: "mail.tm.1_token_request",
      method: "POST",
      url,
      addressMasked: maskEmailForLog(address),
      passwordLen: password.length,
      bodyKeys: ["address", "password"],
    },
    "[mail.tm] Step 1: POST /token (password not logged)"
  );

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ address: address.trim(), password }),
  });
  const bodyText = await res.text();

  if (v) {
    logger.info(
      {
        step: "mail.tm.1_token_response_raw",
        httpStatus: res.status,
        bodyLength: bodyText.length,
        bodyPreview: bodyText.slice(0, 400),
      },
      "[mail.tm] Step 1: response body (preview)"
    );
  }

  if (!res.ok) {
    logger.error(
      {
        step: "mail.tm.1_token_failed",
        httpStatus: res.status,
        bodySnippet: bodyText.slice(0, 500),
        addressMasked: maskEmailForLog(address),
      },
      "[mail.tm] Token request failed — wrong address/password or not a mail.tm mailbox"
    );
    throw new Error(`mail.tm token failed: HTTP ${res.status}`);
  }

  let j: MailTmTokenResponse;
  try {
    j = JSON.parse(bodyText) as MailTmTokenResponse;
  } catch (e) {
    logger.error(
      { step: "mail.tm.1_token_json_parse", err: e, bodyPreview: bodyText.slice(0, 300) },
      "[mail.tm] Token response is not JSON"
    );
    throw new Error("mail.tm token: response is not JSON");
  }

  if (!j.token?.trim()) {
    logger.error(
      { step: "mail.tm.1_token_missing_field", parsedKeys: Object.keys(j) },
      "[mail.tm] JSON parsed but `token` missing or empty"
    );
    throw new Error("mail.tm token: missing token");
  }

  const token = j.token.trim();
  logger.info(
    {
      step: "mail.tm.1_token_ok",
      ...tokenMetaForLog(token),
      addressMasked: maskEmailForLog(address),
    },
    "[mail.tm] Step 1 OK: bearer token received"
  );
  return token;
}

export async function listMailTmMessages(token: string, context?: string): Promise<MailTmMessageRef[]> {
  const v = isMailTmVerbose();
  const url = `${MAIL_TM_API}/messages`;
  const ctx = context ?? "list";

  if (v) {
    logger.info(
      {
        step: "mail.tm.2_messages_request",
        context: ctx,
        method: "GET",
        url,
        ...tokenMetaForLog(token),
      },
      "[mail.tm] GET /messages"
    );
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const bodyText = await res.text();

  if (v) {
    logger.info(
      {
        step: "mail.tm.2_messages_response_raw",
        context: ctx,
        httpStatus: res.status,
        bodyLength: bodyText.length,
        bodyPreview: bodyText.slice(0, 600),
      },
      "[mail.tm] /messages response preview"
    );
  }

  if (!res.ok) {
    logger.error(
      {
        step: "mail.tm.2_messages_failed",
        context: ctx,
        httpStatus: res.status,
        bodySnippet: bodyText.slice(0, 400),
      },
      "[mail.tm] GET /messages failed (token expired?)"
    );
    throw new Error(`mail.tm messages: HTTP ${res.status}`);
  }

  let member: MailTmMessageRef[];
  try {
    member = parseMailTmMessagesJson(bodyText);
  } catch (e) {
    logger.error(
      { step: "mail.tm.2_messages_json", context: ctx, err: e, bodyPreview: bodyText.slice(0, 250) },
      "[mail.tm] /messages not JSON"
    );
    throw new Error("mail.tm messages: response is not JSON");
  }

  logger.info(
    {
      step: "mail.tm.2_messages_ok",
      context: ctx,
      messageCount: member.length,
      ids: member.map((m) => m.id).filter(Boolean),
      summaries: member.map((m) => ({
        id: m.id?.slice(0, 8),
        subject: (m.subject ?? "").slice(0, 80),
        intro: (m.intro ?? "").slice(0, 120),
        createdAt: m.createdAt,
      })),
    },
    "[mail.tm] Step 2 OK: message list parsed"
  );
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
  if (verbose) {
    logger.info({ step: "mail.tm.3_message_detail_request", url, messageId: id }, "[mail.tm] GET message detail");
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const bodyText = await res.text();

  if (!res.ok) {
    logger.warn(
      { step: "mail.tm.3_message_detail_failed", httpStatus: res.status, messageId: id, snippet: bodyText.slice(0, 200) },
      "[mail.tm] GET /messages/{id} failed"
    );
    return "";
  }

  let j: MailTmMessageDetail;
  try {
    j = JSON.parse(bodyText) as MailTmMessageDetail;
  } catch {
    logger.warn({ step: "mail.tm.3_message_detail_bad_json", messageId: id }, "[mail.tm] message detail not JSON");
    return "";
  }

  const parts: string[] = [];
  if (j.subject) parts.push(j.subject);
  if (j.intro) parts.push(j.intro);
  if (j.text) parts.push(j.text);
  if (Array.isArray(j.html)) parts.push(j.html.map(stripHtml).join("\n"));
  else if (typeof j.html === "string") parts.push(stripHtml(j.html));
  const joined = parts.join("\n");

  if (verbose) {
    logger.info(
      {
        step: "mail.tm.3_message_detail_ok",
        messageId: id,
        subjectLen: (j.subject ?? "").length,
        introLen: (j.intro ?? "").length,
        textLen: (j.text ?? "").length,
        htmlParts: Array.isArray(j.html) ? j.html.length : typeof j.html === "string" ? 1 : 0,
        joinedLen: joined.length,
        joinedPreview: joined.slice(0, 800),
      },
      "[mail.tm] Message detail merged text preview"
    );
  }

  return joined;
}

/** Pull digits from VFS / generic verification emails. */
export function extractOtpFromMailText(text: string, verbose?: boolean): string | null {
  const v = verbose ?? isMailTmVerbose();
  const t = text.replace(/\s+/g, " ");
  if (v) {
    logger.info(
      { step: "mail.tm.4_extract_input", textLen: t.length, textPreview: t.slice(0, 600) },
      "[mail.tm] extractOtp: blob for regex"
    );
  }

  const labeled = t.match(/(?:otp|code|verification|one[-\s]?time|pin)[^\d]{0,32}(\d{4,8})\b/i);
  if (labeled?.[1]) {
    if (v) logger.info({ step: "mail.tm.4_extract_match", strategy: "labeled", otpLen: labeled[1].length }, "[mail.tm] extractOtp: labeled pattern");
    return labeled[1];
  }
  if (v) logger.info({ step: "mail.tm.4_extract_no_labeled" }, "[mail.tm] extractOtp: no labeled match");

  const split6 = t.match(/\b(\d{3})[\s\-–—]\s*(\d{3})\b/);
  if (split6) {
    const merged = `${split6[1]}${split6[2]}`;
    if (v) logger.info({ step: "mail.tm.4_extract_match", strategy: "split3-3", otpLen: merged.length }, "[mail.tm] extractOtp: split 3+3");
    return merged;
  }

  const six = t.match(/\b(\d{6})\b/);
  if (six?.[1]) {
    if (v) logger.info({ step: "mail.tm.4_extract_match", strategy: "sixDigits", otpLen: 6 }, "[mail.tm] extractOtp: 6-digit");
    return six[1];
  }

  const candidates = t.match(/\b(\d{4,8})\b/g);
  if (!candidates?.length) {
    if (v) logger.info({ step: "mail.tm.4_extract_no_digits" }, "[mail.tm] extractOtp: no 4–8 digit candidates");
    return null;
  }
  for (const raw of candidates) {
    const n = parseInt(raw, 10);
    if (n >= 1900 && n <= 2099) {
      if (v) logger.info({ step: "mail.tm.4_extract_skip_year", raw }, "[mail.tm] extractOtp: skip year-like");
      continue;
    }
    if (v) logger.info({ step: "mail.tm.4_extract_match", strategy: "firstNonYear", raw }, "[mail.tm] extractOtp: first non-year candidate");
    return raw;
  }
  if (v) logger.info({ step: "mail.tm.4_extract_all_year_skipped" }, "[mail.tm] extractOtp: only year-like numbers");
  return null;
}

/**
 * Poll mail.tm for a message not in `baselineIds`, extract OTP from subject/intro/body.
 */
export async function waitForOtpFromMailTm(
  token: string,
  baselineIds: ReadonlySet<string>,
  opts: MailTmWaitOtpOptions
): Promise<string> {
  const v = isMailTmVerbose();
  const runId = `otp-${Date.now()}`;
  const started = Date.now();
  logger.info(
    {
      step: "mail.tm.poll_start",
      runId,
      baselineSize: baselineIds.size,
      baselineSample: [...baselineIds].slice(0, 5),
      timeoutMs: opts.timeoutMs,
      pollMs: opts.pollMs,
      signInEpochMs: opts.signInEpochMs,
      signInSkewMs: MAIL_TM_SIGN_IN_CLOCK_SKEW_MS,
      ...tokenMetaForLog(token),
    },
    "[mail.tm] Step 5: start OTP poll (baseline ids + optional Sign-In time filter)"
  );

  let iteration = 0;
  const deadline = Date.now() + opts.timeoutMs;

  while (Date.now() < deadline) {
    iteration += 1;
    const remainingMs = deadline - Date.now();

    let list: MailTmMessageRef[];
    try {
      list = await listMailTmMessages(token, `poll#${iteration}`);
    } catch (err) {
      logger.warn(
        { step: "mail.tm.poll_list_error", runId, iteration, remainingMs, err },
        "[mail.tm] Poll iteration: list failed, sleeping and retrying"
      );
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
          if (v) logger.info({ step: "mail.tm.poll_time_filter_skip", id: m.id }, "[mail.tm] Message has no createdAt — keeping as candidate");
          return true;
        }
        const t = Date.parse(m.createdAt);
        if (Number.isNaN(t)) return true;
        const ok = t >= cutoff;
        if (!ok) {
          logger.info(
            {
              step: "mail.tm.poll_skip_before_sign_in",
              messageId: m.id,
              messageCreatedAt: m.createdAt,
              cutoffIso: new Date(cutoff).toISOString(),
            },
            "[mail.tm] Skip message: created before Sign-In window (old OTP)"
          );
        }
        return ok;
      });
      if (candidates.length === 0 && fresh.length > 0) {
        logger.info(
          {
            step: "mail.tm.poll_all_fresh_too_old",
            runId,
            iteration,
            freshCount: fresh.length,
            signInEpochMs: signInMs,
          },
          "[mail.tm] Not-in-baseline messages exist but all predate Sign In — waiting for new VFS email"
        );
      }
    } else {
      candidates = fresh;
    }

    logger.info(
      {
        step: "mail.tm.poll_iteration",
        runId,
        iteration,
        remainingMs,
        totalInMailbox: list.length,
        notInBaselineCount: notInBaseline.length,
        freshCount: fresh.length,
        freshIds: fresh.map((m) => m.id),
        candidateCount: candidates.length,
        candidateIds: candidates.map((m) => m.id),
      },
      "[mail.tm] Poll: baseline + time filter → OTP candidates (newest-first order)"
    );

    for (let fi = 0; fi < candidates.length; fi++) {
      const m = candidates[fi]!;
      let blob = [m.subject, m.intro].filter(Boolean).join("\n");
      logger.info(
        {
          step: "mail.tm.poll_fresh_message",
          runId,
          index: fi,
          messageId: m.id,
          subject: (m.subject ?? "").slice(0, 200),
          intro: (m.intro ?? "").slice(0, 300),
          createdAt: m.createdAt,
        },
        "[mail.tm] Processing new message (list fields)"
      );

      const detail = await fetchMailTmMessageDetail(token, m.id, v);
      if (detail) blob = `${blob}\n${detail}`;

      const otp = extractOtpFromMailText(blob, v);
      if (otp) {
        logger.info(
          {
            step: "mail.tm.poll_otp_found",
            runId,
            messageId: m.id,
            otpLen: otp.length,
            otpLast2: otp.slice(-2),
            elapsedMs: Date.now() - started,
          },
          "[mail.tm] OTP extracted from mail (full OTP omitted from logs; check len/last2)"
        );
        return otp;
      }
      logger.info(
        { step: "mail.tm.poll_message_no_otp", runId, messageId: m.id },
        "[mail.tm] This message did not yield an OTP pattern — trying next"
      );
    }

    if (v && notInBaseline.length === 0) {
      logger.info({ step: "mail.tm.poll_no_fresh", runId, iteration }, "[mail.tm] No messages outside baseline this iteration");
    }

    await new Promise((r) => setTimeout(r, opts.pollMs));
  }

  logger.error(
    {
      step: "mail.tm.poll_timeout",
      runId,
      iterations: iteration,
      elapsedMs: Date.now() - started,
      baselineSize: baselineIds.size,
    },
    "[mail.tm] Timeout: no OTP extracted within window"
  );
  throw new Error(`mail.tm: no OTP within ${opts.timeoutMs}ms`);
}

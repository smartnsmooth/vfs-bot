# VFS Bot — Architecture & Long-Term Updates

## Goals

- **Fast slot detection**: Sub-second HTTP polling, multi-center, proxy rotation.
- **Instant hold**: 1–3 s from detection to hold (browser flow: hold → Turnstile → form → payment).
- **Target**: 5–10 s end-to-end from slot detection to payment page.

## Flow

1. **Login** → (OTP if required) → session cookie.
2. **HTTP polling** only: multi-center, optional proxy rotation, no browser.
3. **On slot detected** → Telegram “slot found” → **browser** starts:
   - Hold/select slot page → Turnstile CAPTCHA → pre-fill form → payment.
4. **Telegram**: slot_found, hold_success, payment_ready, errors.

## Where to Update When VFS Changes

| Change type | Where to update |
|------------|------------------|
| **API endpoints** (login, slots, hold) | `.env`: `VFS_LOGIN_ENDPOINT`, `VFS_SLOT_ENDPOINT`, `VFS_HOLD_ENDPOINT`, `VFS_OTP_ENDPOINT`, `VFS_REFRESH_ENDPOINT` |
| **Booking/hold page URL** | `.env`: `VFS_HOLD_PAGE_URL` (browser opens this for hold + CAPTCHA) |
| **Slot API response shape** | `src/services/polling.service.ts`: `SlotApiResponse` and parsing of `data.slots` / `data.data.slots` |
| **Turnstile / CAPTCHA** | `src/services/browser.service.ts`: Turnstile auto-resolves in the browser; no external solver. |
| **Form fields** (pre-fill) | `src/services/browser.service.ts`: `prefillFormIfPresent()` (applicant details come from the setup form at runtime) |
| **Anti-bot / rate limits** | `src/utils/proxy.util.ts` and `.env`: `PROXY_URL` or `PROXY_LIST`; optionally increase `POLLING_INTERVAL_MS` |
| **Session / cookies** | `src/services/session.service.ts`: how cookie is read (body vs `Set-Cookie` header); refresh logic |

## Key Files

- `src/index.ts` — Entry: dotenv, login+OTP, poll loop, Telegram + browser on slot.
- `src/config/config.ts` — All env-driven config (endpoints, centers, proxies, intervals).
- `src/services/session.service.ts` — Login, OTP submit, refresh.
- `src/services/polling.service.ts` — HTTP slot check, multi-center, proxy rotation.
- `src/services/browser.service.ts` — Hold page, Turnstile solve + inject, form pre-fill, payment (Playwright).
- `src/services/telegram.service.ts` — Alerts.
- `src/utils/proxy.util.ts` — Load and rotate proxies from env.

## Use your own browser (no Playwright window)

Set **`USE_EXISTING_BROWSER=true`** so the bot connects to Chrome you already opened. You log in to VFS in that window (Turnstile passes in a normal session); the bot reads cookies and starts polling.

1. **Start Chrome with remote debugging** (close all Chrome windows first):
   - **Windows**: Run once:  
     `"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222`  
     Or create a shortcut with that as the target.
   - **macOS**: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222`
   - **Linux**: `google-chrome --remote-debugging-port=9222`
2. In that Chrome window, go to VFS and log in as usual.
3. Run the bot: `npm run dev`. It will connect to Chrome, read cookies for the VFS domain, and start polling. No second browser window.

Optional: `BROWSER_CDP_URL=http://localhost:9222` (default) if you use another port.

## Env Summary

- **Required** (unless USE_EXISTING_BROWSER): `VFS_USERNAME`, `VFS_PASSWORD`; if Telegram on: `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`
- **Optional**: `USE_EXISTING_BROWSER`, `BROWSER_CDP_URL`, `VFS_OTP`, `POLLING_INTERVAL_MS`, `HOLD_DEADLINE_MS`, `VFS_CENTER_IDS`, `PROXY_URL` / `PROXY_LIST`, `VFS_*` endpoints, `BROWSER_HEADLESS`, `LOG_LEVEL`

## Turnstile

Turnstile auto-resolves in the browser. The bot waits up to 10 seconds for the Cloudflare challenge to produce a token, then proceeds with login/OTP submission.

## Proxies

- Single: `PROXY_URL=http://user:pass@host:port`
- Multiple: `PROXY_LIST=[{"host":"...","port":80,"username":"...","password":"..."}]`
- Polling uses round-robin; browser uses no proxy by default (configure in Playwright if needed).

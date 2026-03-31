import dotenv from "dotenv";
import { request } from "undici";
import { TurnstileService } from "../src/services/turnstile.service";

// Load .env for CAPMONSTER_API_KEY / config defaults (match app behavior).
dotenv.config({ override: false });

async function main(): Promise<void> {
  const pageUrl = "https://2captcha.com/demo/cloudflare-turnstile";
  const res = await request(pageUrl, { method: "GET" });
  const html = await res.body.text();

  const m = html.match(/data-sitekey="([^"]+)"/i);
  if (!m) throw new Error("Could not find data-sitekey in HTML");

  const sitekey = m[1]!;
  console.log("sitekey:", sitekey);

  const solver = new TurnstileService();
  const token = await solver.solve(pageUrl, sitekey, {});
  console.log("tokenLen:", token.length);
  console.log("tokenPrefix:", token.slice(0, 80));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


import TelegramBot from "node-telegram-bot-api";
import { config, getCurrentInstanceId } from "../config/config";
let bot: TelegramBot | null = null;
function getBot(): TelegramBot | null {
  if (!config.telegramEnabled) return null;
  if (!bot) bot = new TelegramBot(config.telegramToken);
  return bot;
}

function resolveBotInstanceNumber(): number {
  const fromGetter = getCurrentInstanceId();
  if (fromGetter != null && Number.isFinite(fromGetter)) return fromGetter;
  const fromEnv = parseInt(process.env.BOT_INSTANCE_ID ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 1;
}

/** Local time HH:MM:SS + bot N for every outbound Telegram line. */
function formatTelegramPrefix(): string {
  const n = resolveBotInstanceNumber();
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `bot ${n} · ${hh}:${mm}:${ss}`;
}

export type AlertType = "slot_found" | "no_slot_found" | "hold_success" | "payment_ready" | "error" | "info";

export class TelegramService {
  async notify(message: string, opts?: { raw?: boolean }): Promise<void> {
    const client = getBot();
    if (!client) return;
    const text = opts?.raw ? message : `${formatTelegramPrefix()}\n${message}`;
    try {
      await client.sendMessage(config.telegramChatId, text);
    } catch (err) {
          }
  }

  async alert(type: AlertType, detail: string, extra?: Record<string, unknown>): Promise<void> {
    const client = getBot();
    if (!client) return;
    const prefix = type === "error" ? "❌" : type === "slot_found" ? "🔔" : type === "no_slot_found" ? "❌" : type === "hold_success" ? "✅" : type === "payment_ready" ? "💳" : "ℹ️";
    const text = extra ? `${prefix} ${detail}\n${JSON.stringify(extra)}` : `${prefix} ${detail}`;
    await this.notify(text);
  }
}

import TelegramBot from "node-telegram-bot-api";
import { config } from "../config/config";
import { logger } from "../utils/logger";

let bot: TelegramBot | null = null;
function getBot(): TelegramBot | null {
  if (!config.telegramEnabled) return null;
  if (!bot) bot = new TelegramBot(config.telegramToken);
  return bot;
}

export type AlertType = "slot_found" | "hold_success" | "payment_ready" | "error" | "info";

export class TelegramService {
  async notify(message: string): Promise<void> {
    const client = getBot();
    if (!client) return;
    try {
      await client.sendMessage(config.telegramChatId, message);
    } catch (err) {
      logger.warn({ err }, "Telegram send failed");
    }
  }

  async alert(type: AlertType, detail: string, extra?: Record<string, unknown>): Promise<void> {
    const client = getBot();
    if (!client) return;
    const prefix = type === "error" ? "❌" : type === "slot_found" ? "🔔" : type === "hold_success" ? "✅" : type === "payment_ready" ? "💳" : "ℹ️";
    const text = extra ? `${prefix} ${detail}\n${JSON.stringify(extra)}` : `${prefix} ${detail}`;
    await this.notify(text);
  }
}

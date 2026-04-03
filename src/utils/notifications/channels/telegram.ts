import logger from "@app/logger";
import type { NotificationEvent, TelegramChannelConfig } from "../types";

export async function dispatchTelegram(event: NotificationEvent, config: TelegramChannelConfig): Promise<void> {
    if (!config.enabled || !config.botToken || !config.chatId) {
        return;
    }

    try {
        const { createApi, sendMessage } = await import("@app/telegram-bot/lib/api");
        const api = createApi(config.botToken);

        const text = event.title ? `*${event.title}*\n${event.message}` : event.message;
        const chatId = Number(config.chatId);

        await sendMessage(api, chatId, text, "MarkdownV2");
    } catch (err) {
        logger.warn({ err, app: event.app }, "Telegram notification dispatch failed");
    }
}

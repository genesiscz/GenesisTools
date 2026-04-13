import logger from "@app/logger";
import type { NotificationEvent, TelegramChannelConfig } from "../types";

export async function dispatchTelegram(event: NotificationEvent, config: TelegramChannelConfig): Promise<void> {
    if (!config.enabled || !config.botToken || !config.chatId) {
        return;
    }

    try {
        const { createApi, sendMessage } = await import("@app/telegram-bot/lib/api");
        const { escapeMarkdownV2 } = await import("@app/telegram-bot/lib/formatting");
        const api = createApi(config.botToken);

        const title = event.title ? `*${escapeMarkdownV2(event.title)}*` : "";
        const body = escapeMarkdownV2(event.message);
        const text = title ? `${title}\n${body}` : body;
        const chatId = Number(config.chatId);

        if (Number.isNaN(chatId)) {
            logger.warn({ chatId: config.chatId, app: event.app }, "Invalid Telegram chatId");
            return;
        }

        await sendMessage(api, chatId, text, "MarkdownV2");
    } catch (err) {
        logger.warn({ err, app: event.app }, "Telegram notification dispatch failed");
    }
}

import { logger } from "@genesiscz/utils/logger";
import type { NotificationEvent, TelegramChannelConfig } from "../types";

/** True when Telegram accepted the message (or there was nothing to send). Never throws. */
export async function dispatchTelegram(event: NotificationEvent, config: TelegramChannelConfig): Promise<boolean> {
    if (!config.enabled || !config.botToken || !config.chatId) {
        return true;
    }

    try {
        const { createApi, sendMessage } = await import("@genesiscz/utils/telegram-bot/lib/api");
        const { formatTelegramNotification } = await import("@genesiscz/utils/telegram-bot/lib/formatting");
        const api = createApi(config.botToken);

        const text = formatTelegramNotification({ title: event.title, message: event.message });
        const chatId = Number(config.chatId);

        if (Number.isNaN(chatId)) {
            logger.warn({ chatId: config.chatId, app: event.app }, "Invalid Telegram chatId");

            return false;
        }

        await sendMessage(api, chatId, text, "MarkdownV2");

        return true;
    } catch (err) {
        logger.warn({ err, app: event.app }, "Telegram notification dispatch failed");

        return false;
    }
}

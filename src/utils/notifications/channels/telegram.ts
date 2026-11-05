import { logger } from "@genesiscz/utils/logger";
import type { ChannelDefinition, NotificationEvent, TelegramChannelConfig } from "../types";

/** True when Telegram accepted the message (or there was nothing to send). Never throws. */
export async function dispatchTelegram(event: NotificationEvent, config: TelegramChannelConfig): Promise<boolean> {
    if (!config.enabled || !config.botToken || !config.chatId) {
        return true;
    }

    try {
        const { createApi } = await import("@genesiscz/utils/telegram-bot/lib/api");
        const { formatTelegramNotification } = await import("@genesiscz/utils/telegram-bot/lib/formatting");
        const { postTelegramMessage } = await import("@genesiscz/utils/telegram-bot/lib/messages");
        const api = createApi(config.botToken);

        const text = formatTelegramNotification({ title: event.title, message: event.message });
        const chatId = Number(config.chatId);

        if (Number.isNaN(chatId)) {
            logger.warn({ chatId: config.chatId, app: event.app }, "Invalid Telegram chatId");

            return false;
        }

        // With a stable id the message is remembered, so a retraction in another process can edit it.
        await postTelegramMessage({
            api,
            chatId,
            text,
            parseMode: "MarkdownV2",
            ...(event.id ? { noticeId: event.id } : {}),
        });

        return true;
    } catch (err) {
        logger.warn({ err, app: event.app }, "Telegram notification dispatch failed");

        return false;
    }
}

/** The line a retracted message gets under its text, in place of its buttons. */
export const TELEGRAM_CLOSED_ELSEWHERE = "Closed in another place (the hub, the chat or the phone).";

export const telegramChannel: ChannelDefinition<"telegram"> = {
    name: "telegram",
    label: "Telegram",
    defaults: { enabled: false },
    fields: { enabled: "boolean", botToken: "string", chatId: "string" },
    secretKeys: ["botToken"],
    unusable: (config) => (config.botToken && config.chatId ? undefined : "no bot token or chat id"),
    describe: (config) => `chat ${config.chatId ?? "?"} · token ${config.botToken ? "set" : "missing"}`,
    post: async (event, config) => ({ ok: await dispatchTelegram(event, config) }),
    async retract(noticeId, config) {
        try {
            const { createApi } = await import("@genesiscz/utils/telegram-bot/lib/api");
            const { loadTelegramBotConfig } = await import("@genesiscz/utils/telegram-bot/lib/config");
            const { recallMessage, retractTelegramNotice } = await import("@genesiscz/utils/telegram-bot/lib/messages");

            if (!(await recallMessage(noticeId))) {
                return false;
            }

            // A notice may have gone out through the bot of the decisions purpose while this channel names none.
            const bot = config.botToken ? null : await loadTelegramBotConfig();
            const token = config.botToken ?? bot?.botToken;

            if (!token) {
                return false;
            }

            return await retractTelegramNotice({
                api: createApi(token, bot?.apiRoot),
                noticeId,
                edit: (original) => `${original ?? noticeId}\n\n${TELEGRAM_CLOSED_ELSEWHERE}`,
            });
        } catch (err) {
            logger.warn({ err, noticeId }, "could not retract a Telegram message");
            return false;
        }
    },
};

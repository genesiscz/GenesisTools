import { logger } from "@genesiscz/utils/logger";
import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";
import type { ChannelDefinition, NotificationEvent, TelegramChannelConfig } from "../types";
import { isLoopbackUrl } from "./webhook";

const TELEGRAM_SURFACE = "The Telegram notification channel";

/** A test may point the bot at an API root it serves on loopback; any other root is the real Telegram. */
function refuseRealTelegramInTest(apiRoot: string | undefined, remedy: string): void {
    if (!apiRoot || !isLoopbackUrl(apiRoot)) {
        refuseHostEffectInTest(TELEGRAM_SURFACE, remedy);
    }
}

/**
 * True when Telegram accepted the message (or there was nothing to send). Never throws, except that it rejects in a
 * test process (and a child a test spawns) when it would post to the real Telegram: a message in a real chat cannot
 * be taken back.
 */
export async function dispatchTelegram(event: NotificationEvent, config: TelegramChannelConfig): Promise<boolean> {
    if (!config.enabled || !config.botToken || !config.chatId) {
        return true;
    }

    refuseRealTelegramInTest(config.apiRoot, "Assert the event instead of posting it to a real chat.");

    try {
        const { createApi } = await import("@genesiscz/utils/telegram-bot/lib/api");
        const { formatTelegramNotification } = await import("@genesiscz/utils/telegram-bot/lib/formatting");
        const { postTelegramMessage } = await import("@genesiscz/utils/telegram-bot/lib/messages");
        const api = createApi(config.botToken, config.apiRoot);

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

            const apiRoot = config.apiRoot ?? bot?.apiRoot;
            // Caught below like any other failure: a retraction never throws.
            refuseRealTelegramInTest(apiRoot, "Assert the retraction instead of editing a real message.");

            return await retractTelegramNotice({
                api: createApi(token, apiRoot),
                noticeId,
                edit: (original) => `${original ?? noticeId}\n\n${TELEGRAM_CLOSED_ELSEWHERE}`,
            });
        } catch (err) {
            logger.warn({ err, noticeId }, "could not retract a Telegram message");
            return false;
        }
    },
};

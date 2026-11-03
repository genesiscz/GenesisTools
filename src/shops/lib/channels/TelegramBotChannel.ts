import type { DispatchResult, NotificationChannel, NotificationPayload } from "@app/shops/lib/channels/types";
import { TelegramBotClient } from "@app/shops/lib/telegram-bot-client";
import { env as appEnv } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { loadTelegramBotConfigSync, resolveTelegramTarget } from "@genesiscz/utils/telegram-bot/lib/config";
import type { TelegramBotConfig } from "@genesiscz/utils/telegram-bot/lib/types";

const log = logger.child({ component: "TelegramBotChannel" });

interface SendableClient {
    sendMessage(args: {
        chatId: string | number;
        text: string;
        parseMode?: "Markdown" | "MarkdownV2" | "HTML";
        disableWebPagePreview?: boolean;
    }): Promise<{ ok: true; message_id: number }>;
}

export interface TelegramBotChannelConfig {
    chatId: string | number;
    client: SendableClient;
}

function escapeMd(s: string): string {
    return s.replace(/[*_`[\]]/g, "\\$&");
}

export class TelegramBotChannel implements NotificationChannel {
    readonly name = "telegram" as const;
    private readonly chatId: string | number;
    private readonly client: SendableClient;

    constructor(config: TelegramBotChannelConfig) {
        this.chatId = config.chatId;
        this.client = config.client;
    }

    /**
     * `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` when the env names both. Else the one bot config
     * (`tools telegram-bot configure`) and its notifications chat, with the env's chat when only that is set.
     */
    static fromEnv(
        processEnv: Record<string, string | undefined> = appEnv.getProcessEnv(),
        bot: TelegramBotConfig | null = loadTelegramBotConfigSync()
    ): TelegramBotChannel | null {
        const target = resolveTelegramTarget({
            purpose: "notifications",
            own: { botToken: processEnv.TELEGRAM_BOT_TOKEN, chatId: processEnv.TELEGRAM_CHAT_ID },
            bot,
        });
        if (!target) {
            return null;
        }

        return new TelegramBotChannel({
            chatId: target.chatId,
            client: new TelegramBotClient({ token: target.botToken }),
        });
    }

    available(): boolean {
        return true;
    }

    async dispatch(payload: NotificationPayload): Promise<DispatchResult> {
        const url = payload.buyUrl ?? `http://localhost:3073${payload.detailUrl}`;
        const text = [`*${escapeMd(payload.title)}*`, "", payload.body, "", url].join("\n");
        try {
            await this.client.sendMessage({
                chatId: this.chatId,
                text,
                parseMode: "Markdown",
                disableWebPagePreview: false,
            });
            log.debug({ id: payload.notification.id, chatId: this.chatId }, "telegram notification delivered");
            return { channel: "telegram", delivered: true };
        } catch (err) {
            return {
                channel: "telegram",
                delivered: false,
                error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            };
        }
    }
}

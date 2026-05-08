import logger from "@app/logger";
import { TelegramBotClient } from "../telegram-bot-client";
import type { DispatchResult, NotificationChannel, NotificationPayload } from "./types";

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
    return s.replace(/[*_`\[\]]/g, "\\$&");
}

export class TelegramBotChannel implements NotificationChannel {
    readonly name = "telegram" as const;
    private readonly chatId: string | number;
    private readonly client: SendableClient;

    constructor(config: TelegramBotChannelConfig) {
        this.chatId = config.chatId;
        this.client = config.client;
    }

    static fromEnv(env: Record<string, string | undefined> = process.env): TelegramBotChannel | null {
        const chatId = env.TELEGRAM_CHAT_ID;
        const client = TelegramBotClient.fromEnv(env);
        if (!chatId || !client) {
            return null;
        }

        return new TelegramBotChannel({ chatId, client });
    }

    available(): boolean {
        return true;
    }

    async dispatch(payload: NotificationPayload): Promise<DispatchResult> {
        const url = payload.buyUrl ?? `http://localhost:3072${payload.detailUrl}`;
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

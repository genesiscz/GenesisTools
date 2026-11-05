import type { DispatchResult, NotificationChannel, NotificationPayload } from "@app/shops/lib/channels/types";
import { env as appEnv } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { CHANNELS, type ChannelReceipt, type NotificationEvent } from "@genesiscz/utils/notifications";
import { loadTelegramBotConfigSync, resolveTelegramTarget } from "@genesiscz/utils/telegram-bot/lib/config";
import type { TelegramBotConfig } from "@genesiscz/utils/telegram-bot/lib/types";

const log = logger.child({ component: "TelegramBotChannel" });

export interface TelegramBotChannelConfig {
    chatId: string | number;
    botToken: string;
    /** Sends through the shared Telegram channel of the notification table by default. Tests pass a spy. */
    post?: (event: NotificationEvent, target: { botToken: string; chatId: string }) => Promise<ChannelReceipt>;
}

export class TelegramBotChannel implements NotificationChannel {
    readonly name = "telegram" as const;
    private readonly chatId: string;
    private readonly botToken: string;
    private readonly post: NonNullable<TelegramBotChannelConfig["post"]>;

    constructor(config: TelegramBotChannelConfig) {
        this.chatId = String(config.chatId);
        this.botToken = config.botToken;
        this.post = config.post ?? ((event, target) => CHANNELS.telegram.post(event, { enabled: true, ...target }));
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
            botToken: target.botToken,
        });
    }

    available(): boolean {
        return true;
    }

    async dispatch(payload: NotificationPayload): Promise<DispatchResult> {
        const url = payload.buyUrl ?? `http://localhost:3073${payload.detailUrl}`;
        const receipt = await this.post(
            { app: "shops", title: payload.title, message: `${payload.body}\n\n${url}` },
            { botToken: this.botToken, chatId: this.chatId }
        );

        if (!receipt.ok) {
            return {
                channel: "telegram",
                delivered: false,
                error: receipt.detail ?? "the Telegram channel did not accept the message",
            };
        }

        log.debug({ id: payload.notification.id, chatId: this.chatId }, "telegram notification delivered");
        return { channel: "telegram", delivered: true };
    }
}

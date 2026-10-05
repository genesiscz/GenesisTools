import type { SecureRef } from "@genesiscz/utils/security/SecureRef";

export type { Chat as TelegramChat, Message as TelegramMessage, User as TelegramUser } from "grammy/types";

export type ParseMode = "MarkdownV2" | "HTML";

export interface TelegramWebhookConfig {
    /** Public https URL Telegram delivers updates to. Defaults to the tunnel route in `webhook/settings.ts`. */
    url?: string;
    /** Vault pointer to the secret Telegram echoes in `X-Telegram-Bot-Api-Secret-Token`. Never the value. */
    secret?: SecureRef;
}

export interface TelegramBotConfig {
    botToken: string;
    chatId: number;
    botUsername?: string;
    configuredAt: string;
    /** Base URL of the Bot API server. Defaults to Telegram's own; set it for a self-hosted server. */
    apiRoot?: string;
    webhook?: TelegramWebhookConfig;
}

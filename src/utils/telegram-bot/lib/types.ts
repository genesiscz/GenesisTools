import type { SecureRef } from "@genesiscz/utils/security/SecureRef";

export type { Chat as TelegramChat, Message as TelegramMessage, User as TelegramUser } from "grammy/types";

export type ParseMode = "MarkdownV2" | "HTML";

export interface TelegramWebhookConfig {
    /** Public https URL Telegram delivers updates to; required for webhook mode unless supplied with --url. */
    url?: string;
    /** Vault pointer to the secret Telegram echoes in `X-Telegram-Bot-Api-Secret-Token`. Never the value. */
    secret?: SecureRef;
}

/**
 * What a chat is used for. The axis is the bot's purpose: commands (the chat the bot takes `/run` and button presses
 * from), notifications (the notify channel and shops alerts) and decisions (❓ DECISION posts with letter buttons).
 */
export type TelegramChatPurpose = "commands" | "notifications" | "decisions";

/** One chat id per purpose. Only `commands` is required; a purpose without its own chat uses the commands chat. */
export interface TelegramChats {
    commands: number;
    notifications?: number;
    decisions?: number;
}

/** A project that opted in to decision posts. Telegram stores what it is sent, so the decision text is its own switch. */
export interface TelegramDecisionProject {
    /** true: the prompt and the option texts are posted. false: only the label, the project and the letter buttons. */
    text: boolean;
}

export interface TelegramDecisionsConfig {
    /** Keyed by the decision's `project` (the repository folder name). A project that is not listed is never posted. */
    projects: Record<string, TelegramDecisionProject>;
}

/** The one Telegram bot config (`~/.genesis-tools/telegram-bot/config.json`), version 2: chats nested by purpose. */
export interface TelegramBotConfig {
    botToken: string;
    chats: TelegramChats;
    botUsername?: string;
    configuredAt: string;
    /** Base URL of the Bot API server. Defaults to Telegram's own; set it for a self-hosted server. */
    apiRoot?: string;
    webhook?: TelegramWebhookConfig;
    decisions?: TelegramDecisionsConfig;
}

/** Version 1, written before 2026-11-03: one flat `chatId` for everything. `migrateTelegramBotConfig` reads it. */
export interface TelegramBotConfigV1 extends Omit<TelegramBotConfig, "chats" | "decisions"> {
    chatId: number;
}

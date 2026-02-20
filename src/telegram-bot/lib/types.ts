export type { Chat as TelegramChat, Message as TelegramMessage, User as TelegramUser } from "grammy/types";

export type ParseMode = "MarkdownV2" | "HTML";

export interface TelegramBotConfig {
    botToken: string;
    chatId: number;
    botUsername?: string;
    configuredAt: string;
}

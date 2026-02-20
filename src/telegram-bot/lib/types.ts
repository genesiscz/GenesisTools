export type { User as TelegramUser, Chat as TelegramChat, Message as TelegramMessage } from "grammy/types";

export type ParseMode = "MarkdownV2" | "HTML";

export interface TelegramBotConfig {
  botToken: string;
  chatId: number;
  botUsername?: string;
  configuredAt: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  first_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export type ParseMode = "MarkdownV2" | "HTML";

export interface SendMessageParams {
  chat_id: number | string;
  text: string;
  parse_mode?: ParseMode;
  disable_web_page_preview?: boolean;
}

export interface TelegramBotConfig {
  botToken: string;
  chatId: number;
  botUsername?: string;
  configuredAt: string;
}

export interface BotCommand {
  command: string;
  args: string;
  chatId: number;
  messageId: number;
  fromUser?: TelegramUser;
}

export type CommandHandler = (cmd: BotCommand) => Promise<{ text: string; parse_mode?: ParseMode }>;

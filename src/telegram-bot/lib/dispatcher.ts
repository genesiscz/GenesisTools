import type { TelegramApi } from "./api";
import type { BotCommand, CommandHandler, TelegramMessage } from "./types";
import { checkRateLimit } from "./security";
import { truncateForTelegram } from "./formatting";
import logger from "@app/logger";

const handlers = new Map<string, CommandHandler>();

export function registerCommand(name: string, handler: CommandHandler): void {
  handlers.set(name.toLowerCase(), handler);
}

export function getRegisteredCommands(): string[] {
  return [...handlers.keys()];
}

export async function dispatch(api: TelegramApi, message: TelegramMessage, authorizedChatId: number): Promise<void> {
  if (message.chat.id !== authorizedChatId) return;
  if (!message.text?.startsWith("/")) return;

  const parts = message.text.slice(1).split(/\s+/);
  const commandName = parts[0].toLowerCase().replace(/@\w+$/, "");
  const args = parts.slice(1).join(" ");

  const handler = handlers.get(commandName);
  if (!handler) {
    await api.sendMessage({ chat_id: message.chat.id, text: `Unknown command: /${commandName}\nType /help for available commands.` });
    return;
  }

  const rateCheck = checkRateLimit(commandName);
  if (!rateCheck.allowed) {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: `Rate limited. Try again in ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)}s.`,
    });
    return;
  }

  const cmd: BotCommand = {
    command: commandName,
    args,
    chatId: message.chat.id,
    messageId: message.message_id,
    fromUser: message.from,
  };

  try {
    const response = await handler(cmd);
    await api.sendMessage({
      chat_id: message.chat.id,
      text: truncateForTelegram(response.text),
      parse_mode: response.parse_mode,
    });
  } catch (err) {
    logger.error({ err, command: commandName }, "Command handler failed");
    await api.sendMessage({ chat_id: message.chat.id, text: `Error: ${(err as Error).message}` });
  }
}

import { Bot, type CommandContext, type Context } from "grammy";
import { checkRateLimit } from "./security";
import { registerStatusCommand } from "./handlers/status";
import { registerTasksCommand } from "./handlers/tasks";
import { registerRunCommand } from "./handlers/run";
import { registerToolsCommand } from "./handlers/tools";
import { registerHelpCommand } from "./handlers/help";
import logger from "@app/logger";

export function createBot(token: string, authorizedChatId: number): Bot {
  const bot = new Bot(token);

  bot.use(async (ctx, next) => {
    if (ctx.chat?.id !== authorizedChatId) return;
    await next();
  });

  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (!text?.startsWith("/")) { await next(); return; }

    const command = text.slice(1).split(/\s+/)[0].toLowerCase().replace(/@\w+$/, "");
    const rateCheck = checkRateLimit(command);
    if (!rateCheck.allowed) {
      await ctx.reply(`Rate limited. Try again in ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)}s.`);
      return;
    }
    await next();
  });

  bot.catch((err) => {
    logger.error({ err: err.error }, "Bot error");
  });

  registerStatusCommand(bot);
  registerTasksCommand(bot);
  registerRunCommand(bot);
  registerToolsCommand(bot);
  registerHelpCommand(bot);

  return bot;
}

export type BotCommandContext = CommandContext<Context>;

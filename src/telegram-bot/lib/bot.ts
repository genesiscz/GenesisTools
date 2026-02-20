import * as p from "@clack/prompts";
import { Bot, type CommandContext, type Context } from "grammy";
import { registerHelpCommand } from "./handlers/help";
import { registerRunCommand } from "./handlers/run";
import { registerStatusCommand } from "./handlers/status";
import { registerTasksCommand } from "./handlers/tasks";
import { registerToolsCommand } from "./handlers/tools";

export function createBot(token: string, authorizedChatId: number): Bot {
    const bot = new Bot(token);

    bot.use(async (ctx, next) => {
        const chatId = ctx.chat?.id;
        const text = ctx.message?.text;
        p.log.info(`Incoming: chat=${chatId} text="${text ?? "(none)"}"`);
        if (chatId !== authorizedChatId) {
            p.log.warn(`Rejected: chat ${chatId} !== authorized ${authorizedChatId}`);
            return;
        }
        await next();
    });

    bot.use(async (ctx, next) => {
        const text = ctx.message?.text;
        if (!text?.startsWith("/")) {
            await next();
            return;
        }

        const command = text.slice(1).split(/\s+/)[0].toLowerCase().replace(/@\w+$/, "");
        p.log.step(`Command: /${command}`);
        await next();
    });

    bot.catch((err) => {
        p.log.error(`Bot error: ${err.error instanceof Error ? err.error.message : String(err.error)}`);
    });

    registerStatusCommand(bot);
    registerTasksCommand(bot);
    registerRunCommand(bot);
    registerToolsCommand(bot);
    registerHelpCommand(bot);

    return bot;
}

export type BotCommandContext = CommandContext<Context>;

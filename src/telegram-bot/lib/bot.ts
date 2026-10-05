import * as p from "@clack/prompts";
import { logger } from "@genesiscz/utils/logger";
import { Bot, BotError, type CommandContext, type Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { registerHelpCommand } from "./handlers/help";
import { registerRunCommand } from "./handlers/run";
import { registerStatusCommand } from "./handlers/status";
import { registerTasksCommand } from "./handlers/tasks";
import { registerToolsCommand } from "./handlers/tools";
import { createRateLimiter, type RateLimiter } from "./security";

export interface CreateBotOptions {
    /** Bot API base URL; Telegram's own when omitted. */
    apiRoot?: string;
    /** Skips the `getMe` call that `bot.init()` would make. */
    botInfo?: UserFromGetMe;
    rateLimiter?: RateLimiter;
}

export function createBot(token: string, authorizedChatId: number, options: CreateBotOptions = {}): Bot {
    const bot = new Bot(token, { botInfo: options.botInfo, client: { apiRoot: options.apiRoot } });
    const rateLimiter = options.rateLimiter ?? createRateLimiter();

    bot.use(async (ctx, next) => {
        const chatId = ctx.chat?.id;
        if (chatId !== authorizedChatId) {
            logger.debug(
                { chatId, updateId: ctx.update.update_id },
                "telegram-bot: dropped an update from a chat that is not allowed"
            );
            return;
        }

        p.log.info(`Incoming: chat=${chatId} text="${ctx.message?.text ?? "(none)"}"`);
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

        const verdict = rateLimiter.check(command);
        if (!verdict.allowed) {
            const seconds = Math.ceil((verdict.retryAfterMs ?? 0) / 1000);
            p.log.warn(`Rate limited: /${command}, retry in ${seconds}s`);
            await ctx.reply(`Too many requests. Try again in ${seconds}s.`);
            return;
        }

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

/**
 * The one entry point for an update. Polling reaches it through grammY's own loop, which calls
 * `bot.handleUpdate` for every update it fetches, and the webhook receiver calls this function. Both
 * therefore run the same middleware: the chat allowlist, the rate limit, then the command handlers.
 */
export async function handleUpdate(bot: Bot, update: Update): Promise<void> {
    try {
        await bot.handleUpdate(update);
    } catch (err) {
        if (err instanceof BotError) {
            await bot.errorHandler(err);
            return;
        }

        throw err;
    }
}

export type BotCommandContext = CommandContext<Context>;

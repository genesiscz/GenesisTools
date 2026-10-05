import type { TelegramBotConfig } from "@genesiscz/utils/telegram-bot/lib/types";
import { Api } from "grammy";
import { resolveApiRoot } from "./settings";

export function createTelegramApi(config: Pick<TelegramBotConfig, "botToken" | "apiRoot">): Api {
    return new Api(config.botToken, { apiRoot: resolveApiRoot(config.apiRoot) });
}

const MASK = "***";

/**
 * Text that names the bot token with the token hidden. The Bot API puts the token in the request path
 * (`/bot<token>/<method>`), so a failed request can carry it into an error message.
 */
export function maskToken(text: string, token: string): string {
    const withoutToken = token ? text.split(token).join(MASK) : text;

    return withoutToken.replace(/\bbot\d+:[A-Za-z0-9_-]+/g, `bot${MASK}`).replace(/\b\d{5,}:[A-Za-z0-9_-]{30,}/g, MASK);
}

export function describeApiError(err: unknown, token: string): string {
    return maskToken(err instanceof Error ? err.message : String(err), token);
}

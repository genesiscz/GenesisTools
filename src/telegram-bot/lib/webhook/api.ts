import { type Api, createApi } from "@genesiscz/utils/telegram-bot/lib/api";
import type { TelegramBotConfig } from "@genesiscz/utils/telegram-bot/lib/types";
import { resolveApiRoot } from "./settings";

/**
 * The bot's short-call client: the shared `createApi` (its request timeout), with a bad `apiRoot` reported as a
 * webhook settings error.
 */
export function createTelegramApi(config: Pick<TelegramBotConfig, "botToken" | "apiRoot">): Api {
    return createApi(config.botToken, resolveApiRoot(config.apiRoot));
}

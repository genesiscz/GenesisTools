import { Api } from "grammy";
import type { ParseMode } from "./types";

/** `apiRoot`: a self-hosted Bot API server (the bot config's `apiRoot`); Telegram's own when omitted. */
export function createApi(botToken: string, apiRoot?: string) {
    return apiRoot ? new Api(botToken, { apiRoot }) : new Api(botToken);
}

export async function sendMessage(api: Api, chatId: number, text: string, parseMode?: ParseMode) {
    return api.sendMessage(chatId, text, {
        parse_mode: parseMode,
    });
}

export type { Api };

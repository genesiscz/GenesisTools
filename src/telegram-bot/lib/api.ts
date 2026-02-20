import { Api } from "grammy";
import type { ParseMode } from "./types";

export function createApi(botToken: string) {
    return new Api(botToken);
}

export async function sendMessage(api: Api, chatId: number, text: string, parseMode?: ParseMode) {
    return api.sendMessage(chatId, text, {
        parse_mode: parseMode,
    });
}

export type { Api };

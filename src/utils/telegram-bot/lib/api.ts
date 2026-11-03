import { Api } from "grammy";
import type { ParseMode } from "./types";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class TelegramApiRootError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TelegramApiRootError";
    }
}

/**
 * A custom Bot API root, checked: every request URL carries the bot token, so the root is https, or plain http on a
 * loopback address only. Telegram's own server when unset; a trailing slash is dropped.
 */
export function validateTelegramApiRoot(apiRoot: string | undefined): string | undefined {
    if (!apiRoot) {
        return undefined;
    }

    let parsed: URL;

    try {
        parsed = new URL(apiRoot);
    } catch {
        throw new TelegramApiRootError("apiRoot in the telegram-bot config is not a valid URL.");
    }

    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))) {
        throw new TelegramApiRootError("apiRoot must use https, or http on a loopback address.");
    }

    return apiRoot.replace(/\/+$/, "");
}

/** `apiRoot`: a self-hosted Bot API server (the bot config's `apiRoot`), validated; Telegram's own when omitted. */
export function createApi(botToken: string, apiRoot?: string) {
    const root = validateTelegramApiRoot(apiRoot);
    return root ? new Api(botToken, { apiRoot: root }) : new Api(botToken);
}

export async function sendMessage(api: Api, chatId: number, text: string, parseMode?: ParseMode) {
    return api.sendMessage(chatId, text, {
        parse_mode: parseMode,
    });
}

export type { Api };

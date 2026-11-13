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

/**
 * How long one call of a `createApi` client may wait for Telegram. grammy's default is 500 s, and its timer and the
 * open request keep the process alive: a decision answer's best-effort `editMessageText` retraction that Telegram did
 * not answer held `tools hub widget call` open after its answer (2026-11-05, Telegram gave 502 and 504 that
 * afternoon), so the widget killed the call at 120 s and said the delivered decisions were not sent. Every caller
 * makes short calls (a message, a webhook setting, a long poll shorter than this bound), which Telegram answers in
 * well under a second; the polling bot does not use this.
 */
export const TELEGRAM_REQUEST_TIMEOUT_SECONDS = 10;

/** `apiRoot`: a self-hosted Bot API server (the bot config's `apiRoot`), validated; Telegram's own when omitted. */
export function createApi(botToken: string, apiRoot?: string) {
    const root = validateTelegramApiRoot(apiRoot);
    return new Api(botToken, { timeoutSeconds: TELEGRAM_REQUEST_TIMEOUT_SECONDS, ...(root ? { apiRoot: root } : {}) });
}

export async function sendMessage(api: Api, chatId: number, text: string, parseMode?: ParseMode) {
    return api.sendMessage(chatId, text, {
        parse_mode: parseMode,
    });
}

export type { Api };

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

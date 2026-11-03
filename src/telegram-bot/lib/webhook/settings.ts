import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { TelegramApiRootError, validateTelegramApiRoot } from "@genesiscz/utils/telegram-bot/lib/api";
import { WEB_SERVICES } from "@genesiscz/utils/ui/dashboards";

/**
 * The update kinds the bot reads: messages (commands) and button presses (`callback_query`, the decision letters).
 * Telegram remembers the last list it was given (webhook or `getUpdates`), so every path passes this one: the
 * webhook registration, the polling loop and the setup poll of `configure`. Anything else is never delivered.
 */
export const WEBHOOK_ALLOWED_UPDATES = ["message", "callback_query"] as const;

export const WEBHOOK_RECEIVER_PORT: number = WEB_SERVICES["telegram-webhook"].port;

export class WebhookSettingsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WebhookSettingsError";
    }
}

export interface WebhookSettings {
    url: string;
    hostname: string;
    /** What the receiver serves and what the tunnel rule matches. cloudflared forwards a path unchanged. */
    path: string;
    port: number;
}

export interface WebhookSettingsInput {
    url?: string;
    configuredUrl?: string;
    path?: string;
    port?: number;
}

export function resolveWebhookSettings(input: WebhookSettingsInput): WebhookSettings {
    const raw = input.url ?? input.configuredUrl;
    if (!raw) {
        throw new WebhookSettingsError(
            `No public webhook URL is set. Pass it once and it is stored: ${toolCommand("telegram-bot webhook set", "--url", "https://<your-host>/telegram-webhook")}`
        );
    }

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new WebhookSettingsError("The webhook URL is not a valid URL.");
    }

    if (parsed.protocol !== "https:") {
        throw new WebhookSettingsError("The webhook URL must use https. Telegram does not deliver to anything else.");
    }

    if (parsed.username || parsed.password) {
        throw new WebhookSettingsError("The webhook URL must not carry credentials.");
    }

    if (parsed.search || parsed.hash) {
        throw new WebhookSettingsError(
            "The webhook URL must not carry a query or a fragment. The secret travels in a header, never in the URL."
        );
    }

    if (input.path !== undefined && input.path !== parsed.pathname) {
        throw new WebhookSettingsError(
            `--path ${input.path} differs from the path of the public URL (${parsed.pathname}). The tunnel forwards the path unchanged, so both must be the same.`
        );
    }

    const port = input.port ?? WEBHOOK_RECEIVER_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new WebhookSettingsError(`Invalid port ${port}.`);
    }

    return { url: parsed.href, hostname: parsed.hostname, path: parsed.pathname, port };
}

/**
 * Telegram's own server when unset. A custom root carries the bot token, so plain http is for loopback only. The
 * rule is the shared `validateTelegramApiRoot`, so the bot and the decision posts refuse the same roots.
 */
export function resolveApiRoot(apiRoot: string | undefined): string | undefined {
    try {
        return validateTelegramApiRoot(apiRoot);
    } catch (err) {
        if (err instanceof TelegramApiRootError) {
            throw new WebhookSettingsError(err.message);
        }

        throw err;
    }
}

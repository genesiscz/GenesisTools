import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { WEB_SERVICES } from "@genesiscz/utils/ui/dashboards";

/** The handlers read nothing but messages (commands). Anything else Telegram could send is never delivered. */
export const WEBHOOK_ALLOWED_UPDATES = ["message"] as const;

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

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Telegram's own server when unset. A custom root carries the bot token, so plain http is for loopback only. */
export function resolveApiRoot(apiRoot: string | undefined): string | undefined {
    if (!apiRoot) {
        return undefined;
    }

    let parsed: URL;
    try {
        parsed = new URL(apiRoot);
    } catch {
        throw new WebhookSettingsError("apiRoot in the telegram-bot config is not a valid URL.");
    }

    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))) {
        throw new WebhookSettingsError("apiRoot must use https, or http on a loopback address.");
    }

    return apiRoot.replace(/\/+$/, "");
}

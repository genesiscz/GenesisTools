import { handleUpdate } from "@app/telegram-bot/lib/bot";
import { withTimeout } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import type { Api, Bot } from "grammy";
import { startWebhookServer, type WebhookServer } from "./receiver";
import { WEBHOOK_ALLOWED_UPDATES, type WebhookSettings } from "./settings";

const { log } = logger.scoped("telegram-webhook");

const DRAIN_TIMEOUT_MS = 15_000;

export interface WebhookServiceOptions {
    bot: Bot;
    api: Api;
    secret: string;
    settings: WebhookSettings;
    /** Remove the webhook on the way out. Off by default: Telegram queues updates while the bot is down and retries them. */
    deleteOnExit: boolean;
    /** Ends the service. Fires on SIGINT or SIGTERM. */
    signal: AbortSignal;
    hostname?: string;
    drainTimeoutMs?: number;
    onListening?: (server: WebhookServer) => void;
}

function untilAborted(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }

        signal.addEventListener("abort", () => resolve(), { once: true });
    });
}

/**
 * Listens first, then tells Telegram where to deliver, so no update is ever posted to a closed port.
 * `bot` is the same one the polling mode runs; every update goes through `handleUpdate`.
 */
export async function runWebhookService(options: WebhookServiceOptions): Promise<void> {
    const { bot, api, secret, settings, signal } = options;
    const server = startWebhookServer({
        secret,
        path: settings.path,
        port: settings.port,
        hostname: options.hostname,
        onUpdate: (update) => handleUpdate(bot, update),
    });

    try {
        options.onListening?.(server);
        await api.setWebhook(settings.url, { secret_token: secret, allowed_updates: [...WEBHOOK_ALLOWED_UPDATES] });
        log.info({ url: settings.url, port: server.port }, "webhook set");
        await untilAborted(signal);
    } finally {
        await server.stop();

        try {
            await withTimeout(server.idle(), options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
        } catch (err) {
            log.warn({ err }, "updates were still running at shutdown");
        }
    }

    if (options.deleteOnExit) {
        await api.deleteWebhook();
        log.info("webhook deleted on exit");
    }
}

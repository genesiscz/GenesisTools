import { handleUpdate } from "@app/telegram-bot/lib/bot";
import { withTimeout } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import type { SecretStore } from "@genesiscz/utils/security";
import type { Api, Bot } from "grammy";
import { startWebhookServer, type WebhookServer } from "./receiver";
import { registerWithStoredSecret } from "./secret";
import { WEBHOOK_ALLOWED_UPDATES, type WebhookSettings } from "./settings";

const { log } = logger.scoped("telegram-webhook");

const DRAIN_TIMEOUT_MS = 15_000;
/** Fits under the config-lock wait a rotation is given while this registration holds the lock. */
const REGISTER_TIMEOUT_MS = 30_000;

export interface WebhookServiceOptions {
    bot: Bot;
    api: Api;
    /** Used only when `store` is omitted. A value passed with `store` is ignored; the stored secret is registered. */
    secret?: string;
    /** When set, or when `secret` is omitted, the listen and the registration run under the rotation lock. */
    store?: SecretStore;
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
 * With a vault (`store`, or no literal `secret`), the listen and `setWebhook` run inside
 * `registerWithStoredSecret`, under the same config lock a rotation holds. Both use the secret the
 * call just read, so a rotation that already finished is what gets registered, and a rotation cannot
 * finish between the listen and the registration. `bot` is the same one the polling mode runs; every
 * update goes through `handleUpdate`.
 */
export async function runWebhookService(options: WebhookServiceOptions): Promise<void> {
    const { bot, api, settings, signal } = options;
    let server: WebhookServer | undefined;

    try {
        const publish = async (secret: string): Promise<void> => {
            const started = startWebhookServer({
                secret,
                path: settings.path,
                port: settings.port,
                hostname: options.hostname,
                onUpdate: (update) => handleUpdate(bot, update),
            });
            server = started;
            options.onListening?.(started);
            await api.setWebhook(
                settings.url,
                { secret_token: secret, allowed_updates: [...WEBHOOK_ALLOWED_UPDATES] },
                AbortSignal.timeout(REGISTER_TIMEOUT_MS)
            );
        };

        if (options.store !== undefined || options.secret === undefined) {
            await registerWithStoredSecret({ store: options.store, register: publish });
        } else {
            await publish(options.secret);
        }

        if (!server) {
            throw new Error("The webhook receiver did not start.");
        }

        log.info({ url: settings.url, port: server.port }, "webhook set");
        await untilAborted(signal);
    } finally {
        if (server) {
            await server.stop();

            try {
                await withTimeout(server.idle(), options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
            } catch (err) {
                log.warn({ err }, "updates were still running at shutdown");
            }
        }
    }

    if (options.deleteOnExit) {
        await api.deleteWebhook();
        log.info("webhook deleted on exit");
    }
}

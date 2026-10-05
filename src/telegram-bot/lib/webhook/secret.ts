import { randomBytes } from "node:crypto";
import {
    loadTelegramConfig,
    notConfiguredMessage,
    saveTelegramConfig,
    withTelegramConfigLock,
} from "@app/telegram-bot/lib/config";
import { logger } from "@genesiscz/utils/logger";
import { type SecretStore, secrets } from "@genesiscz/utils/security";
import { secureRef } from "@genesiscz/utils/security/SecureRef";
import { NETWORKED_LOCK_WAIT_MS } from "@genesiscz/utils/storage/file-lock";

export const WEBHOOK_SECRET_PATH = "telegram-bot/webhook-secret";

/** Telegram accepts 1 to 256 characters of `A-Z a-z 0-9 _ -`; base64url of 32 random bytes is 43 of them. */
export function generateWebhookSecret(): string {
    return randomBytes(32).toString("base64url");
}

/** Read-only: says whether a secret exists without creating one, so a status check never mutates. */
export async function hasWebhookSecret(store?: SecretStore): Promise<boolean> {
    return (store ?? (await secrets())).has(WEBHOOK_SECRET_PATH);
}

/**
 * The shared secret, minted on first use. It lives in the vault and the config keeps only a pointer to it,
 * the way every other credential does. The mint runs under the config lock, so two commands started together
 * cannot each create one and leave the loser holding a secret Telegram never learned.
 */
export async function ensureWebhookSecret(options: { store?: SecretStore } = {}): Promise<string> {
    const store = options.store ?? (await secrets());

    return withTelegramConfigLock(async () => {
        const config = await loadTelegramConfig();
        if (!config) {
            throw new Error(notConfiguredMessage());
        }

        const existing = await store.get(WEBHOOK_SECRET_PATH);
        if (existing) {
            if (config.webhook?.secret?.path !== WEBHOOK_SECRET_PATH) {
                await saveTelegramConfig({
                    ...config,
                    webhook: { ...config.webhook, secret: secureRef(WEBHOOK_SECRET_PATH) },
                });
            }

            return existing;
        }

        const secret = generateWebhookSecret();
        const ref = await store.set(WEBHOOK_SECRET_PATH, secret);
        await saveTelegramConfig({ ...config, webhook: { ...config.webhook, secret: ref } });
        logger.info({ path: WEBHOOK_SECRET_PATH }, "telegram-bot: minted the webhook secret");

        return secret;
    });
}

/**
 * Replaces the secret in the one order that cannot strand a running webhook: `register` hands the new value to
 * Telegram first, and only an accepted call stores it. A refusal, a timeout or a network error leaves the vault
 * and the config as they were, so Telegram and the receiver still share a secret. The config lock is held from
 * the mint to the store, so two rotations cannot interleave and leave Telegram with one value and the vault
 * with the other; `register` is a network call, hence `NETWORKED_LOCK_WAIT_MS`, and the caller bounds it with a
 * deadline that fits inside that wait.
 */
export async function rotateWebhookSecret(options: {
    register: (secret: string) => Promise<unknown>;
    store?: SecretStore;
}): Promise<string> {
    const store = options.store ?? (await secrets());

    return withTelegramConfigLock(async () => {
        const config = await loadTelegramConfig();
        if (!config) {
            throw new Error(notConfiguredMessage());
        }

        const secret = generateWebhookSecret();
        await options.register(secret);

        try {
            const ref = await store.set(WEBHOOK_SECRET_PATH, secret);
            await saveTelegramConfig({ ...config, webhook: { ...config.webhook, secret: ref } });
        } catch (err) {
            throw new Error(
                `Telegram accepted the new secret but it could not be stored (${err instanceof Error ? err.message : String(err)}). Rotate again to bring the two back together.`,
                { cause: err }
            );
        }

        logger.info({ path: WEBHOOK_SECRET_PATH }, "telegram-bot: rotated the webhook secret");

        return secret;
    }, NETWORKED_LOCK_WAIT_MS);
}

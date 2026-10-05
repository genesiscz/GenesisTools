import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { TelegramBotConfig } from "@genesiscz/utils/telegram-bot/lib/types";

/** The config holds the bot token in plaintext, so every write creates the file at 0600, never at the umask default. */
const storage = new Storage("telegram-bot", { configFileMode: 0o600 });

export async function loadTelegramConfig(): Promise<TelegramBotConfig | null> {
    return storage.getConfig<TelegramBotConfig>();
}

export async function saveTelegramConfig(config: TelegramBotConfig): Promise<void> {
    await storage.setConfig(config);
}

export function notConfiguredMessage(): string {
    return `Telegram not configured. Run: ${toolCommand("telegram-bot configure")}`;
}

/**
 * Serialises a read-modify-write of the config. Never nest it: the lock is not reentrant. A holder that runs a
 * network call inside it passes `timeout` (`NETWORKED_LOCK_WAIT_MS`), so a waiter outlasts that call.
 */
export async function withTelegramConfigLock<T>(fn: () => Promise<T>, timeout?: number): Promise<T> {
    return storage.withConfigLock(fn, timeout);
}

export async function saveWebhookUrl(url: string): Promise<void> {
    await withTelegramConfigLock(async () => {
        const config = await loadTelegramConfig();
        if (!config) {
            throw new Error(notConfiguredMessage());
        }

        if (config.webhook?.url === url) {
            return;
        }

        await saveTelegramConfig({ ...config, webhook: { ...config.webhook, url } });
    });
}

export function getStorage() {
    return storage;
}

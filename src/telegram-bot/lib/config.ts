import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import {
    loadTelegramBotConfig,
    saveTelegramBotConfig,
    telegramBotStorage,
} from "@genesiscz/utils/telegram-bot/lib/config";
import type { TelegramBotConfig, TelegramBotConfigV1 } from "@genesiscz/utils/telegram-bot/lib/types";

const storage = telegramBotStorage();

/** The bot config in the version 2 shape (`chats` by purpose); a version 1 file is migrated in memory. */
export async function loadTelegramConfig(): Promise<TelegramBotConfig | null> {
    return loadTelegramBotConfig();
}

export async function saveTelegramConfig(config: TelegramBotConfig | TelegramBotConfigV1): Promise<void> {
    await saveTelegramBotConfig(config);
}

/** Every chat the bot takes updates from: the commands chat, plus the decisions chat when it is another one. */
export function authorizedChats(config: Pick<TelegramBotConfig, "chats">): number[] {
    return [...new Set([config.chats.commands, config.chats.decisions ?? config.chats.commands])];
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

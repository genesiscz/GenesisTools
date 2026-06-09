import { chmodSync } from "node:fs";
import { logger } from "@app/logger";
import { Storage } from "@app/utils/storage/storage";
import type { TelegramBotConfig } from "./types";

const storage = new Storage("telegram-bot");

export async function loadTelegramConfig(): Promise<TelegramBotConfig | null> {
    return storage.getConfig<TelegramBotConfig>();
}

export async function saveTelegramConfig(config: TelegramBotConfig): Promise<void> {
    await storage.setConfig(config);

    try {
        chmodSync(storage.getConfigPath(), 0o600);
    } catch (err) {
        logger.warn(
            { err, path: storage.getConfigPath() },
            "Failed to chmod config to 0600 — bot tokens may be world-readable"
        );
    }
}

export function getStorage() {
    return storage;
}

import { readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { TelegramBotConfig, TelegramBotConfigV1, TelegramChatPurpose } from "./types";

/** The config holds the bot token in plaintext, so every write creates the file at 0600, never at the umask default. */
const storage = new Storage("telegram-bot", { configFileMode: 0o600 });

export function telegramBotStorage(): Storage {
    return storage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chatNumber(value: unknown): number | undefined {
    const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof parsed === "number" && Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Version 1 (one flat `chatId`) to version 2 (`chats` by purpose). Pure and idempotent: a version 2 file comes back
 * unchanged, and when both shapes are present the `chats` object wins and the flat id only fills `chats.commands`.
 * Returns null for a file that names no bot token or no chat, which every reader treats as "not configured".
 */
export function migrateTelegramBotConfig(raw: unknown): TelegramBotConfig | null {
    if (!isRecord(raw) || typeof raw.botToken !== "string" || raw.botToken === "") {
        return null;
    }

    const { chatId: legacyChat, chats: rawChats, ...rest } = raw;
    const chats = isRecord(rawChats) ? rawChats : {};
    const commands = chatNumber(chats.commands) ?? chatNumber(legacyChat);

    if (commands === undefined) {
        return null;
    }

    const notifications = chatNumber(chats.notifications);
    const decisions = chatNumber(chats.decisions);

    return {
        ...(rest as Omit<TelegramBotConfig, "chats">),
        chats: {
            commands,
            ...(notifications === undefined ? {} : { notifications }),
            ...(decisions === undefined ? {} : { decisions }),
        },
    };
}

/** The bot config in the version 2 shape, migrated in memory (a read never writes the file back). */
export async function loadTelegramBotConfig(): Promise<TelegramBotConfig | null> {
    return migrateTelegramBotConfig(await storage.getConfig<Record<string, unknown>>());
}

/** The same, read synchronously, for the callers that build their channel list without awaiting (shops). */
export function loadTelegramBotConfigSync(): TelegramBotConfig | null {
    try {
        return migrateTelegramBotConfig(SafeJSON.parse(readFileSync(storage.getConfigPath(), "utf8")));
    } catch (err) {
        // A missing file is the normal "not configured"; anything else (corrupt JSON, no permission) is logged.
        if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
            logger.warn({ err, path: storage.getConfigPath() }, "telegram-bot: could not read the bot config");
        }

        return null;
    }
}

/** Writes the version 2 shape. A version 1 object (an older caller) is migrated first, so the flat id never returns. */
export async function saveTelegramBotConfig(config: TelegramBotConfig | TelegramBotConfigV1): Promise<void> {
    const migrated = migrateTelegramBotConfig(config);

    if (!migrated) {
        throw new Error("telegram-bot config needs a bot token and a chat");
    }

    await storage.setConfig(migrated);
}

/** The chat a purpose posts to: its own chat, else the commands chat. */
export function telegramChatFor(config: Pick<TelegramBotConfig, "chats">, purpose: TelegramChatPurpose): number {
    return config.chats[purpose] ?? config.chats.commands;
}

/** A setting of another tool that names its own Telegram bot or chat (the notify channel, the shops env). */
export interface OwnTelegramSetting {
    botToken?: string;
    chatId?: string | number;
}

export interface TelegramTarget {
    botToken: string;
    chatId: number;
    apiRoot?: string;
}

/**
 * Where a message of `purpose` goes. A setting that names its own token and chat keeps them, so two configs that name
 * different chats both keep working. A setting with only a chat sends through the one bot. A blank setting falls back
 * to the bot config's chat for the purpose. Null when nothing names a token and a chat.
 */
export function resolveTelegramTarget({
    purpose,
    own,
    bot,
}: {
    purpose: TelegramChatPurpose;
    own?: OwnTelegramSetting;
    bot: TelegramBotConfig | null;
}): TelegramTarget | null {
    const ownChat = chatNumber(own?.chatId);
    const ownToken = own?.botToken?.trim() || undefined;

    if (ownToken && ownChat !== undefined) {
        return {
            botToken: ownToken,
            chatId: ownChat,
            ...(ownToken === bot?.botToken && bot.apiRoot ? { apiRoot: bot.apiRoot } : {}),
        };
    }

    if (!bot || ownToken) {
        return null;
    }

    return {
        botToken: bot.botToken,
        chatId: ownChat ?? telegramChatFor(bot, purpose),
        ...(bot.apiRoot ? { apiRoot: bot.apiRoot } : {}),
    };
}

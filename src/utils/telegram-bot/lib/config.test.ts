import { describe, expect, it } from "bun:test";
import { migrateTelegramBotConfig, resolveTelegramTarget, telegramChatFor } from "./config";
import type { TelegramBotConfig } from "./types";

const TOKEN = "100:fake-token-for-tests";
const OTHER_TOKEN = "200:another-fake-token";

const v2: TelegramBotConfig = {
    botToken: TOKEN,
    chats: { commands: 11, notifications: 22 },
    botUsername: "example_bot",
    configuredAt: "2026-01-01T00:00:00.000Z",
    decisions: { projects: { "example-repo": { text: false } } },
};

describe("migrateTelegramBotConfig", () => {
    it("moves the version 1 flat chatId into chats.commands and drops it", () => {
        const migrated = migrateTelegramBotConfig({
            botToken: TOKEN,
            chatId: 11,
            configuredAt: "2026-01-01",
            webhook: { url: "https://example.org/telegram-webhook" },
        });

        expect(migrated).toEqual({
            botToken: TOKEN,
            chats: { commands: 11 },
            configuredAt: "2026-01-01",
            webhook: { url: "https://example.org/telegram-webhook" },
        });
        expect(migrated && "chatId" in migrated).toBe(false);
    });

    it("returns a version 2 config unchanged, and a second run changes nothing", () => {
        const once = migrateTelegramBotConfig(v2);

        expect(once).toEqual(v2);
        expect(migrateTelegramBotConfig(once)).toEqual(v2);
    });

    it("lets chats win over a leftover flat chatId", () => {
        expect(migrateTelegramBotConfig({ ...v2, chatId: 99 })?.chats).toEqual({ commands: 11, notifications: 22 });
    });

    it("reads a chat id saved as a string", () => {
        expect(migrateTelegramBotConfig({ botToken: TOKEN, chatId: "-1005", configuredAt: "x" })?.chats).toEqual({
            commands: -1005,
        });
    });

    it("is null without a token or a chat", () => {
        expect(migrateTelegramBotConfig({ chatId: 1 })).toBeNull();
        expect(migrateTelegramBotConfig({ botToken: TOKEN, configuredAt: "x" })).toBeNull();
        expect(migrateTelegramBotConfig(null)).toBeNull();
    });
});

describe("telegramChatFor", () => {
    it("uses the purpose's own chat, else the commands chat", () => {
        expect(telegramChatFor(v2, "notifications")).toBe(22);
        expect(telegramChatFor(v2, "decisions")).toBe(11);
    });
});

describe("resolveTelegramTarget", () => {
    it("keeps a notify setting that names its own token and another chat", () => {
        expect(
            resolveTelegramTarget({ purpose: "notifications", own: { botToken: OTHER_TOKEN, chatId: "33" }, bot: v2 })
        ).toEqual({ botToken: OTHER_TOKEN, chatId: 33 });
    });

    it("sends a blank setting through the one bot to the purpose's chat", () => {
        expect(resolveTelegramTarget({ purpose: "notifications", own: {}, bot: v2 })).toEqual({
            botToken: TOKEN,
            chatId: 22,
        });
    });

    it("sends a setting with only a chat through the one bot to that chat", () => {
        expect(resolveTelegramTarget({ purpose: "notifications", own: { chatId: "44" }, bot: v2 })).toEqual({
            botToken: TOKEN,
            chatId: 44,
        });
    });

    it("is null for a token without a chat, and for nothing at all", () => {
        expect(resolveTelegramTarget({ purpose: "notifications", own: { botToken: OTHER_TOKEN }, bot: v2 })).toBeNull();
        expect(resolveTelegramTarget({ purpose: "notifications", own: {}, bot: null })).toBeNull();
    });
});

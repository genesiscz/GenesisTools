import { describe, expect, it } from "bun:test";
import { migrateContactV1toV2, migrateConfigV1toV2 } from "../TelegramToolConfig";
import type { ContactConfig, TelegramConfigData, TelegramConfigDataV2 } from "../types";

describe("V1 -> V2 config migration", () => {
    it("migrates a V1 contact with ask config into V2 modes", () => {
        const v1: ContactConfig = {
            userId: "123",
            displayName: "Alice",
            username: "alice",
            actions: ["ask", "notify"],
            askSystemPrompt: "Be helpful",
            askProvider: "openai",
            askModel: "gpt-4o",
            replyDelayMin: 2000,
            replyDelayMax: 5000,
        };

        const v2 = migrateContactV1toV2(v1);

        expect(v2.userId).toBe("123");
        expect(v2.displayName).toBe("Alice");
        expect(v2.chatType).toBe("user");
        expect(v2.actions).toEqual(["ask", "notify"]);

        expect(v2.modes.autoReply.enabled).toBe(true);
        expect(v2.modes.autoReply.provider).toBe("openai");
        expect(v2.modes.autoReply.model).toBe("gpt-4o");
        expect(v2.modes.autoReply.systemPrompt).toBe("Be helpful");

        expect(v2.modes.assistant.enabled).toBe(true);
        expect(v2.modes.suggestions.enabled).toBe(true);
        expect(v2.modes.suggestions.count).toBe(3);
    });

    it("migrates a V1 contact without ask config", () => {
        const v1: ContactConfig = {
            userId: "456",
            displayName: "Bob",
            actions: ["notify"],
            replyDelayMin: 2000,
            replyDelayMax: 5000,
        };

        const v2 = migrateContactV1toV2(v1);

        expect(v2.modes.autoReply.enabled).toBe(false);
        expect(v2.modes.autoReply.provider).toBeUndefined();
    });

    it("migrates full V1 config to V2", () => {
        const v1: TelegramConfigData = {
            apiId: 12345,
            apiHash: "abc",
            session: "session",
            contacts: [
                { userId: "1", displayName: "A", actions: ["ask"], replyDelayMin: 2000, replyDelayMax: 5000 },
            ],
            configuredAt: "2024-01-01",
        };

        const v2 = migrateConfigV1toV2(v1);

        expect(v2.version).toBe(2);
        expect(v2.contacts.length).toBe(1);
        expect(v2.contacts[0].modes).toBeDefined();
        expect(v2.globalDefaults).toBeDefined();
    });

    it("passes through V2 config unchanged", () => {
        const v2Config: TelegramConfigDataV2 = {
            version: 2,
            apiId: 12345,
            apiHash: "abc",
            session: "session",
            contacts: [],
            globalDefaults: {
                modes: {
                    autoReply: { enabled: false },
                    assistant: { enabled: true },
                    suggestions: { enabled: true, count: 3, trigger: "manual", autoDelayMs: 5000, allowAutoSend: false },
                },
                watch: { enabled: true, contextLength: 30, runtimeMode: "ink" },
                styleProfile: { enabled: false, refresh: "incremental", rules: [], previewInWatch: false },
            },
            configuredAt: "2024-01-01",
        };

        const result = migrateConfigV1toV2(v2Config);
        expect(result.version).toBe(2);
    });
});

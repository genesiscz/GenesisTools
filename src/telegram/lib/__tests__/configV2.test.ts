import { describe, expect, it } from "bun:test";
import type { TelegramContactV2 } from "../types";
import { DEFAULT_MODE_CONFIG, DEFAULT_STYLE_PROFILE, DEFAULT_WATCH_CONFIG } from "../types";

describe("V2 Config types", () => {
    it("default mode config has correct shape", () => {
        expect(DEFAULT_MODE_CONFIG.autoReply.enabled).toBe(false);
        expect(DEFAULT_MODE_CONFIG.assistant.enabled).toBe(true);
        expect(DEFAULT_MODE_CONFIG.suggestions.enabled).toBe(true);
        expect(DEFAULT_MODE_CONFIG.suggestions.count).toBe(3);
        expect(DEFAULT_MODE_CONFIG.suggestions.trigger).toBe("manual");
    });

    it("default watch config has correct shape", () => {
        expect(DEFAULT_WATCH_CONFIG.enabled).toBe(true);
        expect(DEFAULT_WATCH_CONFIG.contextLength).toBe(30);
        expect(DEFAULT_WATCH_CONFIG.runtimeMode).toBe("ink");
    });

    it("default style profile is disabled", () => {
        expect(DEFAULT_STYLE_PROFILE.enabled).toBe(false);
        expect(DEFAULT_STYLE_PROFILE.rules).toEqual([]);
    });

    it("TelegramContactV2 can be constructed", () => {
        const contact: TelegramContactV2 = {
            userId: "123",
            displayName: "Alice",
            username: "alice",
            chatType: "user",
            actions: ["ask", "notify"],
            watch: DEFAULT_WATCH_CONFIG,
            modes: DEFAULT_MODE_CONFIG,
            styleProfile: DEFAULT_STYLE_PROFILE,
            replyDelayMin: 2000,
            replyDelayMax: 5000,
        };
        expect(contact.displayName).toBe("Alice");
        expect(contact.modes.suggestions.count).toBe(3);
    });
});

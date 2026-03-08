import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StyleProfileEngine } from "../StyleProfileEngine";
import { TelegramHistoryStore } from "../TelegramHistoryStore";

function tmpDbPath() {
    return join(tmpdir(), `telegram-style-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("StyleProfileEngine", () => {
    let store: TelegramHistoryStore;
    let dbPath: string;

    beforeEach(() => {
        dbPath = tmpDbPath();
        store = new TelegramHistoryStore();
        store.open(dbPath);

        const messages = [
            {
                id: 1,
                senderId: "me",
                text: "hey whats up",
                isOutgoing: true,
                date: "2024-01-10T10:00:00Z",
                dateUnix: 1704880800,
            },
            {
                id: 2,
                senderId: "me",
                text: "lol yea that was crazy",
                isOutgoing: true,
                date: "2024-01-10T10:01:00Z",
                dateUnix: 1704880860,
            },
            {
                id: 3,
                senderId: "me",
                text: "nah im good thanks tho",
                isOutgoing: true,
                date: "2024-01-10T10:02:00Z",
                dateUnix: 1704880920,
            },
            {
                id: 4,
                senderId: "me",
                text: "wanna grab coffee tmrw?",
                isOutgoing: true,
                date: "2024-01-10T10:03:00Z",
                dateUnix: 1704880980,
            },
            {
                id: 5,
                senderId: "me",
                text: "k cool see ya",
                isOutgoing: true,
                date: "2024-01-10T10:04:00Z",
                dateUnix: 1704881040,
            },
        ];

        for (const msg of messages) {
            store.insertMessages("chat1", [{ ...msg, mediaDescription: undefined }]);
        }
    });

    afterEach(() => {
        store.close();

        if (existsSync(dbPath)) {
            unlinkSync(dbPath);
        }
    });

    it("generates a style summary from messages", () => {
        const engine = new StyleProfileEngine(store);
        const summary = engine.analyzeStyle("chat1", "me", 100);

        expect(summary.totalMessages).toBe(5);
        expect(summary.avgLength).toBeGreaterThan(0);
        expect(summary.traits).toBeInstanceOf(Array);
        expect(summary.traits.length).toBeGreaterThan(0);
    });

    it("builds a hybrid style prompt", () => {
        const engine = new StyleProfileEngine(store);
        const prompt = engine.buildStylePrompt({
            rules: [{ id: "r1", sourceChatId: "chat1", direction: "outgoing", limit: 100 }],
            exampleCount: 5,
        });

        expect(prompt).toContain("Style Summary");
        expect(prompt).toContain("Example Messages");
        expect(prompt).toContain("hey whats up");
    });

    it("respects rule filters", () => {
        const engine = new StyleProfileEngine(store);

        store.insertMessages("chat1", [
            {
                id: 10,
                senderId: "other",
                text: "How are you?",
                mediaDescription: undefined,
                isOutgoing: false,
                date: "2024-01-10T10:05:00Z",
                dateUnix: 1704881100,
            },
        ]);

        const prompt = engine.buildStylePrompt({
            rules: [{ id: "r1", sourceChatId: "chat1", direction: "outgoing", limit: 100 }],
            exampleCount: 5,
        });

        expect(prompt).not.toContain("How are you?");
    });
});

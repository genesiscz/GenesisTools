import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramHistoryStore } from "../TelegramHistoryStore";

function tmpDbPath() {
    return join(tmpdir(), `telegram-query-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("TelegramHistoryStore.queryMessages", () => {
    let store: TelegramHistoryStore;
    let dbPath: string;

    beforeEach(() => {
        dbPath = tmpDbPath();
        store = new TelegramHistoryStore();
        store.open(dbPath);

        store.insertMessages("chat1", [
            {
                id: 1,
                senderId: "user1",
                text: "hello from them",
                mediaDescription: undefined,
                isOutgoing: false,
                date: "2024-01-10T10:00:00Z",
                dateUnix: 1704880800,
            },
            {
                id: 2,
                senderId: "me",
                text: "hello back",
                mediaDescription: undefined,
                isOutgoing: true,
                date: "2024-01-10T10:01:00Z",
                dateUnix: 1704880860,
            },
            {
                id: 3,
                senderId: "user1",
                text: "how are you?",
                mediaDescription: undefined,
                isOutgoing: false,
                date: "2024-01-11T10:00:00Z",
                dateUnix: 1704967200,
            },
            {
                id: 4,
                senderId: "me",
                text: "I am good thanks",
                mediaDescription: undefined,
                isOutgoing: true,
                date: "2024-01-12T10:00:00Z",
                dateUnix: 1705053600,
            },
            {
                id: 5,
                senderId: "user1",
                text: "great to hear!",
                mediaDescription: undefined,
                isOutgoing: false,
                date: "2024-01-13T10:00:00Z",
                dateUnix: 1705140000,
            },
        ]);
    });

    afterEach(() => {
        store.close();

        if (existsSync(dbPath)) {
            unlinkSync(dbPath);
        }
    });

    it("returns all messages for a chat", () => {
        const results = store.queryMessages("chat1", {});
        expect(results.length).toBe(5);
    });

    it("filters by sender=outgoing", () => {
        const results = store.queryMessages("chat1", { sender: "me" });
        expect(results.length).toBe(2);
        expect(results.every((r) => r.is_outgoing === 1)).toBe(true);
    });

    it("filters by sender=incoming", () => {
        const results = store.queryMessages("chat1", { sender: "them" });
        expect(results.length).toBe(3);
        expect(results.every((r) => r.is_outgoing === 0)).toBe(true);
    });

    it("filters by date range", () => {
        const results = store.queryMessages("chat1", {
            since: new Date("2024-01-11T00:00:00Z"),
            until: new Date("2024-01-12T23:59:59Z"),
        });
        expect(results.length).toBe(2);
    });

    it("filters by text regex", () => {
        const results = store.queryMessages("chat1", { textPattern: "hello" });
        expect(results.length).toBe(2);
    });

    it("combines filters", () => {
        const results = store.queryMessages("chat1", {
            sender: "me",
            since: new Date("2024-01-10T00:00:00Z"),
            until: new Date("2024-01-11T00:00:00Z"),
        });
        expect(results.length).toBe(1);
    });

    it("respects limit", () => {
        const results = store.queryMessages("chat1", { limit: 2 });
        expect(results.length).toBe(2);
    });

    it("excludes deleted messages by default", () => {
        store.markMessageDeleted("chat1", 3);
        const results = store.queryMessages("chat1", {});
        expect(results.length).toBe(4);
    });

    it("includes deleted messages when requested", () => {
        store.markMessageDeleted("chat1", 3);
        const results = store.queryMessages("chat1", { includeDeleted: true });
        expect(results.length).toBe(5);
    });
});

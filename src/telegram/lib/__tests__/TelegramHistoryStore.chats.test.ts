import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramHistoryStore } from "../TelegramHistoryStore";

function tmpDbPath() {
    return join(tmpdir(), `telegram-chat-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("TelegramHistoryStore chats", () => {
    let store: TelegramHistoryStore;
    let dbPath: string;

    beforeEach(() => {
        dbPath = tmpDbPath();
        store = new TelegramHistoryStore();
        store.open(dbPath);
    });

    afterEach(() => {
        store.close();

        if (existsSync(dbPath)) {
            unlinkSync(dbPath);
        }
    });

    it("upserts chat metadata", () => {
        store.upsertChat({ chat_id: "123", chat_type: "user", title: "John", username: "john" });
        const chat = store.getChat("123");
        expect(chat).toBeTruthy();
        expect(chat!.title).toBe("John");
        expect(chat!.chat_type).toBe("user");
    });

    it("lists chats by type", () => {
        store.upsertChat({ chat_id: "1", chat_type: "user", title: "Alice", username: null });
        store.upsertChat({ chat_id: "2", chat_type: "group", title: "Dev Team", username: null });
        store.upsertChat({
            chat_id: "3",
            chat_type: "channel",
            title: "News",
            username: "news",
        });

        const users = store.listChats("user");
        expect(users.length).toBe(1);

        const all = store.listChats();
        expect(all.length).toBe(3);
    });
});

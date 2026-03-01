import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramHistoryStore } from "../TelegramHistoryStore";

function tmpDbPath() {
    return join(tmpdir(), `telegram-rev-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("TelegramHistoryStore.upsertMessageWithRevision", () => {
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

    it("inserts new message and records create revision", () => {
        store.upsertMessageWithRevision("chat1", {
            id: 100,
            senderId: "user1",
            text: "new msg",
            mediaDescription: undefined,
            isOutgoing: false,
            date: "2024-02-01T10:00:00Z",
            dateUnix: 1706781600,
        });

        const msgs = store.queryMessages("chat1", {});
        const msg = msgs.find((m) => m.id === 100);
        expect(msg).toBeTruthy();
        expect(msg!.text).toBe("new msg");

        const revisions = store.getRevisions("chat1", 100);
        expect(revisions.length).toBe(1);
        expect(revisions[0].revision_type).toBe("create");
    });

    it("updates existing message text and records edit revision", () => {
        store.upsertMessageWithRevision("chat1", {
            id: 101,
            senderId: "user1",
            text: "original",
            mediaDescription: undefined,
            isOutgoing: false,
            date: "2024-02-01T10:00:00Z",
            dateUnix: 1706781600,
        });

        store.upsertMessageWithRevision("chat1", {
            id: 101,
            senderId: "user1",
            text: "edited!",
            mediaDescription: undefined,
            isOutgoing: false,
            date: "2024-02-01T10:00:00Z",
            dateUnix: 1706781600,
            editedDateUnix: 1706781700,
        });

        const msgs = store.queryMessages("chat1", {});
        const msg = msgs.find((m) => m.id === 101);
        expect(msg!.text).toBe("edited!");
        expect(msg!.edited_date_unix).toBe(1706781700);

        const revisions = store.getRevisions("chat1", 101);
        expect(revisions.length).toBe(2);
        expect(revisions[1].revision_type).toBe("edit");
        expect(revisions[1].old_text).toBe("original");
        expect(revisions[1].new_text).toBe("edited!");
    });
});

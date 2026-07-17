import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

describe("ask threads", () => {
    it("creates threads, appends ordered messages, scopes reads to the owner", () => {
        const thread = db.createAskThread({ userId: 1, collectionId: 5, title: "What did I learn?" });

        db.appendAskMessage({ threadId: thread.id, role: "user", content: "Summarize the collection" });
        db.appendAskMessage({
            threadId: thread.id,
            role: "tool",
            content: '[{"id":"vid00000001"}]',
            toolName: "list_videos",
            toolArgsJson: "{}",
        });
        db.appendAskMessage({ threadId: thread.id, role: "assistant", content: "You watched 1 video about X." });

        const messages = db.listAskMessages(thread.id);

        expect(messages.map((message) => message.role)).toEqual(["user", "tool", "assistant"]);
        expect(messages[1].toolName).toBe("list_videos");
        expect(db.getAskThread(1, thread.id)?.title).toBe("What did I learn?");
        expect(db.getAskThread(2, thread.id)).toBeNull();
        expect(db.listAskThreads(1, 5)).toHaveLength(1);
        expect(db.listAskThreads(1, 999)).toHaveLength(0);
    });

    it("touchAskThread bumps updated_at ordering", async () => {
        const older = db.createAskThread({ userId: 1, collectionId: 5, title: "old" });
        const newer = db.createAskThread({ userId: 1, collectionId: 5, title: "new" });

        expect(older.id).toBeLessThan(newer.id);
        await Bun.sleep(2);
        db.touchAskThread(older.id);
        const threads = db.listAskThreads(1, 5);

        expect(threads[0].id).toBe(older.id);
    });
});

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
        const thread = db.createAskSession({
            userId: 1,
            collectionId: 5,
            scopeKind: "collection",
            title: "What did I learn?",
        });

        db.appendAskSessionMessage({ sessionId: thread.id, role: "user", content: "Summarize the collection" });
        db.appendAskSessionMessage({
            sessionId: thread.id,
            role: "tool",
            content: '[{"id":"vid00000001"}]',
            toolName: "list_videos",
            toolArgsJson: "{}",
        });
        db.appendAskSessionMessage({
            sessionId: thread.id,
            role: "assistant",
            content: "You watched 1 video about X.",
        });

        const messages = db.listAskSessionMessages(thread.id);

        expect(messages.map((message) => message.role)).toEqual(["user", "tool", "assistant"]);
        expect(messages[1].toolName).toBe("list_videos");
        expect(db.getAskSession(1, thread.id)?.title).toBe("What did I learn?");
        expect(db.getAskSession(2, thread.id)).toBeNull();
        expect(db.listAskSessions(1, { collectionId: 5 })).toHaveLength(1);
        expect(db.listAskSessions(1, { collectionId: 999 })).toHaveLength(0);
    });

    it("touchAskThread bumps updated_at ordering", async () => {
        const older = db.createAskSession({ userId: 1, collectionId: 5, scopeKind: "collection", title: "old" });
        const newer = db.createAskSession({ userId: 1, collectionId: 5, scopeKind: "collection", title: "new" });

        expect(older.id).toBeLessThan(newer.id);
        await Bun.sleep(2);
        db.touchAskSession(older.id);
        const threads = db.listAskSessions(1, { collectionId: 5 });

        expect(threads[0].id).toBe(older.id);
    });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

describe("ask sessions", () => {
    it("creates sessions, appends ordered messages, scopes reads to the owner", () => {
        const session = db.createAskSession({
            userId: 1,
            collectionId: 5,
            scopeKind: "collection",
            title: "What did I learn?",
        });

        db.appendAskSessionMessage({ sessionId: session.id, role: "user", content: "Summarize the collection" });
        db.appendAskSessionMessage({
            sessionId: session.id,
            role: "tool",
            content: '[{"id":"vid00000001"}]',
            toolName: "list_videos",
            toolArgsJson: "{}",
        });
        db.appendAskSessionMessage({
            sessionId: session.id,
            role: "assistant",
            content: "You watched 1 video about X.",
        });

        const messages = db.listAskSessionMessages(session.id);

        expect(messages.map((message) => message.role)).toEqual(["user", "tool", "assistant"]);
        expect(messages[1].toolName).toBe("list_videos");
        expect(db.getAskSession(1, session.id)?.title).toBe("What did I learn?");
        expect(db.getAskSession(2, session.id)).toBeNull();
        expect(db.listAskSessions(1, { collectionId: 5 })).toHaveLength(1);
        expect(db.listAskSessions(1, { collectionId: 999 })).toHaveLength(0);
    });

    it("touchAskSession bumps updated_at ordering", async () => {
        const older = db.createAskSession({ userId: 1, collectionId: 5, scopeKind: "collection", title: "old" });
        const newer = db.createAskSession({ userId: 1, collectionId: 5, scopeKind: "collection", title: "new" });

        expect(older.id).toBeLessThan(newer.id);
        // updated_at is millisecond-resolution and listAskSessions tie-breaks on
        // `id DESC`, so a sleep too short to cross a tick would rank `newer` first.
        await Bun.sleep(25);
        db.touchAskSession(older.id);
        const sessions = db.listAskSessions(1, { collectionId: 5 });

        expect(sessions[0].id).toBe(older.id);
    });
});

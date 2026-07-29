import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeDatabase } from "@app/youtube/lib/db";

let dir: string;
let path: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-ask-migration-"));
    path = join(dir, "youtube.db");
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/**
 * Seeds the pre-constraint shape: `ask_sessions` with no unique index, holding two
 * sessions that share `(user_id, title)`. A file DB rather than `:memory:` because
 * the point is to open it a second time through the real migration path.
 */
function seedDuplicates(): void {
    const raw = new Database(path);

    raw.exec(`
        CREATE TABLE ask_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            collection_id INTEGER,
            scope_kind TEXT NOT NULL DEFAULT 'collection',
            scope_value TEXT NOT NULL DEFAULT '',
            video_ids_json TEXT NOT NULL DEFAULT '[]',
            provider_spec TEXT,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
            updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
        );
        CREATE TABLE ask_session_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            tool_name TEXT,
            tool_args_json TEXT,
            citations_json TEXT,
            created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO ask_sessions (id, user_id, scope_kind, title)
            VALUES (1, 1, 'channel', 'digest'), (2, 1, 'channel', 'digest'), (3, 1, 'channel', 'other'),
                   (4, 2, 'channel', 'digest'),
                   -- Two collection conversations that happen to open with the same
                   -- question. They are NOT named sessions and must survive intact.
                   (5, 1, 'collection', 'what did they say about pricing?'),
                   (6, 1, 'collection', 'what did they say about pricing?');
        INSERT INTO ask_session_messages (session_id, role, content)
            VALUES (1, 'user', 'from winner'), (2, 'user', 'from duplicate'), (4, 'user', 'other owner'),
                   (5, 'user', 'first conversation'), (6, 'user', 'second conversation');
    `);
    raw.close();
}

describe("ask-sessions-unique-title-per-user migration", () => {
    it("merges pre-existing duplicates into the lowest id, keeping their messages", () => {
        seedDuplicates();
        const db = new YoutubeDatabase(path);

        try {
            const sessions = db.listAskSessions(1, {});

            // Session 2 folded into 1; 'other' untouched. The two identically-titled
            // collection conversations (5, 6) are a different namespace and both stay.
            expect(sessions.map((session) => session.id).sort((left, right) => left - right)).toEqual([1, 3, 5, 6]);
            // The duplicate's conversation survived the merge rather than being deleted.
            expect(db.listAskSessionMessages(1).map((message) => message.content)).toEqual([
                "from winner",
                "from duplicate",
            ]);
            // A different owner's identically-titled session is not touched.
            expect(db.getAskSessionByTitle(2, "digest")?.id).toBe(4);
        } finally {
            db.close();
        }
    });

    it("is idempotent across reopens and rejects duplicates afterwards", () => {
        seedDuplicates();
        new YoutubeDatabase(path).close();
        const db = new YoutubeDatabase(path);

        try {
            expect(
                db
                    .listAskSessions(1, {})
                    .map((session) => session.id)
                    .sort((left, right) => left - right)
            ).toEqual([1, 3, 5, 6]);
            expect(() =>
                db.createAskSession({ userId: 1, collectionId: null, scopeKind: "channel", title: "digest" })
            ).toThrow();
        } finally {
            db.close();
        }
    });

    // The index is scoped to named sessions because `collection-ask` titles a
    // conversation with the question that opened it — asking the same thing twice
    // is ordinary use, not a duplicate.
    it("still lets two collection conversations share a title", () => {
        seedDuplicates();
        const db = new YoutubeDatabase(path);

        try {
            const first = db.createAskSession({
                userId: 1,
                collectionId: 7,
                scopeKind: "collection",
                title: "how do they compare?",
            });
            const second = db.createAskSession({
                userId: 1,
                collectionId: 7,
                scopeKind: "collection",
                title: "how do they compare?",
            });

            expect(second.id).not.toBe(first.id);
            // And a collection title never satisfies a named-session lookup.
            expect(db.getAskSessionByTitle(1, "how do they compare?")).toBeNull();
        } finally {
            db.close();
        }
    });
});

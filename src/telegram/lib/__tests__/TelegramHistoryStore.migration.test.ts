import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramHistoryStore } from "../TelegramHistoryStore";

describe("TelegramHistoryStore migration", () => {
    it("migrates v1 schema to v2 and supports new methods", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "telegram-store-"));
        const dbPath = join(tempDir, "history.db");

        try {
            const db = new Database(dbPath);
            db.run(`
                CREATE TABLE messages (
                    id INTEGER NOT NULL,
                    chat_id TEXT NOT NULL,
                    sender_id TEXT,
                    text TEXT,
                    media_desc TEXT,
                    is_outgoing INTEGER NOT NULL,
                    date_unix INTEGER NOT NULL,
                    date_iso TEXT NOT NULL,
                    PRIMARY KEY (chat_id, id)
                )
            `);
            db.run(`
                CREATE TABLE sync_state (
                    chat_id TEXT PRIMARY KEY,
                    last_synced_id INTEGER NOT NULL,
                    last_synced_at TEXT NOT NULL
                )
            `);
            db.run(`
                CREATE TABLE embeddings (
                    message_rowid INTEGER PRIMARY KEY,
                    embedding BLOB NOT NULL
                )
            `);
            db.run("PRAGMA user_version = 1");
            db.close();

            const store = new TelegramHistoryStore();
            store.open(dbPath);

            const inserted = store.insertMessages("chat-1", [
                {
                    id: 1,
                    senderId: "u1",
                    text: "hello",
                    mediaDescription: undefined,
                    isOutgoing: false,
                    date: "2025-01-01T00:00:00.000Z",
                    dateUnix: 1_735_689_600,
                    attachments: [],
                },
            ]);

            expect(inserted).toBe(1);

            const rows = store.queryMessages("chat-1", {
                sender: "any",
            });
            expect(rows).toHaveLength(1);
            expect(rows[0].is_deleted).toBe(0);

            store.markMessageDeleted("chat-1", 1, 1_735_689_700);
            const deletedRows = store.queryMessages("chat-1", {});
            expect(deletedRows[0].is_deleted).toBe(1);

            store.insertSyncSegment("chat-1", 100, 200, "query");
            const gaps = store.getMissingSegments("chat-1", new Date(90 * 1000), new Date(220 * 1000));
            expect(gaps).toEqual([
                { sinceUnix: 90, untilUnix: 99 },
                { sinceUnix: 201, untilUnix: 220 },
            ]);

            store.close();
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});

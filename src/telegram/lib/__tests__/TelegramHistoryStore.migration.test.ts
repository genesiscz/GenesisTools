import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramHistoryStore } from "../TelegramHistoryStore";

function tmpDbPath() {
    return join(tmpdir(), `telegram-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("TelegramHistoryStore migrations", () => {
    let store: TelegramHistoryStore;
    let dbPath: string;

    beforeEach(() => {
        dbPath = tmpDbPath();
        store = new TelegramHistoryStore();
    });

    afterEach(() => {
        store.close();

        if (existsSync(dbPath)) {
            unlinkSync(dbPath);
        }
    });

    it("creates all V2 tables on fresh database", () => {
        store.open(dbPath);
        const db = (store as unknown as { db: Database }).db;

        const chats = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='chats'").get();
        expect(chats).toBeTruthy();

        const revisions = db
            .query("SELECT name FROM sqlite_master WHERE type='table' AND name='message_revisions'")
            .get();
        expect(revisions).toBeTruthy();

        const attachments = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='attachments'").get();
        expect(attachments).toBeTruthy();

        const segments = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_segments'").get();
        expect(segments).toBeTruthy();

        const version = db.query("PRAGMA user_version").get() as { user_version: number };
        expect(version.user_version).toBe(2);
    });

    it("migrates V0 (fresh) to V2 with new message columns", () => {
        store.open(dbPath);
        const db = (store as unknown as { db: Database }).db;

        const cols = db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
        const colNames = cols.map((c) => c.name);

        expect(colNames).toContain("edited_date_unix");
        expect(colNames).toContain("is_deleted");
        expect(colNames).toContain("deleted_at_iso");
        expect(colNames).toContain("reply_to_msg_id");
    });

    it("migrates existing V1 database to V2", () => {
        const db = new Database(dbPath);
        db.run("PRAGMA journal_mode = WAL");
        db.run(`CREATE TABLE IF NOT EXISTS messages (
			id INTEGER NOT NULL,
			chat_id TEXT NOT NULL,
			sender_id TEXT,
			text TEXT,
			media_desc TEXT,
			is_outgoing INTEGER NOT NULL,
			date_unix INTEGER NOT NULL,
			date_iso TEXT NOT NULL,
			PRIMARY KEY (chat_id, id)
		)`);
        db.run(`CREATE TABLE IF NOT EXISTS sync_state (
			chat_id TEXT PRIMARY KEY,
			last_synced_id INTEGER NOT NULL,
			last_synced_at TEXT NOT NULL
		)`);
        db.run("PRAGMA user_version = 1");
        db.close();

        store.open(dbPath);
        const storeDb = (store as unknown as { db: Database }).db;

        const version = storeDb.query("PRAGMA user_version").get() as { user_version: number };
        expect(version.user_version).toBe(2);

        const cols = storeDb.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
        const colNames = cols.map((c) => c.name);
        expect(colNames).toContain("is_deleted");
    });

    it("idempotent: opening V2 database doesn't re-migrate", () => {
        store.open(dbPath);
        store.close();

        store = new TelegramHistoryStore();
        store.open(dbPath);

        const db = (store as unknown as { db: Database }).db;
        const version = db.query("PRAGMA user_version").get() as { user_version: number };
        expect(version.user_version).toBe(2);
    });
});

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramSource } from "./telegram-source";

function createTestDb(dbPath: string): Database {
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

    db.run(`CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        chat_type TEXT NOT NULL DEFAULT 'user',
        title TEXT NOT NULL,
        username TEXT,
        last_synced_at TEXT
    )`);

    // Insert test data
    db.run(`INSERT INTO chats (chat_id, chat_type, title) VALUES ('123', 'user', 'Alice')`);
    db.run(`INSERT INTO chats (chat_id, chat_type, title) VALUES ('456', 'group', 'Dev Team')`);

    db.run(`INSERT INTO messages (id, chat_id, sender_id, text, is_outgoing, date_unix, date_iso)
            VALUES (1, '123', 'u1', 'Hello Alice!', 1, 1710000000, '2024-03-09T12:00:00Z')`);
    db.run(`INSERT INTO messages (id, chat_id, sender_id, text, is_outgoing, date_unix, date_iso)
            VALUES (2, '123', 'u2', 'Hi there, how are you?', 0, 1710000060, '2024-03-09T12:01:00Z')`);
    db.run(`INSERT INTO messages (id, chat_id, sender_id, text, is_outgoing, date_unix, date_iso)
            VALUES (3, '456', 'u3', 'Build is broken again', 0, 1710000120, '2024-03-09T12:02:00Z')`);
    db.run(`INSERT INTO messages (id, chat_id, text, is_outgoing, date_unix, date_iso)
            VALUES (4, '456', NULL, 0, 1710000180, '2024-03-09T12:03:00Z')`); // no text, should be skipped
    db.run(`INSERT INTO messages (id, chat_id, sender_id, text, media_desc, is_outgoing, date_unix, date_iso)
            VALUES (5, '456', 'u1', 'See this screenshot', 'photo (1280x720)', 1, 1710000240, '2024-03-09T12:04:00Z')`);

    db.close();
    return new Database(dbPath, { readonly: true });
}

describe("TelegramSource", () => {
    let tmpDir: string;

    afterEach(() => {
        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("scans messages with text content", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "tg-source-"));
        const dbPath = join(tmpDir, "history.db");
        const testDb = createTestDb(dbPath);
        testDb.close();

        const source = TelegramSource.create({ dbPath });
        const entries = await source.scan();

        // 4 messages have text (message 4 has NULL text, skipped)
        expect(entries.length).toBe(4);
        source.dispose();
    });

    it("includes chat title and direction in content", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "tg-source-"));
        const dbPath = join(tmpDir, "history.db");
        const testDb = createTestDb(dbPath);
        testDb.close();

        const source = TelegramSource.create({ dbPath });
        const entries = await source.scan();

        const aliceMsg = entries.find((e) => e.content.includes("Hello Alice!"));
        expect(aliceMsg).toBeDefined();
        expect(aliceMsg!.content).toContain("Chat: Alice");
        expect(aliceMsg!.content).toContain("Direction: sent");

        const devMsg = entries.find((e) => e.content.includes("Build is broken"));
        expect(devMsg).toBeDefined();
        expect(devMsg!.content).toContain("Chat: Dev Team");
        expect(devMsg!.content).toContain("Direction: received");

        source.dispose();
    });

    it("includes media description when present", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "tg-source-"));
        const dbPath = join(tmpDir, "history.db");
        const testDb = createTestDb(dbPath);
        testDb.close();

        const source = TelegramSource.create({ dbPath });
        const entries = await source.scan();

        const mediaMsg = entries.find((e) => e.content.includes("screenshot"));
        expect(mediaMsg).toBeDefined();
        expect(mediaMsg!.content).toContain("Media: photo (1280x720)");

        source.dispose();
    });

    it("filters by chatIds", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "tg-source-"));
        const dbPath = join(tmpDir, "history.db");
        const testDb = createTestDb(dbPath);
        testDb.close();

        const source = TelegramSource.create({ dbPath, chatIds: ["123"] });
        const entries = await source.scan();

        expect(entries.length).toBe(2); // only Alice's messages
        expect(entries.every((e) => e.content.includes("Chat: Alice"))).toBe(true);

        source.dispose();
    });

    it("respects limit in scan options", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "tg-source-"));
        const dbPath = join(tmpDir, "history.db");
        const testDb = createTestDb(dbPath);
        testDb.close();

        const source = TelegramSource.create({ dbPath });
        const entries = await source.scan({ limit: 2 });

        expect(entries.length).toBe(2);

        source.dispose();
    });

    it("calls onProgress during scan", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "tg-source-"));
        const dbPath = join(tmpDir, "history.db");
        const testDb = createTestDb(dbPath);
        testDb.close();

        const source = TelegramSource.create({ dbPath });
        const progressCalls: Array<{ current: number; total: number }> = [];

        await source.scan({
            onProgress: (current, total) => {
                progressCalls.push({ current, total });
            },
        });

        expect(progressCalls.length).toBe(4); // 4 messages with text
        expect(progressCalls[0].current).toBe(1);
        expect(progressCalls[progressCalls.length - 1].current).toBe(4);

        source.dispose();
    });

    it("detectChanges identifies added and unchanged entries", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "tg-source-"));
        const dbPath = join(tmpDir, "history.db");
        const testDb = createTestDb(dbPath);
        testDb.close();

        const source = TelegramSource.create({ dbPath });
        const entries = await source.scan();

        // First sync: all added
        const changes1 = source.detectChanges({
            previousHashes: null,
            currentEntries: entries,
        });

        expect(changes1.added.length).toBe(4);
        expect(changes1.unchanged.length).toBe(0);

        // Second sync: all unchanged
        const hashes = new Map<string, string>();

        for (const entry of entries) {
            hashes.set(entry.id, source.hashEntry(entry));
        }

        const changes2 = source.detectChanges({
            previousHashes: hashes,
            currentEntries: entries,
        });

        expect(changes2.added.length).toBe(0);
        expect(changes2.unchanged.length).toBe(4);

        source.dispose();
    });

    it("detectChanges identifies deleted entries", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "tg-source-"));
        const dbPath = join(tmpDir, "history.db");
        const testDb = createTestDb(dbPath);
        testDb.close();

        const source = TelegramSource.create({ dbPath });
        const entries = await source.scan();

        const hashes = new Map<string, string>();

        for (const entry of entries) {
            hashes.set(entry.id, source.hashEntry(entry));
        }

        // Add a fake previous entry that no longer exists
        hashes.set("999:999", "fakehash");

        const changes = source.detectChanges({
            previousHashes: hashes,
            currentEntries: entries,
        });

        expect(changes.deleted.length).toBe(1);
        expect(changes.deleted[0]).toBe("999:999");

        source.dispose();
    });

    it("estimateTotal returns count of messages with text", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "tg-source-"));
        const dbPath = join(tmpDir, "history.db");
        const testDb = createTestDb(dbPath);
        testDb.close();

        const source = TelegramSource.create({ dbPath });
        const total = await source.estimateTotal();

        expect(total).toBe(4); // 5 messages, but 1 has NULL text

        source.dispose();
    });

    it("hashEntry returns consistent SHA-256", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "tg-source-"));
        const dbPath = join(tmpDir, "history.db");
        const testDb = createTestDb(dbPath);
        testDb.close();

        const source = TelegramSource.create({ dbPath });
        const entry = { id: "test", content: "hello world", path: "test" };

        const hash1 = source.hashEntry(entry);
        const hash2 = source.hashEntry(entry);

        expect(hash1).toBe(hash2);
        expect(hash1.length).toBeGreaterThan(0); // xxHash64 hex

        source.dispose();
    });

    it("throws when database does not exist", () => {
        expect(() => {
            TelegramSource.create({ dbPath: "/nonexistent/path/history.db" });
        }).toThrow("Telegram history database not found");
    });

    it("entry id is chatId:messageId format", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "tg-source-"));
        const dbPath = join(tmpDir, "history.db");
        const testDb = createTestDb(dbPath);
        testDb.close();

        const source = TelegramSource.create({ dbPath });
        const entries = await source.scan();

        for (const entry of entries) {
            expect(entry.id).toMatch(/^\d+:\d+$/);
        }

        source.dispose();
    });
});

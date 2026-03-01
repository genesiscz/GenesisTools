# Phase 1: Data Foundation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the SQLite schema to support full conversation memory — revision tracking, attachment metadata, sync coverage segments, and rich query primitives.

**Architecture:** Versioned schema migrations via `PRAGMA user_version`. All new tables and columns added in a single migration function. Query primitives built as methods on `TelegramHistoryStore`.

**Tech Stack:** bun:sqlite, chrono-node (natural language dates)

---

## Task 1: Install Natural Language Date Parser

**Files:**
- Modify: `package.json`

**Step 1: Install chrono-node**

```bash
bun add chrono-node
```

chrono-node is a natural language date parser that handles "yesterday", "last week", "3 days ago", "since January", etc. Zero config, works in Node/Bun.

**Step 2: Verify installation**

```bash
bunx tsgo --noEmit | rg "chrono"
```

Expected: no errors (or no output)

**Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "feat(telegram): add chrono-node for natural language date parsing"
```

---

## Task 2: Define New Type Definitions for Schema V2

**Files:**
- Modify: `src/telegram/lib/types.ts`

**Step 1: Write the test**

Create `src/telegram/lib/__tests__/types.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import type {
    AttachmentRow,
    ChatRow,
    MessageRevisionRow,
    SyncSegmentRow,
    MessageRowV2,
} from "../types";

describe("V2 type definitions", () => {
    it("MessageRowV2 extends MessageRow with new fields", () => {
        const msg: MessageRowV2 = {
            id: 1,
            chat_id: "123",
            sender_id: "456",
            text: "hello",
            media_desc: null,
            is_outgoing: 0,
            date_unix: 1700000000,
            date_iso: "2023-11-14T00:00:00Z",
            edited_date_unix: null,
            is_deleted: 0,
            deleted_at_iso: null,
            reply_to_msg_id: null,
        };
        expect(msg.is_deleted).toBe(0);
    });

    it("ChatRow has required fields", () => {
        const chat: ChatRow = {
            chat_id: "123",
            chat_type: "user",
            title: "John Doe",
            username: "johndoe",
            last_synced_at: "2023-11-14T00:00:00Z",
        };
        expect(chat.chat_type).toBe("user");
    });

    it("AttachmentRow has required fields", () => {
        const att: AttachmentRow = {
            chat_id: "123",
            message_id: 1,
            attachment_index: 0,
            kind: "photo",
            mime_type: "image/jpeg",
            file_name: null,
            file_size: 1024,
            telegram_file_id: "abc123",
            is_downloaded: 0,
            local_path: null,
            sha256: null,
        };
        expect(att.is_downloaded).toBe(0);
    });

    it("MessageRevisionRow tracks edits", () => {
        const rev: MessageRevisionRow = {
            id: 1,
            chat_id: "123",
            message_id: 1,
            revision_type: "edit",
            old_text: "hello",
            new_text: "hello!",
            revised_at_unix: 1700000100,
            revised_at_iso: "2023-11-14T00:01:40Z",
        };
        expect(rev.revision_type).toBe("edit");
    });

    it("SyncSegmentRow tracks coverage", () => {
        const seg: SyncSegmentRow = {
            id: 1,
            chat_id: "123",
            from_date_unix: 1700000000,
            to_date_unix: 1700086400,
            from_msg_id: 1,
            to_msg_id: 100,
            synced_at: "2023-11-14T00:00:00Z",
        };
        expect(seg.from_msg_id).toBe(1);
    });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test src/telegram/lib/__tests__/types.test.ts
```

Expected: FAIL — types don't exist yet

**Step 3: Add V2 type definitions to types.ts**

Add these types to `src/telegram/lib/types.ts` (after the existing `MessageRow` interface):

```typescript
export interface MessageRowV2 extends MessageRow {
    edited_date_unix: number | null;
    is_deleted: number; // 0 or 1
    deleted_at_iso: string | null;
    reply_to_msg_id: number | null;
}

export type ChatType = "user" | "group" | "channel";

export interface ChatRow {
    chat_id: string;
    chat_type: ChatType;
    title: string;
    username: string | null;
    last_synced_at: string | null;
}

export interface AttachmentRow {
    chat_id: string;
    message_id: number;
    attachment_index: number;
    kind: string; // "photo" | "video" | "audio" | "voice" | "sticker" | "document" | "animation"
    mime_type: string | null;
    file_name: string | null;
    file_size: number | null;
    telegram_file_id: string | null;
    is_downloaded: number; // 0 or 1
    local_path: string | null;
    sha256: string | null;
}

export interface MessageRevisionRow {
    id: number;
    chat_id: string;
    message_id: number;
    revision_type: "create" | "edit" | "delete";
    old_text: string | null;
    new_text: string | null;
    revised_at_unix: number;
    revised_at_iso: string;
}

export interface SyncSegmentRow {
    id: number;
    chat_id: string;
    from_date_unix: number;
    to_date_unix: number;
    from_msg_id: number;
    to_msg_id: number;
    synced_at: string;
}
```

**Step 4: Run test to verify it passes**

```bash
bun test src/telegram/lib/__tests__/types.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/telegram/lib/types.ts src/telegram/lib/__tests__/types.test.ts
git commit -m "feat(telegram): add V2 schema type definitions"
```

---

## Task 3: Schema Migration System

**Files:**
- Modify: `src/telegram/lib/TelegramHistoryStore.ts`

**Context:** The current store calls `initSchema()` which uses `CREATE TABLE IF NOT EXISTS`. We need versioned migrations using `PRAGMA user_version` so we can add columns and tables incrementally.

**Step 1: Write migration test**

Create `src/telegram/lib/__tests__/TelegramHistoryStore.migration.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { TelegramHistoryStore } from "../TelegramHistoryStore";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
        const db = (store as any).db;

        // Check chats table exists
        const chats = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='chats'").get();
        expect(chats).toBeTruthy();

        // Check message_revisions table exists
        const revisions = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='message_revisions'").get();
        expect(revisions).toBeTruthy();

        // Check attachments table exists
        const attachments = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='attachments'").get();
        expect(attachments).toBeTruthy();

        // Check sync_segments table exists
        const segments = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_segments'").get();
        expect(segments).toBeTruthy();

        // Check user_version is set
        const version = db.query("PRAGMA user_version").get() as { user_version: number };
        expect(version.user_version).toBe(2);
    });

    it("migrates V0 (fresh) to V2 with new message columns", () => {
        store.open(dbPath);
        const db = (store as any).db;

        // Check new columns exist on messages table
        const cols = db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
        const colNames = cols.map((c) => c.name);

        expect(colNames).toContain("edited_date_unix");
        expect(colNames).toContain("is_deleted");
        expect(colNames).toContain("deleted_at_iso");
        expect(colNames).toContain("reply_to_msg_id");
    });

    it("migrates existing V1 database to V2", () => {
        // Simulate V1: open and create old schema manually
        const Database = require("bun:sqlite").default;
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
        // V1 has user_version = 0 (default)
        db.close();

        // Now open with V2 store — migration should run
        store.open(dbPath);
        const storeDb = (store as any).db;

        const version = storeDb.query("PRAGMA user_version").get() as { user_version: number };
        expect(version.user_version).toBe(2);

        const cols = storeDb.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
        const colNames = cols.map((c) => c.name);
        expect(colNames).toContain("is_deleted");
    });

    it("idempotent: opening V2 database doesn't re-migrate", () => {
        store.open(dbPath);
        store.close();

        // Re-open — should not throw
        store = new TelegramHistoryStore();
        store.open(dbPath);

        const db = (store as any).db;
        const version = db.query("PRAGMA user_version").get() as { user_version: number };
        expect(version.user_version).toBe(2);
    });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test src/telegram/lib/__tests__/TelegramHistoryStore.migration.test.ts
```

Expected: FAIL — migration logic doesn't exist yet

**Step 3: Implement versioned migration in TelegramHistoryStore.ts**

Replace the `initSchema()` method (currently called in `open()`) with a versioned migration system. The key changes to `src/telegram/lib/TelegramHistoryStore.ts`:

In the `open()` method, after setting pragmas, replace the `initSchema()` call with `this.migrate()`.

Add private method `migrate()`:

```typescript
private migrate(): void {
    const db = this.db!;
    const { user_version: currentVersion } = db.query("PRAGMA user_version").get() as { user_version: number };

    if (currentVersion < 1) {
        // V0 → V1: Original schema (messages, sync_state, FTS, embeddings)
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
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat_date ON messages(chat_id, date_unix)`);
        db.run(`CREATE TABLE IF NOT EXISTS sync_state (
            chat_id TEXT PRIMARY KEY,
            last_synced_id INTEGER NOT NULL,
            last_synced_at TEXT NOT NULL
        )`);
        db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            text, content=messages, content_rowid=rowid, tokenize='unicode61'
        )`);
        // FTS triggers
        db.run(`CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END`);
        db.run(`CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
        END`);
        db.run(`CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
            INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END`);
        db.run(`CREATE TABLE IF NOT EXISTS embeddings (
            message_rowid INTEGER PRIMARY KEY,
            embedding BLOB NOT NULL
        )`);
    }

    if (currentVersion < 2) {
        // V1 → V2: Add new columns to messages, new tables
        // New columns on messages (use try/catch for idempotency — ALTER TABLE IF NOT EXISTS not supported)
        const existingCols = new Set(
            (db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name)
        );

        if (!existingCols.has("edited_date_unix")) {
            db.run("ALTER TABLE messages ADD COLUMN edited_date_unix INTEGER");
        }
        if (!existingCols.has("is_deleted")) {
            db.run("ALTER TABLE messages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0");
        }
        if (!existingCols.has("deleted_at_iso")) {
            db.run("ALTER TABLE messages ADD COLUMN deleted_at_iso TEXT");
        }
        if (!existingCols.has("reply_to_msg_id")) {
            db.run("ALTER TABLE messages ADD COLUMN reply_to_msg_id INTEGER");
        }

        // Chats table
        db.run(`CREATE TABLE IF NOT EXISTS chats (
            chat_id TEXT PRIMARY KEY,
            chat_type TEXT NOT NULL DEFAULT 'user',
            title TEXT NOT NULL,
            username TEXT,
            last_synced_at TEXT
        )`);

        // Message revisions (edit/delete history)
        db.run(`CREATE TABLE IF NOT EXISTS message_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            revision_type TEXT NOT NULL,
            old_text TEXT,
            new_text TEXT,
            revised_at_unix INTEGER NOT NULL,
            revised_at_iso TEXT NOT NULL
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_revisions_chat_msg ON message_revisions(chat_id, message_id)`);

        // Attachments
        db.run(`CREATE TABLE IF NOT EXISTS attachments (
            chat_id TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            attachment_index INTEGER NOT NULL,
            kind TEXT NOT NULL,
            mime_type TEXT,
            file_name TEXT,
            file_size INTEGER,
            telegram_file_id TEXT,
            is_downloaded INTEGER NOT NULL DEFAULT 0,
            local_path TEXT,
            sha256 TEXT,
            PRIMARY KEY (chat_id, message_id, attachment_index)
        )`);

        // Sync segments (date coverage tracking)
        db.run(`CREATE TABLE IF NOT EXISTS sync_segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            from_date_unix INTEGER NOT NULL,
            to_date_unix INTEGER NOT NULL,
            from_msg_id INTEGER NOT NULL,
            to_msg_id INTEGER NOT NULL,
            synced_at TEXT NOT NULL
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_sync_segments_chat ON sync_segments(chat_id, from_date_unix)`);
    }

    db.run(`PRAGMA user_version = 2`);
}
```

Also remove the old `initSchema()` method and update `open()` to call `this.migrate()` instead of `this.initSchema()`.

**Step 4: Run test to verify it passes**

```bash
bun test src/telegram/lib/__tests__/TelegramHistoryStore.migration.test.ts
```

Expected: PASS

**Step 5: Run full type check**

```bash
bunx tsgo --noEmit | rg "src/telegram"
```

Expected: no errors

**Step 6: Commit**

```bash
git add src/telegram/lib/TelegramHistoryStore.ts src/telegram/lib/__tests__/TelegramHistoryStore.migration.test.ts
git commit -m "feat(telegram): versioned schema migration with V2 tables"
```

---

## Task 4: Query Primitives — queryMessages()

**Files:**
- Modify: `src/telegram/lib/TelegramHistoryStore.ts`

**Step 1: Write query test**

Create `src/telegram/lib/__tests__/TelegramHistoryStore.query.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { TelegramHistoryStore } from "../TelegramHistoryStore";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

        // Seed test data
        store.insertMessages("chat1", [
            { id: 1, senderId: "user1", text: "hello from them", mediaDescription: undefined, isOutgoing: false, date: "2024-01-10T10:00:00Z", dateUnix: 1704880800 },
            { id: 2, senderId: "me", text: "hello back", mediaDescription: undefined, isOutgoing: true, date: "2024-01-10T10:01:00Z", dateUnix: 1704880860 },
            { id: 3, senderId: "user1", text: "how are you?", mediaDescription: undefined, isOutgoing: false, date: "2024-01-11T10:00:00Z", dateUnix: 1704967200 },
            { id: 4, senderId: "me", text: "I am good thanks", mediaDescription: undefined, isOutgoing: true, date: "2024-01-12T10:00:00Z", dateUnix: 1705053600 },
            { id: 5, senderId: "user1", text: "great to hear!", mediaDescription: undefined, isOutgoing: false, date: "2024-01-13T10:00:00Z", dateUnix: 1705140000 },
        ]);
    });

    afterEach(() => {
        store.close();
        if (existsSync(dbPath)) unlinkSync(dbPath);
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
        expect(results.length).toBe(2); // messages 3 and 4
    });

    it("filters by text regex", () => {
        const results = store.queryMessages("chat1", { textPattern: "hello" });
        expect(results.length).toBe(2); // messages 1 and 2
    });

    it("combines filters", () => {
        const results = store.queryMessages("chat1", {
            sender: "me",
            since: new Date("2024-01-10T00:00:00Z"),
            until: new Date("2024-01-11T00:00:00Z"),
        });
        expect(results.length).toBe(1); // only message 2
    });

    it("respects limit", () => {
        const results = store.queryMessages("chat1", { limit: 2 });
        expect(results.length).toBe(2);
    });

    it("excludes deleted messages by default", () => {
        // Mark message 3 as deleted
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
```

**Step 2: Run test to verify it fails**

```bash
bun test src/telegram/lib/__tests__/TelegramHistoryStore.query.test.ts
```

Expected: FAIL — `queryMessages` and `markMessageDeleted` don't exist

**Step 3: Implement queryMessages and markMessageDeleted on TelegramHistoryStore**

Add to `src/telegram/lib/TelegramHistoryStore.ts`:

```typescript
interface QueryOptions {
    sender?: "me" | "them" | "any";
    since?: Date;
    until?: Date;
    textPattern?: string;
    limit?: number;
    includeDeleted?: boolean;
}

queryMessages(chatId: string, options: QueryOptions): MessageRowV2[] {
    const db = this.db!;
    const conditions: string[] = ["chat_id = ?"];
    const params: (string | number)[] = [chatId];

    if (!options.includeDeleted) {
        conditions.push("is_deleted = 0");
    }

    if (options.sender === "me") {
        conditions.push("is_outgoing = 1");
    } else if (options.sender === "them") {
        conditions.push("is_outgoing = 0");
    }

    if (options.since) {
        conditions.push("date_unix >= ?");
        params.push(Math.floor(options.since.getTime() / 1000));
    }

    if (options.until) {
        conditions.push("date_unix <= ?");
        params.push(Math.floor(options.until.getTime() / 1000));
    }

    if (options.textPattern) {
        conditions.push("text LIKE ?");
        params.push(`%${options.textPattern}%`);
    }

    let sql = `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY date_unix ASC`;

    if (options.limit) {
        sql += ` LIMIT ?`;
        params.push(options.limit);
    }

    return db.query(sql).all(...params) as MessageRowV2[];
}

markMessageDeleted(chatId: string, messageId: number): void {
    const db = this.db!;
    const now = new Date();

    // Get current text before marking deleted
    const current = db.query("SELECT text FROM messages WHERE chat_id = ? AND id = ?").get(chatId, messageId) as { text: string | null } | null;

    db.run(
        "UPDATE messages SET is_deleted = 1, deleted_at_iso = ? WHERE chat_id = ? AND id = ?",
        now.toISOString(), chatId, messageId
    );

    // Record revision
    db.run(
        `INSERT INTO message_revisions (chat_id, message_id, revision_type, old_text, new_text, revised_at_unix, revised_at_iso)
         VALUES (?, ?, 'delete', ?, NULL, ?, ?)`,
        chatId, messageId, current?.text ?? null, Math.floor(now.getTime() / 1000), now.toISOString()
    );
}
```

Also export `QueryOptions` from types.ts.

**Step 4: Run test to verify it passes**

```bash
bun test src/telegram/lib/__tests__/TelegramHistoryStore.query.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/telegram/lib/TelegramHistoryStore.ts src/telegram/lib/__tests__/TelegramHistoryStore.query.test.ts src/telegram/lib/types.ts
git commit -m "feat(telegram): add queryMessages with filters and markMessageDeleted"
```

---

## Task 5: Upsert With Revision Tracking

**Files:**
- Modify: `src/telegram/lib/TelegramHistoryStore.ts`

**Step 1: Write the test**

Add to `src/telegram/lib/__tests__/TelegramHistoryStore.query.test.ts` (or create a new file `TelegramHistoryStore.revisions.test.ts`):

```typescript
describe("TelegramHistoryStore.upsertMessageWithRevision", () => {
    it("inserts new message and records create revision", () => {
        store.upsertMessageWithRevision("chat1", {
            id: 100, senderId: "user1", text: "new msg", mediaDescription: undefined,
            isOutgoing: false, date: "2024-02-01T10:00:00Z", dateUnix: 1706781600,
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
        // Insert original
        store.upsertMessageWithRevision("chat1", {
            id: 101, senderId: "user1", text: "original", mediaDescription: undefined,
            isOutgoing: false, date: "2024-02-01T10:00:00Z", dateUnix: 1706781600,
        });

        // Edit
        store.upsertMessageWithRevision("chat1", {
            id: 101, senderId: "user1", text: "edited!", mediaDescription: undefined,
            isOutgoing: false, date: "2024-02-01T10:00:00Z", dateUnix: 1706781600,
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
```

**Step 2: Run test to verify it fails**

```bash
bun test src/telegram/lib/__tests__/TelegramHistoryStore.revisions.test.ts
```

**Step 3: Implement upsertMessageWithRevision and getRevisions**

Add to `TelegramHistoryStore.ts`:

```typescript
interface UpsertMessage {
    id: number;
    senderId: string | undefined;
    text: string;
    mediaDescription: string | undefined;
    isOutgoing: boolean;
    date: string;
    dateUnix: number;
    editedDateUnix?: number;
    replyToMsgId?: number;
}

upsertMessageWithRevision(chatId: string, msg: UpsertMessage): void {
    const db = this.db!;
    const now = new Date();

    const existing = db.query(
        "SELECT text FROM messages WHERE chat_id = ? AND id = ?"
    ).get(chatId, msg.id) as { text: string | null } | null;

    if (existing) {
        // Update — record edit revision if text changed
        if (existing.text !== msg.text) {
            db.run(
                `INSERT INTO message_revisions (chat_id, message_id, revision_type, old_text, new_text, revised_at_unix, revised_at_iso)
                 VALUES (?, ?, 'edit', ?, ?, ?, ?)`,
                chatId, msg.id, existing.text, msg.text,
                msg.editedDateUnix ?? Math.floor(now.getTime() / 1000), now.toISOString()
            );
        }

        db.run(
            `UPDATE messages SET text = ?, media_desc = ?, edited_date_unix = ?, reply_to_msg_id = ? WHERE chat_id = ? AND id = ?`,
            msg.text, msg.mediaDescription ?? null, msg.editedDateUnix ?? null, msg.replyToMsgId ?? null,
            chatId, msg.id
        );
    } else {
        // Insert new
        db.run(
            `INSERT INTO messages (id, chat_id, sender_id, text, media_desc, is_outgoing, date_unix, date_iso, reply_to_msg_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            msg.id, chatId, msg.senderId ?? null, msg.text, msg.mediaDescription ?? null,
            msg.isOutgoing ? 1 : 0, msg.dateUnix, msg.date, msg.replyToMsgId ?? null
        );

        // Record create revision
        db.run(
            `INSERT INTO message_revisions (chat_id, message_id, revision_type, old_text, new_text, revised_at_unix, revised_at_iso)
             VALUES (?, ?, 'create', NULL, ?, ?, ?)`,
            chatId, msg.id, msg.text, msg.dateUnix, msg.date
        );
    }
}

getRevisions(chatId: string, messageId: number): MessageRevisionRow[] {
    const db = this.db!;
    return db.query(
        "SELECT * FROM message_revisions WHERE chat_id = ? AND message_id = ? ORDER BY revised_at_unix ASC"
    ).all(chatId, messageId) as MessageRevisionRow[];
}
```

**Step 4: Run test to verify it passes**

```bash
bun test src/telegram/lib/__tests__/TelegramHistoryStore.revisions.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/telegram/lib/TelegramHistoryStore.ts src/telegram/lib/__tests__/TelegramHistoryStore.revisions.test.ts
git commit -m "feat(telegram): upsert with revision tracking for edit history"
```

---

## Task 6: Attachment Metadata Methods

**Files:**
- Modify: `src/telegram/lib/TelegramHistoryStore.ts`

**Step 1: Write the test**

Create `src/telegram/lib/__tests__/TelegramHistoryStore.attachments.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { TelegramHistoryStore } from "../TelegramHistoryStore";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tmpDbPath() {
    return join(tmpdir(), `telegram-att-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("TelegramHistoryStore attachments", () => {
    let store: TelegramHistoryStore;
    let dbPath: string;

    beforeEach(() => {
        dbPath = tmpDbPath();
        store = new TelegramHistoryStore();
        store.open(dbPath);
    });

    afterEach(() => {
        store.close();
        if (existsSync(dbPath)) unlinkSync(dbPath);
    });

    it("upserts attachment metadata", () => {
        store.upsertAttachment({
            chat_id: "chat1",
            message_id: 1,
            attachment_index: 0,
            kind: "photo",
            mime_type: "image/jpeg",
            file_name: null,
            file_size: 1024,
            telegram_file_id: "abc123",
        });

        const atts = store.getAttachments("chat1", 1);
        expect(atts.length).toBe(1);
        expect(atts[0].kind).toBe("photo");
        expect(atts[0].is_downloaded).toBe(0);
    });

    it("lists attachments for a chat", () => {
        store.upsertAttachment({ chat_id: "chat1", message_id: 1, attachment_index: 0, kind: "photo", mime_type: "image/jpeg", file_name: null, file_size: 1024, telegram_file_id: "a" });
        store.upsertAttachment({ chat_id: "chat1", message_id: 2, attachment_index: 0, kind: "video", mime_type: "video/mp4", file_name: "vid.mp4", file_size: 5000, telegram_file_id: "b" });
        store.upsertAttachment({ chat_id: "chat1", message_id: 2, attachment_index: 1, kind: "document", mime_type: "application/pdf", file_name: "doc.pdf", file_size: 2000, telegram_file_id: "c" });

        const all = store.listAttachments("chat1");
        expect(all.length).toBe(3);

        const forMsg2 = store.getAttachments("chat1", 2);
        expect(forMsg2.length).toBe(2);
    });

    it("marks attachment as downloaded", () => {
        store.upsertAttachment({ chat_id: "chat1", message_id: 1, attachment_index: 0, kind: "photo", mime_type: "image/jpeg", file_name: null, file_size: 1024, telegram_file_id: "a" });

        store.markAttachmentDownloaded("chat1", 1, 0, "/path/to/file.jpg", "sha256hash");

        const atts = store.getAttachments("chat1", 1);
        expect(atts[0].is_downloaded).toBe(1);
        expect(atts[0].local_path).toBe("/path/to/file.jpg");
        expect(atts[0].sha256).toBe("sha256hash");
    });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test src/telegram/lib/__tests__/TelegramHistoryStore.attachments.test.ts
```

**Step 3: Implement attachment methods**

Add to `TelegramHistoryStore.ts`:

```typescript
interface UpsertAttachmentInput {
    chat_id: string;
    message_id: number;
    attachment_index: number;
    kind: string;
    mime_type: string | null;
    file_name: string | null;
    file_size: number | null;
    telegram_file_id: string | null;
}

upsertAttachment(input: UpsertAttachmentInput): void {
    const db = this.db!;
    db.run(
        `INSERT OR REPLACE INTO attachments (chat_id, message_id, attachment_index, kind, mime_type, file_name, file_size, telegram_file_id, is_downloaded, local_path, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT is_downloaded FROM attachments WHERE chat_id = ? AND message_id = ? AND attachment_index = ?), 0),
                 (SELECT local_path FROM attachments WHERE chat_id = ? AND message_id = ? AND attachment_index = ?),
                 (SELECT sha256 FROM attachments WHERE chat_id = ? AND message_id = ? AND attachment_index = ?))`,
        input.chat_id, input.message_id, input.attachment_index, input.kind, input.mime_type, input.file_name, input.file_size, input.telegram_file_id,
        input.chat_id, input.message_id, input.attachment_index,
        input.chat_id, input.message_id, input.attachment_index,
        input.chat_id, input.message_id, input.attachment_index
    );
}

getAttachments(chatId: string, messageId: number): AttachmentRow[] {
    const db = this.db!;
    return db.query(
        "SELECT * FROM attachments WHERE chat_id = ? AND message_id = ? ORDER BY attachment_index ASC"
    ).all(chatId, messageId) as AttachmentRow[];
}

listAttachments(chatId: string, options?: { since?: Date; until?: Date; kind?: string }): AttachmentRow[] {
    const db = this.db!;
    const conditions = ["a.chat_id = ?"];
    const params: (string | number)[] = [chatId];

    if (options?.kind) {
        conditions.push("a.kind = ?");
        params.push(options.kind);
    }

    // Join with messages for date filtering
    let sql = `SELECT a.* FROM attachments a`;

    if (options?.since || options?.until) {
        sql += ` JOIN messages m ON a.chat_id = m.chat_id AND a.message_id = m.id`;
        if (options.since) {
            conditions.push("m.date_unix >= ?");
            params.push(Math.floor(options.since.getTime() / 1000));
        }
        if (options.until) {
            conditions.push("m.date_unix <= ?");
            params.push(Math.floor(options.until.getTime() / 1000));
        }
    }

    sql += ` WHERE ${conditions.join(" AND ")} ORDER BY a.message_id ASC, a.attachment_index ASC`;

    return db.query(sql).all(...params) as AttachmentRow[];
}

markAttachmentDownloaded(chatId: string, messageId: number, attachmentIndex: number, localPath: string, sha256: string): void {
    const db = this.db!;
    db.run(
        "UPDATE attachments SET is_downloaded = 1, local_path = ?, sha256 = ? WHERE chat_id = ? AND message_id = ? AND attachment_index = ?",
        localPath, sha256, chatId, messageId, attachmentIndex
    );
}
```

**Step 4: Run test to verify it passes**

```bash
bun test src/telegram/lib/__tests__/TelegramHistoryStore.attachments.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/telegram/lib/TelegramHistoryStore.ts src/telegram/lib/__tests__/TelegramHistoryStore.attachments.test.ts
git commit -m "feat(telegram): attachment metadata storage and query methods"
```

---

## Task 7: Sync Segment Tracking

**Files:**
- Modify: `src/telegram/lib/TelegramHistoryStore.ts`

**Step 1: Write the test**

Create `src/telegram/lib/__tests__/SyncSegments.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { TelegramHistoryStore } from "../TelegramHistoryStore";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tmpDbPath() {
    return join(tmpdir(), `telegram-seg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("Sync segment tracking", () => {
    let store: TelegramHistoryStore;
    let dbPath: string;

    beforeEach(() => {
        dbPath = tmpDbPath();
        store = new TelegramHistoryStore();
        store.open(dbPath);
    });

    afterEach(() => {
        store.close();
        if (existsSync(dbPath)) unlinkSync(dbPath);
    });

    it("inserts a sync segment", () => {
        store.insertSyncSegment("chat1", {
            fromDateUnix: 1700000000,
            toDateUnix: 1700086400,
            fromMsgId: 1,
            toMsgId: 100,
        });

        const segments = store.getSyncSegments("chat1");
        expect(segments.length).toBe(1);
        expect(segments[0].from_msg_id).toBe(1);
        expect(segments[0].to_msg_id).toBe(100);
    });

    it("detects missing segments (gap in coverage)", () => {
        // We have coverage for day 1 and day 3, but not day 2
        store.insertSyncSegment("chat1", {
            fromDateUnix: 1700000000, // Nov 14 00:00
            toDateUnix: 1700086400,   // Nov 15 00:00
            fromMsgId: 1, toMsgId: 50,
        });
        store.insertSyncSegment("chat1", {
            fromDateUnix: 1700172800, // Nov 16 00:00
            toDateUnix: 1700259200,   // Nov 17 00:00
            fromMsgId: 100, toMsgId: 150,
        });

        // Query for full range Nov 14 - Nov 17
        const gaps = store.getMissingSegments("chat1", 1700000000, 1700259200);
        expect(gaps.length).toBe(1);
        expect(gaps[0].fromDateUnix).toBe(1700086400); // gap starts Nov 15
        expect(gaps[0].toDateUnix).toBe(1700172800);   // gap ends Nov 16
    });

    it("returns empty when fully covered", () => {
        store.insertSyncSegment("chat1", {
            fromDateUnix: 1700000000,
            toDateUnix: 1700259200,
            fromMsgId: 1, toMsgId: 150,
        });

        const gaps = store.getMissingSegments("chat1", 1700000000, 1700259200);
        expect(gaps.length).toBe(0);
    });

    it("returns full range when no segments exist", () => {
        const gaps = store.getMissingSegments("chat1", 1700000000, 1700259200);
        expect(gaps.length).toBe(1);
        expect(gaps[0].fromDateUnix).toBe(1700000000);
        expect(gaps[0].toDateUnix).toBe(1700259200);
    });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test src/telegram/lib/__tests__/SyncSegments.test.ts
```

**Step 3: Implement sync segment methods**

Add to `TelegramHistoryStore.ts`:

```typescript
interface InsertSegmentInput {
    fromDateUnix: number;
    toDateUnix: number;
    fromMsgId: number;
    toMsgId: number;
}

interface DateRange {
    fromDateUnix: number;
    toDateUnix: number;
}

insertSyncSegment(chatId: string, input: InsertSegmentInput): void {
    const db = this.db!;
    db.run(
        `INSERT INTO sync_segments (chat_id, from_date_unix, to_date_unix, from_msg_id, to_msg_id, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        chatId, input.fromDateUnix, input.toDateUnix, input.fromMsgId, input.toMsgId, new Date().toISOString()
    );
}

getSyncSegments(chatId: string): SyncSegmentRow[] {
    const db = this.db!;
    return db.query(
        "SELECT * FROM sync_segments WHERE chat_id = ? ORDER BY from_date_unix ASC"
    ).all(chatId) as SyncSegmentRow[];
}

getMissingSegments(chatId: string, fromDateUnix: number, toDateUnix: number): DateRange[] {
    const segments = this.getSyncSegments(chatId);
    const gaps: DateRange[] = [];

    // Sort segments by start date
    const sorted = segments
        .filter((s) => s.to_date_unix > fromDateUnix && s.from_date_unix < toDateUnix)
        .sort((a, b) => a.from_date_unix - b.from_date_unix);

    if (sorted.length === 0) {
        return [{ fromDateUnix, toDateUnix }];
    }

    // Check gap before first segment
    if (sorted[0].from_date_unix > fromDateUnix) {
        gaps.push({ fromDateUnix, toDateUnix: sorted[0].from_date_unix });
    }

    // Check gaps between segments
    for (let i = 0; i < sorted.length - 1; i++) {
        const currentEnd = sorted[i].to_date_unix;
        const nextStart = sorted[i + 1].from_date_unix;
        if (nextStart > currentEnd) {
            gaps.push({ fromDateUnix: currentEnd, toDateUnix: nextStart });
        }
    }

    // Check gap after last segment
    const lastEnd = sorted[sorted.length - 1].to_date_unix;
    if (lastEnd < toDateUnix) {
        gaps.push({ fromDateUnix: lastEnd, toDateUnix });
    }

    return gaps;
}
```

**Step 4: Run test to verify it passes**

```bash
bun test src/telegram/lib/__tests__/SyncSegments.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/telegram/lib/TelegramHistoryStore.ts src/telegram/lib/__tests__/SyncSegments.test.ts
git commit -m "feat(telegram): sync segment tracking with gap detection"
```

---

## Task 8: Chat Table Methods

**Files:**
- Modify: `src/telegram/lib/TelegramHistoryStore.ts`

**Step 1: Write the test**

Add a small test for chat upsert:

```typescript
describe("TelegramHistoryStore chats", () => {
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
        store.upsertChat({ chat_id: "3", chat_type: "channel", title: "News", username: "news" });

        const users = store.listChats("user");
        expect(users.length).toBe(1);

        const all = store.listChats();
        expect(all.length).toBe(3);
    });
});
```

**Step 2: Implement**

```typescript
upsertChat(input: { chat_id: string; chat_type: string; title: string; username: string | null }): void {
    const db = this.db!;
    db.run(
        `INSERT INTO chats (chat_id, chat_type, title, username) VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET chat_type = excluded.chat_type, title = excluded.title, username = excluded.username`,
        input.chat_id, input.chat_type, input.title, input.username
    );
}

getChat(chatId: string): ChatRow | null {
    const db = this.db!;
    return (db.query("SELECT * FROM chats WHERE chat_id = ?").get(chatId) as ChatRow) ?? null;
}

listChats(type?: string): ChatRow[] {
    const db = this.db!;
    if (type) {
        return db.query("SELECT * FROM chats WHERE chat_type = ? ORDER BY title").all(type) as ChatRow[];
    }
    return db.query("SELECT * FROM chats ORDER BY chat_type, title").all() as ChatRow[];
}
```

**Step 3: Run tests, commit**

```bash
bun test src/telegram/lib/__tests__/
git add src/telegram/lib/TelegramHistoryStore.ts src/telegram/lib/__tests__/
git commit -m "feat(telegram): chat metadata storage (user/group/channel)"
```

---

## Task 9: Natural Language Date Parser Utility

**Files:**
- Create: `src/telegram/lib/DateParser.ts`

**Step 1: Write the test**

Create `src/telegram/lib/__tests__/DateParser.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { parseDate, parseDateRange } from "../DateParser";

describe("DateParser", () => {
    it("parses ISO dates", () => {
        const d = parseDate("2024-01-15");
        expect(d).toBeInstanceOf(Date);
        expect(d!.getFullYear()).toBe(2024);
    });

    it("parses natural language 'yesterday'", () => {
        const d = parseDate("yesterday");
        expect(d).toBeInstanceOf(Date);
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        expect(d!.toDateString()).toBe(yesterday.toDateString());
    });

    it("parses '3 days ago'", () => {
        const d = parseDate("3 days ago");
        expect(d).toBeInstanceOf(Date);
    });

    it("parses 'last week'", () => {
        const d = parseDate("last week");
        expect(d).toBeInstanceOf(Date);
    });

    it("returns null for unparseable input", () => {
        const d = parseDate("not a date at all xyz");
        expect(d).toBeNull();
    });

    it("parseDateRange handles 'since X until Y'", () => {
        const range = parseDateRange({ since: "2024-01-01", until: "2024-01-31" });
        expect(range.since).toBeInstanceOf(Date);
        expect(range.until).toBeInstanceOf(Date);
        expect(range.since!.getMonth()).toBe(0); // January
    });

    it("parseDateRange handles natural language", () => {
        const range = parseDateRange({ since: "last week" });
        expect(range.since).toBeInstanceOf(Date);
        expect(range.until).toBeUndefined();
    });
});
```

**Step 2: Implement DateParser.ts**

```typescript
import * as chrono from "chrono-node";

export function parseDate(input: string): Date | null {
    if (!input) {
        return null;
    }

    // Try ISO first
    const isoDate = new Date(input);
    if (!Number.isNaN(isoDate.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(input)) {
        return isoDate;
    }

    // Try chrono natural language
    const results = chrono.parse(input);
    if (results.length > 0) {
        return results[0].start.date();
    }

    return null;
}

export function parseDateRange(input: { since?: string; until?: string }): {
    since?: Date;
    until?: Date;
} {
    return {
        since: input.since ? parseDate(input.since) ?? undefined : undefined,
        until: input.until ? parseDate(input.until) ?? undefined : undefined,
    };
}
```

**Step 3: Run test**

```bash
bun test src/telegram/lib/__tests__/DateParser.test.ts
```

Expected: PASS

**Step 4: Commit**

```bash
git add src/telegram/lib/DateParser.ts src/telegram/lib/__tests__/DateParser.test.ts
git commit -m "feat(telegram): natural language date parsing with chrono-node"
```

---

## Task 10: Suggestion Tracking Table

**Files:**
- Modify: `src/telegram/lib/TelegramHistoryStore.ts`

This table stores AI suggestion vs. user edit pairs for the feedback loop (Phase 5).

**Step 1: Add to migration (in the V2 block)**

Add to the `currentVersion < 2` migration block:

```sql
CREATE TABLE IF NOT EXISTS suggestion_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    message_id INTEGER,
    suggested_text TEXT NOT NULL,
    edited_text TEXT NOT NULL,
    sent_text TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suggestion_edits_chat ON suggestion_edits(chat_id);
```

**Step 2: Add store methods**

```typescript
insertSuggestionEdit(input: {
    chatId: string;
    messageId: number | null;
    suggestedText: string;
    editedText: string;
    sentText: string;
    provider: string | null;
    model: string | null;
}): void {
    const db = this.db!;
    db.run(
        `INSERT INTO suggestion_edits (chat_id, message_id, suggested_text, edited_text, sent_text, provider, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.chatId, input.messageId, input.suggestedText, input.editedText, input.sentText,
        input.provider, input.model, new Date().toISOString()
    );
}

getRecentSuggestionEdits(chatId: string, limit = 10): Array<{
    suggested_text: string;
    edited_text: string;
    sent_text: string;
    created_at: string;
}> {
    const db = this.db!;
    return db.query(
        `SELECT suggested_text, edited_text, sent_text, created_at
         FROM suggestion_edits WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(chatId, limit) as any[];
}
```

**Step 3: Test, commit**

```bash
bun test src/telegram/lib/__tests__/
bunx tsgo --noEmit | rg "src/telegram"
git add src/telegram/lib/TelegramHistoryStore.ts
git commit -m "feat(telegram): suggestion edit tracking table for feedback loop"
```

---

## Task 11: Final Phase 1 Verification

**Step 1: Run all telegram tests**

```bash
bun test src/telegram/
```

Expected: all pass

**Step 2: Type check**

```bash
bunx tsgo --noEmit | rg "src/telegram"
```

Expected: no errors

**Step 3: Lint**

```bash
bunx biome check src/telegram
```

Fix any issues.

**Step 4: Commit any fixes**

```bash
git add src/telegram/
git commit -m "fix(telegram): lint and type fixes for Phase 1"
```

---

## Summary of Phase 1 Deliverables

| Component | Status |
|-----------|--------|
| chrono-node installed | Task 1 |
| V2 type definitions (MessageRowV2, ChatRow, AttachmentRow, etc.) | Task 2 |
| Versioned schema migration (PRAGMA user_version) | Task 3 |
| queryMessages() with sender/date/text/deleted filters | Task 4 |
| upsertMessageWithRevision() + getRevisions() | Task 5 |
| Attachment metadata CRUD | Task 6 |
| Sync segment tracking + gap detection | Task 7 |
| Chat metadata (user/group/channel) | Task 8 |
| Natural language date parser | Task 9 |
| Suggestion edit tracking table | Task 10 |

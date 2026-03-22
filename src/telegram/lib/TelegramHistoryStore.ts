import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import logger from "@app/logger";
import { FTS5SearchEngine } from "@app/utils/search";
import { vectorSearch } from "@app/utils/search/drivers/sqlite-fts5/vector";
import type { SerializedMessage } from "./TelegramMessage";
import type {
    AttachmentRow,
    ChatRow,
    ChatStats,
    DateRange,
    InsertSegmentInput,
    MessageRevisionRow,
    MessageRow,
    MessageRowV2,
    QueryOptions,
    SearchOptions,
    SearchResult,
    SuggestionEditInput,
    SuggestionEditRow,
    SyncSegmentRow,
    SyncStateRow,
    UpsertAttachmentInput,
    UpsertMessageInput,
} from "./types";

const DB_PATH = join(homedir(), ".genesis-tools", "telegram", "history.db");

/** MessageRow with index signature so it satisfies Record<string, unknown> for FTS5SearchEngine */
type IndexableMessageRow = MessageRow & Record<string, unknown>;

export class TelegramHistoryStore {
    private db: Database | null = null;
    private searchEngine: FTS5SearchEngine<IndexableMessageRow> | null = null;

    open(dbPath: string = DB_PATH): void {
        if (this.db) {
            return;
        }

        const dir = dirname(dbPath);

        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(dbPath);
        this.db.run("PRAGMA journal_mode = WAL");
        this.db.run("PRAGMA foreign_keys = ON");

        this.migrate();
        this.initSearchEngine();
        logger.debug("TelegramHistoryStore opened");
    }

    close(): void {
        if (this.db) {
            this.searchEngine = null;
            this.db.close();
            this.db = null;
            logger.debug("TelegramHistoryStore closed");
        }
    }

    private getDb(): Database {
        if (!this.db) {
            throw new Error("TelegramHistoryStore not opened. Call open() first.");
        }

        return this.db;
    }

    private getSearchEngine(): FTS5SearchEngine<IndexableMessageRow> {
        if (!this.searchEngine) {
            throw new Error("Search engine not initialized. Call open() first.");
        }

        return this.searchEngine;
    }

    private initSearchEngine(): void {
        const db = this.getDb();

        this.searchEngine = FTS5SearchEngine.fromDatabase<IndexableMessageRow>(db, {
            tableName: "messages",
            schema: {
                textFields: ["text"],
                idField: "rowid" as keyof MessageRow & string,
            },
            skipSchemaInit: true,
            tableOverrides: {
                contentTable: "messages",
                ftsTable: "messages_fts",
                embeddingsTable: "embeddings",
                embeddingsDocIdColumn: "message_rowid",
            },
        });
    }

    private buildSearchFilters(
        chatId: string,
        options: SearchOptions
    ): { sql: string; params: Array<string | number> } {
        const conditions: string[] = ["c.chat_id = ?"];
        const params: Array<string | number> = [chatId];

        if (options.since) {
            conditions.push("c.date_unix >= ?");
            params.push(Math.floor(options.since.getTime() / 1000));
        }

        if (options.until) {
            conditions.push("c.date_unix <= ?");
            params.push(Math.floor(options.until.getTime() / 1000));
        }

        return { sql: conditions.join(" AND "), params };
    }

    private migrate(): void {
        const db = this.getDb();
        const { user_version: currentVersion } = db.query("PRAGMA user_version").get() as {
            user_version: number;
        };

        if (currentVersion < 1) {
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

            try {
                db.run(`CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
                    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
                END`);
            } catch {
                // trigger already exists
            }

            try {
                db.run(`CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
                END`);
            } catch {
                // trigger already exists
            }

            try {
                db.run(`CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
                    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
                END`);
            } catch {
                // trigger already exists
            }

            db.run(`CREATE TABLE IF NOT EXISTS embeddings (
                message_rowid INTEGER PRIMARY KEY,
                embedding BLOB NOT NULL
            )`);
        }

        if (currentVersion < 2) {
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

            db.run(`CREATE TABLE IF NOT EXISTS chats (
                chat_id TEXT PRIMARY KEY,
                chat_type TEXT NOT NULL DEFAULT 'user',
                title TEXT NOT NULL,
                username TEXT,
                last_synced_at TEXT
            )`);

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

            db.run(`CREATE TABLE IF NOT EXISTS suggestion_edits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                message_id INTEGER,
                suggested_text TEXT NOT NULL,
                edited_text TEXT NOT NULL,
                sent_text TEXT NOT NULL,
                provider TEXT,
                model TEXT,
                created_at TEXT NOT NULL
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_suggestion_edits_chat ON suggestion_edits(chat_id)`);
        }

        db.run("PRAGMA user_version = 2");
    }

    // ── Insert ────────────────────────────────────────────────────────

    insertMessages(chatId: string, messages: SerializedMessage[]): number {
        const db = this.getDb();
        let inserted = 0;

        const insertStmt = db.prepare(`
			INSERT OR IGNORE INTO messages (id, chat_id, sender_id, text, media_desc, is_outgoing, date_unix, date_iso)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);

        const insertMany = db.transaction(() => {
            for (const msg of messages) {
                const result = insertStmt.run(
                    msg.id,
                    chatId,
                    msg.senderId ?? null,
                    msg.text || null,
                    msg.mediaDescription ?? null,
                    msg.isOutgoing ? 1 : 0,
                    msg.dateUnix,
                    msg.date
                );

                if (result.changes > 0) {
                    inserted++;
                }
            }
        });

        insertMany();
        return inserted;
    }

    // ── Embeddings ────────────────────────────────────────────────────

    getUnembeddedMessages(chatId: string, limit = 500): MessageRow[] {
        const db = this.getDb();

        return db
            .query(`
			SELECT m.*
			FROM messages m
			LEFT JOIN embeddings e ON e.message_rowid = m.rowid
			WHERE m.chat_id = ?
				AND m.text IS NOT NULL
				AND m.text != ''
				AND e.message_rowid IS NULL
			ORDER BY m.date_unix ASC
			LIMIT ?
		`)
            .all(chatId, limit) as MessageRow[];
    }

    insertEmbedding(chatId: string, messageId: number, embedding: Float32Array): void {
        const db = this.getDb();

        const row = db.query("SELECT rowid FROM messages WHERE chat_id = ? AND id = ?").get(chatId, messageId) as {
            rowid: number;
        } | null;

        if (!row) {
            return;
        }

        db.run("INSERT OR REPLACE INTO embeddings (message_rowid, embedding) VALUES (?, ?)", [
            row.rowid,
            Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
        ]);
    }

    getEmbeddedCount(chatId: string): number {
        const db = this.getDb();

        const row = db
            .query(`
			SELECT COUNT(*) AS cnt
			FROM embeddings e
			JOIN messages m ON m.rowid = e.message_rowid
			WHERE m.chat_id = ?
		`)
            .get(chatId) as { cnt: number };

        return row.cnt;
    }

    // ── Search ────────────────────────────────────────────────────────

    search(chatId: string, query: string, options: SearchOptions = {}): SearchResult[] {
        const engine = this.getSearchEngine();
        const limit = options.limit ?? 20;
        const filters = this.buildSearchFilters(chatId, options);

        const results = engine.bm25Search(query, limit, undefined, filters);

        return results.map((r) => ({
            message: r.doc,
            rank: -r.score,
        }));
    }

    semanticSearch(chatId: string, queryEmbedding: Float32Array, options: SearchOptions = {}): SearchResult[] {
        const db = this.getDb();
        const limit = options.limit ?? 20;

        let dateFilter = "";
        const params: (string | number)[] = [chatId];

        if (options.since) {
            dateFilter += " AND m.date_unix >= ?";
            params.push(Math.floor(options.since.getTime() / 1000));
        }

        if (options.until) {
            dateFilter += " AND m.date_unix <= ?";
            params.push(Math.floor(options.until.getTime() / 1000));
        }

        const hits = vectorSearch(db, "messages", queryEmbedding, limit * 5, {
            table: "embeddings",
            docIdColumn: "message_rowid",
        });

        const results: SearchResult[] = [];

        for (const hit of hits) {
            const row = db
                .query(`SELECT m.* FROM messages m WHERE m.rowid = ? AND m.chat_id = ?${dateFilter}`)
                .get(hit.docId, ...params) as MessageRow | null;

            if (row) {
                results.push({
                    message: row,
                    distance: hit.distance,
                });
            }

            if (results.length >= limit) {
                break;
            }
        }

        return results;
    }

    hybridSearch(
        chatId: string,
        query: string,
        queryEmbedding: Float32Array,
        options: SearchOptions = {}
    ): SearchResult[] {
        const ftsResults = this.search(chatId, query, { ...options, limit: 100 });
        const vecResults = this.semanticSearch(chatId, queryEmbedding, { ...options, limit: 100 });

        // Reciprocal Rank Fusion (k=60) — same algorithm as shared FTS5 engine
        const K = 60;
        const scores = new Map<number, { score: number; row: MessageRow }>();

        for (let i = 0; i < ftsResults.length; i++) {
            const r = ftsResults[i];
            const rrfScore = 1.0 / (K + i + 1);
            const existing = scores.get(r.message.id);

            if (existing) {
                existing.score += rrfScore;
            } else {
                scores.set(r.message.id, { score: rrfScore, row: r.message });
            }
        }

        for (let i = 0; i < vecResults.length; i++) {
            const r = vecResults[i];
            const rrfScore = 1.0 / (K + i + 1);
            const existing = scores.get(r.message.id);

            if (existing) {
                existing.score += rrfScore;
            } else {
                scores.set(r.message.id, { score: rrfScore, row: r.message });
            }
        }

        const limit = options.limit ?? 20;

        return [...scores.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map((entry) => ({
                message: entry.row,
                score: entry.score,
            }));
    }

    // ── Date Range Queries ────────────────────────────────────────────

    getByDateRange(chatId: string, since?: Date, until?: Date, limit?: number): MessageRow[] {
        const db = this.getDb();
        const params: (string | number)[] = [chatId];
        let dateFilter = "";

        if (since) {
            dateFilter += " AND date_unix >= ?";
            params.push(Math.floor(since.getTime() / 1000));
        }

        if (until) {
            dateFilter += " AND date_unix <= ?";
            params.push(Math.floor(until.getTime() / 1000));
        }

        const limitClause = limit ? " LIMIT ?" : "";

        if (limit) {
            params.push(limit);
        }

        return db
            .query(`
			SELECT * FROM messages
			WHERE chat_id = ? ${dateFilter}
			ORDER BY date_unix ASC
			${limitClause}
		`)
            .all(...params) as MessageRow[];
    }

    // ── Sync State ────────────────────────────────────────────────────

    getLastSyncedId(chatId: string): number | null {
        const db = this.getDb();
        const row = db
            .query("SELECT last_synced_id FROM sync_state WHERE chat_id = ?")
            .get(chatId) as SyncStateRow | null;

        return row?.last_synced_id ?? null;
    }

    setLastSyncedId(chatId: string, messageId: number): void {
        const db = this.getDb();

        db.run(
            `
			INSERT INTO sync_state (chat_id, last_synced_id, last_synced_at)
			VALUES (?, ?, datetime('now'))
			ON CONFLICT(chat_id) DO UPDATE SET
				last_synced_id = excluded.last_synced_id,
				last_synced_at = excluded.last_synced_at
		`,
            [chatId, messageId]
        );
    }

    // ── Query Primitives (V2) ────────────────────────────────────────

    queryMessages(chatId: string, options: QueryOptions): MessageRowV2[] {
        const db = this.getDb();
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

        const order = options.limit ? "DESC" : "ASC";
        let sql = `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY date_unix ${order}`;

        if (options.limit) {
            sql += " LIMIT ?";
            params.push(options.limit);
        }

        const rows = db.query(sql).all(...params) as MessageRowV2[];

        // DESC + LIMIT gives us the *last* N rows; reverse back to chronological for display
        if (options.limit) {
            rows.reverse();
        }

        return rows;
    }

    countMessages(chatId: string, options: QueryOptions): number {
        const db = this.getDb();
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

        const row = db
            .query(`SELECT COUNT(*) AS count FROM messages WHERE ${conditions.join(" AND ")}`)
            .get(...params) as {
            count: number;
        };
        return row.count;
    }

    findMessageById(messageId: number, chatId?: string): { chat_id: string } | null {
        const db = this.getDb();

        if (chatId) {
            return (
                (db
                    .query("SELECT chat_id FROM messages WHERE chat_id = ? AND id = ? LIMIT 1")
                    .get(chatId, messageId) as {
                    chat_id: string;
                }) ?? null
            );
        }

        const rows = db
            .query("SELECT chat_id FROM messages WHERE id = ? GROUP BY chat_id LIMIT 2")
            .all(messageId) as Array<{
            chat_id: string;
        }>;
        return rows.length === 1 ? rows[0] : null;
    }

    markMessageDeleted(chatId: string, messageId: number): void {
        const db = this.getDb();
        const now = new Date();

        const current = db.query("SELECT text FROM messages WHERE chat_id = ? AND id = ?").get(chatId, messageId) as {
            text: string | null;
        } | null;

        const updateResult = db.run(
            "UPDATE messages SET is_deleted = 1, deleted_at_iso = ? WHERE chat_id = ? AND id = ?",
            [now.toISOString(), chatId, messageId]
        );

        if (updateResult.changes === 0) {
            return;
        }

        db.run(
            `INSERT INTO message_revisions (chat_id, message_id, revision_type, old_text, new_text, revised_at_unix, revised_at_iso)
             VALUES (?, ?, 'delete', ?, NULL, ?, ?)`,
            [chatId, messageId, current?.text ?? null, Math.floor(now.getTime() / 1000), now.toISOString()]
        );
    }

    // ── Upsert With Revision Tracking ────────────────────────────────

    upsertMessageWithRevision(chatId: string, msg: UpsertMessageInput): void {
        const db = this.getDb();
        const now = new Date();

        const existing = db.query("SELECT text FROM messages WHERE chat_id = ? AND id = ?").get(chatId, msg.id) as {
            text: string | null;
        } | null;

        if (existing) {
            if (existing.text !== msg.text) {
                db.run(
                    `INSERT INTO message_revisions (chat_id, message_id, revision_type, old_text, new_text, revised_at_unix, revised_at_iso)
                     VALUES (?, ?, 'edit', ?, ?, ?, ?)`,
                    [
                        chatId,
                        msg.id,
                        existing.text,
                        msg.text,
                        msg.editedDateUnix ?? Math.floor(now.getTime() / 1000),
                        now.toISOString(),
                    ]
                );
            }

            db.run(
                `UPDATE messages SET text = ?, media_desc = ?, edited_date_unix = ?, reply_to_msg_id = ? WHERE chat_id = ? AND id = ?`,
                [
                    msg.text,
                    msg.mediaDescription ?? null,
                    msg.editedDateUnix ?? null,
                    msg.replyToMsgId ?? null,
                    chatId,
                    msg.id,
                ]
            );
        } else {
            db.run(
                `INSERT INTO messages (id, chat_id, sender_id, text, media_desc, is_outgoing, date_unix, date_iso, reply_to_msg_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    msg.id,
                    chatId,
                    msg.senderId ?? null,
                    msg.text,
                    msg.mediaDescription ?? null,
                    msg.isOutgoing ? 1 : 0,
                    msg.dateUnix,
                    msg.date,
                    msg.replyToMsgId ?? null,
                ]
            );

            db.run(
                `INSERT INTO message_revisions (chat_id, message_id, revision_type, old_text, new_text, revised_at_unix, revised_at_iso)
                 VALUES (?, ?, 'create', NULL, ?, ?, ?)`,
                [chatId, msg.id, msg.text, msg.dateUnix, msg.date]
            );
        }
    }

    getRevisions(chatId: string, messageId: number): MessageRevisionRow[] {
        const db = this.getDb();
        return db
            .query("SELECT * FROM message_revisions WHERE chat_id = ? AND message_id = ? ORDER BY revised_at_unix ASC")
            .all(chatId, messageId) as MessageRevisionRow[];
    }

    // ── Attachments ──────────────────────────────────────────────────

    upsertAttachment(input: UpsertAttachmentInput): void {
        const db = this.getDb();
        db.run(
            `INSERT OR REPLACE INTO attachments (chat_id, message_id, attachment_index, kind, mime_type, file_name, file_size, telegram_file_id, is_downloaded, local_path, sha256)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                     COALESCE((SELECT is_downloaded FROM attachments WHERE chat_id = ? AND message_id = ? AND attachment_index = ?), 0),
                     (SELECT local_path FROM attachments WHERE chat_id = ? AND message_id = ? AND attachment_index = ?),
                     (SELECT sha256 FROM attachments WHERE chat_id = ? AND message_id = ? AND attachment_index = ?))`,
            [
                input.chat_id,
                input.message_id,
                input.attachment_index,
                input.kind,
                input.mime_type,
                input.file_name,
                input.file_size,
                input.telegram_file_id,
                input.chat_id,
                input.message_id,
                input.attachment_index,
                input.chat_id,
                input.message_id,
                input.attachment_index,
                input.chat_id,
                input.message_id,
                input.attachment_index,
            ]
        );
    }

    getAttachments(chatId: string, messageId: number): AttachmentRow[] {
        const db = this.getDb();
        return db
            .query("SELECT * FROM attachments WHERE chat_id = ? AND message_id = ? ORDER BY attachment_index ASC")
            .all(chatId, messageId) as AttachmentRow[];
    }

    listAttachments(chatId: string, options?: { since?: Date; until?: Date; kind?: string }): AttachmentRow[] {
        const db = this.getDb();
        const conditions = ["a.chat_id = ?"];
        const params: (string | number)[] = [chatId];

        if (options?.kind) {
            conditions.push("a.kind = ?");
            params.push(options.kind);
        }

        let sql = "SELECT a.* FROM attachments a";

        if (options?.since || options?.until) {
            sql += " JOIN messages m ON a.chat_id = m.chat_id AND a.message_id = m.id";

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

    markAttachmentDownloaded(
        chatId: string,
        messageId: number,
        attachmentIndex: number,
        localPath: string,
        sha256: string
    ): void {
        const db = this.getDb();
        db.run(
            "UPDATE attachments SET is_downloaded = 1, local_path = ?, sha256 = ? WHERE chat_id = ? AND message_id = ? AND attachment_index = ?",
            [localPath, sha256, chatId, messageId, attachmentIndex]
        );
    }

    // ── Sync Segments ────────────────────────────────────────────────

    insertSyncSegment(chatId: string, input: InsertSegmentInput): void {
        const db = this.getDb();
        db.run(
            `INSERT INTO sync_segments (chat_id, from_date_unix, to_date_unix, from_msg_id, to_msg_id, synced_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [chatId, input.fromDateUnix, input.toDateUnix, input.fromMsgId, input.toMsgId, new Date().toISOString()]
        );
    }

    getSyncSegments(chatId: string, fromDateUnix?: number, toDateUnix?: number): SyncSegmentRow[] {
        const db = this.getDb();
        let sql = "SELECT * FROM sync_segments WHERE chat_id = ?";
        const params: Array<string | number> = [chatId];

        if (fromDateUnix !== undefined) {
            sql += " AND to_date_unix > ?";
            params.push(fromDateUnix);
        }

        if (toDateUnix !== undefined) {
            sql += " AND from_date_unix < ?";
            params.push(toDateUnix);
        }

        sql += " ORDER BY from_date_unix ASC";

        return db.query(sql).all(...params) as SyncSegmentRow[];
    }

    getMissingSegments(chatId: string, fromDateUnix: number, toDateUnix: number): DateRange[] {
        const segments = this.getSyncSegments(chatId, fromDateUnix, toDateUnix);
        const gaps: DateRange[] = [];
        const sorted = [...segments].sort((a, b) => a.from_date_unix - b.from_date_unix);

        const merged: Array<{ from: number; to: number }> = [];

        for (const s of sorted) {
            if (merged.length === 0 || s.from_date_unix > merged[merged.length - 1].to) {
                merged.push({ from: s.from_date_unix, to: s.to_date_unix });
            } else {
                merged[merged.length - 1].to = Math.max(merged[merged.length - 1].to, s.to_date_unix);
            }
        }

        if (merged.length === 0) {
            return [{ fromDateUnix, toDateUnix }];
        }

        if (merged[0].from > fromDateUnix) {
            gaps.push({ fromDateUnix, toDateUnix: merged[0].from });
        }

        for (let i = 0; i < merged.length - 1; i++) {
            const currentEnd = merged[i].to;
            const nextStart = merged[i + 1].from;

            if (nextStart > currentEnd) {
                gaps.push({ fromDateUnix: currentEnd, toDateUnix: nextStart });
            }
        }

        const lastEnd = merged[merged.length - 1].to;

        if (lastEnd < toDateUnix) {
            gaps.push({ fromDateUnix: lastEnd, toDateUnix });
        }

        return gaps;
    }

    // ── Chat Metadata ────────────────────────────────────────────────

    upsertChat(input: { chat_id: string; chat_type: string; title: string; username: string | null }): void {
        const db = this.getDb();
        db.run(
            `INSERT INTO chats (chat_id, chat_type, title, username) VALUES (?, ?, ?, ?)
             ON CONFLICT(chat_id) DO UPDATE SET chat_type = excluded.chat_type, title = excluded.title, username = excluded.username`,
            [input.chat_id, input.chat_type, input.title, input.username]
        );
    }

    getChat(chatId: string): ChatRow | null {
        const db = this.getDb();
        return (db.query("SELECT * FROM chats WHERE chat_id = ?").get(chatId) as ChatRow) ?? null;
    }

    listChats(type?: string): ChatRow[] {
        const db = this.getDb();

        if (type) {
            return db.query("SELECT * FROM chats WHERE chat_type = ? ORDER BY title").all(type) as ChatRow[];
        }

        return db.query("SELECT * FROM chats ORDER BY chat_type, title").all() as ChatRow[];
    }

    // ── Suggestion Edits ─────────────────────────────────────────────

    insertSuggestionEdit(input: SuggestionEditInput): void {
        const db = this.getDb();
        db.run(
            `INSERT INTO suggestion_edits (chat_id, message_id, suggested_text, edited_text, sent_text, provider, model, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.chatId,
                input.messageId,
                input.suggestedText,
                input.editedText,
                input.sentText,
                input.provider,
                input.model,
                new Date().toISOString(),
            ]
        );
    }

    getRecentSuggestionEdits(chatId: string, limit = 10): SuggestionEditRow[] {
        const db = this.getDb();
        return db
            .query(
                `SELECT suggested_text, edited_text, sent_text, created_at
                 FROM suggestion_edits WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?`
            )
            .all(chatId, limit) as SuggestionEditRow[];
    }

    // ── Stats ─────────────────────────────────────────────────────────

    getStats(chatId?: string): ChatStats[] {
        const db = this.getDb();

        if (chatId) {
            const row = db
                .query(`
				SELECT
					chat_id,
					COUNT(*) AS total_messages,
					SUM(CASE WHEN is_outgoing = 1 THEN 1 ELSE 0 END) AS outgoing_messages,
					SUM(CASE WHEN is_outgoing = 0 THEN 1 ELSE 0 END) AS incoming_messages,
					MIN(date_iso) AS first_message_date,
					MAX(date_iso) AS last_message_date
				FROM messages
				WHERE chat_id = ?
				GROUP BY chat_id
			`)
                .get(chatId) as {
                chat_id: string;
                total_messages: number;
                outgoing_messages: number;
                incoming_messages: number;
                first_message_date: string | null;
                last_message_date: string | null;
            } | null;

            if (!row) {
                return [];
            }

            const embeddedCount = this.getEmbeddedCount(chatId);

            return [
                {
                    chatId: row.chat_id,
                    totalMessages: row.total_messages,
                    outgoingMessages: row.outgoing_messages,
                    incomingMessages: row.incoming_messages,
                    firstMessageDate: row.first_message_date,
                    lastMessageDate: row.last_message_date,
                    embeddedMessages: embeddedCount,
                },
            ];
        }

        const rows = db
            .query(`
			SELECT
				chat_id,
				COUNT(*) AS total_messages,
				SUM(CASE WHEN is_outgoing = 1 THEN 1 ELSE 0 END) AS outgoing_messages,
				SUM(CASE WHEN is_outgoing = 0 THEN 1 ELSE 0 END) AS incoming_messages,
				MIN(date_iso) AS first_message_date,
				MAX(date_iso) AS last_message_date
			FROM messages
			GROUP BY chat_id
			ORDER BY total_messages DESC
		`)
            .all() as Array<{
            chat_id: string;
            total_messages: number;
            outgoing_messages: number;
            incoming_messages: number;
            first_message_date: string | null;
            last_message_date: string | null;
        }>;

        return rows.map((row) => ({
            chatId: row.chat_id,
            totalMessages: row.total_messages,
            outgoingMessages: row.outgoing_messages,
            incomingMessages: row.incoming_messages,
            firstMessageDate: row.first_message_date,
            lastMessageDate: row.last_message_date,
            embeddedMessages: this.getEmbeddedCount(row.chat_id),
        }));
    }

    getTotalMessageCount(): number {
        const db = this.getDb();
        const row = db.query("SELECT COUNT(*) AS cnt FROM messages").get() as { cnt: number };
        return row.cnt;
    }
}

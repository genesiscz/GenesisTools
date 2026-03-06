import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import logger from "@app/logger";
import { cosineDistance } from "@app/utils/math";
import type { AttachmentDescriptor, SerializedMessage } from "./TelegramMessage";
import type {
    AttachmentLocator,
    AttachmentRow,
    ChatRow,
    ChatStats,
    MessageRow,
    MissingRange,
    QueryMessagesOptions,
    SearchOptions,
    SearchResult,
    SuggestionFeedbackRow,
    SyncSegmentRow,
    SyncStateRow,
} from "./types";

const DB_PATH = join(homedir(), ".genesis-tools", "telegram", "history.db");

interface UpsertMessageResult {
    inserted: boolean;
    updated: boolean;
}

interface MessageRowWithEmbedding extends MessageRow {
    embedding: Buffer;
}

export class TelegramHistoryStore {
    private db: Database | null = null;

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

        this.initSchema();
        logger.debug("TelegramHistoryStore opened");
    }

    close(): void {
        if (this.db) {
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

    private initSchema(): void {
        const db = this.getDb();
        const row = db.query("PRAGMA user_version").get() as { user_version: number };
        let version = row.user_version;

        if (version < 1) {
            this.createBaseSchemaV1();
            db.run("PRAGMA user_version = 1");
            version = 1;
        }

        if (version < 2) {
            this.migrateToV2();
            db.run("PRAGMA user_version = 2");
            version = 2;
        }

        if (version >= 2) {
            this.ensureV2Schema();
        }

        this.ensureFtsTable();
        this.ensureFtsTriggers();
    }

    private ensureFtsTable(): void {
        const db = this.getDb();

        db.run(`
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                text,
                content=messages,
                content_rowid=rowid,
                tokenize='unicode61'
            )
        `);
    }

    private createBaseSchemaV1(): void {
        const db = this.getDb();

        db.run(`
            CREATE TABLE IF NOT EXISTS messages (
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
            CREATE INDEX IF NOT EXISTS idx_messages_chat_date
            ON messages(chat_id, date_unix)
        `);

        db.run(`
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                text,
                content=messages,
                content_rowid=rowid,
                tokenize='unicode61'
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS sync_state (
                chat_id TEXT PRIMARY KEY,
                last_synced_id INTEGER NOT NULL,
                last_synced_at TEXT NOT NULL
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS embeddings (
                message_rowid INTEGER PRIMARY KEY,
                embedding BLOB NOT NULL
            )
        `);
    }

    private migrateToV2(): void {
        const db = this.getDb();

        if (!this.hasColumn("messages", "edited_date_unix")) {
            db.run("ALTER TABLE messages ADD COLUMN edited_date_unix INTEGER");
        }

        if (!this.hasColumn("messages", "is_deleted")) {
            db.run("ALTER TABLE messages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0");
        }

        if (!this.hasColumn("messages", "deleted_at_iso")) {
            db.run("ALTER TABLE messages ADD COLUMN deleted_at_iso TEXT");
        }

        if (!this.hasColumn("messages", "reply_to_msg_id")) {
            db.run("ALTER TABLE messages ADD COLUMN reply_to_msg_id INTEGER");
        }

        this.ensureV2Schema();
    }

    private ensureV2Schema(): void {
        const db = this.getDb();

        db.run(`
            CREATE TABLE IF NOT EXISTS chats (
                chat_id TEXT PRIMARY KEY,
                chat_type TEXT NOT NULL,
                title TEXT NOT NULL,
                username TEXT,
                last_seen_at_iso TEXT NOT NULL
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS message_revisions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                message_id INTEGER NOT NULL,
                revision_type TEXT NOT NULL,
                text TEXT,
                media_desc TEXT,
                date_iso TEXT NOT NULL,
                date_unix INTEGER NOT NULL,
                UNIQUE(chat_id, message_id, revision_type, date_unix)
            )
        `);

        db.run(`
            CREATE INDEX IF NOT EXISTS idx_message_revisions_chat_msg
            ON message_revisions(chat_id, message_id, date_unix)
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS attachments (
                chat_id TEXT NOT NULL,
                message_id INTEGER NOT NULL,
                attachment_index INTEGER NOT NULL,
                kind TEXT NOT NULL,
                mime_type TEXT,
                file_name TEXT,
                file_size INTEGER,
                telegram_file_id TEXT,
                thumb_count INTEGER NOT NULL DEFAULT 0,
                is_downloaded INTEGER NOT NULL DEFAULT 0,
                local_path TEXT,
                sha256 TEXT,
                created_at_iso TEXT NOT NULL,
                updated_at_iso TEXT NOT NULL,
                PRIMARY KEY (chat_id, message_id, attachment_index)
            )
        `);

        db.run(`
            CREATE INDEX IF NOT EXISTS idx_attachments_chat_message
            ON attachments(chat_id, message_id)
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS sync_segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                start_unix INTEGER NOT NULL,
                end_unix INTEGER NOT NULL,
                source TEXT NOT NULL,
                created_at_iso TEXT NOT NULL
            )
        `);

        db.run(`
            CREATE INDEX IF NOT EXISTS idx_sync_segments_chat_range
            ON sync_segments(chat_id, start_unix, end_unix)
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS suggestion_feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                incoming_message_id INTEGER,
                suggestion_text TEXT NOT NULL,
                edited_text TEXT,
                sent_text TEXT NOT NULL,
                was_edited INTEGER NOT NULL DEFAULT 0,
                created_at_iso TEXT NOT NULL
            )
        `);

        db.run(`
            CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_chat_time
            ON suggestion_feedback(chat_id, created_at_iso DESC)
        `);
    }

    private ensureFtsTriggers(): void {
        const db = this.getDb();

        try {
            db.run(`
                CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
                    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
                END
            `);
        } catch {
            // trigger already exists
        }

        try {
            db.run(`
                CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
                END
            `);
        } catch {
            // trigger already exists
        }

        try {
            db.run(`
                CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
                    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
                END
            `);
        } catch {
            // trigger already exists
        }
    }

    private hasColumn(table: string, column: string): boolean {
        const db = this.getDb();
        const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;

        return rows.some((row) => row.name === column);
    }

    private toMessageRow(row: Record<string, unknown>): MessageRow {
        return {
            id: Number(row.id),
            chat_id: String(row.chat_id),
            sender_id: row.sender_id === null ? null : String(row.sender_id),
            text: row.text === null ? null : String(row.text),
            media_desc: row.media_desc === null ? null : String(row.media_desc),
            is_outgoing: Number(row.is_outgoing),
            date_unix: Number(row.date_unix),
            date_iso: String(row.date_iso),
            edited_date_unix: row.edited_date_unix === null ? null : Number(row.edited_date_unix),
            is_deleted: Number(row.is_deleted ?? 0),
            deleted_at_iso: row.deleted_at_iso === null ? null : String(row.deleted_at_iso),
            reply_to_msg_id: row.reply_to_msg_id === null ? null : Number(row.reply_to_msg_id),
        };
    }

    // ── Chat Metadata ────────────────────────────────────────────────

    upsertChat(chat: Omit<ChatRow, "last_seen_at_iso">): void {
        const db = this.getDb();

        db.run(
            `
            INSERT INTO chats (chat_id, chat_type, title, username, last_seen_at_iso)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(chat_id) DO UPDATE SET
                chat_type = excluded.chat_type,
                title = excluded.title,
                username = excluded.username,
                last_seen_at_iso = excluded.last_seen_at_iso
            `,
            [chat.chat_id, chat.chat_type, chat.title, chat.username ?? null]
        );
    }

    // ── Insert / Upsert ──────────────────────────────────────────────

    insertMessages(chatId: string, messages: SerializedMessage[]): number {
        let inserted = 0;

        for (const msg of messages) {
            const result = this.upsertMessageWithRevision(chatId, msg, "create");

            if (result.inserted) {
                inserted++;
            }
        }

        return inserted;
    }

    upsertMessageWithRevision(
        chatId: string,
        message: SerializedMessage,
        revisionType: "create" | "edit" = "create"
    ): UpsertMessageResult {
        const db = this.getDb();
        const existing = db
            .query(
                `
                SELECT text, media_desc, edited_date_unix, is_deleted, reply_to_msg_id
                FROM messages
                WHERE chat_id = ? AND id = ?
                `
            )
            .get(chatId, message.id) as {
            text: string | null;
            media_desc: string | null;
            edited_date_unix: number | null;
            is_deleted: number;
            reply_to_msg_id: number | null;
        } | null;

        if (!existing) {
            db.run(
                `
                INSERT INTO messages (
                    id,
                    chat_id,
                    sender_id,
                    text,
                    media_desc,
                    is_outgoing,
                    date_unix,
                    date_iso,
                    edited_date_unix,
                    is_deleted,
                    deleted_at_iso,
                    reply_to_msg_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
                `,
                [
                    message.id,
                    chatId,
                    message.senderId ?? null,
                    message.text || null,
                    message.mediaDescription ?? null,
                    message.isOutgoing ? 1 : 0,
                    message.dateUnix,
                    message.date,
                    message.editedDateUnix ?? null,
                    message.replyToMsgId ?? null,
                ]
            );

            this.insertMessageRevision(
                chatId,
                message.id,
                revisionType,
                message.text,
                message.mediaDescription,
                message.dateUnix
            );

            if (message.attachments && message.attachments.length > 0) {
                this.upsertAttachments(chatId, message.id, message.attachments);
            }

            return { inserted: true, updated: false };
        }

        const normalizedText = message.text || null;
        const normalizedMedia = message.mediaDescription ?? null;
        const normalizedEdited = message.editedDateUnix ?? null;
        const normalizedReplyTo = message.replyToMsgId ?? null;

        const changed =
            existing.text !== normalizedText ||
            existing.media_desc !== normalizedMedia ||
            existing.edited_date_unix !== normalizedEdited ||
            existing.reply_to_msg_id !== normalizedReplyTo ||
            existing.is_deleted !== 0;

        if (!changed) {
            if (message.attachments && message.attachments.length > 0) {
                this.upsertAttachments(chatId, message.id, message.attachments);
            }

            return { inserted: false, updated: false };
        }

        db.run(
            `
            UPDATE messages
            SET
                sender_id = ?,
                text = ?,
                media_desc = ?,
                is_outgoing = ?,
                date_unix = ?,
                date_iso = ?,
                edited_date_unix = ?,
                is_deleted = 0,
                deleted_at_iso = NULL,
                reply_to_msg_id = ?
            WHERE chat_id = ? AND id = ?
            `,
            [
                message.senderId ?? null,
                normalizedText,
                normalizedMedia,
                message.isOutgoing ? 1 : 0,
                message.dateUnix,
                message.date,
                normalizedEdited,
                normalizedReplyTo,
                chatId,
                message.id,
            ]
        );

        this.insertMessageRevision(
            chatId,
            message.id,
            "edit",
            message.text,
            message.mediaDescription,
            message.dateUnix
        );

        if (message.attachments && message.attachments.length > 0) {
            this.upsertAttachments(chatId, message.id, message.attachments);
        }

        return { inserted: false, updated: true };
    }

    markMessageDeleted(chatId: string, messageId: number, deletedAtUnix: number = Math.floor(Date.now() / 1000)): void {
        const db = this.getDb();
        const existing = db.query("SELECT id FROM messages WHERE chat_id = ? AND id = ?").get(chatId, messageId) as {
            id: number;
        } | null;

        if (!existing) {
            return;
        }

        const deletedIso = new Date(deletedAtUnix * 1000).toISOString();

        db.run(
            `
            UPDATE messages
            SET is_deleted = 1,
                deleted_at_iso = ?
            WHERE chat_id = ? AND id = ?
            `,
            [deletedIso, chatId, messageId]
        );

        this.insertMessageRevision(chatId, messageId, "delete", null, null, deletedAtUnix);
    }

    private insertMessageRevision(
        chatId: string,
        messageId: number,
        revisionType: "create" | "edit" | "delete",
        text: string | null | undefined,
        mediaDescription: string | null | undefined,
        dateUnix: number
    ): void {
        const db = this.getDb();
        const dateIso = new Date(dateUnix * 1000).toISOString();

        db.run(
            `
            INSERT OR IGNORE INTO message_revisions (
                chat_id,
                message_id,
                revision_type,
                text,
                media_desc,
                date_iso,
                date_unix
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
            [chatId, messageId, revisionType, text ?? null, mediaDescription ?? null, dateIso, dateUnix]
        );
    }

    upsertAttachments(chatId: string, messageId: number, attachments: AttachmentDescriptor[]): void {
        const db = this.getDb();
        const now = new Date().toISOString();

        for (const attachment of attachments) {
            db.run(
                `
                INSERT INTO attachments (
                    chat_id,
                    message_id,
                    attachment_index,
                    kind,
                    mime_type,
                    file_name,
                    file_size,
                    telegram_file_id,
                    thumb_count,
                    is_downloaded,
                    local_path,
                    sha256,
                    created_at_iso,
                    updated_at_iso
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
                ON CONFLICT(chat_id, message_id, attachment_index) DO UPDATE SET
                    kind = excluded.kind,
                    mime_type = excluded.mime_type,
                    file_name = excluded.file_name,
                    file_size = excluded.file_size,
                    telegram_file_id = excluded.telegram_file_id,
                    thumb_count = excluded.thumb_count,
                    updated_at_iso = excluded.updated_at_iso
                `,
                [
                    chatId,
                    messageId,
                    attachment.index,
                    attachment.kind,
                    attachment.mimeType ?? null,
                    attachment.fileName ?? null,
                    attachment.fileSize ?? null,
                    attachment.telegramFileId ?? null,
                    attachment.thumbCount,
                    now,
                    now,
                ]
            );
        }
    }

    markAttachmentDownloaded(locator: AttachmentLocator, localPath: string, content: Buffer): void {
        const db = this.getDb();
        const now = new Date().toISOString();
        const hash = createHash("sha256").update(content).digest("hex");

        db.run(
            `
            UPDATE attachments
            SET is_downloaded = 1,
                local_path = ?,
                sha256 = ?,
                updated_at_iso = ?
            WHERE chat_id = ? AND message_id = ? AND attachment_index = ?
            `,
            [localPath, hash, now, locator.chatId, locator.messageId, locator.attachmentIndex]
        );
    }

    listAttachments(
        chatId: string,
        options: {
            since?: Date;
            until?: Date;
            messageId?: number;
            limit?: number;
        } = {}
    ): AttachmentRow[] {
        const db = this.getDb();
        const params: Array<number | string> = [chatId];
        let where = "WHERE a.chat_id = ?";

        if (options.messageId !== undefined) {
            where += " AND a.message_id = ?";
            params.push(options.messageId);
        }

        if (options.since) {
            where += " AND m.date_unix >= ?";
            params.push(Math.floor(options.since.getTime() / 1000));
        }

        if (options.until) {
            where += " AND m.date_unix <= ?";
            params.push(Math.floor(options.until.getTime() / 1000));
        }

        const limit = options.limit ?? 200;
        params.push(limit);

        return db
            .query(
                `
                SELECT a.*
                FROM attachments a
                JOIN messages m
                ON m.chat_id = a.chat_id AND m.id = a.message_id
                ${where}
                ORDER BY m.date_unix DESC, a.attachment_index ASC
                LIMIT ?
                `
            )
            .all(...params) as AttachmentRow[];
    }

    getAttachment(locator: AttachmentLocator): AttachmentRow | null {
        const db = this.getDb();

        return (
            (db
                .query(
                    `
                SELECT *
                FROM attachments
                WHERE chat_id = ?
                    AND message_id = ?
                    AND attachment_index = ?
                `
                )
                .get(locator.chatId, locator.messageId, locator.attachmentIndex) as AttachmentRow | null) ?? null
        );
    }

    recordSuggestionFeedback(options: {
        chatId: string;
        incomingMessageId?: number;
        suggestionText: string;
        sentText: string;
        editedText?: string;
    }): void {
        const db = this.getDb();
        const wasEdited = options.editedText !== undefined && options.editedText !== options.suggestionText;

        db.run(
            `
            INSERT INTO suggestion_feedback (
                chat_id,
                incoming_message_id,
                suggestion_text,
                edited_text,
                sent_text,
                was_edited,
                created_at_iso
            ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            `,
            [
                options.chatId,
                options.incomingMessageId ?? null,
                options.suggestionText,
                options.editedText ?? null,
                options.sentText,
                wasEdited ? 1 : 0,
            ]
        );
    }

    getSuggestionFeedback(chatId: string, limit = 40): SuggestionFeedbackRow[] {
        const db = this.getDb();

        return db
            .query(
                `
                SELECT *
                FROM suggestion_feedback
                WHERE chat_id = ?
                ORDER BY created_at_iso DESC
                LIMIT ?
                `
            )
            .all(chatId, limit) as SuggestionFeedbackRow[];
    }

    // ── Embeddings ────────────────────────────────────────────────────

    getUnembeddedMessages(chatId: string, limit = 500): MessageRow[] {
        const db = this.getDb();

        return db
            .query(
                `
                SELECT m.*
                FROM messages m
                LEFT JOIN embeddings e ON e.message_rowid = m.rowid
                WHERE m.chat_id = ?
                    AND m.text IS NOT NULL
                    AND m.text != ''
                    AND m.is_deleted = 0
                    AND e.message_rowid IS NULL
                ORDER BY m.date_unix ASC
                LIMIT ?
                `
            )
            .all(chatId, limit)
            .map((row) => this.toMessageRow(row as Record<string, unknown>));
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
            .query(
                `
                SELECT COUNT(*) AS cnt
                FROM embeddings e
                JOIN messages m ON m.rowid = e.message_rowid
                WHERE m.chat_id = ?
                `
            )
            .get(chatId) as { cnt: number };

        return row.cnt;
    }

    // ── Search ────────────────────────────────────────────────────────

    search(chatId: string, query: string, options: SearchOptions = {}): SearchResult[] {
        const db = this.getDb();

        const ftsQuery = query
            .replace(/['"]/g, "")
            .split(/\s+/)
            .filter(Boolean)
            .map((word) => `"${word}"`)
            .join(" ");

        if (!ftsQuery) {
            return [];
        }

        const limit = options.limit ?? 20;
        let dateFilter = "";
        const params: Array<number | string> = [ftsQuery, chatId];

        if (options.since) {
            dateFilter += " AND m.date_unix >= ?";
            params.push(Math.floor(options.since.getTime() / 1000));
        }

        if (options.until) {
            dateFilter += " AND m.date_unix <= ?";
            params.push(Math.floor(options.until.getTime() / 1000));
        }

        params.push(limit);

        const sql = `
            SELECT m.*, fts.rank
            FROM messages_fts fts
            JOIN messages m ON m.rowid = fts.rowid
            WHERE messages_fts MATCH ?
                AND m.chat_id = ?
                AND m.is_deleted = 0
                ${dateFilter}
            ORDER BY fts.rank
            LIMIT ?
        `;

        const rows = db.query(sql).all(...params) as Array<Record<string, unknown> & { rank: number }>;

        return rows.map((row) => ({
            message: this.toMessageRow(row),
            rank: Number(row.rank),
        }));
    }

    semanticSearch(chatId: string, queryEmbedding: Float32Array, options: SearchOptions = {}): SearchResult[] {
        const db = this.getDb();
        const limit = options.limit ?? 20;

        let dateFilter = "";
        const params: Array<number | string> = [chatId];

        if (options.since) {
            dateFilter += " AND m.date_unix >= ?";
            params.push(Math.floor(options.since.getTime() / 1000));
        }

        if (options.until) {
            dateFilter += " AND m.date_unix <= ?";
            params.push(Math.floor(options.until.getTime() / 1000));
        }

        const sql = `
            SELECT m.*, e.embedding
            FROM embeddings e
            JOIN messages m ON m.rowid = e.message_rowid
            WHERE m.chat_id = ?
                AND m.is_deleted = 0
                ${dateFilter}
        `;

        const rows = db.query(sql).all(...params) as MessageRowWithEmbedding[];
        const scored: Array<{ message: MessageRow; distance: number }> = [];

        for (const row of rows) {
            const storedVec = new Float32Array(
                row.embedding.buffer,
                row.embedding.byteOffset,
                row.embedding.byteLength / 4
            );
            const distance = cosineDistance(queryEmbedding, storedVec);

            scored.push({
                message: this.toMessageRow(row as unknown as Record<string, unknown>),
                distance,
            });
        }

        scored.sort((a, b) => a.distance - b.distance);

        return scored.slice(0, limit).map((entry) => ({
            message: entry.message,
            distance: entry.distance,
        }));
    }

    hybridSearch(
        chatId: string,
        query: string,
        queryEmbedding: Float32Array,
        options: SearchOptions = {}
    ): SearchResult[] {
        const ftsResults = this.search(chatId, query, { ...options, limit: 100 });
        const vecResults = this.semanticSearch(chatId, queryEmbedding, { ...options, limit: 100 });
        const K = 60;
        const scores = new Map<number, { score: number; row: MessageRow }>();

        for (let i = 0; i < ftsResults.length; i++) {
            const result = ftsResults[i];
            const rrfScore = 1.0 / (K + i + 1);
            const existing = scores.get(result.message.id);

            if (existing) {
                existing.score += rrfScore;
            } else {
                scores.set(result.message.id, { score: rrfScore, row: result.message });
            }
        }

        for (let i = 0; i < vecResults.length; i++) {
            const result = vecResults[i];
            const rrfScore = 1.0 / (K + i + 1);
            const existing = scores.get(result.message.id);

            if (existing) {
                existing.score += rrfScore;
            } else {
                scores.set(result.message.id, { score: rrfScore, row: result.message });
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

    // ── Date/Query ────────────────────────────────────────────────────

    getByDateRange(chatId: string, since?: Date, until?: Date, limit?: number): MessageRow[] {
        return this.queryMessages(chatId, {
            since,
            until,
            sender: "any",
            limit,
        });
    }

    queryMessages(chatId: string, options: QueryMessagesOptions = {}): MessageRow[] {
        const db = this.getDb();
        const params: Array<number | string> = [chatId];
        const where: string[] = ["chat_id = ?"];

        if (options.since) {
            where.push("date_unix >= ?");
            params.push(Math.floor(options.since.getTime() / 1000));
        }

        if (options.until) {
            where.push("date_unix <= ?");
            params.push(Math.floor(options.until.getTime() / 1000));
        }

        if (options.sender === "me") {
            where.push("is_outgoing = 1");
        }

        if (options.sender === "them") {
            where.push("is_outgoing = 0");
        }

        let limitClause = "";

        if (options.limit !== undefined) {
            limitClause = "LIMIT ?";
            params.push(options.limit);
        }

        const rows = db
            .query(
                `
                SELECT *
                FROM messages
                WHERE ${where.join(" AND ")}
                ORDER BY date_unix ASC
                ${limitClause}
                `
            )
            .all(...params)
            .map((row) => this.toMessageRow(row as Record<string, unknown>));

        if (!options.textRegex) {
            return rows;
        }

        try {
            const regex = new RegExp(options.textRegex, "i");
            return rows.filter((row) => {
                const text = row.text ?? row.media_desc ?? "";
                return regex.test(text);
            });
        } catch {
            return rows;
        }
    }

    // ── Sync Coverage ────────────────────────────────────────────────

    insertSyncSegment(
        chatId: string,
        sinceUnix: number,
        untilUnix: number,
        source: "full" | "incremental" | "query"
    ): void {
        const db = this.getDb();
        const start = Math.min(sinceUnix, untilUnix);
        const end = Math.max(sinceUnix, untilUnix);

        db.run(
            `
            INSERT INTO sync_segments (chat_id, start_unix, end_unix, source, created_at_iso)
            VALUES (?, ?, ?, ?, datetime('now'))
            `,
            [chatId, start, end, source]
        );
    }

    getSyncSegments(chatId: string): SyncSegmentRow[] {
        const db = this.getDb();

        return db
            .query(
                `
                SELECT *
                FROM sync_segments
                WHERE chat_id = ?
                ORDER BY start_unix ASC, end_unix ASC
                `
            )
            .all(chatId) as SyncSegmentRow[];
    }

    getMissingSegments(chatId: string, since: Date, until: Date): MissingRange[] {
        const targetStart = Math.floor(since.getTime() / 1000);
        const targetEnd = Math.floor(until.getTime() / 1000);
        const segments = this.getSyncSegments(chatId)
            .filter((segment) => segment.end_unix >= targetStart && segment.start_unix <= targetEnd)
            .sort((a, b) => a.start_unix - b.start_unix);

        if (segments.length === 0) {
            return [{ sinceUnix: targetStart, untilUnix: targetEnd }];
        }

        const gaps: MissingRange[] = [];
        let cursor = targetStart;

        for (const segment of segments) {
            if (segment.start_unix > cursor) {
                gaps.push({
                    sinceUnix: cursor,
                    untilUnix: Math.min(segment.start_unix - 1, targetEnd),
                });
            }

            cursor = Math.max(cursor, segment.end_unix + 1);

            if (cursor > targetEnd) {
                break;
            }
        }

        if (cursor <= targetEnd) {
            gaps.push({ sinceUnix: cursor, untilUnix: targetEnd });
        }

        return gaps;
    }

    findChatsByMessageId(messageId: number): string[] {
        const db = this.getDb();
        const rows = db.query("SELECT DISTINCT chat_id FROM messages WHERE id = ?").all(messageId) as Array<{
            chat_id: string;
        }>;

        return rows.map((row) => row.chat_id);
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

    // ── Stats ─────────────────────────────────────────────────────────

    getStats(chatId?: string): ChatStats[] {
        const db = this.getDb();

        if (chatId) {
            const row = db
                .query(
                    `
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
                    `
                )
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
            .query(
                `
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
                `
            )
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

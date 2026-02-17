import { Database } from "bun:sqlite";
import { existsSync, copyFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import logger from "@app/logger";
import { ENVELOPE_INDEX_PATH, TEMP_DB_PREFIX } from "@app/macos-mail/lib/constants";
import type {
    MailMessageRow,
    MailAttachment,
    MailRecipient,
    ReceiverInfo,
    SearchOptions,
} from "@app/macos-mail/lib/types";

let _tempDbPath: string | null = null;
let _db: Database | null = null;

/**
 * Copy the Envelope Index to a temp file and open it.
 * Reuses the same copy within a single CLI invocation.
 */
export function getDatabase(): Database {
    if (_db) return _db;

    if (!existsSync(ENVELOPE_INDEX_PATH)) {
        throw new Error(
            `Mail database not found at: ${ENVELOPE_INDEX_PATH}\n` +
            "Make sure Mail.app is configured and has downloaded messages."
        );
    }

    _tempDbPath = join(tmpdir(), `${TEMP_DB_PREFIX}-${Date.now()}.sqlite`);
    logger.debug(`Copying Mail database to ${_tempDbPath}`);
    copyFileSync(ENVELOPE_INDEX_PATH, _tempDbPath);

    // Also copy WAL and SHM if they exist (for consistency)
    const walPath = ENVELOPE_INDEX_PATH + "-wal";
    const shmPath = ENVELOPE_INDEX_PATH + "-shm";
    if (existsSync(walPath)) copyFileSync(walPath, _tempDbPath + "-wal");
    if (existsSync(shmPath)) copyFileSync(shmPath, _tempDbPath + "-shm");

    _db = new Database(_tempDbPath, { readonly: true });
    return _db;
}

/** Clean up the temp database file */
export function cleanup(): void {
    if (_db) {
        _db.close();
        _db = null;
    }
    if (_tempDbPath) {
        try { unlinkSync(_tempDbPath); } catch {}
        try { unlinkSync(_tempDbPath + "-wal"); } catch {}
        try { unlinkSync(_tempDbPath + "-shm"); } catch {}
        _tempDbPath = null;
    }
}

/**
 * Search messages by metadata (subject, sender, attachment names).
 * Does NOT search body content -- that requires JXA.
 *
 * The query uses OR to combine:
 * 1. Subject LIKE match
 * 2. Sender address/name LIKE match
 * 3. Attachment name LIKE match
 */
export function searchMessages(opts: SearchOptions): MailMessageRow[] {
    const db = getDatabase();
    const params: Record<string, string | number> = {};
    const queryPattern = `%${opts.query}%`;
    params.$query = queryPattern;

    // Build WHERE clauses for filters
    const filters: string[] = ["m.deleted = 0"];

    if (opts.from) {
        filters.push("m.date_sent >= $dateFrom");
        params.$dateFrom = Math.floor(opts.from.getTime() / 1000);
    }
    if (opts.to) {
        filters.push("m.date_sent <= $dateTo");
        params.$dateTo = Math.floor(opts.to.getTime() / 1000);
    }
    if (opts.mailbox) {
        filters.push("mb.url LIKE $mailbox");
        params.$mailbox = `%${opts.mailbox}%`;
    }
    if (opts.receiver) {
        filters.push(`m.ROWID IN (
            SELECT r.message FROM recipients r
            JOIN addresses a ON r.address = a.ROWID
            WHERE a.address LIKE $receiver
        )`);
        params.$receiver = `%${opts.receiver}%`;
    }

    const whereClause = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";
    const limit = opts.limit ?? 200;

    const sql = `
        SELECT DISTINCT
            m.ROWID as rowid,
            s.subject,
            a.address as senderAddress,
            a.comment as senderName,
            m.date_sent as dateSent,
            m.date_received as dateReceived,
            mb.url as mailboxUrl,
            m.read,
            m.flagged,
            m.deleted,
            m.size
        FROM messages m
        JOIN subjects s ON m.subject = s.ROWID
        JOIN addresses a ON m.sender = a.ROWID
        JOIN mailboxes mb ON m.mailbox = mb.ROWID
        WHERE (
            s.subject LIKE $query
            OR a.address LIKE $query
            OR a.comment LIKE $query
            OR m.ROWID IN (
                SELECT att.message FROM attachments att
                WHERE att.name LIKE $query
            )
        )
        ${whereClause}
        ORDER BY m.date_sent DESC
        LIMIT ${limit}
    `;

    logger.debug(`Running search query with pattern: ${queryPattern}`);
    const stmt = db.prepare(sql);
    return stmt.all(params) as MailMessageRow[];
}

/**
 * List recent messages from a mailbox.
 */
export function listMessages(mailbox: string, limit: number): MailMessageRow[] {
    const db = getDatabase();
    const mailboxPattern = `%${mailbox}%`;

    const sql = `
        SELECT
            m.ROWID as rowid,
            s.subject,
            a.address as senderAddress,
            a.comment as senderName,
            m.date_sent as dateSent,
            m.date_received as dateReceived,
            mb.url as mailboxUrl,
            m.read,
            m.flagged,
            m.deleted,
            m.size
        FROM messages m
        JOIN subjects s ON m.subject = s.ROWID
        JOIN addresses a ON m.sender = a.ROWID
        JOIN mailboxes mb ON m.mailbox = mb.ROWID
        WHERE m.deleted = 0
          AND mb.url LIKE $mailbox
        ORDER BY m.date_sent DESC
        LIMIT $limit
    `;

    return db.prepare(sql).all({ $mailbox: mailboxPattern, $limit: limit }) as MailMessageRow[];
}

/**
 * Get attachments for a set of message ROWIDs.
 */
export function getAttachments(messageRowids: number[]): Map<number, MailAttachment[]> {
    if (messageRowids.length === 0) return new Map();
    const db = getDatabase();

    const placeholders = messageRowids.map(() => "?").join(",");
    const sql = `
        SELECT message, name, attachment_id as attachmentId
        FROM attachments
        WHERE message IN (${placeholders})
        ORDER BY message, ROWID
    `;

    const rows = db.prepare(sql).all(...messageRowids) as Array<{
        message: number;
        name: string;
        attachmentId: string;
    }>;

    const map = new Map<number, MailAttachment[]>();
    for (const row of rows) {
        const list = map.get(row.message) ?? [];
        list.push({ name: row.name, attachmentId: row.attachmentId });
        map.set(row.message, list);
    }
    return map;
}

/**
 * Get recipients (To/CC) for a set of message ROWIDs.
 */
export function getRecipients(messageRowids: number[]): Map<number, MailRecipient[]> {
    if (messageRowids.length === 0) return new Map();
    const db = getDatabase();

    const placeholders = messageRowids.map(() => "?").join(",");
    const sql = `
        SELECT r.message, a.address, a.comment as name, r.type
        FROM recipients r
        JOIN addresses a ON r.address = a.ROWID
        WHERE r.message IN (${placeholders})
        ORDER BY r.message, r.type, r.position
    `;

    const rows = db.prepare(sql).all(...messageRowids) as Array<{
        message: number;
        address: string;
        name: string;
        type: number;
    }>;

    const map = new Map<number, MailRecipient[]>();
    for (const row of rows) {
        const list = map.get(row.message) ?? [];
        list.push({
            address: row.address,
            name: row.name,
            type: row.type === 0 ? "to" : "cc",
        });
        map.set(row.message, list);
    }
    return map;
}

/**
 * List all receiver addresses with message counts.
 * Used by --help-receivers flag.
 */
export function listReceivers(): ReceiverInfo[] {
    const db = getDatabase();
    const sql = `
        SELECT
            a.address,
            a.comment as name,
            COUNT(DISTINCT r.message) as messageCount
        FROM recipients r
        JOIN addresses a ON r.address = a.ROWID
        WHERE r.type = 0
        GROUP BY a.address, a.comment
        HAVING messageCount > 10
        ORDER BY messageCount DESC
        LIMIT 50
    `;
    return db.prepare(sql).all() as ReceiverInfo[];
}

/**
 * List all mailboxes with message counts.
 */
export function listMailboxes(): Array<{ url: string; totalCount: number; unreadCount: number }> {
    const db = getDatabase();
    const sql = `
        SELECT url, total_count as totalCount, unread_count as unreadCount
        FROM mailboxes
        WHERE total_count > 0
        ORDER BY total_count DESC
    `;
    return db.prepare(sql).all() as Array<{ url: string; totalCount: number; unreadCount: number }>;
}

/**
 * Get total message count (for progress reporting).
 */
export function getMessageCount(): number {
    const db = getDatabase();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE deleted = 0").get() as { cnt: number };
    return row.cnt;
}

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import logger from "@app/logger";
import { ENVELOPE_INDEX_PATH } from "@app/macos/lib/mail/constants";
import type {
    AccountInfo,
    MailAttachment,
    MailMessageRow,
    MailRecipient,
    ReceiverInfo,
    SearchOptions,
} from "@app/macos/lib/mail/types";
import { MacOS } from "@app/utils/macos/MacOS";
import { detectTerminalApp } from "@app/utils/terminal";

let _db: Database | null = null;

/** Escape LIKE metacharacters so user input is treated as literal text */
function escapeLike(s: string): string {
    return s.replace(/[%_\\]/g, "\\$&");
}

/**
 * Open the Envelope Index directly in readonly mode.
 * Reuses the same connection within a single CLI invocation.
 */
export function getDatabase(): Database {
    if (_db) {
        return _db;
    }

    if (!existsSync(ENVELOPE_INDEX_PATH)) {
        throw new Error(
            `Mail database not found at: ${ENVELOPE_INDEX_PATH}\n` +
                "Make sure Mail.app is configured and has downloaded messages."
        );
    }

    logger.debug(`Opening Mail database at ${ENVELOPE_INDEX_PATH} (readonly)`);

    try {
        _db = new Database(ENVELOPE_INDEX_PATH, { readonly: true });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (
            message.includes("authorization denied") ||
            message.includes("not authorized") ||
            message.includes("EPERM")
        ) {
            const termApp = detectTerminalApp();

            MacOS.settings.openFullDiskAccess();

            throw new Error(
                [
                    "Full Disk Access is required to read the Mail database.",
                    `Opening System Settings → Privacy & Security → Full Disk Access...`,
                    `Add "${termApp}" to the list, then restart your terminal.`,
                ].join("\n")
            );
        }

        throw err;
    }

    return _db;
}

/** Close the database connection */
export function cleanup(): void {
    if (_db) {
        _db.close();
        _db = null;
    }
}

interface FilterOptions {
    from?: Date;
    to?: Date;
    mailbox?: string;
    receiver?: string;
    account?: string;
}

const MESSAGE_SELECT = `
    SELECT DISTINCT
        m.ROWID as rowid, s.subject,
        a.address as senderAddress, a.comment as senderName,
        m.date_sent as dateSent, m.date_received as dateReceived,
        mb.url as mailboxUrl, m.read, m.flagged, m.deleted, m.size
    FROM messages m
    JOIN subjects s ON m.subject = s.ROWID
    JOIN addresses a ON m.sender = a.ROWID
    JOIN mailboxes mb ON m.mailbox = mb.ROWID`;

/** Build WHERE clauses + params for date/mailbox/receiver/account filters. */
function buildFilters(opts: FilterOptions, params: Record<string, string | number>): string[] {
    const filters: string[] = [];

    if (opts.from) {
        filters.push("m.date_sent >= $dateFrom");
        params.$dateFrom = Math.floor(opts.from.getTime() / 1000);
    }

    if (opts.to) {
        filters.push("m.date_sent <= $dateTo");
        params.$dateTo = Math.floor(opts.to.getTime() / 1000);
    }

    if (opts.mailbox) {
        filters.push("mb.url LIKE $mailbox ESCAPE '\\'");
        params.$mailbox = `%${escapeLike(opts.mailbox)}%`;
    }

    if (opts.receiver) {
        filters.push(`m.ROWID IN (
            SELECT r.message FROM recipients r
            JOIN addresses a ON r.address = a.ROWID
            WHERE a.address LIKE $receiver ESCAPE '\\'
        )`);
        params.$receiver = `%${escapeLike(opts.receiver)}%`;
    }

    if (opts.account) {
        filters.push("mb.url LIKE $account ESCAPE '\\'");
        params.$account = `%${escapeLike(opts.account)}%`;
    }

    return filters;
}

/** Max rowids per SQL IN clause to stay within SQLite bind limits. */
const SQL_BIND_BATCH = 900;

/**
 * Search messages by metadata (subject, sender, attachment names).
 * Tokenizes multi-word queries for per-word AND matching.
 */
export function searchMessages(opts: SearchOptions): MailMessageRow[] {
    const db = getDatabase();
    const params: Record<string, string | number> = {};

    const tokens = opts.query.split(/\s+/).filter((t) => t.length > 0);
    const tokenConditions = tokens.map((_, i) => {
        const key = `$tok${i}`;
        return `(s.subject LIKE ${key} ESCAPE '\\' OR a.address LIKE ${key} ESCAPE '\\' OR a.comment LIKE ${key} ESCAPE '\\')`;
    });

    for (let i = 0; i < tokens.length; i++) {
        params[`$tok${i}`] = `%${escapeLike(tokens[i])}%`;
    }

    const filters: string[] = ["m.deleted = 0", ...buildFilters(opts, params)];
    const whereClause = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";
    const limit = opts.limit ?? 200;
    params.$limit = limit;

    const sql = `${MESSAGE_SELECT}
        WHERE (${tokenConditions.join(" AND ")})
        ${whereClause}
        ORDER BY m.date_sent DESC
        LIMIT $limit`;

    logger.debug(`Running search query with ${tokens.length} token(s): ${tokens.join(", ")}`);
    return db.prepare(sql).all(params) as MailMessageRow[];
}

/**
 * Get messages by ROWIDs with optional filters.
 * Batches rowids to stay within SQLite bind limits (~999).
 */
export function getMessagesByRowids(rowids: number[], opts?: FilterOptions): MailMessageRow[] {
    if (rowids.length === 0) {
        return [];
    }

    const db = getDatabase();
    const results: MailMessageRow[] = [];

    for (let offset = 0; offset < rowids.length; offset += SQL_BIND_BATCH) {
        const batch = rowids.slice(offset, offset + SQL_BIND_BATCH);
        const params: Record<string, string | number> = {};
        const filters: string[] = ["m.deleted = 0"];

        const placeholders = batch.map((_, i) => `$r${i}`).join(",");

        for (let i = 0; i < batch.length; i++) {
            params[`$r${i}`] = batch[i];
        }

        filters.push(`m.ROWID IN (${placeholders})`);

        if (opts) {
            filters.push(...buildFilters(opts, params));
        }

        const sql = `${MESSAGE_SELECT}
            WHERE ${filters.join(" AND ")}
            ORDER BY m.date_sent DESC`;

        results.push(...(db.prepare(sql).all(params) as MailMessageRow[]));
    }

    return results;
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
    if (messageRowids.length === 0) {
        return new Map();
    }
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
    if (messageRowids.length === 0) {
        return new Map();
    }
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
 * Get a single message by ROWID with all metadata.
 */
export function getMessageById(rowid: number): MailMessageRow | null {
    const db = getDatabase();
    const sql = `
        SELECT
            m.ROWID as rowid, s.subject,
            a.address as senderAddress, a.comment as senderName,
            m.date_sent as dateSent, m.date_received as dateReceived,
            mb.url as mailboxUrl, m.read, m.flagged, m.deleted, m.size
        FROM messages m
        JOIN subjects s ON m.subject = s.ROWID
        JOIN addresses a ON m.sender = a.ROWID
        JOIN mailboxes mb ON m.mailbox = mb.ROWID
        WHERE m.ROWID = $rowid
    `;
    return (db.prepare(sql).get({ $rowid: rowid }) as MailMessageRow) ?? null;
}

/**
 * List all mail accounts by parsing mailbox URLs and resolving email addresses.
 * Maps UUID → most-frequent To recipient in that account's INBOX.
 */
export function listAccounts(): AccountInfo[] {
    const db = getDatabase();

    const mailboxes = db
        .prepare("SELECT url, total_count as totalCount FROM mailboxes WHERE total_count > 0")
        .all() as Array<{ url: string; totalCount: number }>;

    // Group by account UUID extracted from mailbox URLs
    const accounts = new Map<string, { protocol: string; mailboxCount: number; messageCount: number }>();

    for (const mb of mailboxes) {
        // URL format: imap://UUID/INBOX or ews://UUID/...
        const match = mb.url.match(/^(\w+):\/\/([^/]+)\//);

        if (!match) {
            continue;
        }

        const protocol = match[1];
        const uuid = match[2];
        const existing = accounts.get(uuid) ?? { protocol, mailboxCount: 0, messageCount: 0 };
        existing.mailboxCount++;
        existing.messageCount += mb.totalCount;
        accounts.set(uuid, existing);
    }

    // Batch: find the most common To address per account in a single query
    const inboxEmails = db
        .prepare(
            `SELECT mb_url_account AS accountUuid, a.address, COUNT(DISTINCT r.message) AS cnt
            FROM (
                SELECT m.ROWID AS mid, SUBSTR(mb.url, INSTR(mb.url, '://') + 3,
                    INSTR(SUBSTR(mb.url, INSTR(mb.url, '://') + 3), '/') - 1) AS mb_url_account
                FROM messages m
                JOIN mailboxes mb ON m.mailbox = mb.ROWID
                WHERE mb.url LIKE '%/INBOX'
            ) inb
            JOIN recipients r ON r.message = inb.mid
            JOIN addresses a ON r.address = a.ROWID
            WHERE r.type = 0
            GROUP BY accountUuid, a.address
            ORDER BY accountUuid, cnt DESC`
        )
        .all() as Array<{ accountUuid: string; address: string; cnt: number }>;

    // Keep only the top address per account
    const emailByAccount = new Map<string, string>();

    for (const row of inboxEmails) {
        if (!emailByAccount.has(row.accountUuid)) {
            emailByAccount.set(row.accountUuid, row.address);
        }
    }

    const result: AccountInfo[] = [];

    for (const [uuid, info] of accounts) {
        result.push({
            uuid,
            protocol: info.protocol,
            email: emailByAccount.get(uuid) ?? "unknown",
            mailboxCount: info.mailboxCount,
            messageCount: info.messageCount,
        });
    }

    return result.sort((a, b) => b.messageCount - a.messageCount);
}

/**
 * Get total message count (for progress reporting).
 */
export function getMessageCount(): number {
    const db = getDatabase();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE deleted = 0").get() as { cnt: number };
    return row.cnt;
}

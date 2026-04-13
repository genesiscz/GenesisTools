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
import { MacDatabase } from "./MacDatabase";

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

const SQL_BIND_BATCH = 900;

function escapeLike(s: string): string {
    return s.replace(/[%_\\]/g, "\\$&");
}

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

export class MailDatabase extends MacDatabase {
    protected readonly dbPath = ENVELOPE_INDEX_PATH;
    protected readonly dbLabel = "Mail database";
    protected readonly notFoundMessage = "Make sure Mail.app is configured and has downloaded messages.";

    searchMessages(opts: SearchOptions): MailMessageRow[] {
        const db = this.getDb();
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

    getMessagesByRowids(rowids: number[], opts?: FilterOptions): MailMessageRow[] {
        if (rowids.length === 0) {
            return [];
        }

        const db = this.getDb();
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

    listMessages(mailbox: string, limit: number): MailMessageRow[] {
        const db = this.getDb();
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

    getAttachments(messageRowids: number[]): Map<number, MailAttachment[]> {
        if (messageRowids.length === 0) {
            return new Map();
        }

        const db = this.getDb();
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

    getRecipients(messageRowids: number[]): Map<number, MailRecipient[]> {
        if (messageRowids.length === 0) {
            return new Map();
        }

        const db = this.getDb();
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

    listReceivers(): ReceiverInfo[] {
        const db = this.getDb();
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

    listMailboxes(): Array<{ url: string; totalCount: number; unreadCount: number }> {
        const db = this.getDb();
        const sql = `
            SELECT url, total_count as totalCount, unread_count as unreadCount
            FROM mailboxes
            WHERE total_count > 0
            ORDER BY total_count DESC
        `;
        return db.prepare(sql).all() as Array<{ url: string; totalCount: number; unreadCount: number }>;
    }

    getMessageById(rowid: number): MailMessageRow | null {
        const db = this.getDb();
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

    listAccounts(): AccountInfo[] {
        const db = this.getDb();

        const mailboxes = db
            .prepare("SELECT url, total_count as totalCount FROM mailboxes WHERE total_count > 0")
            .all() as Array<{ url: string; totalCount: number }>;

        const accounts = new Map<string, { protocol: string; mailboxCount: number; messageCount: number }>();

        for (const mb of mailboxes) {
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

    getMessageCount(): number {
        const db = this.getDb();
        const row = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE deleted = 0").get() as { cnt: number };
        return row.cnt;
    }
}

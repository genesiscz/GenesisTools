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
import {
    ATTACHMENT_JOIN,
    buildFilters,
    escapeLike,
    LIKE_ESCAPE_CLAUSE,
    type MailFilterOptions,
    MESSAGE_SELECT,
    SQL_BIND_BATCH,
} from "./mail-sql";

export class MailDatabase extends MacDatabase {
    protected readonly dbPath = ENVELOPE_INDEX_PATH;
    protected readonly dbLabel = "Mail database";
    protected readonly notFoundMessage = "Make sure Mail.app is configured and has downloaded messages.";

    searchMessages(opts: SearchOptions): MailMessageRow[] {
        const db = this.getDb();
        const params: Record<string, string | number> = {};

        const tokens = opts.query.split(/\s+/).filter((t) => t.length > 0);

        if (tokens.length === 0) {
            return [];
        }

        // Two complementary patterns:
        //  - ordered wildcard: %tok1%tok2%tok3% — matches "invoice pay now" within longer text
        //  - any-order ANDed: each individual %tokN% must match somewhere
        const orderedPattern = `%${tokens.map((t) => escapeLike(t)).join("%")}%`;
        params.$ordered = orderedPattern;

        const orderedClause = `(s.subject LIKE $ordered ${LIKE_ESCAPE_CLAUSE} OR a.address LIKE $ordered ${LIKE_ESCAPE_CLAUSE} OR a.comment LIKE $ordered ${LIKE_ESCAPE_CLAUSE} OR att.name LIKE $ordered ${LIKE_ESCAPE_CLAUSE})`;

        const anyOrderClauses: string[] = tokens.map((_, i) => {
            const key = `$tok${i}`;
            return `(s.subject LIKE ${key} ${LIKE_ESCAPE_CLAUSE} OR a.address LIKE ${key} ${LIKE_ESCAPE_CLAUSE} OR a.comment LIKE ${key} ${LIKE_ESCAPE_CLAUSE} OR att.name LIKE ${key} ${LIKE_ESCAPE_CLAUSE})`;
        });

        for (let i = 0; i < tokens.length; i++) {
            params[`$tok${i}`] = `%${escapeLike(tokens[i])}%`;
        }

        const filters: string[] = ["m.deleted = 0", ...buildFilters(opts, params)];
        const whereClause = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";

        // Drop the LIMIT — fallback path takes care of pagination after merge.
        const sql = `${MESSAGE_SELECT}
            ${ATTACHMENT_JOIN}
            WHERE (${orderedClause} OR (${anyOrderClauses.join(" AND ")}))
            ${whereClause}
            ORDER BY m.date_sent DESC`;

        logger.debug(`Running search query (wildcard) with ${tokens.length} token(s): ${tokens.join(", ")}`);
        return db.prepare(sql).all(params) as MailMessageRow[];
    }

    getMessagesByRowids(rowids: number[], opts?: MailFilterOptions): MailMessageRow[] {
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
        const mailboxPattern = `%${escapeLike(mailbox)}%`;

        const sql = `${MESSAGE_SELECT}
            WHERE m.deleted = 0
              AND mb.url LIKE $mailbox ${LIKE_ESCAPE_CLAUSE}
            ORDER BY m.date_sent DESC
            LIMIT $limit`;

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
            attachmentId: string | null;
        }>;

        const map = new Map<number, MailAttachment[]>();

        for (const row of rows) {
            const list = map.get(row.message) ?? [];
            list.push({ name: row.name, attachmentId: row.attachmentId ?? "" });
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
        const sql = `${MESSAGE_SELECT}
            WHERE m.ROWID = $rowid`;
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

        type AccountEmailRow = { accountUuid: string; address: string; cnt: number };

        // Primary: messages.sender in Sent/Drafts/Outbox folders — strongest signal.
        const sentSenders = db
            .prepare(
                `SELECT
                    SUBSTR(mb.url, INSTR(mb.url, '://') + 3,
                        INSTR(SUBSTR(mb.url, INSTR(mb.url, '://') + 3), '/') - 1) AS accountUuid,
                    a.address,
                    COUNT(*) AS cnt
                FROM messages m
                JOIN mailboxes mb ON m.mailbox = mb.ROWID
                JOIN addresses a ON m.sender = a.ROWID
                WHERE m.deleted = 0
                  AND (mb.url LIKE '%/Sent%' OR mb.url LIKE '%Sent%20Items%'
                       OR mb.url LIKE '%Sent%20Messages%' OR mb.url LIKE '%Outbox%'
                       OR mb.url LIKE '%Drafts%')
                GROUP BY accountUuid, a.address
                ORDER BY accountUuid, cnt DESC`
            )
            .all() as AccountEmailRow[];

        // Fallback: most-frequent type=0 (To) recipient across non-sent folders.
        const inboxRecipients = db
            .prepare(
                `SELECT
                    SUBSTR(mb.url, INSTR(mb.url, '://') + 3,
                        INSTR(SUBSTR(mb.url, INSTR(mb.url, '://') + 3), '/') - 1) AS accountUuid,
                    a.address,
                    COUNT(*) AS cnt
                FROM messages m
                JOIN mailboxes mb ON m.mailbox = mb.ROWID
                JOIN recipients r ON r.message = m.ROWID
                JOIN addresses a ON r.address = a.ROWID
                WHERE m.deleted = 0
                  AND r.type = 0
                  AND mb.url NOT LIKE '%/Sent%'
                  AND mb.url NOT LIKE '%Sent%20Items%'
                  AND mb.url NOT LIKE '%Sent%20Messages%'
                  AND mb.url NOT LIKE '%Outbox%'
                  AND mb.url NOT LIKE '%Drafts%'
                GROUP BY accountUuid, a.address
                ORDER BY accountUuid, cnt DESC`
            )
            .all() as AccountEmailRow[];

        const emailByAccount = new Map<string, string>();

        for (const row of sentSenders) {
            if (!emailByAccount.has(row.accountUuid)) {
                emailByAccount.set(row.accountUuid, row.address);
            }
        }

        for (const row of inboxRecipients) {
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

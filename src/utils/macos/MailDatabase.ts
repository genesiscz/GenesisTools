import logger from "@app/logger";
import { ENVELOPE_INDEX_PATH } from "@app/macos/lib/mail/constants";
import type { MailDB } from "@app/macos/lib/mail/db-types";
import type {
    AccountInfo,
    MailAttachment,
    MailMessageRow,
    MailRecipient,
    ReceiverInfo,
    SearchOptions,
} from "@app/macos/lib/mail/types";
import { buildOrderedLikePattern, escapeLike } from "@app/utils/database";
import { type Expression, type SqlBool, sql } from "kysely";
import { MacDatabase } from "./MacDatabase";
import { type MailFilterOptions, SQL_BIND_BATCH } from "./mail-sql";

/**
 * Build raw SQL filter fragments for date range / mailbox / receiver / account.
 * Returned as boolean Expressions to be combined with `eb.and(...)`.
 */
function buildMailFilterExpressions(opts: MailFilterOptions): Expression<SqlBool>[] {
    const filters: Expression<SqlBool>[] = [];

    if (opts.from) {
        const seconds = Math.floor(opts.from.getTime() / 1000);
        filters.push(sql<SqlBool>`m.date_sent >= ${seconds}`);
    }

    if (opts.to) {
        const seconds = Math.floor(opts.to.getTime() / 1000);
        filters.push(sql<SqlBool>`m.date_sent <= ${seconds}`);
    }

    if (opts.mailbox) {
        const pattern = `%${escapeLike(opts.mailbox)}%`;
        filters.push(sql<SqlBool>`mb.url LIKE ${pattern} ESCAPE '\\'`);
    }

    if (opts.receiver) {
        const pattern = `%${escapeLike(opts.receiver)}%`;
        filters.push(sql<SqlBool>`m.ROWID IN (
            SELECT r.message FROM recipients r
            JOIN addresses a ON r.address = a.ROWID
            WHERE a.address LIKE ${pattern} ESCAPE '\\'
        )`);
    }

    if (opts.account) {
        const pattern = `%${escapeLike(opts.account)}%`;
        filters.push(sql<SqlBool>`mb.url LIKE ${pattern} ESCAPE '\\'`);
    }

    return filters;
}

const MESSAGE_SELECT_COLUMNS = [
    sql<number>`m.ROWID`.as("rowid"),
    "s.subject",
    sql<string>`a.address`.as("senderAddress"),
    sql<string | null>`a.comment`.as("senderName"),
    sql<number>`m.date_sent`.as("dateSent"),
    sql<number>`m.date_received`.as("dateReceived"),
    sql<string>`mb.url`.as("mailboxUrl"),
    "m.read",
    "m.flagged",
    "m.deleted",
    "m.size",
] as const;

export class MailDatabase extends MacDatabase {
    protected readonly dbPath = ENVELOPE_INDEX_PATH;
    protected readonly dbLabel = "Mail database";
    protected readonly notFoundMessage = "Make sure Mail.app is configured and has downloaded messages.";

    private k() {
        return this.getKysely<MailDB>();
    }

    async searchMessages(opts: SearchOptions): Promise<MailMessageRow[]> {
        const tokens = opts.query.split(/\s+/).filter((t) => t.length > 0);

        if (tokens.length === 0) {
            return [];
        }

        const ordered = buildOrderedLikePattern(tokens);
        const escapedTokens = tokens.map((t) => `%${escapeLike(t)}%`);
        const filterExpressions = buildMailFilterExpressions(opts);

        logger.debug(`Running search query (wildcard) with ${tokens.length} token(s): ${tokens.join(", ")}`);

        const rows = await this.k()
            .selectFrom("messages as m")
            .innerJoin("subjects as s", "s.ROWID", "m.subject")
            .innerJoin("addresses as a", "a.ROWID", "m.sender")
            .innerJoin("mailboxes as mb", "mb.ROWID", "m.mailbox")
            .leftJoin("attachments as att", "att.message", "m.ROWID")
            .select(MESSAGE_SELECT_COLUMNS as never)
            .distinct()
            .where("m.deleted", "=", 0)
            .where((eb) =>
                eb.or([
                    sql<SqlBool>`s.subject LIKE ${ordered} ESCAPE '\\'`,
                    sql<SqlBool>`a.address LIKE ${ordered} ESCAPE '\\'`,
                    sql<SqlBool>`a.comment LIKE ${ordered} ESCAPE '\\'`,
                    sql<SqlBool>`att.name LIKE ${ordered} ESCAPE '\\'`,
                    eb.and(
                        escapedTokens.map(
                            (pattern) => sql<SqlBool>`(
                                s.subject LIKE ${pattern} ESCAPE '\\'
                                OR a.address LIKE ${pattern} ESCAPE '\\'
                                OR a.comment LIKE ${pattern} ESCAPE '\\'
                                OR att.name LIKE ${pattern} ESCAPE '\\'
                            )`
                        )
                    ),
                ])
            )
            .where((eb) => eb.and(filterExpressions))
            .orderBy("m.date_sent", "desc")
            .execute();

        return rows as unknown as MailMessageRow[];
    }

    async getMessagesByRowids(rowids: number[], opts?: MailFilterOptions): Promise<MailMessageRow[]> {
        if (rowids.length === 0) {
            return [];
        }

        const results: MailMessageRow[] = [];
        const filterExpressions = opts ? buildMailFilterExpressions(opts) : [];

        for (let offset = 0; offset < rowids.length; offset += SQL_BIND_BATCH) {
            const batch = rowids.slice(offset, offset + SQL_BIND_BATCH);

            const rows = await this.k()
                .selectFrom("messages as m")
                .innerJoin("subjects as s", "s.ROWID", "m.subject")
                .innerJoin("addresses as a", "a.ROWID", "m.sender")
                .innerJoin("mailboxes as mb", "mb.ROWID", "m.mailbox")
                .select(MESSAGE_SELECT_COLUMNS as never)
                .distinct()
                .where("m.deleted", "=", 0)
                .where("m.ROWID", "in", batch)
                .where((eb) => eb.and(filterExpressions))
                .orderBy("m.date_sent", "desc")
                .execute();

            results.push(...(rows as unknown as MailMessageRow[]));
        }

        return results;
    }

    async listMessages(mailbox: string, limit: number): Promise<MailMessageRow[]> {
        const pattern = `%${escapeLike(mailbox)}%`;

        const rows = await this.k()
            .selectFrom("messages as m")
            .innerJoin("subjects as s", "s.ROWID", "m.subject")
            .innerJoin("addresses as a", "a.ROWID", "m.sender")
            .innerJoin("mailboxes as mb", "mb.ROWID", "m.mailbox")
            .select(MESSAGE_SELECT_COLUMNS as never)
            .distinct()
            .where("m.deleted", "=", 0)
            .where(sql<SqlBool>`mb.url LIKE ${pattern} ESCAPE '\\'`)
            .orderBy("m.date_sent", "desc")
            .limit(limit)
            .execute();

        return rows as unknown as MailMessageRow[];
    }

    async getAttachments(messageRowids: number[]): Promise<Map<number, MailAttachment[]>> {
        if (messageRowids.length === 0) {
            return new Map();
        }

        const rows = await this.k()
            .selectFrom("attachments")
            .select(["message", "name", "attachment_id as attachmentId", "ROWID"])
            .where("message", "in", messageRowids)
            .orderBy(["message", "ROWID"])
            .execute();

        const map = new Map<number, MailAttachment[]>();

        for (const row of rows) {
            const list = map.get(row.message) ?? [];
            list.push({ name: row.name ?? "", attachmentId: row.attachmentId ?? "" });
            map.set(row.message, list);
        }

        return map;
    }

    async getRecipients(messageRowids: number[]): Promise<Map<number, MailRecipient[]>> {
        if (messageRowids.length === 0) {
            return new Map();
        }

        const rows = await this.k()
            .selectFrom("recipients as r")
            .innerJoin("addresses as a", "a.ROWID", "r.address")
            .select([
                sql<number>`r.message`.as("message"),
                sql<string>`a.address`.as("address"),
                sql<string | null>`a.comment`.as("name"),
                sql<number>`r.type`.as("type"),
            ])
            .where("r.message", "in", messageRowids)
            .orderBy(["r.message", "r.type", "r.position"])
            .execute();

        const map = new Map<number, MailRecipient[]>();

        for (const row of rows) {
            const list = map.get(row.message) ?? [];
            list.push({
                address: row.address,
                name: row.name ?? "",
                type: row.type === 0 ? "to" : "cc",
            });
            map.set(row.message, list);
        }

        return map;
    }

    async listReceivers(): Promise<ReceiverInfo[]> {
        const rows = await this.k()
            .selectFrom("recipients as r")
            .innerJoin("addresses as a", "a.ROWID", "r.address")
            .select([
                sql<string>`a.address`.as("address"),
                sql<string | null>`a.comment`.as("name"),
                sql<number>`COUNT(DISTINCT r.message)`.as("messageCount"),
            ])
            .where("r.type", "=", 0)
            .groupBy(["a.address", "a.comment"])
            .having(sql`COUNT(DISTINCT r.message)`, ">", 10)
            .orderBy("messageCount", "desc")
            .limit(50)
            .execute();

        return rows.map((r) => ({
            address: r.address,
            name: r.name ?? "",
            messageCount: r.messageCount,
        }));
    }

    async listMailboxes(): Promise<Array<{ url: string; totalCount: number; unreadCount: number }>> {
        const rows = await this.k()
            .selectFrom("mailboxes")
            .select(["url", sql<number>`total_count`.as("totalCount"), sql<number>`unread_count`.as("unreadCount")])
            .where("total_count", ">", 0)
            .orderBy("total_count", "desc")
            .execute();

        return rows;
    }

    async getMessageById(rowid: number): Promise<MailMessageRow | null> {
        const row = await this.k()
            .selectFrom("messages as m")
            .innerJoin("subjects as s", "s.ROWID", "m.subject")
            .innerJoin("addresses as a", "a.ROWID", "m.sender")
            .innerJoin("mailboxes as mb", "mb.ROWID", "m.mailbox")
            .select(MESSAGE_SELECT_COLUMNS as never)
            .distinct()
            .where("m.ROWID", "=", rowid)
            .executeTakeFirst();

        return (row as unknown as MailMessageRow | undefined) ?? null;
    }

    async getMessageCount(): Promise<number> {
        const row = await this.k()
            .selectFrom("messages")
            .select(sql<number>`COUNT(*)`.as("cnt"))
            .where("deleted", "=", 0)
            .executeTakeFirstOrThrow();

        return row.cnt;
    }

    async listAccounts(): Promise<AccountInfo[]> {
        const mailboxes = await this.k()
            .selectFrom("mailboxes")
            .select(["url", sql<number>`total_count`.as("totalCount")])
            .where("total_count", ">", 0)
            .execute();

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

        const accountUuidExpr = sql<string>`SUBSTR(mb.url, INSTR(mb.url, '://') + 3,
            INSTR(SUBSTR(mb.url, INSTR(mb.url, '://') + 3), '/') - 1)`;

        const sentSenders = await this.k()
            .selectFrom("messages as m")
            .innerJoin("mailboxes as mb", "mb.ROWID", "m.mailbox")
            .innerJoin("addresses as a", "a.ROWID", "m.sender")
            .select([
                accountUuidExpr.as("accountUuid"),
                sql<string>`a.address`.as("address"),
                sql<number>`COUNT(*)`.as("cnt"),
            ])
            .where("m.deleted", "=", 0)
            .where((eb) =>
                eb.or([
                    sql<boolean>`mb.url LIKE '%/Sent%'`,
                    sql<boolean>`mb.url LIKE '%Sent%20Items%'`,
                    sql<boolean>`mb.url LIKE '%Sent%20Messages%'`,
                    sql<boolean>`mb.url LIKE '%Outbox%'`,
                    sql<boolean>`mb.url LIKE '%Drafts%'`,
                ])
            )
            .groupBy(["accountUuid", "a.address"])
            .orderBy(["accountUuid", "cnt desc"])
            .execute();

        const inboxRecipients = await this.k()
            .selectFrom("messages as m")
            .innerJoin("mailboxes as mb", "mb.ROWID", "m.mailbox")
            .innerJoin("recipients as r", "r.message", "m.ROWID")
            .innerJoin("addresses as a", "a.ROWID", "r.address")
            .select([
                accountUuidExpr.as("accountUuid"),
                sql<string>`a.address`.as("address"),
                sql<number>`COUNT(*)`.as("cnt"),
            ])
            .where("m.deleted", "=", 0)
            .where("r.type", "=", 0)
            .where(sql<boolean>`mb.url NOT LIKE '%/Sent%'`)
            .where(sql<boolean>`mb.url NOT LIKE '%Sent%20Items%'`)
            .where(sql<boolean>`mb.url NOT LIKE '%Sent%20Messages%'`)
            .where(sql<boolean>`mb.url NOT LIKE '%Outbox%'`)
            .where(sql<boolean>`mb.url NOT LIKE '%Drafts%'`)
            .groupBy(["accountUuid", "a.address"])
            .orderBy(["accountUuid", "cnt desc"])
            .execute();

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
}

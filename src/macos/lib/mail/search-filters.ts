import { escapeLike, LIKE_ESCAPE_CLAUSE } from "@app/utils/macos/mail-sql";

export interface MailFilterOpts {
    from?: Date;
    to?: Date;
    mailbox?: string;
    receiver?: string;
    account?: string;
    /**
     * Pre-resolved `mailboxes.ROWID` set for `mailbox`/`account` substring
     * filters. The FTS path consumes these instead of LIKE so non-ASCII names
     * (e.g. Czech "Doručená pošta") match correctly.
     */
    mailboxRowids?: number[];
}

/**
 * Build a SQL predicate appended via AND to the FTS / cosine search WHERE clause.
 * Assumes Mail.app's Envelope Index is ATTACHed as `mailapp` and the indexer's
 * content table is aliased `c`.
 *
 * Returns `null` when no filters are set — caller should skip the ATTACH and
 * the IN-subquery entirely (cheaper).
 */
export function buildMailFilterPredicate(opts: MailFilterOpts): { sql: string; params: Array<string | number> } | null {
    const conds: string[] = ["m.deleted = 0"];
    const params: Array<string | number> = [];
    const joins: string[] = [];
    let joinedMb = false;

    if (opts.from) {
        conds.push("m.date_sent >= ?");
        params.push(Math.floor(opts.from.getTime() / 1000));
    }

    if (opts.to) {
        conds.push("m.date_sent <= ?");
        params.push(Math.floor(opts.to.getTime() / 1000));
    }

    if (opts.mailboxRowids !== undefined) {
        if (opts.mailboxRowids.length === 0) {
            conds.push("1 = 0");
        } else {
            conds.push(`m.mailbox IN (${opts.mailboxRowids.join(",")})`);
        }
    } else {
        if (opts.mailbox) {
            joins.push("JOIN mailapp.mailboxes mb ON mb.ROWID = m.mailbox");
            joinedMb = true;
            conds.push(`mb.url LIKE ? ${LIKE_ESCAPE_CLAUSE}`);
            params.push(`%${escapeLike(opts.mailbox)}%`);
        }

        if (opts.account) {
            if (!joinedMb) {
                joins.push("JOIN mailapp.mailboxes mb ON mb.ROWID = m.mailbox");
                joinedMb = true;
            }

            conds.push(`mb.url LIKE ? ${LIKE_ESCAPE_CLAUSE}`);
            params.push(`%${escapeLike(opts.account)}%`);
        }
    }

    if (opts.receiver) {
        joins.push(
            "JOIN mailapp.recipients r ON r.message = m.ROWID",
            "JOIN mailapp.addresses ra ON ra.ROWID = r.address"
        );
        conds.push(`ra.address LIKE ? ${LIKE_ESCAPE_CLAUSE}`);
        params.push(`%${escapeLike(opts.receiver)}%`);
    }

    // `conds` always carries `m.deleted = 0`; a real filter is anything beyond
    // that. Use conds.length > 1 instead of params.length to detect zero-filter
    // calls, since a `mailboxRowids` constraint inlines its rowids into the SQL
    // string rather than producing bind params.
    if (conds.length === 1) {
        return null;
    }

    const sql = `c.source_id IN (
        SELECT CAST(m.ROWID AS TEXT) FROM mailapp.messages m
        ${joins.join(" ")}
        WHERE ${conds.join(" AND ")}
    )`;

    return { sql, params };
}

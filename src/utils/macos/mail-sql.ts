/**
 * Shared SQL helpers for Mail.app's Envelope Index database.
 *
 * Centralized so LIKE escape rules cannot drift between mail search callers.
 */

/**
 * SQL fragment to append after a LIKE expression. Runtime form is
 * `ESCAPE '\'` — the SQLite escape argument is exactly one backslash char.
 */
export const LIKE_ESCAPE_CLAUSE = "ESCAPE '\\'";

export const SQL_BIND_BATCH = 900;

export interface MailFilterOptions {
    from?: Date;
    to?: Date;
    mailbox?: string;
    receiver?: string;
    account?: string;
}

/** Escape LIKE metacharacters so user input is treated as literal text. */
export function escapeLike(s: string): string {
    return s.replace(/[%_\\]/g, "\\$&");
}

export const MESSAGE_SELECT = `
    SELECT DISTINCT
        m.ROWID as rowid, s.subject,
        a.address as senderAddress, a.comment as senderName,
        m.date_sent as dateSent, m.date_received as dateReceived,
        mb.url as mailboxUrl, m.read, m.flagged, m.deleted, m.size
    FROM messages m
    JOIN subjects s ON m.subject = s.ROWID
    JOIN addresses a ON m.sender = a.ROWID
    JOIN mailboxes mb ON m.mailbox = mb.ROWID`;

export const ATTACHMENT_JOIN = "LEFT JOIN attachments att ON att.message = m.ROWID";

/** Build WHERE clauses + params for date/mailbox/receiver/account filters. */
export function buildFilters(opts: MailFilterOptions, params: Record<string, string | number>): string[] {
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
        filters.push(`mb.url LIKE $mailbox ${LIKE_ESCAPE_CLAUSE}`);
        params.$mailbox = `%${escapeLike(opts.mailbox)}%`;
    }

    if (opts.receiver) {
        filters.push(`m.ROWID IN (
            SELECT r.message FROM recipients r
            JOIN addresses a ON r.address = a.ROWID
            WHERE a.address LIKE $receiver ${LIKE_ESCAPE_CLAUSE}
        )`);
        params.$receiver = `%${escapeLike(opts.receiver)}%`;
    }

    if (opts.account) {
        filters.push(`mb.url LIKE $account ${LIKE_ESCAPE_CLAUSE}`);
        params.$account = `%${escapeLike(opts.account)}%`;
    }

    return filters;
}

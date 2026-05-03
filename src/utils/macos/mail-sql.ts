/**
 * Shared SQL helpers for Mail.app's Envelope Index database.
 *
 * Centralized so LIKE escape rules cannot drift between mail search callers.
 */

import type { Database } from "bun:sqlite";

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
    /**
     * Pre-resolved set of `mailboxes.ROWID`s satisfying the `mailbox` and/or
     * `account` substring constraints. Filter builders prefer this over the
     * raw strings — it's the only path that handles URL-encoded UTF-8 (e.g.
     * Czech "Doručená pošta" stored as `Doru%C4%8Den%C3%A1%20po%C5%A1ta`).
     */
    mailboxRowids?: number[];
}

/**
 * Normalize a mailbox-name comparand: percent-decode if applicable, then NFC
 * + lowercase. Mail.app stores `mailboxes.url` percent-encoded as UTF-8 NFD
 * (combining diacritics), while user input is typically NFC composed — so
 * raw `String.includes` between the two never matches non-ASCII names.
 */
function normalizeMailboxText(s: string): string {
    let decoded: string;

    try {
        decoded = decodeURIComponent(s);
    } catch {
        decoded = s;
    }

    return decoded.normalize("NFC").toLowerCase();
}

/**
 * Resolve `mailbox` / `account` substring filters to a concrete set of
 * `mailboxes.ROWID`s by URL-decoding + NFC-normalizing each `mailboxes.url`
 * in JS and matching case-insensitively. SQLite's built-in LOWER is
 * ASCII-only and `mailboxes.url` is percent-encoded UTF-8 NFD, so this
 * resolve is the only way to match non-ASCII names like "Doručená pošta".
 *
 * Returns `undefined` when neither filter is set (caller should leave
 * `mailboxRowids` unset). Returns `[]` when both filters are set but no
 * mailbox satisfies them — callers should treat that as "no match".
 */
export function resolveMailboxRowids(db: Database, mailbox?: string, account?: string): number[] | undefined {
    if (!mailbox && !account) {
        return undefined;
    }

    const rows = db.query("SELECT ROWID, url FROM mailboxes WHERE url IS NOT NULL").all() as Array<{
        ROWID: number;
        url: string;
    }>;
    const ml = mailbox ? normalizeMailboxText(mailbox) : undefined;
    const al = account ? normalizeMailboxText(account) : undefined;

    return rows
        .filter((r) => {
            const decoded = normalizeMailboxText(r.url);

            if (ml && !decoded.includes(ml)) {
                return false;
            }

            if (al && !decoded.includes(al)) {
                return false;
            }

            return true;
        })
        .map((r) => r.ROWID);
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

    if (opts.mailboxRowids !== undefined) {
        // Pre-resolved rowids: Unicode-safe path. Empty array → guaranteed
        // no-match predicate so callers don't accidentally match everything.
        if (opts.mailboxRowids.length === 0) {
            filters.push("1 = 0");
        } else {
            filters.push(`m.mailbox IN (${opts.mailboxRowids.join(",")})`);
        }
    } else {
        if (opts.mailbox) {
            filters.push(`mb.url LIKE $mailbox ${LIKE_ESCAPE_CLAUSE}`);
            params.$mailbox = `%${escapeLike(opts.mailbox)}%`;
        }

        if (opts.account) {
            filters.push(`mb.url LIKE $account ${LIKE_ESCAPE_CLAUSE}`);
            params.$account = `%${escapeLike(opts.account)}%`;
        }
    }

    if (opts.receiver) {
        filters.push(`m.ROWID IN (
            SELECT r.message FROM recipients r
            JOIN addresses a ON r.address = a.ROWID
            WHERE a.address LIKE $receiver ${LIKE_ESCAPE_CLAUSE}
        )`);
        params.$receiver = `%${escapeLike(opts.receiver)}%`;
    }

    return filters;
}

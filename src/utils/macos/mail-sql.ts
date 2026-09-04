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
    /** Substring match on sender address or display name. */
    sender?: string;
    /** When true, only unread (`read = 0`). Mutually exclusive with `read`. */
    unread?: boolean;
    /** When true, only read (`read != 0`). Mutually exclusive with `unread`. */
    read?: boolean;
    /** When true, only flagged (`flagged != 0`). */
    flagged?: boolean;
    /** When true, only messages that have at least one attachment row. */
    hasAttachment?: boolean;
    /** Inclusive-exclusive lower bound on `messages.ROWID` (since-last-check). */
    minRowid?: number;
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
 * The mailbox name `INBOX` (any case) is an alias for every account's inbox;
 * see `resolveInboxRowids`.
 *
 * Returns `undefined` when neither filter is set (caller should leave
 * `mailboxRowids` unset). Returns `[]` when both filters are set but no
 * mailbox satisfies them — callers should treat that as "no match".
 */
export function resolveMailboxRowids(db: Database, mailbox?: string, account?: string): number[] | undefined {
    if (!mailbox && !account) {
        return undefined;
    }

    const ml = mailbox ? normalizeMailboxText(mailbox) : undefined;
    const al = account ? normalizeMailboxText(account) : undefined;

    if (ml === "inbox") {
        return resolveInboxRowids(db, al);
    }

    const rows = listMailboxes(db);

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

type MailboxRow = { ROWID: number; url: string };

function listMailboxes(db: Database): MailboxRow[] {
    return db.query("SELECT ROWID, url FROM mailboxes WHERE url IS NOT NULL").all() as MailboxRow[];
}

/** Localized names Mail.app uses for an account's inbox (last URL segment, decoded + lowercased). */
const INBOX_SEGMENTS = new Set(["inbox", "doručená pošta", "doručené", "posteingang", "boîte de réception"]);

function urlAccount(decodedUrl: string): string {
    const match = decodedUrl.match(/^[a-z]+:\/\/([^/]+)\//);
    return match ? match[1] : "";
}

function urlLastSegment(decodedUrl: string): string {
    const slash = decodedUrl.lastIndexOf("/");
    return slash < 0 ? decodedUrl : decodedUrl.slice(slash + 1);
}

/**
 * The inbox of EVERY account, not just the mailboxes whose URL contains "INBOX".
 *
 * Two things make a plain substring match miss most mail on a multi-account Mac:
 * EWS accounts name the inbox in the account language ("Doručená pošta"), and
 * Mail.app keeps a Gmail account's INBOX row empty, storing every message once
 * under the localized `[Gmail]/All Mail` box. So an account whose inbox rows
 * hold no messages falls back to its largest `[Gmail]/` mailbox (All Mail is a
 * superset of every other Gmail label except Spam and Trash, so it is always the
 * largest). Callers listing All Mail should expect the account's own sent mail in
 * the result.
 */
export function resolveInboxRowids(db: Database, accountNeedle?: string): number[] {
    const counts = new Map<number, number>();

    for (const row of db
        .query("SELECT mailbox, COUNT(*) AS c FROM messages WHERE deleted = 0 GROUP BY mailbox")
        .all() as Array<{
        mailbox: number;
        c: number;
    }>) {
        counts.set(row.mailbox, row.c);
    }

    const perAccount = new Map<string, { inbox: number[]; gmail: number[] }>();

    for (const row of listMailboxes(db)) {
        const decoded = normalizeMailboxText(row.url);

        if (accountNeedle && !decoded.includes(accountNeedle)) {
            continue;
        }

        const account = urlAccount(decoded);
        const entry = perAccount.get(account) ?? { inbox: [], gmail: [] };
        perAccount.set(account, entry);

        if (INBOX_SEGMENTS.has(urlLastSegment(decoded))) {
            entry.inbox.push(row.ROWID);
        } else if (decoded.includes("/[gmail]/")) {
            entry.gmail.push(row.ROWID);
        }
    }

    const result: number[] = [];

    for (const { inbox, gmail } of perAccount.values()) {
        const live = inbox.filter((id) => (counts.get(id) ?? 0) > 0);

        if (live.length > 0) {
            result.push(...live);
        } else if (gmail.length > 0) {
            result.push(gmail.reduce((best, id) => ((counts.get(id) ?? 0) > (counts.get(best) ?? 0) ? id : best)));
        } else {
            result.push(...inbox);
        }
    }

    return result;
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

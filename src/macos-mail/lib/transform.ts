import { parseMailboxUrl, normalizeMailboxName } from "@app/macos-mail/lib/constants";
import type { MailMessage, MailMessageRow } from "@app/macos-mail/lib/types";

/**
 * Convert a raw SQLite row to a MailMessage domain object.
 * Parses mailbox URLs, converts Unix timestamps to Dates, and normalizes booleans.
 */
export function rowToMessage(row: MailMessageRow): MailMessage {
    const { account, mailbox } = parseMailboxUrl(row.mailboxUrl);
    return {
        rowid: row.rowid,
        subject: row.subject,
        senderAddress: row.senderAddress,
        senderName: row.senderName,
        dateSent: new Date(row.dateSent * 1000),
        dateReceived: new Date(row.dateReceived * 1000),
        mailbox: normalizeMailboxName(mailbox),
        account,
        read: row.read !== 0,
        flagged: row.flagged !== 0,
        size: row.size,
        attachments: [],
    };
}

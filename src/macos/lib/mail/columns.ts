import type { MailMessage } from "@app/macos/lib/mail/types";
import { formatBytes, formatRelativeTime } from "@app/utils/format";

function formatRecipients(msg: MailMessage, type: "to" | "cc"): string {
    if (!msg.recipients) {
        return "";
    }

    return msg.recipients
        .filter((r) => r.type === type)
        .map((r) => r.name || r.address)
        .join(", ");
}

function formatRecipientEmails(msg: MailMessage, type: "to" | "cc"): string {
    if (!msg.recipients) {
        return "";
    }

    return msg.recipients
        .filter((r) => r.type === type)
        .map((r) => r.address)
        .join(", ");
}

export const MAIL_COLUMNS = {
    date: {
        label: "Date",
        get: (m: MailMessage) => formatRelativeTime(m.dateSent, { compact: true }),
    },
    from: {
        label: "From",
        get: (m: MailMessage) => m.senderName || m.senderAddress,
    },
    fromEmail: {
        label: "From Email",
        get: (m: MailMessage) => m.senderAddress,
    },
    to: {
        label: "To",
        get: (m: MailMessage) => formatRecipients(m, "to"),
    },
    toEmail: {
        label: "To Email",
        get: (m: MailMessage) => formatRecipientEmails(m, "to"),
    },
    cc: {
        label: "CC",
        get: (m: MailMessage) => formatRecipients(m, "cc"),
    },
    subject: {
        label: "Subject",
        get: (m: MailMessage) => (m.subject.length > 60 ? m.subject.slice(0, 60) + "..." : m.subject),
    },
    mailbox: {
        label: "Mailbox",
        get: (m: MailMessage) => m.mailbox,
    },
    account: {
        label: "Account",
        get: (m: MailMessage) => m.account,
    },
    read: {
        label: "Read",
        get: (m: MailMessage) => (m.read ? "yes" : "no"),
    },
    flagged: {
        label: "Flagged",
        get: (m: MailMessage) => (m.flagged ? "yes" : ""),
    },
    size: {
        label: "Size",
        get: (m: MailMessage) => formatBytes(m.size),
    },
    attachments: {
        label: "Attachments",
        get: (m: MailMessage) => (m.attachments.length > 0 ? String(m.attachments.length) : ""),
    },
    body: {
        label: "Body Match",
        get: (m: MailMessage) => (m.bodyMatchesQuery ? "yes" : ""),
    },
    relevance: {
        label: "Relevance",
        get: (m: MailMessage) => (m.semanticScore !== undefined ? (1 - m.semanticScore / 2).toFixed(2) : ""),
    },
} as const;

export type MailColumnKey = keyof typeof MAIL_COLUMNS;
export const DEFAULT_LIST_COLUMNS: MailColumnKey[] = ["date", "from", "subject", "attachments"];
export const ALL_COLUMN_KEYS = Object.keys(MAIL_COLUMNS) as MailColumnKey[];
export const RECIPIENT_COLUMNS: MailColumnKey[] = ["to", "toEmail", "cc"];

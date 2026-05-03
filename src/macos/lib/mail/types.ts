/** Raw row from the SQLite join query */
export interface MailMessageRow {
    rowid: number;
    subject: string;
    /** Null for messages with no sender FK — overwhelmingly drafts. LEFT JOIN keeps these. */
    senderAddress: string | null;
    senderName: string | null;
    dateSent: number;
    dateReceived: number;
    mailboxUrl: string;
    read: number;
    flagged: number;
    deleted: number;
    size: number;
}

/** Enriched message with optional body + attachment info */
export interface MailMessage {
    rowid: number;
    subject: string;
    /** Null for messages with no sender FK — overwhelmingly drafts. */
    senderAddress: string | null;
    senderName: string | null;
    dateSent: Date;
    dateReceived: Date;
    mailbox: string;
    account: string;
    read: boolean;
    flagged: boolean;
    size: number;
    attachments: MailAttachment[];
    body?: string;
    bodyText?: string;
    bodyHtml?: string;
    bodyMarkdown?: string;
    bodyRaw?: string;
    /** First ~200 chars of the FTS/vector hit chunk, surfaced in search results. */
    ftsSnippet?: string;
    bodyMatchesQuery?: boolean;
    /** Cosine distance from query (0 = identical). Set when semantic ranking is active. */
    semanticScore?: number;
    recipients?: MailRecipient[];
}

export interface MailAttachment {
    name: string;
    attachmentId: string;
}

export interface MailRecipient {
    address: string;
    name: string;
    type: "to" | "cc";
}

export interface AccountInfo {
    uuid: string;
    protocol: string;
    email: string;
    mailboxCount: number;
    messageCount: number;
}

export interface SearchOptions {
    query: string;
    withoutBody?: boolean;
    receiver?: string;
    account?: string;
    from?: Date;
    to?: Date;
    mailbox?: string;
    /** Pre-resolved mailbox ROWID set; populated by `MailDatabase.resolveMailboxFilter`. */
    mailboxRowids?: number[];
    limit?: number;
    offset?: number;
}

export interface ReceiverInfo {
    address: string;
    name: string;
    messageCount: number;
}

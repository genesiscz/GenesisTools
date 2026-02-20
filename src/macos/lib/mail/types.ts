/** Raw row from the SQLite join query */
export interface MailMessageRow {
    rowid: number;
    subject: string;
    senderAddress: string;
    senderName: string;
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
    senderAddress: string;
    senderName: string;
    dateSent: Date;
    dateReceived: Date;
    mailbox: string;
    account: string;
    read: boolean;
    flagged: boolean;
    size: number;
    attachments: MailAttachment[];
    body?: string;
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

export interface SearchOptions {
    query: string;
    withoutBody?: boolean;
    receiver?: string;
    from?: Date;
    to?: Date;
    mailbox?: string;
    limit?: number;
}

export interface ReceiverInfo {
    address: string;
    name: string;
    messageCount: number;
}

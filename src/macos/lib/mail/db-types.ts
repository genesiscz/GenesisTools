/**
 * Apple Mail Envelope Index schema (readonly).
 *
 * Mirrors the proprietary Mail.app schema. Because we never write, all columns
 * are typed as plain values (no Generated<>). If macOS updates change the
 * schema, the introspection helper in MacDatabase will warn on first open.
 */
export interface MessagesTable {
    ROWID: number;
    subject: number;
    sender: number;
    mailbox: number;
    date_sent: number;
    date_received: number;
    deleted: number;
    read: number;
    flagged: number;
    size: number;
}

export interface SubjectsTable {
    ROWID: number;
    subject: string | null;
}

export interface AddressesTable {
    ROWID: number;
    address: string | null;
    comment: string | null;
}

export interface MailboxesTable {
    ROWID: number;
    url: string;
    total_count: number;
    unread_count: number;
}

export interface AttachmentsTable {
    ROWID: number;
    message: number;
    name: string | null;
    attachment_id: string | null;
}

export interface RecipientsTable {
    ROWID: number;
    message: number;
    address: number;
    type: number;
    position: number;
}

export interface MailDB {
    messages: MessagesTable;
    subjects: SubjectsTable;
    addresses: AddressesTable;
    mailboxes: MailboxesTable;
    attachments: AttachmentsTable;
    recipients: RecipientsTable;
}

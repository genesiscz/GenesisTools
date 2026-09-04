import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { MacContactsDatabase } from "./MacContactsDatabase";
import { MacDatabase } from "./MacDatabase";

// --- Constants ---

const IMESSAGE_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");
const APPLE_EPOCH_OFFSET = 978307200; // seconds between Unix epoch (1970) and Apple epoch (2001)
const NS_PER_SEC = 1_000_000_000;

// --- Types ---

export interface ChatInfo {
    chatId: number;
    chatIdentifier: string;
    displayName: string | null;
    serviceName: string;
    style: "group" | "individual";
    participants: string[];
    messageCount: number;
    lastMessageDate: Date | null;
}

export interface MessageInfo {
    rowid: number;
    text: string | null;
    sender: string;
    isFromMe: boolean;
    date: Date;
    chatIdentifier: string;
    replyToGuid: string | null;
    threadGuid: string | null;
    attachments?: AttachmentInfo[];
}

export interface AttachmentInfo {
    rowid: number;
    filename: string | null;
    mimeType: string | null;
    transferName: string | null;
    totalBytes: number;
}

export interface ListChatsOptions {
    service?: "iMessage" | "SMS";
    from?: Date;
    to?: Date;
    limit?: number;
    page?: number;
}

export interface GetMessagesOptions {
    from?: Date;
    to?: Date;
    limit?: number;
    page?: number;
    includeReactions?: boolean;
    includeAttachments?: boolean;
}

export interface SearchMessagesOptions {
    chatIdentifier?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    page?: number;
}

/**
 * Ceiling for a whole-conversation load. `loadAllMessages` pages 1000 rows at a
 * time and keeps every row, attachments included, so a multi-year group chat
 * with half a million messages otherwise exhausts memory. At this cap one
 * export holds roughly 50 000 message records.
 */
export const EXPORT_MESSAGE_LIMIT = 50_000;

/** A whole-conversation load plus whether the cap dropped anything. */
export interface LoadedConversation {
    messages: MessageInfo[];
    truncated: boolean;
}

export interface ExportConversationOptions {
    from?: Date;
    to?: Date;
    /** Ceiling on messages loaded. Default {@link EXPORT_MESSAGE_LIMIT}. */
    maxMessages?: number;
    format?: "text" | "markdown";
    resolveContacts?: boolean;
    groupByTime?: boolean;
    /** Override the `[name #id]` fragment written for each attachment. */
    formatAttachment?: (att: AttachmentInfo) => string;
    /**
     * Messages already paged for this chat, from {@link iMessagesDatabase.loadConversation}.
     * A caller that walked the conversation for another reason (an attachment
     * export) passes them back here instead of paging the whole chat twice.
     */
    preloaded?: LoadedConversation;
}

// --- Blob Parsing ---

const ATTRIBUTED_BODY_MARKER = Buffer.from([0x84, 0x01, 0x2b]);

/**
 * Extract plain text from an NSArchiver/typedstream attributedBody blob.
 *
 * Format (macOS Sequoia):
 *   ... NSString class hierarchy ... \x84\x01\x2b <length> <utf8_text> ...
 *
 * Length encoding:
 *   - byte < 0x80: single-byte length (up to 127 bytes)
 *   - 0x81 + 2-byte little-endian uint16: long NSString (data detectors, pastes)
 *
 * Reading 0x81 as big-endian over-reads into the following NSDictionary /
 * NSKeyedArchiver bplist attribute runs and dumps them as message text.
 */
export function extractTextFromAttributedBody(blob: Buffer): string | null {
    const idx = blob.indexOf(ATTRIBUTED_BODY_MARKER);

    if (idx === -1) {
        return null;
    }

    const lengthStart = idx + ATTRIBUTED_BODY_MARKER.length;

    if (lengthStart >= blob.length) {
        return null;
    }

    let textLength: number;
    let textStart: number;
    const firstByte = blob[lengthStart];

    if (firstByte < 0x80) {
        textLength = firstByte;
        textStart = lengthStart + 1;
    } else if (firstByte === 0x81) {
        if (lengthStart + 2 >= blob.length) {
            return null;
        }

        textLength = blob[lengthStart + 1] | (blob[lengthStart + 2] << 8);
        textStart = lengthStart + 3;
    } else {
        return null;
    }

    if (textStart + textLength > blob.length) {
        return null;
    }

    const sliced = blob.subarray(textStart, textStart + textLength).toString("utf-8");

    return sanitizeExtractedText(sliced);
}

const EXTRACT_CUT_MARKERS = ["\0", "bplist00", "NSKeyedArchiver"] as const;

function sanitizeExtractedText(text: string): string {
    let end = text.length;

    for (const marker of EXTRACT_CUT_MARKERS) {
        const at = text.indexOf(marker);

        if (at >= 0 && at < end) {
            end = at;
        }
    }

    if (end === text.length) {
        return text;
    }

    return text.slice(0, end);
}

/**
 * The message body: the plain `text` column VERBATIM, and only otherwise the
 * decoded attributedBody blob.
 *
 * The cut markers exist to trim an over-read blob. Running them over the text
 * column truncated any ordinary message containing one of those words, e.g.
 * "the blob starts with bplist00 magic" came back as "the blob starts with ".
 */
export function messageTextFromRow(row: { text: string | null; attributedBody: Buffer | null }): string | null {
    if (row.text) {
        return row.text;
    }

    if (row.attributedBody) {
        return extractTextFromAttributedBody(Buffer.from(row.attributedBody));
    }

    return row.text;
}

// --- Helpers ---

function appleTimestampToDate(ts: number): Date {
    return new Date((ts / NS_PER_SEC + APPLE_EPOCH_OFFSET) * 1000);
}

function dateToAppleTimestamp(d: Date): number {
    return Math.floor((d.getTime() / 1000 - APPLE_EPOCH_OFFSET) * NS_PER_SEC);
}

const DEFAULT_LIMIT = 50;

function computeOffset(limit: number, page?: number): number {
    if (!page || page <= 1) {
        return 0;
    }

    return (page - 1) * limit;
}

// --- Database Class ---

export class iMessagesDatabase extends MacDatabase {
    protected readonly dbPath = IMESSAGE_DB_PATH;
    protected readonly dbLabel = "iMessage database";
    protected readonly fullDiskAccess = {
        reason: "read your iMessage and SMS history",
        feature: "messages",
    } as const;
    protected readonly notFoundMessage = "Make sure Messages.app has been used on this Mac.";

    /**
     * List all conversations, ordered by most recent message.
     */
    listChats(options?: ListChatsOptions): ChatInfo[] {
        const db = this.getDb();
        const limit = options?.limit ?? DEFAULT_LIMIT;
        const offset = computeOffset(limit, options?.page);
        const params: Record<string, string | number> = { $limit: limit, $offset: offset };
        const filters: string[] = [];

        if (options?.service) {
            filters.push("c.service_name = $service");
            params.$service = options.service;
        }

        if (options?.from) {
            filters.push("last_msg.date >= $from");
            params.$from = dateToAppleTimestamp(options.from);
        }

        if (options?.to) {
            filters.push("last_msg.date <= $to");
            params.$to = dateToAppleTimestamp(options.to);
        }

        const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

        const rows = db
            .prepare(
                `SELECT
                    c.ROWID as chatId,
                    c.chat_identifier as chatIdentifier,
                    c.display_name as displayName,
                    c.service_name as serviceName,
                    c.style,
                    COUNT(cmj.message_id) as messageCount,
                    MAX(m.date) as lastDate
                FROM chat c
                LEFT JOIN chat_message_join cmj ON c.ROWID = cmj.chat_id
                LEFT JOIN message m ON cmj.message_id = m.ROWID
                LEFT JOIN (
                    SELECT cmj2.chat_id, MAX(m2.date) as date
                    FROM chat_message_join cmj2
                    JOIN message m2 ON cmj2.message_id = m2.ROWID
                    GROUP BY cmj2.chat_id
                ) last_msg ON c.ROWID = last_msg.chat_id
                ${whereClause}
                GROUP BY c.ROWID
                ORDER BY lastDate DESC
                LIMIT $limit OFFSET $offset`
            )
            .all(params) as Array<{
            chatId: number;
            chatIdentifier: string;
            displayName: string | null;
            serviceName: string;
            style: number;
            messageCount: number;
            lastDate: number | null;
        }>;

        return rows.map((row) => {
            const participants = db
                .prepare(
                    `SELECT h.id FROM handle h
                     JOIN chat_handle_join chj ON h.ROWID = chj.handle_id
                     WHERE chj.chat_id = $chatId`
                )
                .all({ $chatId: row.chatId }) as Array<{ id: string }>;

            return {
                chatId: row.chatId,
                chatIdentifier: row.chatIdentifier,
                displayName: row.displayName || null,
                serviceName: row.serviceName,
                style: row.style === 43 ? "group" : "individual",
                participants: participants.map((p) => p.id),
                messageCount: row.messageCount,
                lastMessageDate: row.lastDate ? appleTimestampToDate(row.lastDate) : null,
            } satisfies ChatInfo;
        });
    }

    /**
     * Get messages in a conversation by chat identifier (phone number or group ID).
     */
    getMessages(chatIdentifier: string, options?: GetMessagesOptions): MessageInfo[] {
        const db = this.getDb();
        const limit = options?.limit ?? DEFAULT_LIMIT;
        const offset = computeOffset(limit, options?.page);
        const includeReactions = options?.includeReactions ?? false;
        const params: Record<string, string | number> = {
            $chatId: chatIdentifier,
            $limit: limit,
            $offset: offset,
        };
        const filters: string[] = ["c.chat_identifier = $chatId"];

        if (!includeReactions) {
            filters.push("m.associated_message_type = 0");
        }

        if (options?.from) {
            filters.push("m.date >= $from");
            params.$from = dateToAppleTimestamp(options.from);
        }

        if (options?.to) {
            filters.push("m.date <= $to");
            params.$to = dateToAppleTimestamp(options.to);
        }

        const rows = db
            .prepare(
                `SELECT
                    m.ROWID as rowid,
                    m.text,
                    m.attributedBody,
                    m.is_from_me as isFromMe,
                    m.date,
                    m.handle_id as handleId,
                    m.reply_to_guid as replyToGuid,
                    m.thread_originator_guid as threadGuid,
                    h.id as handleIdentifier,
                    c.chat_identifier as chatIdentifier
                FROM message m
                JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
                JOIN chat c ON cmj.chat_id = c.ROWID
                LEFT JOIN handle h ON m.handle_id = h.ROWID
                WHERE ${filters.join(" AND ")}
                ORDER BY m.date ASC
                LIMIT $limit OFFSET $offset`
            )
            .all(params) as Array<RawMessageRow>;

        const messages = rows.map((row) => this.rawToMessageInfo(row));

        if (options?.includeAttachments) {
            this.attachAttachments(
                messages,
                rows.map((r) => r.rowid)
            );
        }

        return messages;
    }

    /**
     * Search messages across all conversations by text content.
     */
    searchMessages(query: string, options?: SearchMessagesOptions): MessageInfo[] {
        const db = this.getDb();
        const limit = options?.limit ?? DEFAULT_LIMIT;
        const offset = computeOffset(limit, options?.page);
        const params: Record<string, string | number> = {
            $query: `%${query}%`,
            $limit: limit,
            $offset: offset,
        };
        const filters: string[] = ["m.associated_message_type = 0"];

        if (options?.chatIdentifier) {
            filters.push("c.chat_identifier = $chatId");
            params.$chatId = options.chatIdentifier;
        }

        if (options?.from) {
            filters.push("m.date >= $from");
            params.$from = dateToAppleTimestamp(options.from);
        }

        if (options?.to) {
            filters.push("m.date <= $to");
            params.$to = dateToAppleTimestamp(options.to);
        }

        // Search in text column — attributedBody is binary, can't LIKE-search it
        // For messages with text=NULL (stored in attributedBody), we extract text
        // programmatically and filter in-memory
        const textRows = db
            .prepare(
                `SELECT
                    m.ROWID as rowid,
                    m.text,
                    m.attributedBody,
                    m.is_from_me as isFromMe,
                    m.date,
                    m.handle_id as handleId,
                    m.reply_to_guid as replyToGuid,
                    m.thread_originator_guid as threadGuid,
                    h.id as handleIdentifier,
                    c.chat_identifier as chatIdentifier
                FROM message m
                JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
                JOIN chat c ON cmj.chat_id = c.ROWID
                LEFT JOIN handle h ON m.handle_id = h.ROWID
                WHERE ${filters.join(" AND ")}
                  AND m.text LIKE $query
                ORDER BY m.date DESC
                LIMIT $limit OFFSET $offset`
            )
            .all(params) as Array<RawMessageRow>;

        // Also search in attributedBody blobs (messages where text is NULL)
        // Fetch a larger batch, extract text, filter in-memory
        const blobFilters = [...filters, "m.text IS NULL", "m.attributedBody IS NOT NULL"];
        const blobParams = { ...params };
        delete blobParams.$query;
        blobParams.$blobLimit = limit * 20; // over-fetch since we filter in-memory

        const blobRows = db
            .prepare(
                `SELECT
                    m.ROWID as rowid,
                    m.text,
                    m.attributedBody,
                    m.is_from_me as isFromMe,
                    m.date,
                    m.handle_id as handleId,
                    m.reply_to_guid as replyToGuid,
                    m.thread_originator_guid as threadGuid,
                    h.id as handleIdentifier,
                    c.chat_identifier as chatIdentifier
                FROM message m
                JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
                JOIN chat c ON cmj.chat_id = c.ROWID
                LEFT JOIN handle h ON m.handle_id = h.ROWID
                WHERE ${blobFilters.join(" AND ")}
                ORDER BY m.date DESC
                LIMIT $blobLimit`
            )
            .all(blobParams) as Array<RawMessageRow>;

        const queryLower = query.toLowerCase();
        const blobMatches = blobRows
            .filter((row) => {
                if (!row.attributedBody) {
                    return false;
                }

                const extracted = extractTextFromAttributedBody(Buffer.from(row.attributedBody));
                return extracted?.toLowerCase().includes(queryLower) ?? false;
            })
            .slice(0, limit);

        // Merge text matches + blob matches, deduplicate, sort by date DESC
        const seenRowids = new Set<number>();
        const all: RawMessageRow[] = [];

        for (const row of [...textRows, ...blobMatches]) {
            if (!seenRowids.has(row.rowid)) {
                seenRowids.add(row.rowid);
                all.push(row);
            }
        }

        all.sort((a, b) => b.date - a.date);

        return all.slice(0, limit).map((row) => this.rawToMessageInfo(row));
    }

    /**
     * Get a single message by ROWID with full metadata.
     */
    getMessage(rowid: number): MessageInfo | null {
        const db = this.getDb();

        const row = db
            .prepare(
                `SELECT
                    m.ROWID as rowid,
                    m.text,
                    m.attributedBody,
                    m.is_from_me as isFromMe,
                    m.date,
                    m.handle_id as handleId,
                    m.reply_to_guid as replyToGuid,
                    m.thread_originator_guid as threadGuid,
                    h.id as handleIdentifier,
                    c.chat_identifier as chatIdentifier
                FROM message m
                JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
                JOIN chat c ON cmj.chat_id = c.ROWID
                LEFT JOIN handle h ON m.handle_id = h.ROWID
                WHERE m.ROWID = $rowid`
            )
            .get({ $rowid: rowid }) as RawMessageRow | null;

        if (!row) {
            return null;
        }

        const msg = this.rawToMessageInfo(row);
        this.attachAttachments([msg], [row.rowid]);
        return msg;
    }

    /**
     * Export a conversation as formatted text for AI context or display.
     * Capped at `maxMessages`; a truncated export says so in its first lines.
     */
    exportConversation(chatIdentifier: string, options?: ExportConversationOptions): string {
        const format = options?.format ?? "text";
        const resolveContacts = options?.resolveContacts ?? true;
        const groupByTime = options?.groupByTime ?? true;

        const maxMessages = options?.maxMessages ?? EXPORT_MESSAGE_LIMIT;
        const { messages, truncated } =
            options?.preloaded ??
            this.loadAllMessages(
                chatIdentifier,
                {
                    from: options?.from,
                    to: options?.to,
                    includeAttachments: true,
                },
                maxMessages
            );

        if (messages.length === 0) {
            return "No messages found.";
        }

        // Resolve contact names
        let nameMap = new Map<string, string>();

        if (resolveContacts) {
            const contacts = new MacContactsDatabase();
            const identifiers = [...new Set(messages.filter((m) => !m.isFromMe).map((m) => m.sender))];
            nameMap = contacts.resolveAll(identifiers);
            contacts.close();
        }

        const resolveName = (sender: string, isFromMe: boolean): string => {
            if (isFromMe) {
                return "Me";
            }

            return nameMap.get(sender) ?? sender;
        };

        const isMarkdown = format === "markdown";
        const lines: string[] = [];

        if (truncated) {
            // Messages come back oldest first, so what is missing is the RECENT
            // end. Say so rather than writing a silently partial transcript.
            lines.push(
                `> Truncated: only the OLDEST ${maxMessages} messages of this conversation are here.`,
                "> Narrow it with a date range, or raise maxMessages.",
                ""
            );
        }

        let prevSender = "";
        let prevDateStr = "";

        for (const msg of messages) {
            const hasAttachments = msg.attachments && msg.attachments.length > 0;

            if (!msg.text && !hasAttachments) {
                continue;
            }

            // Date header when the day changes
            const dateStr = msg.date.toLocaleDateString("en-US", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
            });

            if (dateStr !== prevDateStr) {
                if (lines.length > 0) {
                    lines.push("");
                }

                if (isMarkdown) {
                    lines.push(`## ${dateStr}`);
                } else {
                    lines.push(`── ${dateStr} ──`);
                }

                lines.push("");
                prevSender = "";
                prevDateStr = dateStr;
            }

            const senderName = resolveName(msg.sender, msg.isFromMe);
            const time = msg.date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

            // Build message line
            let content = msg.text ?? "";

            if (hasAttachments) {
                const attLabels = msg
                    .attachments!.map((a) =>
                        options?.formatAttachment
                            ? options.formatAttachment(a)
                            : `${a.transferName ?? a.filename ?? "attachment"} #${a.rowid}`
                    )
                    .join(", ");

                if (content) {
                    content += ` [${attLabels}]`;
                } else {
                    content = `[${attLabels}]`;
                }
            }

            const prefix = isMarkdown ? "  - " : "- ";

            if (groupByTime && senderName === prevSender) {
                lines.push(`${prefix}[${time}] ${content}`);
            } else {
                if (lines.length > 0 && prevSender !== "") {
                    lines.push("");
                }

                if (isMarkdown) {
                    lines.push(`**${senderName}:**`);
                } else {
                    lines.push(`${senderName}:`);
                }

                lines.push(`${prefix}[${time}] ${content}`);
                prevSender = senderName;
            }
        }

        return lines.join("\n");
    }

    /**
     * Load every message in a chat (paginated), up to `maxMessages`. Used by
     * disk export / attachment dumps.
     */
    getAllMessages(
        chatIdentifier: string,
        options?: GetMessagesOptions,
        maxMessages: number = EXPORT_MESSAGE_LIMIT
    ): MessageInfo[] {
        return this.loadAllMessages(chatIdentifier, options, maxMessages).messages;
    }

    /**
     * Same load as {@link getAllMessages}, keeping the truncation flag so the
     * result can be handed to `exportConversation({ preloaded })`.
     */
    loadConversation(
        chatIdentifier: string,
        options?: GetMessagesOptions,
        maxMessages: number = EXPORT_MESSAGE_LIMIT
    ): LoadedConversation {
        return this.loadAllMessages(chatIdentifier, options, maxMessages);
    }

    /**
     * Get a single attachment by ROWID with its resolved filesystem path.
     */
    getAttachment(rowid: number): (AttachmentInfo & { resolvedPath: string }) | null {
        const db = this.getDb();

        const row = db
            .prepare(
                `SELECT a.ROWID as rowid, a.filename, a.mime_type, a.transfer_name, a.total_bytes
                 FROM attachment a
                 WHERE a.ROWID = $rowid`
            )
            .get({ $rowid: rowid }) as {
            rowid: number;
            filename: string | null;
            mime_type: string | null;
            transfer_name: string | null;
            total_bytes: number;
        } | null;

        if (!row) {
            return null;
        }

        const resolvedPath = row.filename ? row.filename.replace(/^~/, homedir()) : "";

        return {
            rowid: row.rowid,
            filename: row.filename,
            mimeType: row.mime_type,
            transferName: row.transfer_name,
            totalBytes: row.total_bytes,
            resolvedPath,
        };
    }

    // --- Private helpers ---

    /**
     * Page a whole chat, stopping once the feed is exhausted or the cap is
     * proven to have dropped a row.
     *
     * Truncation needs an OVERFLOW, not a hit: `length >= maxMessages` called a
     * conversation of exactly the cap truncated, so a complete export carried
     * the "only the OLDEST N messages" banner and the warn log fired for a run
     * that lost nothing. Reading past the cap is what tells the two apart.
     */
    private loadAllMessages(
        chatIdentifier: string,
        options?: GetMessagesOptions,
        maxMessages: number = EXPORT_MESSAGE_LIMIT
    ): { messages: MessageInfo[]; truncated: boolean } {
        const pageSize = 1_000;
        const messages: MessageInfo[] = [];
        let page = 1;

        for (;;) {
            const batch = this.getMessages(chatIdentifier, {
                ...options,
                limit: pageSize,
                page,
            });
            messages.push(...batch);

            if (messages.length > maxMessages) {
                logger.warn(
                    { chatIdentifier, maxMessages, loaded: messages.length },
                    "[iMessages] conversation hit the load cap; the result is truncated"
                );

                return { messages: messages.slice(0, maxMessages), truncated: true };
            }

            if (batch.length < pageSize) {
                break;
            }

            page++;
        }

        return { messages, truncated: false };
    }

    private rawToMessageInfo(row: RawMessageRow): MessageInfo {
        return {
            rowid: row.rowid,
            text: messageTextFromRow(row),
            sender: row.isFromMe ? "me" : (row.handleIdentifier ?? "unknown"),
            isFromMe: row.isFromMe === 1,
            date: appleTimestampToDate(row.date),
            chatIdentifier: row.chatIdentifier,
            replyToGuid: row.replyToGuid ?? null,
            threadGuid: row.threadGuid ?? null,
        };
    }

    private attachAttachments(messages: MessageInfo[], rowids: number[]): void {
        const db = this.getDb();
        if (rowids.length === 0) {
            return;
        }

        const placeholders = rowids.map(() => "?").join(",");
        const rows = db
            .prepare(
                `SELECT maj.message_id, a.ROWID as attachment_rowid, a.filename, a.mime_type, a.transfer_name, a.total_bytes
                 FROM message_attachment_join maj
                 JOIN attachment a ON maj.attachment_id = a.ROWID
                 WHERE maj.message_id IN (${placeholders})
                 ORDER BY maj.message_id`
            )
            .all(...rowids) as Array<{
            message_id: number;
            attachment_rowid: number;
            filename: string | null;
            mime_type: string | null;
            transfer_name: string | null;
            total_bytes: number;
        }>;

        const byMessage = new Map<number, AttachmentInfo[]>();

        for (const row of rows) {
            const list = byMessage.get(row.message_id) ?? [];
            list.push({
                rowid: row.attachment_rowid,
                filename: row.filename,
                mimeType: row.mime_type,
                transferName: row.transfer_name,
                totalBytes: row.total_bytes,
            });
            byMessage.set(row.message_id, list);
        }

        for (let i = 0; i < messages.length; i++) {
            const atts = byMessage.get(rowids[i]);

            if (atts) {
                messages[i].attachments = atts;
            }
        }
    }
}

// --- Raw Row Types ---

interface RawMessageRow {
    rowid: number;
    text: string | null;
    attributedBody: Buffer | null;
    isFromMe: number;
    date: number;
    handleId: number;
    replyToGuid: string | null;
    threadGuid: string | null;
    handleIdentifier: string | null;
    chatIdentifier: string;
}

export type ActionType = "say" | "ask" | "notify";

export interface ContactConfig {
    userId: string;
    displayName: string;
    username?: string;
    actions: ActionType[];
    askSystemPrompt?: string;
    askProvider?: string;
    askModel?: string;
    replyDelayMin: number;
    replyDelayMax: number;
}

export interface TelegramConfigData {
    apiId: number;
    apiHash: string;
    session: string;
    me?: { firstName: string; username?: string; phone?: string };
    contacts: ContactConfig[];
    configuredAt: string;
}

export interface ActionResult {
    action: ActionType;
    success: boolean;
    reply?: string;
    duration: number;
    error?: unknown;
}

export type ActionHandler = (
    message: import("./TelegramMessage").TelegramMessage,
    contact: import("./TelegramContact").TelegramContact,
    client: import("./TGClient").TGClient,
    conversationHistory?: string
) => Promise<ActionResult>;

export const DEFAULTS = {
    apiId: 39398121,
    apiHash: "d1857dc6fabd4d7034795dd3bd6ac0d1",
    replyDelayMin: 2000,
    replyDelayMax: 5000,
    askSystemPrompt:
        "You're chatting casually on Telegram. Reply naturally and briefly (1-2 sentences). Match the language of the incoming message. You may receive recent conversation history for context — reply only to the latest message.",
    connectionRetries: 5,
    maxProcessedMessages: 500,
    typingIntervalMs: 4000,
    askTimeoutMs: 60_000,
    askProvider: "openai",
    askModel: "gpt-4o-mini",
    maxContextMessages: 30,
    historyFetchLimit: 100,
} as const;

// ── History Types (Phase 2) ─────────────────────────────────────────

export interface MessageRow {
    id: number;
    chat_id: string;
    sender_id: string | null;
    text: string | null;
    media_desc: string | null;
    is_outgoing: number;
    date_unix: number;
    date_iso: string;
}

export interface SyncStateRow {
    chat_id: string;
    last_synced_id: number;
    last_synced_at: string;
}

export interface SearchOptions {
    since?: Date;
    until?: Date;
    limit?: number;
}

export interface SearchResult {
    message: MessageRow;
    rank?: number;
    distance?: number;
    score?: number;
}

export interface ChatStats {
    chatId: string;
    displayName?: string;
    totalMessages: number;
    outgoingMessages: number;
    incomingMessages: number;
    firstMessageDate: string | null;
    lastMessageDate: string | null;
    embeddedMessages: number;
}

/** Languages supported by macOS NLEmbedding */
export const EMBEDDING_LANGUAGES = new Set(["en", "es", "fr", "de", "it", "pt", "zh"]);

// ── V2 Schema Types ─────────────────────────────────────────────────

export interface MessageRowV2 extends MessageRow {
    edited_date_unix: number | null;
    is_deleted: number; // 0 or 1
    deleted_at_iso: string | null;
    reply_to_msg_id: number | null;
}

export type ChatType = "user" | "group" | "channel";

export interface ChatRow {
    chat_id: string;
    chat_type: ChatType;
    title: string;
    username: string | null;
    last_synced_at: string | null;
}

export interface AttachmentRow {
    chat_id: string;
    message_id: number;
    attachment_index: number;
    kind: string;
    mime_type: string | null;
    file_name: string | null;
    file_size: number | null;
    telegram_file_id: string | null;
    is_downloaded: number; // 0 or 1
    local_path: string | null;
    sha256: string | null;
}

export interface MessageRevisionRow {
    id: number;
    chat_id: string;
    message_id: number;
    revision_type: "create" | "edit" | "delete";
    old_text: string | null;
    new_text: string | null;
    revised_at_unix: number;
    revised_at_iso: string;
}

export interface SyncSegmentRow {
    id: number;
    chat_id: string;
    from_date_unix: number;
    to_date_unix: number;
    from_msg_id: number;
    to_msg_id: number;
    synced_at: string;
}

export interface QueryOptions {
    sender?: "me" | "them" | "any";
    since?: Date;
    until?: Date;
    textPattern?: string;
    limit?: number;
    includeDeleted?: boolean;
}

export interface UpsertMessageInput {
    id: number;
    senderId: string | undefined;
    text: string;
    mediaDescription: string | undefined;
    isOutgoing: boolean;
    date: string;
    dateUnix: number;
    editedDateUnix?: number;
    replyToMsgId?: number;
}

export interface UpsertAttachmentInput {
    chat_id: string;
    message_id: number;
    attachment_index: number;
    kind: string;
    mime_type: string | null;
    file_name: string | null;
    file_size: number | null;
    telegram_file_id: string | null;
}

export interface InsertSegmentInput {
    fromDateUnix: number;
    toDateUnix: number;
    fromMsgId: number;
    toMsgId: number;
}

export interface DateRange {
    fromDateUnix: number;
    toDateUnix: number;
}

export interface SuggestionEditInput {
    chatId: string;
    messageId: number | null;
    suggestedText: string;
    editedText: string;
    sentText: string;
    provider: string | null;
    model: string | null;
}

export interface SuggestionEditRow {
    suggested_text: string;
    edited_text: string;
    sent_text: string;
    created_at: string;
}

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
    conversationHistory?: string,
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

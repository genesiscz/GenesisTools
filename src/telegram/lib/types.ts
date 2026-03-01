export type ActionType = "say" | "ask" | "notify";

export type TelegramRuntimeMode = "daemon" | "light" | "ink";
export type TelegramDialogType = "user" | "group" | "channel";
export type SuggestionTrigger = "manual" | "auto" | "hybrid";
export type StyleRefreshMode = "incremental";

export interface AskModeConfig {
    enabled: boolean;
    provider?: string;
    model?: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
}

export interface SuggestionModeConfig extends AskModeConfig {
    count: number;
    trigger: SuggestionTrigger;
    autoDelayMs: number;
    allowAutoSend: boolean;
}

export interface StyleSourceRule {
    id: string;
    sourceChatId: string;
    direction: "outgoing" | "incoming";
    limit?: number;
    since?: string;
    until?: string;
    regex?: string;
}

export interface StyleProfileConfig {
    enabled: boolean;
    refresh: StyleRefreshMode;
    rules: StyleSourceRule[];
    previewInWatch: boolean;
    derivedPrompt?: string;
    derivedAt?: string;
}

export interface WatchConfig {
    enabled: boolean;
    contextLength: number;
    runtimeMode?: TelegramRuntimeMode;
}

export interface ContactModesConfig {
    autoReply: AskModeConfig;
    assistant: AskModeConfig;
    suggestions: SuggestionModeConfig;
}

export interface ContactConfig {
    userId: string;
    displayName: string;
    username?: string;
    dialogType?: TelegramDialogType;
    actions: ActionType[];

    // V2 config
    watch?: WatchConfig;
    modes?: ContactModesConfig;
    styleProfile?: StyleProfileConfig;

    // V1 compatibility (auto-migrated to modes.autoReply)
    askSystemPrompt?: string;
    askProvider?: string;
    askModel?: string;

    replyDelayMin: number;
    replyDelayMax: number;
}

export interface TelegramDefaultsConfig {
    autoReply: AskModeConfig;
    assistant: AskModeConfig;
    suggestions: SuggestionModeConfig;
}

export interface TelegramConfigData {
    version?: number;
    apiId: number;
    apiHash: string;
    session: string;
    me?: { firstName: string; username?: string; phone?: string };
    defaults?: TelegramDefaultsConfig;
    contacts: ContactConfig[];
    configuredAt: string;
}

export interface ActionResult {
    action: ActionType;
    success: boolean;
    reply?: string;
    sentMessageId?: number;
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
    askTemperature: 0.7,
    askMaxTokens: 512,
    maxContextMessages: 30,
    historyFetchLimit: 100,
    watchContextLength: 30,
    watchRuntimeMode: "daemon" as TelegramRuntimeMode,
    suggestionCount: 3,
    suggestionAutoDelayMs: 5000,
} as const;

export const TELEGRAM_CONFIG_VERSION = 2;

export const DEFAULT_MODE_CONFIG: ContactModesConfig = {
    autoReply: {
        enabled: false,
        provider: DEFAULTS.askProvider,
        model: DEFAULTS.askModel,
        systemPrompt: DEFAULTS.askSystemPrompt,
        temperature: DEFAULTS.askTemperature,
        maxTokens: DEFAULTS.askMaxTokens,
    },
    assistant: {
        enabled: true,
        provider: DEFAULTS.askProvider,
        model: DEFAULTS.askModel,
        systemPrompt: DEFAULTS.askSystemPrompt,
        temperature: DEFAULTS.askTemperature,
        maxTokens: DEFAULTS.askMaxTokens,
    },
    suggestions: {
        enabled: true,
        provider: DEFAULTS.askProvider,
        model: DEFAULTS.askModel,
        systemPrompt: DEFAULTS.askSystemPrompt,
        temperature: DEFAULTS.askTemperature,
        maxTokens: DEFAULTS.askMaxTokens,
        count: DEFAULTS.suggestionCount,
        trigger: "manual",
        autoDelayMs: DEFAULTS.suggestionAutoDelayMs,
        allowAutoSend: false,
    },
};

export const DEFAULT_STYLE_PROFILE: StyleProfileConfig = {
    enabled: false,
    refresh: "incremental",
    rules: [],
    previewInWatch: false,
};

export const DEFAULT_WATCH_CONFIG: WatchConfig = {
    enabled: true,
    contextLength: DEFAULTS.watchContextLength,
    runtimeMode: DEFAULTS.watchRuntimeMode,
};

// ── History Types (V2) ──────────────────────────────────────────────

export interface MessageRow {
    id: number;
    chat_id: string;
    sender_id: string | null;
    text: string | null;
    media_desc: string | null;
    is_outgoing: number;
    date_unix: number;
    date_iso: string;
    edited_date_unix: number | null;
    is_deleted: number;
    deleted_at_iso: string | null;
    reply_to_msg_id: number | null;
}

export interface MessageRevisionRow {
    id: number;
    chat_id: string;
    message_id: number;
    revision_type: "create" | "edit" | "delete";
    text: string | null;
    media_desc: string | null;
    date_iso: string;
    date_unix: number;
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
    thumb_count: number;
    is_downloaded: number;
    local_path: string | null;
    sha256: string | null;
    created_at_iso: string;
    updated_at_iso: string;
}

export interface SuggestionFeedbackRow {
    id: number;
    chat_id: string;
    incoming_message_id: number | null;
    suggestion_text: string;
    edited_text: string | null;
    sent_text: string;
    was_edited: number;
    created_at_iso: string;
}

export interface SyncStateRow {
    chat_id: string;
    last_synced_id: number;
    last_synced_at: string;
}

export interface SyncSegmentRow {
    id: number;
    chat_id: string;
    start_unix: number;
    end_unix: number;
    source: "full" | "incremental" | "query";
    created_at_iso: string;
}

export interface ChatRow {
    chat_id: string;
    chat_type: TelegramDialogType;
    title: string;
    username: string | null;
    last_seen_at_iso: string;
}

export interface SearchOptions {
    since?: Date;
    until?: Date;
    limit?: number;
}

export interface QueryMessagesOptions {
    since?: Date;
    until?: Date;
    sender?: "me" | "them" | "any";
    textRegex?: string;
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

export interface AttachmentLocator {
    chatId: string;
    messageId: number;
    attachmentIndex: number;
}

export interface MissingRange {
    sinceUnix: number;
    untilUnix: number;
}

export interface QueryRequest {
    from: string;
    since?: string;
    until?: string;
    sender?: "me" | "them" | "any";
    text?: string;
    localOnly?: boolean;
    nl?: string;
    limit?: number;
}

/** Languages supported by macOS NLEmbedding */
export const EMBEDDING_LANGUAGES = new Set(["en", "es", "fr", "de", "it", "pt", "zh"]);

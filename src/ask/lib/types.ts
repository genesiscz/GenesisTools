import type { LanguageModelUsage } from "ai";

// Re-export relevant existing types
export type { ProviderChoice, DetectedProvider, ModelInfo } from "@ask/types";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";

export interface AIChatOptions {
    provider: string;
    model: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    tools?: Record<string, AIChatTool>;
    logLevel?: LogLevel;
    session?: {
        dir?: string;
        id?: string;
        autoSave?: boolean;
    };
    resume?: string;
}

export interface AIChatTool {
    description: string;
    parameters: unknown; // ZodSchema or JSON schema object
    execute: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface SendOptions {
    onChunk?: (text: string) => void;
    override?: Partial<Omit<AIChatOptions, "session" | "resume">>;
    addToHistory?: boolean;
    saveThinking?: boolean;
}

export interface ChatResponse {
    content: string;
    thinking?: string;
    usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cachedInputTokens?: number;
    };
    cost?: number;
    duration: number;
    toolCalls?: ToolCallResult[];
}

export interface ToolCallResult {
    name: string;
    input: unknown;
    output: unknown;
    duration: number;
}

export type SessionEntry =
    | SessionConfigEntry
    | SessionUserEntry
    | SessionAssistantEntry
    | SessionSystemEntry
    | SessionContextEntry;

export interface SessionConfigEntry {
    type: "config";
    timestamp: string;
    provider: string;
    model: string;
    systemPrompt?: string;
}

export interface SessionUserEntry {
    type: "user";
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
}

export interface SessionAssistantEntry {
    type: "assistant";
    content: string;
    thinking?: string;
    timestamp: string;
    usage?: LanguageModelUsage;
    cost?: number;
    toolCalls?: ToolCallResult[];
}

export interface SessionSystemEntry {
    type: "system";
    content: string;
    timestamp: string;
}

export interface SessionContextEntry {
    type: "context";
    content: string;
    timestamp: string;
    label?: string;
    metadata?: Record<string, unknown>;
}

export interface AIChatSelection {
    provider: string;
    model: string;
}

export interface LogEntry {
    level: LogLevel;
    message: string;
    timestamp: Date;
    source?: string;
}

export interface SessionStats {
    messageCount: number;
    tokenCount: number;
    cost: number;
    duration: number;
    startedAt: string;
    byRole: Record<string, number>;
}

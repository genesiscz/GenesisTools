import type { LanguageModel, LanguageModelUsage } from "ai";
import type { DetectedProvider, PricingInfo } from "./provider";

// Message types
export interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: Date;
    tokens?: number;
    usage?: LanguageModelUsage;
}

export type APIMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

// Configuration types
export interface ChatConfig {
    model: LanguageModel;
    provider: string;
    modelName: string;
    streaming: boolean;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
}

export interface ChatResponse {
    content: string;
    usage?: LanguageModelUsage;
    cost?: number;
    toolCalls?: Array<{
        toolCallType: "function" | "provider";
        toolCallId: string;
        args?: Record<string, unknown>;
    }>;
}

// Session and conversation types
export interface ChatSession {
    id: string;
    model: string;
    provider: string;
    startTime: string;
    endTime?: string;
    messages: ChatMessage[];
    totalUsage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cachedInputTokens?: number;
    };
    totalCost?: number;
}

export interface ConversationMetadata {
    sessionId: string;
    model: string;
    provider: string;
    startTime: string;
    endTime?: string;
    messageCount: number;
    totalTokens: number;
    totalCost: number;
}

// Provider and model types
export interface ProviderChoice {
    provider: DetectedProvider;
    model: ModelInfo;
}

export interface ModelInfo {
    id: string;
    name: string;
    contextWindow: number;
    pricing?: PricingInfo;
    capabilities: string[];
    provider: string;
}

// Output and formatting types
export type OutputFormat = "text" | "json" | "markdown" | "clipboard" | "file";

export interface OutputConfig {
    type: OutputFormat;
    filename?: string;
}

export interface CostBreakdown {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    cost: number;
    currency: string;
}

// Transcription types
export interface TranscriptionOptions {
    language?: string;
    provider?: string;
    model?: string;
    timestamp?: boolean;
    verbose?: boolean;
}

export interface TranscriptionResult {
    text: string;
    provider: string;
    model: string;
    duration?: number;
    confidence?: number;
    cost?: number;
    processingTime: number;
}

// Search and web types
export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    publishedDate?: string;
}

export interface WebSearchOptions {
    query: string;
    numResults?: number;
    safeSearch?: "off" | "moderate" | "strict";
    country?: string;
    language?: string;
}

// Error handling types
export type APIError = {
    message: string;
    status?: number;
    code?: string;
    details?: unknown;
};

export type ErrorHandler = (error: APIError | Error) => void;

// Utility types
export type EnquirerChoice = {
    name: string;
    message: string;
    value?: unknown;
};

export type EnquirerResponse = {
    [key: string]: string | number | boolean;
};

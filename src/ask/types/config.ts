import type { OutputFormat, TranscriptionOptions, SearchResult, WebSearchOptions } from "./chat";

export interface CLIOptions {
    sst?: string; // Speech-to-text file
    model?: string; // Specific model
    provider?: string; // Specific provider
    format?: string; // Output format for pricing (table/json)
    output?: string; // Output format
    interactive?: boolean;
    streaming?: boolean;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    help?: boolean;
    version?: boolean;
    verbose?: boolean;
    silent?: boolean;
    predictCost?: boolean;
    // Aliases
    s?: string;
    m?: string;
    p?: string;
    f?: string;
    o?: string;
    h?: boolean;
    v?: boolean;
}

export interface Args extends CLIOptions {
    _: string[]; // Message to send
}

export interface AppConfig {
    defaultProvider?: string;
    defaultModel?: string;
    maxTokens?: number;
    temperature?: number;
    costLimit?: number;
    streaming?: boolean;
    conversationsDir?: string;
}

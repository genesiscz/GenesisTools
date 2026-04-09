// ── Account types (from account-types.ts) ──

export type AIProvider =
    | "anthropic" // API key (sk-ant-api...)
    | "anthropic-sub" // Claude Max/Pro OAuth subscription
    | "openai" // API key (sk-...)
    | "openai-sub" // Codex subscription (future)
    | "google"
    | "groq"
    | "elevenlabs"
    | "huggingface";

export interface AIAccountTokens {
    apiKey?: string; // Standard API key
    accessToken?: string; // OAuth access token
    refreshToken?: string; // OAuth refresh token
    expiresAt?: number; // Token expiry (Unix ms)
}

export interface AIAccountEntry {
    name: string;
    provider: AIProvider;
    tokens: AIAccountTokens;
    label?: string; // e.g. "max 20x", "pro"
    apps?: string[]; // which tools use this: ["ask", "claude"]
}

// ── Task types (from types.ts) ──

export type AIProviderType =
    | "cloud"
    | "local-hf"
    | "darwinkit"
    | "coreml"
    | "ollama"
    | "google"
    | "openai"
    | "groq"
    | "openrouter"
    | "assemblyai"
    | "deepgram"
    | "gladia";
export type AITask = "transcribe" | "translate" | "summarize" | "classify" | "embed" | "sentiment" | "tts";

/** All provider types that route to a cloud API (including the "cloud" auto-select alias) */
export const CLOUD_PROVIDER_TYPES: ReadonlySet<AIProviderType> = new Set([
    "cloud",
    "openai",
    "groq",
    "openrouter",
    "assemblyai",
    "deepgram",
    "gladia",
]);

export function isCloudProvider(type: AIProviderType): boolean {
    return CLOUD_PROVIDER_TYPES.has(type);
}

export interface TaskConfig {
    provider: AIProviderType;
    model?: string;
}

// ── New unified config types ──

/** Per-app defaults (e.g. ask tool's preferred provider/model) */
export interface AppDefaults {
    provider?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    streaming?: boolean;
    embeddingProvider?: string;
    embeddingModel?: string;
}

/** Per-app settings, namespaced under apps.<name> */
export interface AppConfig {
    defaults?: AppDefaults;
}

/** Provider registry entry -- controls env-variable auto-detection */
export interface ProviderConfig {
    enabled: boolean;
    envVariable: string; // e.g. "ANTHROPIC_API_KEY" -- predefined, matches providers.ts
}

/** Root shape of ~/.genesis-tools/ai/config.json */
export interface AIConfigData {
    _schemaVersion: number; // idempotency marker for migrations
    accounts: AIAccountEntry[];
    defaultAccounts: Record<string, string>; // context -> account name
    tasks: Record<string, TaskConfig>;
    apps: Record<string, AppConfig>; // e.g. { ask: { defaults: {...} } }
    providers: Record<string, ProviderConfig>; // e.g. { anthropic: { enabled: true, envVariable: "..." } }
}

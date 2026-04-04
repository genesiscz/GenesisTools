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

export interface AIAccountConfig {
    accounts: AIAccountEntry[];
    defaultAccount?: string; // name of the default account
}

import type { AccountRef } from "@genesiscz/utils/ai/config/refs";
import type { CopilotAccountType, CopilotUsageSummary } from "@genesiscz/utils/ai/github-copilot/types";
import type { GrokBillingConfig, GrokModelRecord, GrokSettings } from "@genesiscz/utils/ai/grok";
import type { MaybeSecret } from "@genesiscz/utils/security";

export type CursorTranslationMode = "auto" | "on" | "off";

/** How Grok reasoning is presented to Cursor. */
export type ThinkingPresentationMode = "raw" | "cursor" | "folded";

export type AiProxyProviderType =
    | "grok-subscription"
    | "github-copilot-subscription"
    | "xai-api-key"
    | "openai"
    | "openrouter"
    | "anthropic-subscription"
    | "openai-subscription";

export interface AiProxyListenConfig {
    host: string;
    port: number;
}

export interface AiProxyTranslationConfig {
    cursorAgent: CursorTranslationMode;
    /** raw = passthrough; cursor = reasoning_content only (native thinking UI); folded = <details> in content */
    thinking: ThinkingPresentationMode;
}

export type PublicExposureMode = "none" | "cloudflared" | "tailscale" | "custom";

export interface AiProxyCloudflaredExposure {
    tunnelName?: string;
    configPath?: string;
    /** Start tunnel on `ai-proxy up` when not already running. Never stopped by `down`. */
    autoStart?: boolean;
}

export interface AiProxyTailscaleExposure {
    hostname?: string;
    autoStart?: boolean;
}

export interface AiProxyPublicConfig {
    mode?: PublicExposureMode;
    /** Public hostname, e.g. proxy.example.dev or mac.tail123.ts.net */
    hostname?: string;
    /** URL prefix on the hostname, e.g. /ai → https://host/ai/v1 */
    basePath?: string;
    /** When mode=custom, full Cursor base URL (…/v1). Overrides hostname/basePath. */
    baseUrl?: string;
    cloudflared?: AiProxyCloudflaredExposure;
    tailscale?: AiProxyTailscaleExposure;
    /** @deprecated migrated to cloudflared.tunnelName */
    tunnelName?: string;
    /** @deprecated migrated to cloudflared.configPath */
    cloudflaredConfigPath?: string;
}

export interface AiProxyRuntimeState {
    proxy?: {
        pid: number;
        startedAt: string;
    };
    tunnel?: {
        pid: number;
        provider: "cloudflared";
        startedAt: string;
        tunnelName: string;
    };
}

export interface AiProxyGrokAccountConfig {
    /**
     * Name of the grok-sub account in ~/.genesis-tools/ai/config.json to bill
     * (its `authFile` reference is live-read). Wins over `authPath`.
     */
    accountName?: string;
    authPath?: string;
}

export interface AiProxyGithubCopilotAccountConfig {
    dataDir?: string;
    type?: CopilotAccountType;
}

export interface AiProxyAnthropicSubAccountConfig {
    /** Name of the anthropic-sub account in ~/.genesis-tools/ai/config.json to bill. */
    accountName: string;
}

export interface AiProxyOpenAiSubAccountConfig {
    /**
     * Name of the openai-sub account in ~/.genesis-tools/ai/config.json to bill
     * (refreshed + persisted on use). When omitted, the provider reads the token
     * from the Codex CLI cache (~/.codex/auth.json, read-only, CLI-refreshed).
     */
    accountName?: string;
    /** Override path to the Codex CLI auth.json (defaults to ~/.codex/auth.json). */
    codexAuthPath?: string;
    /**
     * Additional `openai-sub` AI-config account names tried in order when the
     * primary is rate-limited (429) or its auth dies (401 after refresh).
     */
    failoverAccountNames?: string[];
    /**
     * Reasoning effort sent to WHAM when the client omits `reasoning`.
     * "none" omits the field entirely. Default: "low".
     */
    defaultReasoningEffort?: "none" | "low" | "medium" | "high";
    /** Extra model aliases for this account, e.g. { "fast": "gpt-5.4-mini" }. */
    aliases?: Record<string, string>;
}

/** Provider-routing knobs, shared shape for both the account-level default and a per-model route. */
export interface AiProxyOpenRouterProviderRouting {
    order?: string[];
    only?: string[];
    ignore?: string[];
    sort?: "price" | "throughput" | "latency";
    max_price?: Record<string, number>;
    allow_fallbacks?: boolean;
    require_parameters?: boolean;
    data_collection?: "allow" | "deny";
}

/**
 * A per-model routing override. `match` is a glob (exact id or a trailing
 * `*`) tested against the UPSTREAM model id — the same id the client's
 * `messages` request resolves to, e.g. `moonshotai/kimi-k3` or the prefix
 * `moonshotai/*`. Each field falls back to the account-level default
 * independently: a route naming only `provider` still uses the account's
 * `fallbackModels`, and vice versa.
 */
export interface AiProxyOpenRouterRoute {
    match: string;
    provider?: AiProxyOpenRouterProviderRouting;
    fallbackModels?: string[];
}

export interface AiProxyOpenRouterAccountConfig {
    /** Per-account /v1/models filter. Globs matched against the OpenRouter id. */
    models?: {
        /** Absent -> the curated default. ["*"] or [] -> every model OpenRouter serves. */
        include?: string[];
        /** Applied AFTER include. Absent -> ["*:free"]. Explicit [] -> nothing excluded. */
        exclude?: string[];
    };
    /**
     * Provider-routing defaults injected into every request body, for the
     * top-level keys the CLIENT did not set. `order` + `allow_fallbacks: false`
     * pins a model to named upstreams. Overridden per model by `routes`.
     */
    provider?: AiProxyOpenRouterProviderRouting;
    /** OpenRouter `models` fallback list: try these ids if the primary one fails. */
    fallbackModels?: string[];
    /**
     * Per-model overrides, checked in array order — first match wins. Lets one
     * account pin a specific model (e.g. an uncensored route) while leaving
     * everything else on open/cheapest routing. Precedence: client request body
     * > first matching route > this account-level `provider`/`fallbackModels` >
     * OpenRouter's own default.
     */
    routes?: AiProxyOpenRouterRoute[];
    appName?: string;
    appUrl?: string;
}

export interface AiProxyAccountConfig {
    name: string;
    label?: string;
    provider: AiProxyProviderType;
    providerSlug: string;
    enabled: boolean;
    /**
     * The AI-config account this entry bills, as `@account/<immutable id>`.
     * Supersedes the name-based `*.accountName` links: renaming an account no
     * longer breaks the proxy, and `referrersOf` can see the link (account-refs.ts).
     */
    account?: AccountRef;
    grok?: AiProxyGrokAccountConfig;
    githubCopilot?: AiProxyGithubCopilotAccountConfig;
    anthropicSub?: AiProxyAnthropicSubAccountConfig;
    openaiSub?: AiProxyOpenAiSubAccountConfig;
    openrouter?: AiProxyOpenRouterAccountConfig;
    /**
     * Literal API key for api-key providers, stored in config instead of the
     * environment. Takes precedence over `apiKeyEnv` so the account keeps
     * working when the proxy runs without the user's shell env (launchd, cron).
     * This is a real billed credential — `redactConfig` masks it.
     */
    apiKey?: string;
    /**
     * Opt in to resolving this account's billed key from the environment. Off by
     * default: an ambient `XAI_API_KEY` must never be spent just because the
     * shell happens to export it.
     */
    allowEnvApiKey?: boolean;
    apiKeyEnv?: string;
    baseUrl?: string;
    /**
     * Override for the realtime WebSocket base (e.g. wss://api.x.ai/v1).
     * Defaults to `baseUrl` with http(s):// swapped for ws(s)://. Point it at a
     * local mock server in tests.
     */
    realtimeBaseUrl?: string;
    managementKeyEnv?: string;
    teamId?: string;
}

export interface AiProxyClientConfig {
    name: string;
    /**
     * The bearer this client presents. A vault pointer for anything this build
     * wrote (`tools ai-proxy clients add`), a literal for configs written before
     * the vault existed — `tools ai-proxy clients secure` moves those in.
     */
    key: MaybeSecret;
    /** Provider types this client may route to. Omitted = all NON-subscription providers. */
    allowedProviders?: AiProxyProviderType[];
    monthlyTokenCap?: number;
    monthlyCostCapUsd?: number;
    disabled?: boolean;
}

export interface AiProxyRealtimeConfig {
    /**
     * Allow POST /v1/realtime/client_secrets. Off by default: the minted secret
     * is spent talking to the vendor DIRECTLY, so the session itself never
     * passes through the proxy and cannot be logged. The WS tunnel
     * (GET /v1/realtime) is the observable path.
     */
    allowClientSecrets?: boolean;
}

export interface AiProxyConfig {
    listen: AiProxyListenConfig;
    proxyApiKey: string;
    /** Per-user keys for multi-client (VPS) mode. proxyApiKey remains the owner key. */
    clients?: AiProxyClientConfig[];
    translation: AiProxyTranslationConfig;
    realtime?: AiProxyRealtimeConfig;
    public?: AiProxyPublicConfig;
    accounts: AiProxyAccountConfig[];
}

export interface ResolvedRoute {
    accountName: string;
    providerSlug: string;
    upstreamId: string;
    account: AiProxyAccountConfig;
}

export interface ProxyModelMeta {
    proxyId: string;
    accountName: string;
    providerSlug: string;
    upstreamId: string;
    provider: AiProxyProviderType;
    baseUrl: string;
    visibility: GrokModelRecord["visibility"];
    speed: GrokModelRecord["speed"];
    thinking: GrokModelRecord["thinking"];
    contextWindow?: number;
    agentType?: string;
    apiBackend?: string;
    supportsTools?: boolean;
    /** Input modalities upstream advertises (e.g. ["text","image"]); absent = unknown. */
    inputModalities?: string[];
    supportsParallelToolCalls?: boolean;
    billingPlane: "subscription" | "api-key";
    source: GrokModelRecord["source"];
    probeStatus?: GrokModelRecord["probeStatus"];
    description?: string;
    object: "model";
    created: number;
    owned_by: string;
}

export interface GrokUsageDetails {
    billing: GrokBillingConfig;
    settings?: GrokSettings;
}

export interface XaiUsageDetails {
    teamUsage?: unknown;
    prepaidBalance?: unknown;
}

export interface SubscriptionUsageDetails {
    grok?: GrokUsageDetails;
    copilot?: CopilotUsageSummary;
    xai?: XaiUsageDetails;
}

export interface UsageSummary {
    accountName: string;
    provider: AiProxyProviderType;
    tier?: string;
    summary: string;
    details?: SubscriptionUsageDetails;
}

import type { CopilotAccountType, CopilotUsageSummary } from "@app/utils/ai/github-copilot/types";
import type { GrokBillingConfig, GrokModelRecord, GrokSettings } from "@app/utils/ai/grok";

export type CursorTranslationMode = "auto" | "on" | "off";

/** How Grok reasoning is presented to Cursor. */
export type ThinkingPresentationMode = "raw" | "cursor" | "folded";

export type AiProxyProviderType = "grok-subscription" | "github-copilot-subscription" | "xai-api-key" | "openai";

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
    authPath?: string;
}

export interface AiProxyGithubCopilotAccountConfig {
    dataDir?: string;
    type?: CopilotAccountType;
}

export interface AiProxyAccountConfig {
    name: string;
    label?: string;
    provider: AiProxyProviderType;
    providerSlug: string;
    enabled: boolean;
    grok?: AiProxyGrokAccountConfig;
    githubCopilot?: AiProxyGithubCopilotAccountConfig;
    apiKeyEnv?: string;
    baseUrl?: string;
    managementKeyEnv?: string;
    teamId?: string;
}

export interface AiProxyConfig {
    listen: AiProxyListenConfig;
    proxyApiKey: string;
    translation: AiProxyTranslationConfig;
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

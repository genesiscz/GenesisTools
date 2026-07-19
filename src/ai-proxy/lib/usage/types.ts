import type { GrokUsageDetails, SubscriptionUsageDetails } from "@app/ai-proxy/lib/types";
import type { CopilotUsageSummary } from "@genesiscz/utils/ai/github-copilot/types";

export interface TokenUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost_in_usd_ticks?: number;
    /** "estimated" = local char-heuristic because upstream omitted usage; absent = upstream-reported. */
    source?: "estimated";
}

export interface UsageRequestRecord {
    ts: string;
    account: string;
    /** Proxy client (key identity) that issued the request. Absent on pre-billing records. */
    client?: string;
    provider: string;
    proxyModel: string;
    upstreamModel: string;
    path: string;
    status: number;
    elapsedMs: number;
    stream: boolean;
    translate?: string;
    thinking?: string;
    usage?: TokenUsage;
    rateLimited?: boolean;
    error?: boolean;
}

export interface AccountBillingSnapshot {
    fetchedAt: string;
    tier?: string;
    summary: string;
    grok?: GrokUsageDetails;
    copilot?: CopilotUsageSummary;
}

export interface BillingUsageStore {
    version: 1;
    accounts: Record<string, AccountBillingSnapshot>;
}

export interface DailyModelUsage {
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    errors: number;
    rate_limits: number;
    /** Requests whose tokens were locally estimated (upstream sent no usage). */
    estimated_requests?: number;
}

export interface DailyUsageStore {
    version: 1;
    days: Record<string, Record<string, DailyModelUsage>>;
}

export type { GrokUsageDetails, SubscriptionUsageDetails };

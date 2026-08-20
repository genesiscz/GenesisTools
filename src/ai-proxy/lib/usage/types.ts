import type { GrokUsageDetails, SubscriptionUsageDetails } from "@app/ai-proxy/lib/types";
import type { CopilotUsageSummary } from "@genesiscz/utils/ai/github-copilot/types";

export interface TokenUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /**
     * Anthropic-shaped cache traffic, reported OUTSIDE input_tokens. Without
     * these the /v1/messages passthrough books a few hundred prompt tokens for
     * a Claude Code turn that really shipped ~20k through the cache. Recorded,
     * not priced: the static rate table carries no cache rates, and charging
     * cache reads at the full input rate would overbill 10x.
     */
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cost_in_usd_ticks?: number;
    /**
     * USD the upstream itself charged for this exchange, as it reported it.
     * OpenRouter returns this when `usage.include` is set. More authoritative than
     * any local rate table, because it prices the route actually taken.
     */
    cost_usd?: number;
    /**
     * What the upstream paid the underlying provider, when the gateway breaks its
     * own margin out. Recorded for visibility; never what a client is billed.
     */
    upstream_cost_usd?: number;
    /** "estimated" = local char-heuristic because upstream omitted usage; absent = upstream-reported. */
    source?: "estimated";
}

import type { CallTimeline } from "./call-timeline";

/** Caller-supplied request tags, mirrored from the `x-gt-*` headers. */
export interface RequestTags {
    session?: string;
    stage?: string;
    run?: string;
    label?: string;
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
    /**
     * Why the exchange never completed (client abort, upstream reset). Set on calls
     * whose body capture failed: those used to be logged and then dropped, so a
     * stalled or reset call left NO row at all and `tools ai-proxy calls` could not
     * see the very failures worth investigating.
     */
    failure?: string;
    /** Caller-supplied `x-gt-*` tags (session/stage/run/label) — how a call maps back to its job. */
    tags?: RequestTags;
    /** Where the full exchange was logged: JSONL file + the assistant entry's uuid. */
    transcript?: { file: string; uuid: string };
    /** Phase timings (dispatch, TTFB, thinking span, text span) for this call. */
    timeline?: CallTimeline;
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

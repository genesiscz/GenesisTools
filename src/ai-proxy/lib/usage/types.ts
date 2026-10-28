import type { EffortSource, GrokUsageDetails, UsageDetails } from "@app/ai-proxy/lib/types";
import type { PrefixDiff } from "@app/ai-proxy/lib/usage/prefix-diff";

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
    /**
     * OpenAI-shaped cache reads (`prompt_tokens_details.cached_tokens`, Responses
     * `input_tokens_details.cached_tokens`): a PART of prompt_tokens, unlike the
     * Anthropic field above, so a hit rate reads one or the other and never adds
     * both (`splitPromptTokens` in `@genesiscz/utils/ai/usage/cache-stats`).
     * Before 2026-10-25 the Codex agent booked no cache count at all.
     */
    cached_prompt_tokens?: number;
    /** Reasoning tokens the upstream reported (`completion_tokens_details` / `output_tokens_details`). */
    reasoning_tokens?: number;
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
    /** The prompt cache key the request carried upstream (a session id or a content hash; never a secret). */
    cacheKey?: string;
    /** Claude Code's compaction turn: the request after it starts a new cache prefix. */
    compaction?: boolean;
    /** The effort the request asked for (`/v1/messages`), before the Codex catalog maps it. */
    effort?: string;
    effortSource?: EffortSource;
    /** Where the upstream request first differed from its thread's previous one: the cause of a cache miss. */
    prefix?: PrefixDiff;
}

export interface AccountBillingSnapshot {
    fetchedAt: string;
    tier?: string;
    summary: string;
    /** The provider's own part of the read, keyed by its source as `UsageSummary.details` carries it. */
    details?: UsageDetails;
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
    /** Cache reads in either convention (see `TokenUsage.cached_prompt_tokens`); absent on days before 2026-10-25. */
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    /** Input outside the cache, in either convention. */
    uncached_input_tokens?: number;
    reasoning_tokens?: number;
}

export interface DailyUsageStore {
    version: 1;
    days: Record<string, Record<string, DailyModelUsage>>;
}

export type { GrokUsageDetails, UsageDetails };

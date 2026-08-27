import type { ModelPricing } from "@genesiscz/utils/ai/catalog";
export interface UsageEvent {
    messageId: string;
    model: string;
    /** ISO-8601 UTC timestamp, e.g. "2026-06-01T09:52:38.815Z" */
    timestamp: string;
    /** Project = the cwd recorded on the event. "" when absent. */
    project: string;
    sessionId: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
}

export interface ModelPrice {
    /** $/Mtok */
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
}

/**
 * Catalog rules the flat rates above cannot express: dated promotions and
 * long-context bands. Kept on the entry so `resolvePrice()` can apply them per
 * EVENT — flattening them away billed every event at the list rate and silently
 * ignored e.g. the dated Sonnet 5 promotion.
 */
export interface ModelPriceEntry extends ModelPrice {
    rules?: ModelPricing["rules"];
}

export type PricingTable = Record<string, ModelPriceEntry>;

export interface TokenTotals {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
}

export interface ModelBreakdown {
    model: string;
    priced: boolean;
    tokens: TokenTotals;
    totalTokens: number;
    cost: number;
}

export interface ProjectBreakdown {
    project: string;
    sessions: number;
    totalTokens: number;
    cost: number;
}

export interface SessionBreakdown {
    sessionId: string;
    project: string;
    /** UTC day (YYYY-MM-DD) of the session's last event in-window */
    lastDay: string;
    totalTokens: number;
    cost: number;
}

export interface DayBreakdown {
    day: string;
    totalTokens: number;
    cost: number;
}

export interface Report {
    windowStartDay: string;
    windowEndDay: string;
    projectCount: number;
    sessionCount: number;
    total: {
        tokens: TokenTotals;
        totalTokens: number;
        cost: number;
        cacheHitRate: number;
    };
    days: DayBreakdown[];
    models: ModelBreakdown[];
    projects: ProjectBreakdown[];
    sessions: SessionBreakdown[];
}

export interface Filters {
    /** ISO day (YYYY-MM-DD) inclusive lower bound. */
    sinceDay?: string;
    /** case-insensitive substring on model id */
    model?: string;
    /** case-insensitive substring on project path */
    project?: string;
    /** leaderboard length cap (models/projects/sessions). Default 10 applied by caller. */
    top?: number;
}

/**
 * Wire contract for the `/ai/accounts` dashboard section.
 *
 * Mirrors the provider-neutral types the AI layer will export from
 * `src/utils/ai/providers/account-features.ts` (spec 2026-09-04 section 4.1). The
 * dashboard consumes these shapes over HTTP, so they live in the contract, which
 * stays free of server imports. When the AI layer lands, `AccountUsageSnapshot`
 * and `LimitWindow` become re-exports of the canonical types; field names must
 * not drift in between.
 */

export type LimitKind = "session" | "weekly" | "monthly" | "scoped" | "credit";

export type LimitSeverity = "ok" | "warn" | "critical";

/** Credit-style windows report money instead of a percentage. Minor units, like cents. */
export interface LimitMoney {
    usedMinor: number;
    limitMinor?: number;
    currency: string;
    exponent: number;
}

/** One rate-limit window, provider-neutral. Claude has 5 to 6, codex 2, grok 1. */
export interface LimitWindow {
    /** Provider-native id: `five_hour`, `seven_day_opus`, `primary`, `monthly`. */
    key: string;
    /** Human label: `5h`, `7d Opus`, `Weekly`, `Monthly`. */
    label: string;
    kind: LimitKind;
    scopeModel?: string;
    /** 0..100, may exceed 100. */
    percentUsed: number;
    resetsAt?: string;
    periodMs?: number;
    severity?: LimitSeverity;
    isActive?: boolean;
    money?: LimitMoney;
}

export interface AccountPlan {
    name?: string;
    status?: string;
    createdAt?: string;
    checkedAt?: string;
    contradictedAt?: number;
}

export interface AccountAuthHealth {
    refreshExpiresAt?: string;
    longLivedExpiresAt?: string;
    orgBlocked?: boolean;
    reason?: string;
}

/** The unit the TUI, the daemon, the dashboard and the Genesis app all consume. `native` is stripped on the wire. */
export interface AccountUsageSnapshot {
    /** Plugin id: `anthropic-sub`, `openai-sub`, `grok-sub`. */
    provider: string;
    accountId: string;
    accountName: string;
    label?: string;
    fetchedAt: string;
    limits: LimitWindow[];
    plan?: AccountPlan;
    auth?: AccountAuthHealth;
    stale?: { lastSuccessAt: string; reason: string };
    error?: string;
}

export interface AiAccountListItem {
    id: string;
    name: string;
    provider: string;
    /** CLI alias for the provider: `claude`, `codex`, `grok`. */
    alias: string;
    label?: string;
    enabled: boolean;
    hasUsage: boolean;
    hasSpendScope: boolean;
    /** Names of credential fields present, never their values. */
    credentialKinds: string[];
}

export interface AiAccountsResult {
    accounts: AiAccountListItem[];
}

export interface AiUsageResult {
    fetchedAt: string;
    snapshots: AccountUsageSnapshot[];
}

export interface LimitSeriesPoint {
    t: string;
    percent: number;
}

export interface LimitSeries {
    accountId: string;
    accountName: string;
    provider: string;
    key: string;
    label: string;
    points: LimitSeriesPoint[];
}

export interface AiUsageSeriesResult {
    series: LimitSeries[];
}

/** Which spend store a number comes from. See spec section 2.4 for the two stores. */
export type SpendSource = "calls" | "transcripts" | "both";

export type SpendGrain = "minute" | "hour" | "day" | "week";

export interface SpendBucket {
    costUsd: number;
    tokens: number;
}

export interface AccountRef {
    accountId: string;
    accountName: string;
    provider: string;
    label?: string;
}

export interface SpendAccountTotals extends AccountRef, SpendBucket {}

export interface AiSpendTotalsResult {
    from: string;
    to: string;
    source: SpendSource;
    total: SpendBucket;
    accounts: SpendAccountTotals[];
    /** Events with no known rate. Never folded into cost: an absent price is not free. */
    unpriced: number;
}

export interface SpendSeriesPoint {
    t: string;
    costUsd: number;
    tokens: number;
    byAccount: Record<string, SpendBucket>;
    byModel?: Record<string, SpendBucket>;
}

export interface AiSpendSeriesResult {
    from: string;
    to: string;
    grain: SpendGrain;
    source: SpendSource;
    points: SpendSeriesPoint[];
    accounts: AccountRef[];
    unpriced: number;
}

export interface AiDaemonProviderStatus {
    lastFetchAt?: string;
    ageSec?: number;
    error?: string;
}

export interface AiDaemonStatus {
    registered: boolean;
    taskName: string;
    lastRunAt?: string;
    nextRunAt?: string;
    perProvider: Record<string, AiDaemonProviderStatus>;
}

/** Transcript spend that no bound account claims (a default home nobody linked). */
export const UNBOUND_ACCOUNT_ID = "(unbound)";

/** Claude transcripts carry no account marker, so they form one row, "claude (all accounts)". */
export const CLAUDE_ALL_ACCOUNT_ID = "claude-all";

/** Route paths the section calls. One place, so the UI and the server never disagree on a string. */
export const AI_ACCOUNTS_API = {
    accounts: "/api/ai/accounts",
    usage: "/api/ai/usage",
    usageRefresh: "/api/ai/usage/refresh",
    usageSeries: "/api/ai/usage/series",
    spendTotals: "/api/ai/spend/totals",
    spendSeries: "/api/ai/spend/series",
    daemon: "/api/ai/daemon",
    daemonRegister: "/api/ai/daemon/register",
} as const;

import type { CodexContext } from "../drivers/codex-context";

/**
 * The report sources, in ccusage's order: ccusage's agent adapters plus Jev, three of them harnesses. The tables keyed
 * by `SourceId` below mirror what ccusage's CLI offers per source (`parity.test.ts` compares the JSON), so they are
 * the report-source axis, not harness facts (harness guard).
 */
export const SOURCE_IDS = [
    "claude",
    "codex",
    "opencode",
    "amp",
    "droid",
    "codebuff",
    "hermes",
    "pi",
    "goose",
    "kilo",
    "copilot",
    "gemini",
    "kimi",
    "qwen",
    "openclaw",
    "grok",
    "jev",
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

export type PeriodGrain = "daily" | "weekly" | "monthly";
export type ReportKind = PeriodGrain | "session" | "blocks" | "statusline" | "reviews";
export type CostMode = "auto" | "calculate" | "display";

export const SOURCE_REPORTS: Record<SourceId, readonly ReportKind[]> = {
    claude: ["daily", "weekly", "monthly", "session", "blocks", "statusline"],
    codex: ["daily", "monthly", "session", "reviews"],
    opencode: ["daily", "weekly", "monthly", "session"],
    amp: ["daily", "monthly", "session"],
    droid: ["daily", "monthly", "session"],
    codebuff: ["daily", "monthly", "session"],
    hermes: ["daily", "monthly", "session"],
    pi: ["daily", "monthly", "session"],
    goose: ["daily", "monthly", "session"],
    kilo: ["daily", "monthly", "session"],
    copilot: ["daily", "monthly", "session"],
    gemini: ["daily", "monthly", "session"],
    kimi: ["daily", "monthly", "session"],
    qwen: ["daily", "monthly", "session"],
    openclaw: ["daily", "monthly", "session"],
    grok: ["daily", "monthly", "session"],
    jev: ["daily", "monthly", "session"],
};

/**
 * The JSON a one-source report prints, matching ccusage's own report for that agent (the parity tests compare them):
 * `models-map` is ccusage's Codex shape (`costUSD`, a `models` map with reasoning tokens), `model-breakdowns` the
 * shape of every other agent (`totalCost`, `modelBreakdowns`).
 */
export type SourceJsonShape = "model-breakdowns" | "models-map";

export const SOURCE_JSON_SHAPE: Record<SourceId, SourceJsonShape> = {
    claude: "model-breakdowns",
    codex: "models-map",
    opencode: "model-breakdowns",
    amp: "model-breakdowns",
    droid: "model-breakdowns",
    codebuff: "model-breakdowns",
    hermes: "model-breakdowns",
    pi: "model-breakdowns",
    goose: "model-breakdowns",
    kilo: "model-breakdowns",
    copilot: "model-breakdowns",
    gemini: "model-breakdowns",
    kimi: "model-breakdowns",
    qwen: "model-breakdowns",
    openclaw: "model-breakdowns",
    grok: "model-breakdowns",
    jev: "model-breakdowns",
};

/** Whether a source's reports take `--mode auto|calculate|display`: only Claude Code's records carry their own cost. */
export const SOURCE_COST_MODE_FLAG: Record<SourceId, boolean> = {
    claude: true,
    codex: false,
    opencode: false,
    amp: false,
    droid: false,
    codebuff: false,
    hermes: false,
    pi: false,
    goose: false,
    kilo: false,
    copilot: false,
    gemini: false,
    kimi: false,
    qwen: false,
    openclaw: false,
    grok: false,
    jev: false,
};

export interface SpendEvent {
    source: SourceId;
    id: string;
    model: string;
    timestamp: string;
    sessionId: string;
    project: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    /** The one-hour share of `cacheCreationTokens` (Claude): Anthropic bills it at 2x input. */
    cacheCreation1hTokens?: number;
    cacheReadTokens: number;
    /** The event sums several model requests (a grok turn): no per-request length, so no context band. */
    aggregate?: boolean;
    reasoningOutputTokens?: number;
    recordedCostUsd?: number;
    serviceTier?: string;
    codex?: CodexContext;
    isSidechain?: boolean;
    /**
     * `AccountEntry.id` of the account whose root this file sat under. Absent
     * when no account claims that root, which reports as `UNBOUND_ACCOUNT_ID`
     * rather than being dropped.
     */
    accountId?: string;
    /** Provider home the file came from (`~/.codex-work`), when known. */
    home?: string;
}

export interface ModelBreakdownJson {
    modelName: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    cost: number;
}

export interface TokenTotalsJson {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    totalCost: number;
}

export interface ReportFlags {
    json?: boolean;
    since?: string;
    until?: string;
    timezone?: string;
    last?: string;
    breakdown?: boolean;
    mode?: string | boolean;
    visualBurnRate?: string | boolean;
    active?: boolean;
    recent?: boolean;
    sessionLength?: string;
    id?: string;
    byAgent?: boolean;
    /** Read provider homes on disk that no account claims. */
    allHomes?: boolean;
    /** Account ids to report; `"(unbound)"` and `"claude-all"` are valid entries. */
    account?: string[];
}

export interface ReportContext {
    home: string;
    now: Date;
    timezone: string;
    sinceDay?: string;
    untilDay?: string;
    last?: number;
    breakdown: boolean;
    mode: CostMode;
    source?: SourceId;
    sessionId?: string;
    byAgent: boolean;
}

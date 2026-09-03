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
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

export type PeriodGrain = "daily" | "weekly" | "monthly";
export type ReportKind = PeriodGrain | "session" | "blocks" | "statusline";
export type CostMode = "auto" | "calculate" | "display";

export const SOURCE_REPORTS: Record<SourceId, readonly ReportKind[]> = {
    claude: ["daily", "weekly", "monthly", "session", "blocks", "statusline"],
    codex: ["daily", "monthly", "session"],
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
    cacheReadTokens: number;
    reasoningOutputTokens?: number;
    recordedCostUsd?: number;
    isSidechain?: boolean;
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
    mode?: string;
    active?: boolean;
    recent?: boolean;
    sessionLength?: string;
    id?: string;
    byAgent?: boolean;
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

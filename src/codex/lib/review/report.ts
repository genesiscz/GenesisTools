import { parseSince } from "@genesiscz/utils/date";
import { parseDuration } from "@genesiscz/utils/format";
import type { ReviewEffort } from "@genesiscz/utils/worker/contract";
import type { ReviewLedgerRecord } from "./ledger";
import type { ReviewVerdict } from "./types";

/** One review session, folded from its ledger lines: what `tools codex reviews` prints as a row. */
export interface ReviewSummary {
    name: string;
    chain: string;
    label?: string;
    pr?: number;
    branch?: string;
    base: string;
    files: number;
    lines: number;
    effort: ReviewEffort;
    startedAt: string;
    lastAt: string;
    turns: number;
    durationMs: number;
    toolCalls: number;
    reasoningTokens: number;
    outputTokens: number;
    /** API-equivalent dollars; null when any turn was unpriced. */
    costUsd: number | null;
    reasoningPer100Lines: number | null;
    /** The last `Files reviewed` line: `12/14`. */
    coverage: string | null;
    /** The last gate verdict; `open` while no gate line exists yet (running, or a turn that failed). */
    verdict: ReviewVerdict | "open";
    reason?: string;
    escalatedTo?: string;
    parent?: string;
}

export interface ReviewFilters {
    since?: Date;
    pr?: number;
    label?: string;
    effort?: string;
    verdict?: string;
    name?: string;
}

export interface ReviewTotals {
    reviews: number;
    turns: number;
    durationMs: number;
    toolCalls: number;
    reasoningTokens: number;
    costUsd: number;
    unpricedReviews: number;
    verdicts: Record<string, number>;
}

function emptySummary(record: ReviewLedgerRecord): ReviewSummary {
    return {
        name: record.name,
        chain: record.chain,
        ...(record.label ? { label: record.label } : {}),
        ...(record.pr === undefined ? {} : { pr: record.pr }),
        ...(record.branch ? { branch: record.branch } : {}),
        base: record.base,
        files: record.files,
        lines: record.lines,
        effort: record.effort,
        startedAt: record.ts,
        lastAt: record.ts,
        turns: 0,
        durationMs: 0,
        toolCalls: 0,
        reasoningTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        reasoningPer100Lines: null,
        coverage: null,
        verdict: "open",
    };
}

/**
 * Folds the ledger into one summary per review session. A `start` line opens a new review, so a name that was
 * reused later shows twice; turn and gate lines without a start (a ledger cut by hand) open one too.
 */
export function summarizeReviews(records: readonly ReviewLedgerRecord[]): ReviewSummary[] {
    const open = new Map<string, ReviewSummary>();
    const all: ReviewSummary[] = [];

    for (const record of records) {
        let summary = open.get(record.name);

        if (!summary || record.kind === "start") {
            summary = emptySummary(record);
            open.set(record.name, summary);
            all.push(summary);
        }

        summary.lastAt = record.ts;

        if (record.kind === "start") {
            if (record.parent) {
                summary.parent = record.parent;
            }

            continue;
        }

        if (record.kind === "turn") {
            summary.turns += 1;
            summary.durationMs += record.durationMs ?? 0;
            summary.toolCalls += record.toolCalls;
            summary.reasoningTokens += record.reasoningTokens ?? 0;
            summary.outputTokens += record.outputTokens ?? 0;
            summary.costUsd =
                summary.costUsd === null || record.costUsd === null ? null : summary.costUsd + record.costUsd;
            summary.effort = record.effort;

            if (record.coverage) {
                summary.coverage = `${record.coverage.reviewed}/${record.coverage.total}`;
            }

            summary.reasoningPer100Lines = Math.round((summary.reasoningTokens * 100) / Math.max(1, summary.lines));
            continue;
        }

        summary.verdict = record.verdict;
        summary.reason = record.reason;

        if (record.escalatedTo) {
            summary.escalatedTo = record.escalatedTo;
        } else {
            delete summary.escalatedTo;
        }
    }

    return all;
}

/** `24h`, `90m`, `7d` back from now; otherwise the `--since` grammar of the other reports (`HH:MM`, a date). */
export function parseReviewSince(value: string, now = new Date()): Date | null {
    const text = value.trim();

    if (/^\d+\s*[a-z]/i.test(text) && !/^\d{4}-/.test(text)) {
        const ms = parseDuration(text);
        return ms > 0 ? new Date(now.getTime() - ms) : null;
    }

    return parseSince(text, now);
}

export function filterReviews(summaries: readonly ReviewSummary[], filters: ReviewFilters): ReviewSummary[] {
    const label = filters.label?.toLowerCase();
    const name = filters.name?.toLowerCase();

    return summaries.filter(
        (summary) =>
            (!filters.since || Date.parse(summary.lastAt) >= filters.since.getTime()) &&
            (filters.pr === undefined || summary.pr === filters.pr) &&
            (!label || (summary.label ?? "").toLowerCase().includes(label)) &&
            (!filters.effort || summary.effort === filters.effort) &&
            (!filters.verdict || summary.verdict === filters.verdict) &&
            (!name || summary.name.toLowerCase().includes(name) || summary.chain.toLowerCase().includes(name))
    );
}

export function reviewTotals(summaries: readonly ReviewSummary[]): ReviewTotals {
    const totals: ReviewTotals = {
        reviews: summaries.length,
        turns: 0,
        durationMs: 0,
        toolCalls: 0,
        reasoningTokens: 0,
        costUsd: 0,
        unpricedReviews: 0,
        verdicts: {},
    };

    for (const summary of summaries) {
        totals.turns += summary.turns;
        totals.durationMs += summary.durationMs;
        totals.toolCalls += summary.toolCalls;
        totals.reasoningTokens += summary.reasoningTokens;
        totals.verdicts[summary.verdict] = (totals.verdicts[summary.verdict] ?? 0) + 1;

        if (summary.costUsd === null) {
            totals.unpricedReviews += 1;
        } else {
            totals.costUsd += summary.costUsd;
        }
    }

    return totals;
}

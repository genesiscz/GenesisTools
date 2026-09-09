import type { DriverLineParser, DriverUsageEvent } from "@genesiscz/utils/ai/usage/transcripts/types";
import { type HistoryFileStatistics, type TokenUsage, zeroTokenUsage } from "../cache-types";
import { scanJsonlRecords } from "../source-scan";
import type { HistorySourceRecord, NativeSourceIssue } from "../types";

interface DayContribution {
    messages: number;
    toolCounts: Record<string, number>;
    hourlyActivity: Record<string, number>;
    tokenUsage: TokenUsage | null;
    modelCounts: Record<string, number>;
    branchCounts: Record<string, number>;
}

/** Shared by every provider's statistics reader; the Claude one counted its own buckets before. */
export function increment(counts: Record<string, number>, key: string): void {
    counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Undefined for a missing or unparsable timestamp. The guard matters: `new Date("x").toISOString()`
 * throws a RangeError, which used to abort a whole statistics read and retain stale aggregates.
 */
export function timestampParts(value: string | undefined): { date: string; hour: string } | undefined {
    if (!value || Number.isNaN(Date.parse(value))) {
        return;
    }
    const instant = new Date(value);
    return { date: instant.toISOString().split("T")[0]!, hour: instant.getHours().toString() };
}

export class NativeStatisticsAccumulator {
    readonly summary: HistoryFileStatistics;
    private readonly days = new Map<string, DayContribution>();
    private readonly eventIds = new Set<string>();

    private readonly project: string;
    private readonly branch?: string;

    constructor(options: { project: string; isSubagent: boolean; branch?: string }) {
        this.project = options.project;
        this.branch = options.branch;
        this.summary = {
            conversations: 1,
            messages: 0,
            subagentSessions: options.isSubagent ? 1 : 0,
            toolCounts: {},
            dailyActivity: {},
            hourlyActivity: {},
            tokenUsage: null,
            modelCounts: {},
            branchCounts: {},
            firstDate: null,
            lastDate: null,
        };
    }

    private day(date: string): DayContribution {
        let value = this.days.get(date);
        if (!value) {
            value = {
                messages: 0,
                toolCounts: {},
                hourlyActivity: {},
                tokenUsage: null,
                modelCounts: {},
                branchCounts: {},
            };
            this.days.set(date, value);
        }
        return value;
    }

    addRecord(record: HistorySourceRecord): void {
        if (record.entries.length === 0) {
            return;
        }
        this.summary.messages++;
        const parts = timestampParts(record.timestamp);
        if (parts) {
            increment(this.summary.dailyActivity, parts.date);
            increment(this.summary.hourlyActivity, parts.hour);
            const day = this.day(parts.date);
            day.messages++;
            increment(day.hourlyActivity, parts.hour);
            if (!this.summary.firstDate || parts.date < this.summary.firstDate) {
                this.summary.firstDate = parts.date;
            }
            if (!this.summary.lastDate || parts.date > this.summary.lastDate) {
                this.summary.lastDate = parts.date;
            }
        }
        if (this.branch) {
            increment(this.summary.branchCounts, this.branch);
            if (parts) {
                increment(this.day(parts.date).branchCounts, this.branch);
            }
        }
        for (const entry of record.entries) {
            if (entry.toolEvent !== "call" || !entry.tool) {
                continue;
            }
            increment(this.summary.toolCounts, entry.tool);
            if (parts) {
                increment(this.day(parts.date).toolCounts, entry.tool);
            }
        }
    }

    addUsage(event: DriverUsageEvent): void {
        const parts = timestampParts(event.timestamp);
        if (!parts || this.eventIds.has(event.id)) {
            return;
        }
        this.eventIds.add(event.id);
        const tokens = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheCreateTokens: event.cacheCreationTokens,
            cacheReadTokens: event.cacheReadTokens,
        };
        this.summary.tokenUsage ??= zeroTokenUsage();
        this.summary.tokenUsage.inputTokens += tokens.inputTokens;
        this.summary.tokenUsage.outputTokens += tokens.outputTokens;
        this.summary.tokenUsage.cacheCreateTokens += tokens.cacheCreateTokens;
        this.summary.tokenUsage.cacheReadTokens += tokens.cacheReadTokens;
        increment(this.summary.modelCounts, event.model);
        const day = this.day(parts.date);
        day.tokenUsage ??= zeroTokenUsage();
        day.tokenUsage.inputTokens += tokens.inputTokens;
        day.tokenUsage.outputTokens += tokens.outputTokens;
        day.tokenUsage.cacheCreateTokens += tokens.cacheCreateTokens;
        day.tokenUsage.cacheReadTokens += tokens.cacheReadTokens;
        increment(day.modelCounts, event.model);
    }

    result(issues: NativeSourceIssue[]): import("../types").HistoryStatisticsRead {
        const dates = [...this.days.keys()].sort();
        const firstObserved = dates[0];
        this.summary.firstDate = firstObserved ?? null;
        this.summary.lastDate = dates.at(-1) ?? null;
        const days = [...this.days.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([date, value]) => ({
                date,
                project: this.project,
                conversations: date === firstObserved ? 1 : 0,
                messages: value.messages,
                subagentSessions: date === firstObserved ? this.summary.subagentSessions : 0,
                toolCounts: value.toolCounts,
                hourlyActivity: value.hourlyActivity,
                tokenUsage: value.tokenUsage,
                modelCounts: value.modelCounts,
                branchCounts: value.branchCounts,
            }));
        return { summary: this.summary, days, issues, complete: issues.length === 0 };
    }
}

export function createIssueCollector(options: { onIssue?: (issue: NativeSourceIssue) => void }): {
    issues: NativeSourceIssue[];
    add: (issue: NativeSourceIssue) => void;
} {
    const issues: NativeSourceIssue[] = [];
    const seen = new Set<string>();
    return {
        issues,
        add(issue) {
            const key = `${issue.path}\0${issue.message}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            issues.push(issue);
            options.onIssue?.(issue);
        },
    };
}

export async function parseUsagePath(options: {
    path: string;
    parser: DriverLineParser;
    accumulator: NativeStatisticsAccumulator;
    signal?: AbortSignal;
    onIssue: (issue: NativeSourceIssue) => void;
}): Promise<void> {
    try {
        for await (const record of scanJsonlRecords({
            path: options.path,
            signal: options.signal,
            onIssue: options.onIssue,
        })) {
            options.parser.parseLine(record.original, (event) => options.accumulator.addUsage(event));
        }
    } catch (error) {
        options.signal?.throwIfAborted();
        const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
        options.onIssue({ path: options.path, message: missing ? "Usage source missing" : "Usage source read failed" });
    }
}

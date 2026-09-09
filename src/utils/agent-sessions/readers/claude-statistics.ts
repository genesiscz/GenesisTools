import { type HistoryFileStatistics, type TokenUsage, zeroTokenUsage } from "../cache-types";
import type { JsonRecord, JsonValue } from "../source-scan";
import { asRecord, scanJsonlRecords, text } from "../source-scan";
import type { HistoryReadOptions, HistoryStatisticsRead, NativeSessionSource, NativeSourceIssue } from "../types";
import { claudeProjectName, isClaudeSubagentPath } from "./claude-paths";
import { increment, timestampParts } from "./native-statistics";

function numeric(value: JsonValue | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * This reader deliberately cannot use `NativeStatisticsAccumulator`, which codex and grok share.
 * It reproduces the pre-index Claude engine byte for byte so the stored numbers do not move, and
 * that engine differs in five ways: it counts every record as a message (not only records that
 * carry entries), buckets model ids into opus/sonnet/haiku/other, reads token usage straight off
 * the transcript rows instead of de-duplicated driver usage events, takes the branch per record
 * rather than once per session, and attributes a multi-day session's tools, hours, tokens, models
 * and branches entirely to its first date. The last one is the base engine's own documented
 * simplification. Only `increment` and `timestampParts` are genuinely shared.
 */
function modelBucket(model: string): string {
    if (model.includes("opus")) {
        return "opus";
    }
    if (model.includes("sonnet")) {
        return "sonnet";
    }
    if (model.includes("haiku")) {
        return "haiku";
    }
    return "other";
}

function addTokenUsage(target: TokenUsage, usage: JsonRecord): void {
    target.inputTokens += numeric(usage.input_tokens);
    target.outputTokens += numeric(usage.output_tokens);
    target.cacheCreateTokens += numeric(usage.cache_creation_input_tokens);
    target.cacheReadTokens += numeric(usage.cache_read_input_tokens);
}

function emptySummary(source: NativeSessionSource<"claude">): HistoryFileStatistics {
    const subagent = isClaudeSubagentPath(source.filePath);
    return {
        conversations: 1,
        messages: 0,
        subagentSessions: subagent ? 1 : 0,
        toolCounts: {},
        dailyActivity: {},
        hourlyActivity: {},
        tokenUsage: zeroTokenUsage(),
        modelCounts: {},
        branchCounts: {},
        firstDate: null,
        lastDate: null,
    };
}

function addAssistantStatistics(
    summary: HistoryFileStatistics,
    dailyTokens: Record<string, TokenUsage>,
    date: string | undefined,
    row: JsonRecord
): void {
    if (row.type !== "assistant") {
        return;
    }
    const message = asRecord(row.message);
    const model = text(message.model);
    if (model) {
        increment(summary.modelCounts, modelBucket(model));
    }
    const usageValue = message.usage;
    const usage = asRecord(usageValue);
    const tokenUsage = summary.tokenUsage;
    if (tokenUsage && Object.keys(usage).length > 0) {
        addTokenUsage(tokenUsage, usage);
    }
    if (usageValue && date) {
        let daily = dailyTokens[date];
        if (!daily) {
            daily = zeroTokenUsage();
            dailyTokens[date] = daily;
        }
        addTokenUsage(daily, usage);
    }
    const content = message.content;
    if (!Array.isArray(content)) {
        return;
    }
    for (const value of content) {
        const block = asRecord(value);
        if (block.type === "tool_use") {
            const name = text(block.name);
            if (name) {
                increment(summary.toolCounts, name);
            }
        }
    }
}

function addRow(summary: HistoryFileStatistics, dailyTokens: Record<string, TokenUsage>, row: JsonRecord): void {
    summary.messages++;
    const parts = timestampParts(text(row.timestamp) || undefined);
    const date = parts?.date;
    if (parts) {
        increment(summary.dailyActivity, parts.date);
        increment(summary.hourlyActivity, parts.hour);
        if (!summary.firstDate || parts.date < summary.firstDate) {
            summary.firstDate = parts.date;
        }
        if (!summary.lastDate || parts.date > summary.lastDate) {
            summary.lastDate = parts.date;
        }
    }
    const branch = text(row.gitBranch);
    if (branch) {
        increment(summary.branchCounts, branch);
    }
    addAssistantStatistics(summary, dailyTokens, date, row);
}

export async function readClaudeStatistics(
    source: NativeSessionSource<"claude">,
    options: HistoryReadOptions = {}
): Promise<HistoryStatisticsRead> {
    const issues: NativeSourceIssue[] = [];
    const summary = emptySummary(source);
    const dailyTokens: Record<string, TokenUsage> = {};
    let cwd = source.metadata?.cwd;
    try {
        for await (const record of scanJsonlRecords({
            path: source.filePath,
            signal: options.signal,
            onIssue: (issue) => {
                issues.push(issue);
                options.onIssue?.(issue);
            },
        })) {
            const row = asRecord(record.value);
            cwd ??= text(row.cwd) || undefined;
            addRow(summary, dailyTokens, row);
        }
    } catch (error) {
        options.signal?.throwIfAborted();
        const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
        const issue = { path: source.filePath, message: missing ? "Source missing" : "Source read failed" };
        issues.push(issue);
        options.onIssue?.(issue);
    }

    const project = claudeProjectName({ source, cwd }) ?? "";
    const days = Object.entries(summary.dailyActivity)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, messages]) => {
            const first = date === summary.firstDate;
            return {
                date,
                project,
                conversations: first ? 1 : 0,
                messages,
                subagentSessions: first ? summary.subagentSessions : 0,
                toolCounts: first ? { ...summary.toolCounts } : {},
                hourlyActivity: first ? { ...summary.hourlyActivity } : {},
                tokenUsage: first ? { ...summary.tokenUsage! } : zeroTokenUsage(),
                modelCounts: first ? { ...summary.modelCounts } : {},
                branchCounts: first ? { ...summary.branchCounts } : {},
            };
        });

    return { summary, dailyTokens, days, issues, complete: issues.length === 0 };
}

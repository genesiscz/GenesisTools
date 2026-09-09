import { type TokenUsage, zeroTokenUsage } from "./cache-types";
import type { HistoryStatisticsRead } from "./types";

export interface HistoryStatisticsSource {
    project: string;
    statistics: HistoryStatisticsRead;
}

export interface HistoryStatisticsAggregate {
    totalConversations: number;
    totalMessages: number;
    projectCounts: Record<string, number>;
    toolCounts: Record<string, number>;
    dailyActivity: Record<string, number>;
    hourlyActivity: Record<string, number>;
    subagentCount: number;
    tokenUsage: TokenUsage;
    dailyTokens: Record<string, TokenUsage>;
    modelCounts: Record<string, number>;
    branchCounts: Record<string, number>;
    conversationLengths: number[];
}

function addCounts(target: Record<string, number>, source: Record<string, number>): void {
    for (const [key, value] of Object.entries(source)) {
        target[key] = (target[key] ?? 0) + value;
    }
}

function addTokens(target: TokenUsage, source: TokenUsage): void {
    target.inputTokens += source.inputTokens;
    target.outputTokens += source.outputTokens;
    target.cacheCreateTokens += source.cacheCreateTokens;
    target.cacheReadTokens += source.cacheReadTokens;
}

/** Aggregate complete original-source summaries without imposing dated-rollup semantics. */
export function aggregateHistoryStatistics(sources: HistoryStatisticsSource[]): HistoryStatisticsAggregate {
    const aggregate: HistoryStatisticsAggregate = {
        totalConversations: 0,
        totalMessages: 0,
        projectCounts: {},
        toolCounts: {},
        dailyActivity: {},
        hourlyActivity: {},
        subagentCount: 0,
        tokenUsage: zeroTokenUsage(),
        dailyTokens: {},
        modelCounts: {},
        branchCounts: {},
        conversationLengths: [],
    };

    for (const source of sources) {
        const { summary, dailyTokens } = source.statistics;
        if (summary.messages === 0) {
            continue;
        }

        aggregate.totalConversations += summary.conversations;
        aggregate.totalMessages += summary.messages;
        aggregate.projectCounts[source.project] =
            (aggregate.projectCounts[source.project] ?? 0) + summary.conversations;
        addCounts(aggregate.toolCounts, summary.toolCounts);
        addCounts(aggregate.dailyActivity, summary.dailyActivity);
        addCounts(aggregate.hourlyActivity, summary.hourlyActivity);
        aggregate.subagentCount += summary.subagentSessions;
        if (summary.tokenUsage) {
            addTokens(aggregate.tokenUsage, summary.tokenUsage);
        }
        for (const [date, tokens] of Object.entries(dailyTokens ?? {})) {
            let target = aggregate.dailyTokens[date];
            if (!target) {
                target = zeroTokenUsage();
                aggregate.dailyTokens[date] = target;
            }
            addTokens(target, tokens);
        }
        addCounts(aggregate.modelCounts, summary.modelCounts);
        addCounts(aggregate.branchCounts, summary.branchCounts);
        aggregate.conversationLengths.push(summary.messages);
    }

    return aggregate;
}

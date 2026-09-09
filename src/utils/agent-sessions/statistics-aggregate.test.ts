import { expect, test } from "bun:test";
import type { HistoryFileStatistics, TokenUsage } from "./cache-types";
import { aggregateHistoryStatistics } from "./statistics-aggregate";
import type { HistoryStatisticsRead } from "./types";

const ZERO_TOKENS: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
};

function read(summary: HistoryFileStatistics, dailyTokens?: Record<string, TokenUsage>): HistoryStatisticsRead {
    return { summary, dailyTokens, days: [], issues: [], complete: true };
}

test("aggregateHistoryStatistics preserves complete source totals and exact dated token buckets", () => {
    const result = aggregateHistoryStatistics([
        {
            project: "shop",
            statistics: read(
                {
                    conversations: 1,
                    messages: 3,
                    subagentSessions: 0,
                    toolCounts: { Read: 1 },
                    dailyActivity: { "2026-09-01": 1, "2026-09-02": 1 },
                    hourlyActivity: { "10": 2 },
                    tokenUsage: {
                        inputTokens: 15,
                        outputTokens: 2,
                        cacheCreateTokens: 3,
                        cacheReadTokens: 4,
                    },
                    modelCounts: { sonnet: 2 },
                    branchCounts: { main: 3 },
                    firstDate: "2026-09-01",
                    lastDate: "2026-09-02",
                },
                {
                    "2026-09-01": { inputTokens: 10, outputTokens: 2, cacheCreateTokens: 3, cacheReadTokens: 4 },
                    "2026-09-02": { inputTokens: 5, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
                }
            ),
        },
        {
            project: "app",
            statistics: read({
                conversations: 1,
                messages: 2,
                subagentSessions: 1,
                toolCounts: { Bash: 2 },
                dailyActivity: { "2026-09-02": 1 },
                hourlyActivity: { "11": 1 },
                tokenUsage: null,
                modelCounts: {},
                branchCounts: { feature: 1 },
                firstDate: "2026-09-02",
                lastDate: "2026-09-02",
            }),
        },
        {
            project: "empty",
            statistics: read({
                conversations: 1,
                messages: 0,
                subagentSessions: 1,
                toolCounts: { MustNotCount: 1 },
                dailyActivity: {},
                hourlyActivity: {},
                tokenUsage: { ...ZERO_TOKENS },
                modelCounts: { other: 1 },
                branchCounts: {},
                firstDate: null,
                lastDate: null,
            }),
        },
    ]);

    expect(result).toEqual({
        totalConversations: 2,
        totalMessages: 5,
        projectCounts: { shop: 1, app: 1 },
        toolCounts: { Read: 1, Bash: 2 },
        dailyActivity: { "2026-09-01": 1, "2026-09-02": 2 },
        hourlyActivity: { "10": 2, "11": 1 },
        subagentCount: 1,
        tokenUsage: { inputTokens: 15, outputTokens: 2, cacheCreateTokens: 3, cacheReadTokens: 4 },
        dailyTokens: {
            "2026-09-01": { inputTokens: 10, outputTokens: 2, cacheCreateTokens: 3, cacheReadTokens: 4 },
            "2026-09-02": { inputTokens: 5, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
        },
        modelCounts: { sonnet: 2 },
        branchCounts: { main: 3, feature: 1 },
        conversationLengths: [3, 2],
    });
});

import { expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { BaselineConversationStats } from "./baseline-oracle";
import { createBaselineOracle } from "./baseline-oracle";
import { createFixtureWorld } from "./fixture-world";
import { withBaseline } from "./with-baseline";

interface QuickStats {
    totalConversations: number;
    totalMessages: number;
    subagentCount: number;
    projectCount: number;
}

interface CandidateResult {
    initial: BaselineConversationStats;
    quickAfterInitial: QuickStats | null;
    ranged: BaselineConversationStats;
    quickAfterRange: QuickStats | null;
    repeated: BaselineConversationStats;
    quickAfterRepeat: QuickStats | null;
    modified: BaselineConversationStats;
    quickAfterModified: QuickStats | null;
}

function line(value: object): string {
    return `${SafeJSON.stringify(value, { strict: true })}\n`;
}

withBaseline(
    "Claude full, range, and quick statistics preserve undated records and replace changed contributions",
    async () => {
        const world = await createFixtureWorld();
        const source = join(world.sources.claude, "-projects-shop", "11111111-2222-4333-8444-555555555555.jsonl");
        await mkdir(dirname(source), { recursive: true });
        await writeFile(
            source,
            line({
                type: "user",
                sessionId: "11111111-2222-4333-8444-555555555555",
                cwd: "/projects/shop",
                gitBranch: "fixture-main",
                timestamp: "2026-08-14T10:00:00.000Z",
                message: { content: "dated message" },
            }) +
                line({
                    type: "assistant",
                    sessionId: "11111111-2222-4333-8444-555555555555",
                    cwd: "/projects/shop",
                    gitBranch: "fixture-main",
                    message: {
                        model: "claude-sonnet-fixture",
                        usage: {
                            input_tokens: 10,
                            output_tokens: 20,
                            cache_creation_input_tokens: 3,
                            cache_read_input_tokens: 4,
                        },
                        content: [{ type: "text", text: "undated assistant" }],
                    },
                }),
            "utf8"
        );

        let baseline: BaselineConversationStats;
        const oracle = await createBaselineOracle({ world });
        try {
            baseline = await oracle.getStatistics({ forceRefresh: true });
        } finally {
            await oracle.close();
        }

        try {
            expect(baseline).toMatchObject({
                totalConversations: 1,
                totalMessages: 1,
                projectCounts: { shop: 1 },
                dailyActivity: { "2026-08-14": 1 },
                subagentCount: 0,
                tokenUsage: { inputTokens: 10, outputTokens: 20, cacheCreateTokens: 3, cacheReadTokens: 4 },
                modelCounts: { sonnet: 1 },
                branchCounts: { "fixture-main": 2 },
                conversationLengths: [2],
            });

            const candidateHome = world.assertOwnedPath(join(world.root, "candidate-statistics-home"));
            await mkdir(candidateHome, { recursive: true });
            const child = Bun.spawn(["bun", join(import.meta.dir, "statistics-compatibility-child.ts")], {
                cwd: join(import.meta.dir, "../../../.."),
                env: {
                    ...world.environment,
                    GENESIS_TOOLS_HOME: candidateHome,
                    HISTORY_STATISTICS_FIXTURE_SOURCE: source,
                    BASELINE_FIXED_NOW: world.now.toISOString(),
                },
                stdout: "pipe",
                stderr: "pipe",
            });
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]);
            expect(exitCode, stderr).toBe(0);
            const candidate = SafeJSON.parse(stdout, { strict: true }) as CandidateResult;
            const baselineQuick: QuickStats = {
                totalConversations: baseline.totalConversations,
                totalMessages: baseline.totalMessages,
                subagentCount: baseline.subagentCount,
                projectCount: Object.keys(baseline.projectCounts).length,
            };

            expect(candidate.initial).toEqual(baseline);
            expect(candidate.quickAfterInitial).toEqual(baselineQuick);
            expect(candidate.ranged).toMatchObject({
                totalConversations: 0,
                totalMessages: 0,
                dailyActivity: {},
                tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
            });
            expect(candidate.quickAfterRange).toEqual(baselineQuick);
            expect(candidate.repeated).toEqual(candidate.initial);
            expect(candidate.quickAfterRepeat).toEqual(baselineQuick);
            expect(candidate.modified).toMatchObject({
                totalConversations: 1,
                totalMessages: 2,
                dailyActivity: { "2026-08-14": 2 },
                tokenUsage: baseline.tokenUsage,
                modelCounts: { sonnet: 1 },
                branchCounts: { "fixture-main": 3 },
                conversationLengths: [3],
            });
            expect(candidate.quickAfterModified).toEqual({ ...baselineQuick, totalMessages: 2 });
        } finally {
            await world.dispose();
        }
    }
);

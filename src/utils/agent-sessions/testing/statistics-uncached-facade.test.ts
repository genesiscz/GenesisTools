import { expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { BaselineConversationStats } from "./baseline-oracle";
import { createFixtureWorld } from "./fixture-world";

function line(record: object): string {
    return `${SafeJSON.stringify(record, { strict: true })}\n`;
}

test("uncached Claude statistics count undated original records without inventing dated tokens", async () => {
    const world = await createFixtureWorld();
    const main = join(world.sources.claude, "-projects-shop", "11111111-2222-4333-8444-555555555555.jsonl");
    const subagent = join(
        world.sources.claude,
        "-projects-shop",
        "11111111-2222-4333-8444-555555555555",
        "subagents",
        "agent-helper.jsonl"
    );
    const empty = join(world.sources.claude, "-projects-shop", "22222222-3333-4444-8555-666666666666.jsonl");
    await Promise.all([mkdir(dirname(main), { recursive: true }), mkdir(dirname(subagent), { recursive: true })]);
    await writeFile(
        main,
        line({
            type: "assistant",
            timestamp: "2026-09-01T10:00:00.000Z",
            gitBranch: "main",
            message: {
                model: "claude-opus-fixture",
                usage: { input_tokens: 10 },
                content: [{ type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }],
            },
        }) +
            line({
                type: "assistant",
                timestamp: "2026-09-02T11:00:00.000Z",
                gitBranch: "feature",
                message: {
                    model: "claude-sonnet-fixture",
                    usage: { input_tokens: 5, output_tokens: 2 },
                    content: [{ type: "tool_use", name: "Bash", input: { command: "pwd" } }],
                },
            }) +
            line({
                type: "assistant",
                gitBranch: "undated",
                message: {
                    model: "claude-haiku-fixture",
                    usage: { input_tokens: 7, cache_read_input_tokens: 3 },
                    content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }],
                },
            }),
        "utf8"
    );
    await writeFile(
        subagent,
        line({
            type: "user",
            timestamp: "2026-09-01T12:00:00.000Z",
            gitBranch: "sub",
            message: { content: "helper" },
        }),
        "utf8"
    );
    await writeFile(empty, "", "utf8");
    await Promise.all([
        utimes(main, new Date("2026-09-03T12:00:00.000Z"), new Date("2026-09-03T12:00:00.000Z")),
        utimes(subagent, new Date("2026-09-02T12:00:00.000Z"), new Date("2026-09-02T12:00:00.000Z")),
    ]);

    try {
        const child = Bun.spawn(["bun", join(import.meta.dir, "statistics-uncached-facade-child.ts")], {
            cwd: join(import.meta.dir, "../../../.."),
            env: world.environment,
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        expect(exitCode, stderr).toBe(0);
        const result = SafeJSON.parse(stdout, { strict: true }) as BaselineConversationStats;

        expect(result).toEqual({
            totalConversations: 2,
            totalMessages: 4,
            projectCounts: { shop: 2 },
            toolCounts: { Read: 1, Bash: 1, Edit: 1 },
            dailyActivity: { "2026-09-01": 2, "2026-09-02": 1 },
            hourlyActivity: { "10": 1, "12": 1, "11": 1 },
            subagentCount: 1,
            tokenUsage: { inputTokens: 22, outputTokens: 2, cacheCreateTokens: 0, cacheReadTokens: 3 },
            dailyTokens: {
                "2026-09-01": { inputTokens: 10, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
                "2026-09-02": { inputTokens: 5, outputTokens: 2, cacheCreateTokens: 0, cacheReadTokens: 0 },
            },
            modelCounts: { opus: 1, sonnet: 1, haiku: 1 },
            branchCounts: { main: 1, feature: 1, undated: 1, sub: 1 },
            conversationLengths: [3, 1],
        });
    } finally {
        await world.dispose();
    }
    // Spawns a child against a generated corpus, so bun's 5 s default is a coin flip on a busy
    // machine rather than a real budget.
}, 120_000);

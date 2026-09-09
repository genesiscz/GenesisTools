import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { HistoryFileStatistics } from "../cache-types";
import { createFixtureWorld } from "./fixture-world";

interface FileCompatibilityResult {
    computed: HistoryFileStatistics;
    first: HistoryFileStatistics | null;
    second: HistoryFileStatistics | null;
    missingRejected: string;
}

test("legacy Claude file-stat exports preserve direct-file refresh behavior", async () => {
    const world = await createFixtureWorld();
    const source = join(
        world.home,
        ".claude-extra",
        "projects",
        "-projects-shop",
        "11111111-2222-4333-8444-555555555555.jsonl"
    );
    await mkdir(dirname(source), { recursive: true });
    await writeFile(
        source,
        `${SafeJSON.stringify(
            {
                type: "assistant",
                timestamp: "2026-09-01T10:00:00.000Z",
                message: {
                    model: "claude-sonnet-fixture",
                    usage: { input_tokens: 4 },
                    content: [{ type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }],
                },
            },
            { strict: true }
        )}\n`,
        "utf8"
    );

    try {
        const child = Bun.spawn(["bun", join(import.meta.dir, "statistics-file-compatibility-child.ts")], {
            cwd: join(import.meta.dir, "../../../.."),
            env: { ...world.environment, HISTORY_STATISTICS_FIXTURE_SOURCE: source },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        expect(exitCode, stderr).toBe(0);
        const result = SafeJSON.parse(stdout, { strict: true }) as FileCompatibilityResult;

        expect(result.computed.messages).toBe(1);
        expect(result.computed.tokenUsage).toEqual({
            inputTokens: 4,
            outputTokens: 0,
            cacheCreateTokens: 0,
            cacheReadTokens: 0,
        });
        expect(result.first?.messages).toBe(1);
        expect(result.second).toBeNull();
        expect(result.missingRejected).toContain(".missing");
    } finally {
        await world.dispose();
    }
    // Spawns a child, so it must not inherit bun's 5 s default.
}, 120_000);

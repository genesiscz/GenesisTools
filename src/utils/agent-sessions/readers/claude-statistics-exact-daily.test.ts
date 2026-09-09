import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { NativeSessionSource } from "../types";
import { readClaudeStatistics } from "./claude-statistics";

function line(record: object): string {
    return `${SafeJSON.stringify(record, { strict: true })}\n`;
}

test("Claude statistics expose exact dated token buckets without changing cached first-date contributions", async () => {
    const home = await mkdtemp(join(tmpdir(), "gt-claude-exact-daily-"));
    const root = join(home, "projects");
    const directory = join(root, "-projects-shop");
    const path = join(directory, "11111111-2222-4333-8444-555555555555.jsonl");
    await mkdir(directory, { recursive: true });
    await writeFile(
        path,
        line({
            type: "assistant",
            timestamp: "2026-09-01T10:00:00.000Z",
            message: { model: "claude-sonnet-fixture", usage: { input_tokens: 10 }, content: [] },
        }) +
            line({
                type: "assistant",
                timestamp: "2026-09-02T10:00:00.000Z",
                message: { model: "claude-sonnet-fixture", usage: { input_tokens: 5, output_tokens: 2 }, content: [] },
            }) +
            line({
                type: "assistant",
                message: { model: "claude-sonnet-fixture", usage: { input_tokens: 7 }, content: [] },
            }),
        "utf8"
    );
    const source: NativeSessionSource<"claude"> = {
        kind: "claude",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [],
    };

    try {
        const result = await readClaudeStatistics(source);

        expect(result.dailyTokens).toEqual({
            "2026-09-01": { inputTokens: 10, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
            "2026-09-02": { inputTokens: 5, outputTokens: 2, cacheCreateTokens: 0, cacheReadTokens: 0 },
        });
        expect(result.summary.tokenUsage).toEqual({
            inputTokens: 22,
            outputTokens: 2,
            cacheCreateTokens: 0,
            cacheReadTokens: 0,
        });
        expect(result.days.map((day) => day.tokenUsage)).toEqual([
            { inputTokens: 22, outputTokens: 2, cacheCreateTokens: 0, cacheReadTokens: 0 },
            { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
        ]);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

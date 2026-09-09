import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { NativeSessionSource } from "../types";
import { readClaudeStatistics } from "./claude-statistics";

function fixture(name = "11111111-2222-4333-8444-555555555555.jsonl"): {
    path: string;
    source: NativeSessionSource<"claude">;
} {
    const home = mkdtempSync(join(tmpdir(), "gt-claude-statistics-"));
    const root = join(home, "projects");
    const directory = join(root, "-projects-shop");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, name);
    return {
        path,
        source: {
            kind: "claude",
            root,
            sourceHome: home,
            filePath: path,
            dataPaths: [path],
            metadataPaths: [],
        },
    };
}

function line(record: object): string {
    return `${SafeJSON.stringify(record, { strict: true })}\n`;
}

function hash(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("statistics preserve file totals and first-date attribution across dated and undated records", async () => {
    const { path, source } = fixture();
    const firstTimestamp = "2026-09-01T10:00:00.000Z";
    const secondTimestamp = "2026-09-02T18:00:00.000Z";
    writeFileSync(
        path,
        line({ type: "user", timestamp: secondTimestamp, gitBranch: "main", message: { content: "later" } }) +
            line({
                type: "assistant",
                timestamp: firstTimestamp,
                gitBranch: "feature/stats",
                message: {
                    model: "claude-opus-4-1",
                    usage: {
                        input_tokens: 10,
                        output_tokens: 20,
                        cache_creation_input_tokens: 3,
                        cache_read_input_tokens: 4,
                    },
                    content: [
                        { type: "text", text: "done" },
                        { type: "tool_use", name: "Read", input: { file_path: "src/file.ts" } },
                    ],
                },
            }) +
            line({
                type: "assistant",
                timestamp: secondTimestamp,
                gitBranch: "main",
                message: {
                    model: "claude-sonnet-4-5",
                    usage: { input_tokens: 5, output_tokens: 7 },
                    content: [{ type: "tool_use", name: "Bash", input: { command: "pwd" } }],
                },
            }) +
            line({
                type: "assistant",
                gitBranch: "undated",
                message: {
                    model: "claude-haiku-3-5",
                    usage: { input_tokens: 2, cache_read_input_tokens: 9 },
                    content: [{ type: "tool_use", name: "Edit", input: {} }],
                },
            }) +
            line({
                type: "assistant",
                message: { model: "fixture-model", usage: { output_tokens: 1 }, content: [] },
            }) +
            line({
                type: "user",
                message: { content: [{ type: "tool_use", name: "MustNotCount", input: {} }] },
            })
    );

    const result = await readClaudeStatistics(source);
    const firstHour = new Date(firstTimestamp).getHours().toString();
    const secondHour = new Date(secondTimestamp).getHours().toString();

    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.summary).toEqual({
        conversations: 1,
        messages: 6,
        subagentSessions: 0,
        toolCounts: { Read: 1, Bash: 1, Edit: 1 },
        dailyActivity: { "2026-09-02": 2, "2026-09-01": 1 },
        hourlyActivity: { [secondHour]: 2, [firstHour]: 1 },
        tokenUsage: { inputTokens: 17, outputTokens: 28, cacheCreateTokens: 3, cacheReadTokens: 13 },
        modelCounts: { opus: 1, sonnet: 1, haiku: 1, other: 1 },
        branchCounts: { main: 2, "feature/stats": 1, undated: 1 },
        firstDate: "2026-09-01",
        lastDate: "2026-09-02",
    });
    expect(result.days).toEqual([
        {
            date: "2026-09-01",
            project: "shop",
            conversations: 1,
            messages: 1,
            subagentSessions: 0,
            toolCounts: { Read: 1, Bash: 1, Edit: 1 },
            hourlyActivity: { [secondHour]: 2, [firstHour]: 1 },
            tokenUsage: { inputTokens: 17, outputTokens: 28, cacheCreateTokens: 3, cacheReadTokens: 13 },
            modelCounts: { opus: 1, sonnet: 1, haiku: 1, other: 1 },
            branchCounts: { main: 2, "feature/stats": 1, undated: 1 },
        },
        {
            date: "2026-09-02",
            project: "shop",
            conversations: 0,
            messages: 2,
            subagentSessions: 0,
            toolCounts: {},
            hourlyActivity: {},
            tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
            modelCounts: {},
            branchCounts: {},
        },
    ]);
});

test("partial input reports incomplete statistics, counts valid records, and never mutates the source", async () => {
    const { path, source } = fixture("agent-helper.jsonl");
    writeFileSync(
        path,
        [
            line({ type: "user", timestamp: "2026-09-01T10:00:00.000Z", message: { content: "valid" } }).trimEnd(),
            '{"broken":',
            '{"type":"assistant"',
        ].join("\n")
    );
    const before = hash(path);
    const forwarded: string[] = [];

    const first = await readClaudeStatistics(source, { onIssue: (issue) => forwarded.push(issue.message) });
    const second = await readClaudeStatistics(source);

    expect(first).toEqual(second);
    expect(hash(path)).toBe(before);
    expect(first.complete).toBe(false);
    expect(first.summary.messages).toBe(1);
    expect(first.summary.subagentSessions).toBe(1);
    expect(first.issues.map((issue) => issue.message)).toEqual([
        "Malformed record at line 2",
        "Partial final record at line 3",
    ]);
    expect(forwarded).toEqual(first.issues.map((issue) => issue.message));
});

test("missing sources return incomplete zero-observation statistics", async () => {
    const { source } = fixture("missing.jsonl");

    const result = await readClaudeStatistics(source);

    expect(result.complete).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual(["Source missing"]);
    expect(result.summary.messages).toBe(0);
    expect(result.summary.tokenUsage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
    });
    expect(result.days).toEqual([]);
});
test("an unparsable timestamp is skipped rather than aborting the whole statistics read", async () => {
    const { path, source } = fixture();
    writeFileSync(
        path,
        line({ type: "user", timestamp: "not a date", gitBranch: "main", message: { content: "broken" } }) +
            line({
                type: "assistant",
                timestamp: "2026-09-01T10:00:00.000Z",
                message: { model: "claude-opus-4-1", usage: { input_tokens: 5, output_tokens: 7 }, content: [] },
            })
    );

    const result = await readClaudeStatistics(source);

    // `new Date("not a date").toISOString()` throws a RangeError. Before the shared guard that
    // escaped the record loop, so the whole file read reported "Source read failed" and the
    // indexer kept the stale aggregates for it forever.
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.summary.messages).toBe(2);
    expect(result.summary.dailyActivity).toEqual({ "2026-09-01": 1 });
    expect(result.summary.branchCounts).toEqual({ main: 1 });
    expect(result.summary.tokenUsage).toEqual({
        inputTokens: 5,
        outputTokens: 7,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
    });
});

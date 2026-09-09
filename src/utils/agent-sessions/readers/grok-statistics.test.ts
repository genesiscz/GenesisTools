import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { NativeSessionSource } from "../types";
import { readGrokStatistics } from "./grok-statistics";

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const line = (value: object): string => `${SafeJSON.stringify(value, { strict: true })}\n`;
const usage = (eventId: string): object => ({
    timestamp: 1_788_333_200,
    params: {
        sessionId: ID,
        update: {
            sessionUpdate: "turn_completed",
            usage: { inputTokens: 30, cachedReadTokens: 10, outputTokens: 5, reasoningTokens: 1 },
        },
        _meta: { eventId, agentTimestampMs: Date.parse("2026-09-03T10:00:00.000Z") },
    },
});

function fixture(withUpdates: boolean): { source: NativeSessionSource<"grok">; updates: string } {
    const home = mkdtempSync(join(tmpdir(), "gt-grok-statistics-"));
    const root = join(home, "sessions");
    const directory = join(root, encodeURIComponent("/projects/shop"), ID);
    mkdirSync(directory, { recursive: true });
    const chat = join(directory, "chat_history.jsonl");
    const updates = join(directory, "updates.jsonl");
    const summary = join(directory, "summary.json");
    writeFileSync(
        chat,
        line({ type: "user", timestamp: "2026-09-01T10:00:00.000Z", content: "hello" }) +
            line({
                type: "assistant",
                timestamp: "2026-09-02T10:00:00.000Z",
                content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { path: "src/a.ts" } }],
            }) +
            line({
                type: "user",
                timestamp: "2026-09-02T10:01:00.000Z",
                content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
            })
    );
    writeFileSync(
        summary,
        SafeJSON.stringify({ info: { id: ID, cwd: "/projects/shop" }, current_model_id: "grok-4.6" }, { strict: true })
    );
    if (withUpdates) {
        writeFileSync(updates, `${line(usage("evt-1"))}${line(usage("evt-1"))}{"broken":`);
    }
    return {
        updates,
        source: {
            kind: "grok",
            root,
            sourceHome: home,
            filePath: chat,
            dataPaths: [chat],
            metadataPaths: [summary],
            statisticsPaths: [updates],
        },
    };
}

test("chat and usage sources stay separate while usage ids deduplicate and partial telemetry is incomplete", async () => {
    const { source } = fixture(true);

    const result = await readGrokStatistics(source);

    expect(result.complete).toBe(false);
    expect(result.summary).toMatchObject({
        messages: 3,
        toolCounts: { Read: 1 },
        tokenUsage: { inputTokens: 20, outputTokens: 5, cacheCreateTokens: 0, cacheReadTokens: 10 },
        modelCounts: { "grok-4.6": 1 },
        firstDate: "2026-09-01",
        lastDate: "2026-09-03",
    });
    expect(result.days.map((day) => [day.date, day.messages, day.tokenUsage])).toEqual([
        ["2026-09-01", 1, null],
        ["2026-09-02", 2, null],
        ["2026-09-03", 0, { inputTokens: 20, outputTokens: 5, cacheCreateTokens: 0, cacheReadTokens: 10 }],
    ]);
    expect(result.issues.map((issue) => issue.message)).toContain("Partial final record at line 3");
});

test("a missing usage file leaves token metrics unavailable without failing conversation statistics", async () => {
    const { source } = fixture(false);

    const result = await readGrokStatistics(source);

    expect(result.complete).toBe(true);
    expect(result.summary.messages).toBe(3);
    expect(result.summary.tokenUsage).toBeNull();
    expect(result.days.map((day) => day.tokenUsage)).toEqual([null, null]);
});

test("a present non-file usage path is an explicit incomplete read", async () => {
    const { source, updates } = fixture(false);
    mkdirSync(updates);

    const result = await readGrokStatistics(source);

    expect(result.complete).toBe(false);
    expect(result.summary.tokenUsage).toBeNull();
    expect(result.issues.map((issue) => issue.message)).toContain("Usage source read failed");
});

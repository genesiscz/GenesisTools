import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { NativeSessionSource } from "../types";
import { readCodexStatistics } from "./codex-statistics";

const ID = "11111111-2222-4333-8444-555555555555";
const line = (value: object): string => `${SafeJSON.stringify(value, { strict: true })}\n`;
const count = (timestamp: string, total: object, last?: object): object => ({
    type: "event_msg",
    timestamp,
    payload: {
        type: "token_count",
        info: { total_token_usage: total, ...(last ? { last_token_usage: last } : {}) },
    },
});

test("legacy statistics count searchable records and preserve cumulative repeat and reset semantics", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-statistics-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const path = join(root, `rollout-${ID}.jsonl`);
    const first = { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 };
    const reset = { input_tokens: 20, cached_input_tokens: 5, output_tokens: 2 };
    writeFileSync(
        path,
        line({
            type: "session_meta",
            timestamp: "2026-09-01T10:00:00.000Z",
            payload: { id: ID, cwd: "/projects/shop", history_mode: "legacy", git: { branch: "main" } },
        }) +
            line({
                type: "response_item",
                timestamp: "2026-09-01T10:01:00.000Z",
                payload: { type: "message", role: "user", content: [{ type: "input_text", text: "inspect" }] },
            }) +
            line({ type: "turn_context", timestamp: "2026-09-01T10:02:00.000Z", payload: { model: "gpt-5" } }) +
            line(count("2026-09-01T10:03:00.000Z", first, first)) +
            line(count("2026-09-01T10:04:00.000Z", first, first)) +
            line({
                type: "response_item",
                timestamp: "2026-09-02T11:00:00.000Z",
                payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: '{"cmd":"pwd"}' },
            }) +
            line({
                type: "response_item",
                timestamp: "2026-09-02T11:01:00.000Z",
                payload: { type: "function_call_output", call_id: "call-1", output: "done" },
            }) +
            line(count("2026-09-02T11:02:00.000Z", reset))
    );
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [],
        statisticsPaths: [path],
    };

    const result = await readCodexStatistics(source);

    expect(result.complete).toBe(true);
    expect(result.summary).toMatchObject({
        messages: 3,
        toolCounts: { exec_command: 1 },
        tokenUsage: { inputTokens: 95, outputTokens: 12, cacheCreateTokens: 0, cacheReadTokens: 25 },
        modelCounts: { "gpt-5": 2 },
        branchCounts: { main: 3 },
        firstDate: "2026-09-01",
        lastDate: "2026-09-02",
    });
    expect(result.days.map((day) => [day.date, day.messages, day.conversations, day.tokenUsage])).toEqual([
        ["2026-09-01", 1, 1, { inputTokens: 80, outputTokens: 10, cacheCreateTokens: 0, cacheReadTokens: 20 }],
        ["2026-09-02", 2, 0, { inputTokens: 15, outputTokens: 2, cacheCreateTokens: 0, cacheReadTokens: 5 }],
    ]);
});

test("paginated conversation records are counted without inventing missing usage", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-paginated-statistics-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const path = join(root, `rollout-${ID}.jsonl`);
    writeFileSync(
        path,
        line({ type: "session_meta", payload: { id: ID, cwd: "/projects/shop", history_mode: "paginated" } })
    );
    const projectionPath = join(home, "thread_history_1.sqlite");
    const db = new Database(projectionPath);
    db.run(
        "CREATE TABLE thread_items (thread_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, updated_at_ordinal INTEGER)"
    );
    db.run("INSERT INTO thread_items VALUES (?, 1, ?, ?, 1)", [
        ID,
        Date.parse("2026-09-01T10:00:00.000Z"),
        SafeJSON.stringify({ type: "userMessage", content: "hello" }, { strict: true }),
    ]);
    db.run("INSERT INTO thread_items VALUES (?, 2, ?, ?, 1)", [
        ID,
        Date.parse("2026-09-02T10:00:00.000Z"),
        SafeJSON.stringify({ type: "commandExecution", command: "pwd", aggregatedOutput: "done" }, { strict: true }),
    ]);
    db.close();
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [projectionPath],
        statisticsPaths: [],
    };

    const result = await readCodexStatistics(source);

    expect(result.complete).toBe(true);
    expect(result.summary.messages).toBe(2);
    expect(result.summary.toolCounts).toEqual({ exec_command: 1 });
    expect(result.summary.tokenUsage).toBeNull();
    expect(result.days.map((day) => day.tokenUsage)).toEqual([null, null]);
});

test("incomplete metadata coverage explicitly invalidates the statistics contribution", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-incomplete-statistics-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const path = join(root, `rollout-${ID}.jsonl`);
    writeFileSync(
        path,
        `${line({ type: "session_meta", payload: { id: ID, cwd: "/projects/shop", history_mode: "legacy" } })}${line({
            type: "response_item",
            timestamp: "2026-09-01T10:00:00.000Z",
            payload: { type: "message", role: "user", content: "valid" },
        })}{"broken":`
    );
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [],
        statisticsPaths: [],
    };

    const result = await readCodexStatistics(source);

    expect(result.complete).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContain("Metadata coverage incomplete");
    expect(result.summary.messages).toBe(1);
});

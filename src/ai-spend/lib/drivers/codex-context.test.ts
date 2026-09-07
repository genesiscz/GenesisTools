import { expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseNativeChunk } from "../reports/native";
import { codexDriver } from "./codex";

const line = (type: string, payload: object, timestamp = "2026-09-07T10:00:00Z") =>
    SafeJSON.stringify({ type, payload, timestamp });
const usage = (input: number, cache: number, write: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: cache,
    cache_write_input_tokens: write,
    output_tokens: output,
});
const count = (total: object, last?: object) =>
    line("event_msg", {
        type: "token_count",
        info: { total_token_usage: total, ...(last ? { last_token_usage: last } : {}) },
    });
const parse = (lines: string[]) =>
    parseNativeChunk({
        driver: codexDriver,
        source: "codex",
        file: "/tmp/rollout-synthetic.jsonl",
        chunk: lines.join("\n"),
    });

test("separates completed code review from a later diagnostic in the same reviewer", () => {
    const first = usage(300_000, 280_000, 5_000, 1_000);
    const result = parse([
        line("session_meta", {
            id: "reviewer",
            source: { subagent: { thread_spawn: { parent_thread_id: "parent", agent_path: "/root/review" } } },
        }),
        line("event_msg", { type: "task_started", turn_id: "review-pass" }),
        line("turn_context", { turn_id: "review-pass", model: "gpt-6-astra", service_tier: "priority" }),
        count(first, first),
        count(first, first),
        line("event_msg", {
            type: "task_complete",
            last_agent_message: "Two confirmed findings in the code review: src/auth.ts allows a provider override.",
        }),
        line("event_msg", { type: "task_started", turn_id: "diagnostic" }, "2026-09-07T11:00:00Z"),
        line("turn_context", { turn_id: "diagnostic", model: "gpt-6-astra", service_tier: null }),
        count(usage(310_000, 285_000, 5_000, 1_100), usage(10_000, 5_000, 0, 100)),
        line("event_msg", {
            type: "task_complete",
            last_agent_message: "The CI stop is an exhausted four-minute step budget.",
        }),
    ]);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
        inputTokens: 15_000,
        cacheReadTokens: 280_000,
        cacheCreationTokens: 5_000,
        serviceTier: "priority",
        codex: {
            threadId: "reviewer",
            parentThreadId: "parent",
            task: { id: "review-pass", kind: "code-review", completed: true },
        },
    });
    expect(result.events[1].codex?.task).toMatchObject({ id: "diagnostic", kind: "other", completed: true });
    expect(result.events[1].serviceTier).toBeUndefined();
});

test("preserves permission review identity across chunks without guessing its model", () => {
    const initial = parse([
        line("session_meta", { id: "guardian", source: { subagent: { other: "guardian" } } }),
        line("event_msg", { type: "task_started", turn_id: "approval" }),
        line("turn_context", { turn_id: "approval", model: "codex-auto-review", service_tier: "fast" }),
    ]);
    const result = parseNativeChunk({
        driver: codexDriver,
        source: "codex",
        file: "/tmp/rollout-synthetic.jsonl",
        state: initial.state,
        chunk: [count(usage(50, 10, 0, 5)), line("event_msg", { type: "task_complete" })].join("\n"),
    });
    expect(result.events[0]).toMatchObject({
        model: "codex-auto-review",
        serviceTier: "fast",
        codex: { task: { kind: "permission-review", completed: true } },
    });
});

test("a cumulative counter reset is a fresh request, including cache writes", () => {
    const result = parse([
        line("turn_context", { model: "gpt-6-astra" }),
        count(usage(1_000, 100, 50, 100)),
        count(usage(200, 20, 10, 30)),
    ]);
    expect(result.events).toHaveLength(2);
    expect(result.events[1]).toMatchObject({
        inputTokens: 170,
        cacheReadTokens: 20,
        cacheCreationTokens: 10,
        outputTokens: 30,
    });
});

test("an implementation summary mentioning findings is not counted as an entire review pass", () => {
    const result = parse([
        line("session_meta", { id: "main", source: "cli" }),
        line("event_msg", { type: "task_started", turn_id: "implementation" }),
        line("turn_context", { model: "gpt-6-astra", turn_id: "implementation" }),
        count(usage(100, 0, 0, 10)),
        line("event_msg", {
            type: "task_complete",
            last_agent_message:
                "Implemented the feature and resolved all findings in src/auth.ts. Saved the review to notes.md.",
        }),
    ]);
    expect(result.events[0].codex?.task?.kind).toBe("other");
});

// Regression: real Codex writes speed changes in thread_settings_applied, not only turn_context.
test("recorded thread settings survive turn contexts and incremental resumes until explicitly cleared", () => {
    const initial = parse([
        line("event_msg", {
            type: "thread_settings_applied",
            thread_settings: { model: "gpt-6-astra", service_tier: "priority" },
        }),
        line("turn_context", { turn_id: "first", model: "gpt-6-astra" }),
    ]);
    const result = parseNativeChunk({
        driver: codexDriver,
        source: "codex",
        file: "/tmp/rollout-synthetic.jsonl",
        state: initial.state,
        chunk: [
            count(usage(300_000, 280_000, 0, 1_000)),
            line("event_msg", { type: "thread_settings_applied", thread_settings: { service_tier: null } }),
            line("turn_context", { turn_id: "second" }),
            count(usage(310_000, 280_000, 0, 1_100), usage(10_000, 0, 0, 100)),
        ].join("\n"),
    });
    expect(result.events[0]).toMatchObject({ model: "gpt-6-astra", serviceTier: "priority" });
    expect(result.events[1].serviceTier).toBeUndefined();
    expect(result.events[0].codex?.task?.id).toBe("first");
});

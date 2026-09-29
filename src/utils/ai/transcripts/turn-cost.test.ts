import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { codexModelOf, scanClaudeNative, toolInputKeys } from "./native-scan";
import { buildToolStats, buildTurnCosts, type CallPricer } from "./turn-cost";
import type { TranscriptTool, TranscriptTurn } from "./types";

const T0 = Date.parse("2026-01-10T10:00:00.000Z");

function iso(offsetSeconds: number): string {
    return new Date(T0 + offsetSeconds * 1000).toISOString();
}

function tool(id: string, name: string, preview: string, extra: Partial<TranscriptTool> = {}): TranscriptTool {
    return { id, name, inputPreview: preview, result: "ok", isError: false, ...extra };
}

function user(id: string, text: string, at: number): TranscriptTurn {
    return { id, role: "user", at: iso(at), text, tools: [] };
}

function assistant(id: string, at: number, extra: Partial<TranscriptTurn> = {}): TranscriptTurn {
    return { id, role: "assistant", at: iso(at), text: "", tools: [], ...extra };
}

function line(record: Record<string, unknown>): string {
    return SafeJSON.stringify(record, { strict: true }) ?? "";
}

/** A tiny Claude session file: two prompts, a split message, a thinking-only call, a sub-agent line. */
function claudeFile(): string {
    return [
        line({
            type: "user",
            uuid: "u1",
            timestamp: iso(0),
            cwd: "/work/app",
            gitBranch: "feat/a",
            message: { role: "user", content: "first" },
        }),
        line({
            type: "assistant",
            uuid: "a1",
            timestamp: iso(5),
            message: {
                id: "m1",
                model: "claude-sonnet-4-5-20250929",
                usage: {
                    input_tokens: 100_000,
                    output_tokens: 10_000,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                },
                content: [{ type: "text", text: "reading" }],
            },
        }),
        // Same message id on its next content block: one call, not two.
        line({
            type: "assistant",
            uuid: "a1b",
            timestamp: iso(6),
            message: {
                id: "m1",
                model: "claude-sonnet-4-5-20250929",
                usage: { input_tokens: 100_000, output_tokens: 10_000 },
                content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
            },
        }),
        line({
            type: "user",
            uuid: "r1",
            timestamp: iso(16),
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
        }),
        line({
            type: "user",
            uuid: "side",
            isSidechain: true,
            timestamp: iso(17),
            message: { role: "user", content: "sub-agent" },
        }),
        line({
            type: "user",
            uuid: "u2",
            timestamp: iso(60),
            gitBranch: "feat/b",
            message: { role: "user", content: "second" },
        }),
        // Thinking only: no transcript turn, but a real call that belongs to prompt u2.
        line({
            type: "assistant",
            uuid: "a2",
            timestamp: iso(62),
            message: {
                id: "m2",
                model: "claude-sonnet-4-5-20250929",
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    cache_read_input_tokens: 50_000,
                    cache_creation_input_tokens: 2_000,
                },
                content: [{ type: "thinking", thinking: "hmm" }],
            },
        }),
        line({ type: "summary", summary: "not a conversation line" }),
    ].join("\n");
}

/** The transcript turns `tools ai sessions tail` builds from that file. */
function claudeTurns(): TranscriptTurn[] {
    return [
        user("u1", "first", 0),
        assistant("a1", 5, { text: "reading" }),
        assistant("a1b", 6, { tools: [tool("t1", "Bash", "ls", { result: "a.txt" })] }),
        user("u2", "second", 60),
    ];
}

describe("scanClaudeNative", () => {
    test("counts a split message once, skips sub-agent lines and records exact tool timing", () => {
        const scan = scanClaudeNative(claudeFile());

        expect(scan.calls.map((call) => call.messageId)).toEqual(["m1", "m2"]);
        expect(scan.calls[0]?.input).toBe(100_000);
        expect(scan.calls[1]?.cacheWrite).toBe(2_000);
        expect(scan.ordinals.has("side")).toBe(false);
        expect(scan.ordinals.get("u2")).toBe(5);
        expect(scan.toolTimings.get("t1")).toEqual({ startedAt: iso(6), endedAt: iso(16) });
        expect(scan.cwd).toBe("/work/app");
        expect(scan.branch).toBe("feat/b");
    });

    test("full tool inputs tell two edits of one file apart", () => {
        const text = [
            line({
                type: "assistant",
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "e1",
                            name: "Edit",
                            input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
                        },
                    ],
                },
            }),
            line({
                type: "assistant",
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "e2",
                            name: "Edit",
                            input: { file_path: "/a.ts", old_string: "p", new_string: "q" },
                        },
                    ],
                },
            }),
        ].join("\n");
        const keys = toolInputKeys(text, "claude");

        expect(keys.get("e1")).not.toBe(keys.get("e2"));
        expect(codexModelOf(line({ type: "turn_context", payload: { model: "gpt-5.5" } }))).toBe("gpt-5.5");
    });
});

describe("buildTurnCosts", () => {
    const flatPricer: CallPricer = (call) => (call.model ? (call.input + call.output) / 1_000_000 : null);

    test("assigns every native call to its prompt, the thinking-only call included, and ranks by cost", () => {
        const result = buildTurnCosts({
            turns: claudeTurns(),
            native: scanClaudeNative(claudeFile()),
            price: flatPricer,
        });

        expect(result.turns.map((turn) => [turn.number, turn.turnId, turn.modelCalls])).toEqual([
            [1, "u1", 1],
            [4, "u2", 1],
        ]);
        expect(result.turns[1]?.cacheWriteTokens).toBe(2_000);
        expect(result.turns[0]?.costUsd).toBeCloseTo(0.11);
        expect(result.turns[0]?.rank).toBe(1);
        expect(result.turns[1]?.rank).toBe(2);
        expect(result.turns[0]?.toolCount).toBe(1);
        expect(result.turns[0]?.models).toEqual(["sonnet"]);
        expect(result.priced).toBe(true);
        expect(result.totals.modelCalls).toBe(2);
    });

    test("an unpriced call leaves the turn without a cost and ranks by billable tokens instead", () => {
        const turns = [
            user("u1", "one", 0),
            assistant("a1", 1, { usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 900_000 } }),
            user("u2", "two", 10),
            assistant("a2", 11, { usage: { inputTokens: 5_000, outputTokens: 100 } }),
        ];
        const result = buildTurnCosts({ turns, price: () => null });

        expect(result.priced).toBe(false);
        expect(result.turns[0]?.costUsd).toBeNull();
        expect(result.turns[0]?.cacheReadTokens).toBe(900_000);
        // Cache reads do not win the ranking on their own.
        expect(result.turns[1]?.rank).toBe(1);
        expect(result.turns[0]?.rank).toBe(2);
    });

    test("envelope usage is priced with the session's model when calls name none", () => {
        const turns = [
            user("u1", "one", 0),
            assistant("a1", 1, { usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
        ];
        const result = buildTurnCosts({ turns, defaultModel: "gpt-x", price: flatPricer });

        expect(result.turns[0]?.costUsd).toBeCloseTo(1);
        expect(result.turns[0]?.models).toEqual(["gpt-x"]);
    });
});

describe("buildToolStats", () => {
    test("uses exact native timing when known, the gap to the next entry otherwise, and skips a pending call", () => {
        const turns = [
            ...claudeTurns(),
            assistant("a3", 70, {
                tools: [
                    tool("t2", "Bash", "false", { isError: true, exitCode: 1 }),
                    tool("t3", "Read", "/work/app/a.ts"),
                ],
            }),
            assistant("a4", 100, { tools: [tool("t4", "Bash", "sleep 999", { result: null })] }),
        ];
        const stats = buildToolStats({ turns, native: scanClaudeNative(claudeFile()) });
        const bash = stats.find((stat) => stat.name === "Bash");

        expect(stats[0]?.name).toBe("Bash");
        expect(bash?.count).toBe(3);
        expect(bash?.failures).toBe(1);
        expect(bash?.failureRate).toBeCloseTo(1 / 3);
        // t1 exact 10 s, t2 gap 30 s, t4 pending and not measured.
        expect(bash?.totalMs).toBe(40_000);
        expect(bash?.slowestMs).toBe(30_000);
        expect(bash?.slowestToolId).toBe("t2");
        expect(bash?.slowestTurnIndex).toBe(4);
        expect(bash?.timing).toBe("upper-bound");
    });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { grokNativeLinesToTurns, grokWorkerTextToTurns } from "./grok";

describe("grokNativeLinesToTurns", () => {
    test("pairs ACP tool_call with tool_call_update and flushes on turn_completed", () => {
        const lines = [
            SafeJSON.stringify({
                timestamp: 1_700_000_000,
                params: {
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: "I will list files." },
                    },
                },
            }),
            SafeJSON.stringify({
                timestamp: 1_700_000_001,
                params: {
                    update: {
                        sessionUpdate: "tool_call",
                        toolCallId: "tc1",
                        title: "bash",
                        rawInput: { command: "ls" },
                    },
                },
            }),
            SafeJSON.stringify({
                timestamp: 1_700_000_002,
                params: {
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "tc1",
                        status: "completed",
                        content: [{ type: "content", content: { type: "text", text: "a.txt" } }],
                    },
                },
            }),
            SafeJSON.stringify({
                timestamp: 1_700_000_003,
                params: { update: { sessionUpdate: "turn_completed" } },
            }),
        ];
        const turns = grokNativeLinesToTurns(lines);
        expect(turns).toHaveLength(1);
        expect(turns[0]?.role).toBe("assistant");
        expect(turns[0]?.text).toBe("I will list files.");
        expect(turns[0]?.tools).toEqual([
            { id: "tc1", name: "bash", inputPreview: "ls", result: "a.txt", isError: false },
        ]);
    });

    test("skips malformed and truncated JSONL lines", () => {
        const lines = [
            "not json",
            '{"params":',
            SafeJSON.stringify({
                timestamp: 1_700_000_000,
                params: {
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: "ok" },
                    },
                },
            }),
            SafeJSON.stringify({
                timestamp: 1_700_000_001,
                params: { update: { sessionUpdate: "turn_completed" } },
            }),
        ];
        const turns = grokNativeLinesToTurns(lines);
        expect(turns).toHaveLength(1);
        expect(turns[0]?.text).toBe("ok");
    });
});

describe("grokWorkerTextToTurns", () => {
    test("maps streaming-json text and tool_call into one assistant turn", () => {
        const text = [
            SafeJSON.stringify({ type: "text", data: "Hello" }),
            SafeJSON.stringify({ type: "tool_call", toolName: "bash", rawInput: { command: "pwd" } }),
            SafeJSON.stringify({ type: "end" }),
        ].join("\n");
        const turns = grokWorkerTextToTurns(text, "sess");
        expect(turns[0]?.text).toBe("Hello");
        expect(turns[0]?.tools[0]?.name).toBe("bash");
        expect(turns[0]?.tools[0]?.inputPreview).toBe("pwd");
        expect(turns.at(-1)?.event).toEqual({ kind: "end", stopReason: "unknown", costUsd: undefined });
    });

    // Shapes cut from a real `tools grok run` turn log (2026-09-04), payloads replaced.
    const fixture = readFileSync(join(import.meta.dir, "fixtures", "grok-worker-turn.jsonl"), "utf8");

    test("one turn per model call: deltas, then usage, then that call's tool calls", () => {
        const turns = grokWorkerTextToTurns(fixture, "sess", 1);
        const assistant = turns.filter((turn) => turn.role === "assistant");

        // Two complete calls, one that died before its usage line, and the error.
        expect(turns.map((turn) => turn.role)).toEqual(["assistant", "assistant", "assistant", "system"]);
        expect(assistant.map((turn) => turn.step)).toEqual([1, 2, 3]);
        expect(assistant[0]?.id).toBe("sess-turn-1-step-1");
        expect(assistant[0]?.reasoning).toBe("The user wants a plan. Read the brief first.");
        expect(assistant[0]?.text).toBe("I'll read the spec first.");
        expect(assistant[0]?.usage).toEqual({
            inputTokens: 41511,
            cacheReadTokens: 512,
            outputTokens: 501,
            reasoningTokens: 331,
        });
        expect(assistant[0]?.tools.map((tool) => tool.name)).toEqual(["read_file", "run_terminal_command"]);
        expect(assistant[1]?.tools.map((tool) => tool.name)).toEqual(["grep"]);
        expect(assistant[2]?.reasoning).toBe("Third call, never finished.");
        expect(assistant[2]?.usage).toBeUndefined();
    });

    test("tool results attach by id even when they land after the next model call started", () => {
        const [first, second] = grokWorkerTextToTurns(fixture, "sess");
        const [readFile, shell] = first?.tools ?? [];

        expect(readFile?.result).toBe("1→---\n2→created: 2026-09-04 17:40\n3→---\n4→# Spec\n");
        expect(readFile?.resultChars).toBe(readFile?.result?.length);
        expect(readFile?.isError).toBe(false);
        expect(readFile?.exitCode).toBeUndefined();

        // ANSI stripped, exit code from rawOutput.
        expect(shell?.result).toBe("2026-09-04 17:50\nSpec.md\n");
        expect(shell?.exitCode).toBe(0);
        expect(shell?.inputPreview).toBe("date '+%Y-%m-%d %H:%M' && ls docs");

        expect(second?.tools[0]?.isError).toBe(true);
        expect(second?.tools[0]?.result).toBe("User cancelled the execution for tool `grep`");
        expect(second?.tools[0]?.inputPreview).toBe("/tmp/project/docs/Spec.md");
    });

    test("the trailing error becomes a system turn, and a malformed line is skipped", () => {
        const turns = grokWorkerTextToTurns(fixture, "sess");
        const last = turns.at(-1);

        expect(last?.role).toBe("system");
        expect(last?.event?.kind).toBe("error");
        expect(last?.text).toContain("403 Forbidden");
    });

    test("an empty or comment-only file yields no turns", () => {
        expect(grokWorkerTextToTurns("", "sess")).toEqual([]);
        expect(grokWorkerTextToTurns('{"type":"available_commands","tools":[]}\n', "sess")).toEqual([]);
    });
});

describe("grok transcript timestamps", () => {
    test("an out-of-range timestamp yields a null clock instead of throwing the file away", () => {
        // PR #341 review round 4, t1: an unguarded toISOString() threw RangeError
        // and abandoned every remaining line of the file.
        const lines = [
            SafeJSON.stringify({
                timestamp: 9e15,
                params: {
                    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still parsed" } },
                },
            }),
            SafeJSON.stringify({ timestamp: 1_700_000_003, params: { update: { sessionUpdate: "turn_completed" } } }),
        ];

        const turns = grokNativeLinesToTurns(lines);

        expect(turns).toHaveLength(1);
        expect(turns[0].at).toBeNull();
        expect(turns[0].text).toContain("still parsed");
    });
});

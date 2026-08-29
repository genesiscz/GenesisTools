import { describe, expect, test } from "bun:test";
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

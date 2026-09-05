import { describe, expect, test } from "bun:test";
import type { WorkerEvent } from "@genesiscz/utils/worker/events";
import { workerEventsToTurns } from "./worker-events";

const S = "sess";

describe("workerEventsToTurns", () => {
    test("groups think, tool calls, results and the answer into steps, and ends on turn.completed", () => {
        const events: WorkerEvent[] = [
            { kind: "reasoning", sessionId: S, text: "Look at the ", delta: true },
            { kind: "reasoning", sessionId: S, text: "file.", delta: true },
            { kind: "text", sessionId: S, text: "Reading it.", delta: false },
            { kind: "tool_call", sessionId: S, tool: "Read", target: "a.md", callId: "c1" },
            { kind: "tool_result", sessionId: S, tool: "Read", callId: "c1", output: "# A\nhello", ok: true },
            { kind: "text", sessionId: S, text: "Done: it says hello.", delta: false },
            { kind: "turn.completed", sessionId: S, usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: 0.01 } },
        ];

        const turns = workerEventsToTurns(events, S, 2);

        expect(turns.map((turn) => turn.role)).toEqual(["assistant", "assistant", "system"]);
        expect(turns[0]).toMatchObject({
            id: "sess-turn-2-step-1",
            step: 1,
            reasoning: "Look at the file.",
            text: "Reading it.",
        });
        expect(turns[0]?.tools[0]).toMatchObject({
            id: "c1",
            name: "Read",
            inputPreview: "a.md",
            result: "# A\nhello",
            resultChars: 9,
            isError: false,
        });
        expect(turns[1]).toMatchObject({ step: 2, text: "Done: it says hello." });
        expect(turns[2]?.event).toEqual({ kind: "end", stopReason: "completed", costUsd: 0.01 });
        expect(turns[2]?.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    });

    test("a failed tool and an error event are marked, and unknown kinds are skipped", () => {
        const events: WorkerEvent[] = [
            { kind: "tool_call", sessionId: S, tool: "Bash", target: "false", callId: "c1" },
            { kind: "usage.limits", sessionId: S, native: {} },
            { kind: "tool_result", sessionId: S, callId: "c1", output: "exit 1", ok: false },
            { kind: "error", sessionId: S, message: "boom" },
        ];

        const turns = workerEventsToTurns(events, S);

        expect(turns[0]?.tools[0]).toMatchObject({ isError: true, result: "exit 1" });
        expect(turns.at(-1)?.event).toEqual({ kind: "error", message: "boom" });
    });

    test("empty input yields no turns", () => {
        expect(workerEventsToTurns([], S)).toEqual([]);
    });
});

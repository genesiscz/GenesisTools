import { describe, expect, test } from "bun:test";
import { type TranscriptTurn, terminatedOf, totalsOf } from "./types";

function turn(partial: Partial<TranscriptTurn>): TranscriptTurn {
    return { id: "t", role: "assistant", at: null, text: "", tools: [], ...partial };
}

describe("totalsOf", () => {
    test("sums usage over every model call and cost from the end event", () => {
        const turns = [
            turn({ usage: { inputTokens: 100, cacheReadTokens: 50, outputTokens: 10, reasoningTokens: 4 } }),
            turn({ usage: { inputTokens: 200, outputTokens: 20 } }),
            turn({ text: "no usage yet: the call that died before its usage line" }),
            turn({ role: "system", event: { kind: "end", stopReason: "end_turn", costUsd: 0.0656 } }),
        ];

        expect(totalsOf(turns)).toEqual({
            modelCalls: 2,
            inputTokens: 300,
            cacheReadTokens: 50,
            outputTokens: 30,
            reasoningTokens: 4,
            costUsd: 0.0656,
        });
    });

    test("a transcript without usage lines reports zero model calls and no token keys", () => {
        expect(totalsOf([turn({ text: "hi" })])).toEqual({ modelCalls: 0 });
    });
});

describe("terminatedOf", () => {
    test("reports the last terminal event, and null while the transcript is still running", () => {
        expect(terminatedOf([turn({})])).toBeNull();
        expect(terminatedOf([turn({}), turn({ role: "system", event: { kind: "error", message: "403" } })])).toBe(
            "error"
        );
        expect(
            terminatedOf([
                turn({ role: "system", event: { kind: "turn.started", turn: 2 } }),
                turn({ role: "system", event: { kind: "end", stopReason: "end_turn" } }),
            ])
        ).toBe("end");
    });
});

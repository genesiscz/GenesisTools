import { describe, expect, test } from "bun:test";
import { grokTurnUsage, parseTurnLog } from "./stream";

describe("parseTurnLog", () => {
    test("non-object JSON lines are malformed, not a crash", () => {
        // `null.type` threw outside the parse try/catch and killed the turn
        // before its metadata was written, so the next steer reused the turn.
        const log = ['{"type":"text","data":"a"}', "null", "42", '["end"]', '{"type":"end"}'].join("\n");

        const summary = parseTurnLog(log);
        expect(summary.report).toBe("a");
        expect(summary.ended).toBe(true);
        expect(summary.malformedLines).toBe(3);
    });

    test("concatenates text deltas, collects tool calls, detects end", () => {
        const log = [
            '{"type":"available_commands","tools":["read_file"]}',
            '{"type":"text","data":"Hello "}',
            '{"type":"thought","data":"hmm"}',
            '{"type":"text","data":"world"}',
            '{"type":"tool_call","toolCallId":"c1","toolName":"run_terminal_command","rawInput":{"command":"bun test"}}',
            '{"type":"tool_call","toolCallId":"c2","toolName":"read_file","rawInput":{"target_file":"a.js"}}',
            '{"type":"usage","data":{}}',
            '{"type":"end"}',
        ].join("\n");

        const summary = parseTurnLog(log);
        expect(summary.report).toBe("Hello world");
        expect(summary.toolCalls).toEqual([
            { tool: "run_terminal_command", target: "bun test" },
            { tool: "read_file", target: "a.js" },
        ]);
        expect(summary.ended).toBe(true);
        expect(summary.malformedLines).toBe(0);
    });

    test("a dead turn has no end event", () => {
        const summary = parseTurnLog(
            '{"type":"text","data":"partial"}\n{"type":"tool_call","toolName":"grep","rawInput":{}}'
        );
        expect(summary.ended).toBe(false);
        expect(summary.report).toBe("partial");
        expect(summary.toolCalls).toEqual([{ tool: "grep", target: "" }]);
    });

    test("tolerates malformed lines and empty input", () => {
        const summary = parseTurnLog('not json\n{"type":"end"}\n\n');
        expect(summary.ended).toBe(true);
        expect(summary.malformedLines).toBe(1);
        expect(parseTurnLog("").ended).toBe(false);
    });
});

test("a completed-turn receipt retains only the provider-reported session identity", () => {
    expect(parseTurnLog('{"type":"end","sessionId":"native-existing"}').sessionId).toBe("native-existing");
    expect(parseTurnLog('{"type":"end"}').sessionId).toBeUndefined();
});

describe("grokTurnUsage", () => {
    test("one part per model call, the model and grok's own cost from the end event", () => {
        const log = [
            '{"type":"usage","usage":{"input_tokens":5000,"output_tokens":100,"cache_read_input_tokens":1000,"cache_creation_input_tokens":0,"reasoning_tokens":40}}',
            '{"type":"tool_call_update","content":"a tool output that says \\"usage\\" in passing"}',
            '{"type":"usage","usage":{"input_tokens":700,"output_tokens":50,"cache_read_input_tokens":6000,"cache_creation_input_tokens":0,"reasoning_tokens":10}}',
            '{"type":"end","usage":{"input_tokens":5700,"cache_read_input_tokens":7000,"output_tokens":150},"total_cost_usd":0.0123,"modelUsage":{"grok-4.7-build-fast":{"inputTokens":5700}}}',
        ].join("\n");

        expect(grokTurnUsage(log)).toEqual({
            model: "grok-4.7-build-fast",
            reportedUsd: 0.0123,
            parts: [
                {
                    model: "grok-4.7-build-fast",
                    singleRequest: true,
                    tokens: { input: 5000, cacheRead: 1000, cacheWrite: 0, output: 100, reasoning: 40 },
                },
                {
                    model: "grok-4.7-build-fast",
                    singleRequest: true,
                    tokens: { input: 700, cacheRead: 6000, cacheWrite: 0, output: 50, reasoning: 10 },
                },
            ],
        });
    });

    test("a turn that reported no usage has no parts, never a zero", () => {
        expect(grokTurnUsage('{"type":"text","data":"hi"}')).toEqual({ parts: null });
    });
});

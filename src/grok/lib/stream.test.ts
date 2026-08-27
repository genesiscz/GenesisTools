import { describe, expect, test } from "bun:test";
import { parseTurnLog } from "./stream";

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

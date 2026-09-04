import { describe, expect, test } from "bun:test";
import { parseTurnEvents, toWorkerEvent } from "./stream";

// Line shapes captured from real turn logs under ~/.genesis-tools/grok/sessions
// (2026-09-01); payload text replaced with fixture values. The stream is FLAT
// NDJSON ({"type":...}), not the ACP nesting the CLI help implies.
const SESSION = "00000000-0000-4000-8000-000000000001";

const lines = {
    text: '{"type":"text","data":"Hello"}',
    thought: '{"type":"thought","data":"The"}',
    toolCall:
        '{"type":"tool_call","toolCallId":"call-1","title":"run_terminal_command","kind":"execute","status":"pending","toolName":"run_terminal_command","rawInput":{"command":"pwd"}}',
    toolUpdateInProgress: '{"type":"tool_call_update","toolCallId":"call-1","status":"in_progress","content":[]}',
    toolUpdateNull: '{"type":"tool_call_update","toolCallId":"call-1","status":null,"content":[]}',
    toolUpdateCompleted: '{"type":"tool_call_update","toolCallId":"call-1","status":"completed","content":[]}',
    toolUpdateFailed: '{"type":"tool_call_update","toolCallId":"call-2","status":"failed","content":[]}',
    end: `{"type":"end","stopReason":"end_turn","sessionId":"${SESSION}","requestId":"req-1","usage":{"input_tokens":4647,"cache_read_input_tokens":100096,"output_tokens":708,"reasoning_tokens":343},"num_turns":2,"total_cost_usd":0.065648}`,
    availableCommands: '{"type":"available_commands","tools":["read_file","list_dir","grep"]}',
    usage: '{"type":"usage","input_tokens":1}',
    plan: '{"type":"plan","entries":[]}',
};

describe("grok toWorkerEvent", () => {
    test("text and thought become deltas", () => {
        expect(toWorkerEvent(lines.text, SESSION)).toMatchObject({ kind: "text", text: "Hello", delta: true });
        expect(toWorkerEvent(lines.thought, SESSION)).toMatchObject({ kind: "reasoning", text: "The", delta: true });
    });

    test("tool_call carries tool, target and call id", () => {
        expect(toWorkerEvent(lines.toolCall, SESSION)).toMatchObject({
            kind: "tool_call",
            tool: "run_terminal_command",
            target: "pwd",
            callId: "call-1",
        });
    });

    test("only terminal tool_call_update statuses become tool_result", () => {
        expect(toWorkerEvent(lines.toolUpdateInProgress, SESSION)).toBeNull();
        expect(toWorkerEvent(lines.toolUpdateNull, SESSION)).toBeNull();
        expect(toWorkerEvent(lines.toolUpdateCompleted, SESSION)).toMatchObject({
            kind: "tool_result",
            callId: "call-1",
            ok: true,
        });
        expect(toWorkerEvent(lines.toolUpdateFailed, SESSION)).toMatchObject({ kind: "tool_result", ok: false });
    });

    test("end becomes turn.completed with usage and cost", () => {
        expect(toWorkerEvent(lines.end, SESSION)).toMatchObject({
            kind: "turn.completed",
            sessionId: SESSION,
            usage: { inputTokens: 4647, cacheReadTokens: 100096, outputTokens: 708, totalCostUsd: 0.065648 },
        });
    });

    test("chatter stays out of the shared stream", () => {
        expect(toWorkerEvent(lines.availableCommands, SESSION)).toBeNull();
        expect(toWorkerEvent(lines.usage, SESSION)).toBeNull();
        expect(toWorkerEvent(lines.plan, SESSION)).toBeNull();
    });

    test("parseTurnEvents walks a whole transcript in order", () => {
        const transcript = [lines.availableCommands, lines.thought, lines.text, lines.toolCall, lines.end].join("\n");
        const kinds = parseTurnEvents(transcript, SESSION).map((event) => event.kind);
        expect(kinds).toEqual(["reasoning", "text", "tool_call", "turn.completed"]);
    });
});

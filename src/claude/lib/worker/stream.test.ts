import { describe, expect, test } from "bun:test";
import { parseTurnEvents, toWorkerEvents } from "./stream";

// Line shapes from a live `claude -p --output-format stream-json --verbose`
// capture (Claude Code 2.1.238, 2026-09-01); payload text and ids replaced
// with fixture values. Every line carries the --session-id uuid back.
const SESSION = "00000000-0000-4000-8000-0000000000aa";

const init = `{"type":"system","subtype":"init","session_id":"${SESSION}","model":"claude-haiku-4-5-20251001"}`;
const hook = `{"type":"system","subtype":"hook_started","session_id":"${SESSION}"}`;
const status = `{"type":"system","subtype":"status","session_id":"${SESSION}"}`;
const rateLimit = `{"type":"rate_limit_event","session_id":"${SESSION}"}`;
const assistant = `{"type":"assistant","session_id":"${SESSION}","message":{"role":"assistant","content":[{"type":"thinking","thinking":"planning…"},{"type":"text","text":"OK"}]}}`;
const assistantToolUse = `{"type":"assistant","session_id":"${SESSION}","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"printenv TOOLS_CLAUDE_ACCOUNT"}}]}}`;
const userToolResult = `{"type":"user","session_id":"${SESSION}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"work"}]}}`;
const result = `{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION}","num_turns":1,"total_cost_usd":0.1147,"usage":{"input_tokens":10,"cache_read_input_tokens":0,"output_tokens":121},"result":"OK"}`;
const errorResult = `{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"${SESSION}"}`;

describe("claude worker stream", () => {
    test("init opens the turn; hook/status/rate-limit chatter stays out", () => {
        expect(toWorkerEvents(init, SESSION)).toMatchObject([{ kind: "turn.started", sessionId: SESSION }]);
        expect(toWorkerEvents(hook, SESSION)).toEqual([]);
        expect(toWorkerEvents(status, SESSION)).toEqual([]);
        expect(toWorkerEvents(rateLimit, SESSION)).toEqual([]);
    });

    test("one assistant line fans out into its content blocks", () => {
        expect(toWorkerEvents(assistant, SESSION)).toMatchObject([
            { kind: "reasoning", text: "planning…", delta: false },
            { kind: "text", text: "OK", delta: false },
        ]);
    });

    test("tool_use and tool_result map with the call id intact", () => {
        expect(toWorkerEvents(assistantToolUse, SESSION)).toMatchObject([
            { kind: "tool_call", tool: "Bash", target: "printenv TOOLS_CLAUDE_ACCOUNT", callId: "toolu_1" },
        ]);
        expect(toWorkerEvents(userToolResult, SESSION)).toMatchObject([
            { kind: "tool_result", callId: "toolu_1", ok: true },
        ]);
    });

    test("result maps to turn.completed with usage and cost", () => {
        expect(toWorkerEvents(result, SESSION)).toMatchObject([
            {
                kind: "turn.completed",
                turn: 1,
                usage: { inputTokens: 10, outputTokens: 121, totalCostUsd: 0.1147 },
            },
        ]);
    });

    test("an error result maps to turn.failed", () => {
        expect(toWorkerEvents(errorResult, SESSION)).toMatchObject([
            { kind: "turn.failed", reason: "error_during_execution" },
        ]);
    });

    test("parseTurnEvents walks a whole transcript in order", () => {
        const transcript = [init, hook, assistant, assistantToolUse, userToolResult, result].join("\n");
        const kinds = parseTurnEvents(transcript, SESSION).map((event) => event.kind);
        expect(kinds).toEqual(["turn.started", "reasoning", "text", "tool_call", "tool_result", "turn.completed"]);
    });
});

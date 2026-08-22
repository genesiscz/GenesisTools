import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseResponseBody, readRequestTags, transcriptFile } from "./transcripts";

function sse(frames: object[]): string {
    return `${frames.map((frame) => `data: ${SafeJSON.stringify(frame)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

describe("parseResponseBody", () => {
    it("returns empty text and thinking for an empty body", () => {
        expect(parseResponseBody("", false)).toEqual({ text: "", thinking: "" });
        expect(parseResponseBody("   \n", true)).toEqual({ text: "", thinking: "" });
    });

    it("reads text, reasoning, usage and finish reason off a plain JSON reply", () => {
        const body = SafeJSON.stringify({
            choices: [
                {
                    message: { content: "answer", reasoning_content: "because" },
                    finish_reason: "stop",
                },
            ],
            usage: { total_tokens: 7 },
        });

        const parsed = parseResponseBody(body, false);
        expect(parsed.text).toBe("answer");
        expect(parsed.thinking).toBe("because");
        expect(parsed.finishReason).toBe("stop");
        expect(parsed.usage).toEqual({ total_tokens: 7 });
    });

    it("reassembles a streamed reply across frames, keeping thinking separate from text", () => {
        const body = sse([
            { choices: [{ delta: { reasoning_content: "think " } }] },
            { choices: [{ delta: { reasoning_content: "harder" } }] },
            { choices: [{ delta: { content: "one " } }] },
            { choices: [{ delta: { content: "two" }, finish_reason: "stop" }] },
        ]);

        const parsed = parseResponseBody(body, true);
        expect(parsed.text).toBe("one two");
        expect(parsed.thinking).toBe("think harder");
        expect(parsed.finishReason).toBe("stop");
    });

    it("collects tool calls out of a stream", () => {
        const body = sse([
            { choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "grep" } }] } }] },
            { choices: [{ delta: { content: "done" }, finish_reason: "tool_calls" }] },
        ]);

        const parsed = parseResponseBody(body, true);
        expect(parsed.toolCalls).toHaveLength(1);
        expect(parsed.toolCalls?.[0]?.function?.name).toBe("grep");
    });

    it("keeps a non-JSON body as text instead of throwing it away", () => {
        expect(parseResponseBody("<html>gateway timeout</html>", false)).toEqual({
            text: "<html>gateway timeout</html>",
            thinking: "",
        });
    });

    it("skips unparseable frames but keeps the good ones", () => {
        const body = `data: {"choices":[{"delta":{"content":"kept"}}]}\n\ndata: {oops\n\ndata: [DONE]\n\n`;
        expect(parseResponseBody(body, true).text).toBe("kept");
    });

    it("reads an Anthropic message body (the passthrough stores a real reply now)", () => {
        // Only choices[0] was read before, so /v1/messages and /v1/responses
        // replies were stored as an empty content block plus a raw prefix.
        const parsed = parseResponseBody(
            '{"type":"message","content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"4"},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"p":"a"}}],"stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":5}}',
            false
        );

        expect(parsed.text).toBe("4");
        expect(parsed.thinking).toBe("hm");
        expect(parsed.finishReason).toBe("tool_use");
        expect(parsed.toolCalls?.[0]?.function?.name).toBe("Read");
        expect(parsed.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    });

    it("reassembles an Anthropic SSE stream", () => {
        const body = [
            'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"4"}}',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
        ].join("\n\n");

        const parsed = parseResponseBody(body, true);
        expect(parsed.text).toBe("4");
        expect(parsed.thinking).toBe("hm");
        expect(parsed.finishReason).toBe("end_turn");
        expect(parsed.usage).toEqual({ input_tokens: 10, output_tokens: 7 });
    });

    it("folds input_json_delta into the streamed tool call (grok probe recorded every input as {})", () => {
        const body = [
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"/tmp/a\\"}"}}',
            'data: {"type":"content_block_stop","index":0}',
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"ListAgents","input":{}}}',
            'data: {"type":"content_block_stop","index":1}',
        ].join("\n\n");

        const parsed = parseResponseBody(body, true);
        expect(parsed.toolCalls?.[0]?.function?.arguments).toBe('{"file_path":"/tmp/a"}');
        // A call that never streams deltas keeps its (empty) start input.
        expect(parsed.toolCalls?.[1]?.function?.name).toBe("ListAgents");
        expect(parsed.toolCalls?.[1]?.function?.arguments).toBe("{}");
    });

    it("routes interleaved input_json_delta frames by block index, not recency", () => {
        const body = [
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_a","name":"Read","input":{}}}',
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_b","name":"Bash","input":{}}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"/tmp/a\\"}"}}',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}',
        ].join("\n\n");

        const parsed = parseResponseBody(body, true);
        expect(parsed.toolCalls?.[0]?.function?.arguments).toBe('{"file_path":"/tmp/a"}');
        expect(parsed.toolCalls?.[1]?.function?.arguments).toBe('{"command":"ls"}');
    });

    it("reads a Responses JSON body", () => {
        const parsed = parseResponseBody(
            '{"object":"response","status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"hm"}]},{"type":"message","content":[{"type":"output_text","text":"4"}]},{"type":"function_call","call_id":"fc_1","name":"Read","arguments":"{}"}],"usage":{"input_tokens":3,"output_tokens":2}}',
            false
        );

        expect(parsed.text).toBe("4");
        expect(parsed.thinking).toBe("hm");
        expect(parsed.toolCalls?.[0]?.function?.name).toBe("Read");
    });

    it("reassembles a Responses SSE stream, including reasoning and function calls", () => {
        // Reasoning streams on its own event type and tool calls only land on
        // output_item.done — a transcript that only reads output_text.delta
        // recorded neither.
        const body = [
            'data: {"type":"response.reasoning_text.delta","delta":"weigh"}',
            // The translator also emits this shape; it was dropped before.
            'data: {"type":"response.reasoning.delta","delta":"-more"}',
            'data: {"type":"response.output_text.delta","delta":"4"}',
            'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"fc_9","name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}',
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":3}}}',
        ].join("\n");

        const parsed = parseResponseBody(body, true);

        expect(parsed.text).toBe("4");
        expect(parsed.thinking).toBe("weigh-more");
        expect(parsed.toolCalls?.[0]?.function?.name).toBe("Bash");
        expect(parsed.toolCalls?.[0]?.function?.arguments).toBe('{"command":"ls"}');
        expect(parsed.toolCalls?.[0]?.id).toBe("fc_9");
        expect(parsed.finishReason).toBe("completed");
        expect(parsed.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
    });
});

describe("readRequestTags", () => {
    it("returns undefined when no x-gt-* header is present", () => {
        expect(readRequestTags(new Headers({ "content-type": "application/json" }))).toBeUndefined();
    });

    it("reads the tags that are present and leaves the rest undefined", () => {
        const tags = readRequestTags(new Headers({ "x-gt-session": "run-7", "x-gt-stage": "filter" }));

        expect(tags?.session).toBe("run-7");
        expect(tags?.stage).toBe("filter");
        expect(tags?.run).toBeUndefined();
        expect(tags?.label).toBeUndefined();
    });
});

describe("transcriptFile", () => {
    it("names the file after the session", () => {
        expect(transcriptFile("2026-07-25", "lff-mine")).toEndWith("/2026-07-25/lff-mine.jsonl");
    });

    it("falls back to _untagged and strips path separators out of a session name", () => {
        expect(transcriptFile("2026-07-25")).toEndWith("/2026-07-25/_untagged.jsonl");
        // A session name can never escape the day directory: separators collapse to dashes.
        expect(transcriptFile("2026-07-25", "../../etc/passwd")).toEndWith("/2026-07-25/..-..-etc-passwd.jsonl");
    });
});

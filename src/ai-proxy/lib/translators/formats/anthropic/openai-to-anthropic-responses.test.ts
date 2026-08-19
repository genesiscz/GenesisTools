import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    anthropicStreamChunk,
    anthropicStreamEnd,
    createAnthropicStreamState,
    openAiCompletionToAnthropicMessage,
    openAiFinishToAnthropicStop,
} from "./openai-to-anthropic-responses";

const MODEL = "martin/grok/grok-4.5";

/** Parse `event: x\ndata: {...}` frames into their JSON payloads, in order. */
function parseFrames(sse: string): Array<Record<string, unknown>> {
    return sse
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => SafeJSON.parse(line.slice("data:".length).trim(), { strict: true }) as Record<string, unknown>);
}

function types(sse: string): string[] {
    return parseFrames(sse).map((frame) => String(frame.type));
}

describe("openAiFinishToAnthropicStop", () => {
    it("maps the OpenAI finish reasons onto Anthropic stop reasons", () => {
        expect(openAiFinishToAnthropicStop("stop")).toBe("end_turn");
        expect(openAiFinishToAnthropicStop("length")).toBe("max_tokens");
        expect(openAiFinishToAnthropicStop("tool_calls")).toBe("tool_use");
        expect(openAiFinishToAnthropicStop(undefined)).toBe("end_turn");
    });
});

describe("openAiCompletionToAnthropicMessage", () => {
    it("orders thinking before text and turns tool_calls into tool_use blocks", () => {
        const message = openAiCompletionToAnthropicMessage(
            {
                id: "chatcmpl-abc",
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            reasoning_content: "let me think",
                            content: "here you go",
                            tool_calls: [
                                { id: "call_1", type: "function", function: { name: "read", arguments: '{"p":"a"}' } },
                            ],
                        },
                        finish_reason: "tool_calls",
                    },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 4 },
            },
            { model: MODEL }
        );

        expect(message.model).toBe(MODEL);
        expect(message.stop_reason).toBe("tool_use");
        expect(message.content).toEqual([
            { type: "thinking", thinking: "let me think" },
            { type: "text", text: "here you go" },
            { type: "tool_use", id: "call_1", name: "read", input: { p: "a" } },
        ]);
        expect(message.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
    });

    it("reports cache reads outside input_tokens, as the Anthropic API does", () => {
        const message = openAiCompletionToAnthropicMessage(
            {
                choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } },
            },
            { model: MODEL }
        );

        expect(message.usage).toEqual({ input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 80 });
    });

    it("never returns an empty content array", () => {
        const message = openAiCompletionToAnthropicMessage(
            { choices: [{ message: { content: null }, finish_reason: "stop" }] },
            { model: MODEL }
        );

        expect(message.content).toEqual([{ type: "text", text: "" }]);
    });
});

describe("anthropic stream state machine", () => {
    it("emits a well-formed text stream", () => {
        const state = createAnthropicStreamState(MODEL);
        let sse = "";

        sse += anthropicStreamChunk(state, { choices: [{ delta: { role: "assistant" } }] });
        sse += anthropicStreamChunk(state, { choices: [{ delta: { content: "Hel" } }] });
        sse += anthropicStreamChunk(state, { choices: [{ delta: { content: "lo" } }] });
        sse += anthropicStreamChunk(state, { choices: [{ delta: {}, finish_reason: "stop" }] });
        sse += anthropicStreamEnd(state);

        expect(types(sse)).toEqual([
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]);

        const frames = parseFrames(sse);
        expect(frames[1]?.content_block).toEqual({ type: "text", text: "" });
        expect(frames[2]?.delta).toEqual({ type: "text_delta", text: "Hel" });
        expect(frames[5]?.delta).toEqual({ stop_reason: "end_turn", stop_sequence: null });
    });

    it("closes the thinking block before opening the text block", () => {
        const state = createAnthropicStreamState(MODEL);
        let sse = "";

        sse += anthropicStreamChunk(state, { choices: [{ delta: { reasoning_content: "hmm" } }] });
        sse += anthropicStreamChunk(state, { choices: [{ delta: { content: "done" } }] });
        sse += anthropicStreamEnd(state);

        expect(types(sse)).toEqual([
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]);

        const frames = parseFrames(sse);
        expect(frames[1]?.content_block).toEqual({ type: "thinking", thinking: "" });
        expect(frames[2]?.delta).toEqual({ type: "thinking_delta", thinking: "hmm" });
        expect(frames[4]?.content_block).toEqual({ type: "text", text: "" });
        // Block indices must keep counting up across kinds.
        expect(frames[4]?.index).toBe(1);
    });

    it("carries a tool call's id and name from the first frame into later argument frames", () => {
        const state = createAnthropicStreamState(MODEL);
        let sse = "";

        sse += anthropicStreamChunk(state, {
            choices: [
                {
                    delta: {
                        tool_calls: [{ index: 0, id: "call_9", function: { name: "edit", arguments: "" } }],
                    },
                },
            ],
        });
        sse += anthropicStreamChunk(state, {
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }],
        });
        sse += anthropicStreamChunk(state, {
            choices: [
                { delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" },
            ],
        });
        sse += anthropicStreamEnd(state);

        const frames = parseFrames(sse);
        expect(frames[1]?.content_block).toEqual({ type: "tool_use", id: "call_9", name: "edit", input: {} });
        expect(frames[2]?.delta).toEqual({ type: "input_json_delta", partial_json: '{"a":' });
        expect(frames[3]?.delta).toEqual({ type: "input_json_delta", partial_json: "1}" });
        expect(frames.at(-2)?.delta).toEqual({ stop_reason: "tool_use", stop_sequence: null });
    });

    it("gives each parallel tool call its own content block", () => {
        const state = createAnthropicStreamState(MODEL);
        let sse = "";

        sse += anthropicStreamChunk(state, {
            choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "one", arguments: "{}" } }] } }],
        });
        sse += anthropicStreamChunk(state, {
            choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "two", arguments: "{}" } }] } }],
        });
        sse += anthropicStreamEnd(state);

        const starts = parseFrames(sse).filter((frame) => frame.type === "content_block_start");
        expect(starts.map((frame) => frame.index)).toEqual([0, 1]);
        expect(starts.map((frame) => (frame.content_block as Record<string, unknown>).name)).toEqual(["one", "two"]);
    });

    it("puts the final usage in message_delta", () => {
        const state = createAnthropicStreamState(MODEL);
        let sse = "";

        sse += anthropicStreamChunk(state, { choices: [{ delta: { content: "x" } }] });
        sse += anthropicStreamChunk(state, { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } });
        sse += anthropicStreamEnd(state);

        const messageDelta = parseFrames(sse).find((frame) => frame.type === "message_delta");
        expect(messageDelta?.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
    });

    it("estimates usage when the upstream reports none (Grok drops stream_options)", () => {
        const state = createAnthropicStreamState(MODEL, 120);
        let sse = "";

        sse += anthropicStreamChunk(state, { choices: [{ delta: { content: "x".repeat(40) } }] });
        sse += anthropicStreamEnd(state);

        const frames = parseFrames(sse);
        expect((frames[0]?.message as Record<string, unknown>).usage).toEqual({
            input_tokens: 120,
            output_tokens: 0,
        });
        expect(frames.find((frame) => frame.type === "message_delta")?.usage).toEqual({
            input_tokens: 120,
            output_tokens: 10,
        });
    });

    it("prefers the upstream's own usage over the estimate", () => {
        const state = createAnthropicStreamState(MODEL, 120);
        let sse = "";

        sse += anthropicStreamChunk(state, { choices: [{ delta: { content: "x".repeat(40) } }] });
        sse += anthropicStreamChunk(state, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 1 } });
        sse += anthropicStreamEnd(state);

        expect(parseFrames(sse).find((frame) => frame.type === "message_delta")?.usage).toEqual({
            input_tokens: 9,
            output_tokens: 1,
        });
    });

    it("still emits a complete message when the upstream sent nothing", () => {
        const state = createAnthropicStreamState(MODEL);

        expect(types(anthropicStreamEnd(state))).toEqual(["message_start", "message_delta", "message_stop"]);
    });
});

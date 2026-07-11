import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { anthropicMessageToOpenAiCompletion, anthropicSseToOpenAiChatStream } from "./anthropic-to-openai-completions";

const MODEL = "martin/claude-sub/haiku";

function streamFrom(text: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
        },
    });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = "";

    for (;;) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        out += decoder.decode(value, { stream: true });
    }

    return out;
}

/** Parse `data: {...}` lines (ignoring [DONE]) into objects. */
function parseChunks(sse: string): Array<Record<string, unknown>> {
    return sse
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
        .map((line) => SafeJSON.parse(line.slice("data:".length).trim()) as Record<string, unknown>);
}

describe("anthropicMessageToOpenAiCompletion", () => {
    it("maps a text message to an OpenAI chat.completion", () => {
        const completion = anthropicMessageToOpenAiCompletion(
            {
                id: "msg_123",
                role: "assistant",
                content: [{ type: "text", text: "Hello there" }],
                stop_reason: "end_turn",
                usage: { input_tokens: 10, output_tokens: 3 },
            },
            { model: MODEL }
        );

        expect(completion.object).toBe("chat.completion");
        expect(completion.model).toBe(MODEL);
        expect(completion.choices[0]?.message.content).toBe("Hello there");
        expect(completion.choices[0]?.finish_reason).toBe("stop");
        expect(completion.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
    });

    it("maps tool_use blocks to tool_calls with finish_reason tool_calls", () => {
        const completion = anthropicMessageToOpenAiCompletion(
            {
                id: "msg_x",
                role: "assistant",
                content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Prague" } }],
                stop_reason: "tool_use",
                usage: { input_tokens: 5, output_tokens: 8 },
            },
            { model: MODEL }
        );

        expect(completion.choices[0]?.message.content).toBeNull();
        expect(completion.choices[0]?.message.tool_calls).toEqual([
            { index: 0, id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Prague"}' } },
        ]);
        expect(completion.choices[0]?.finish_reason).toBe("tool_calls");
    });

    it("maps max_tokens stop_reason to length", () => {
        const completion = anthropicMessageToOpenAiCompletion(
            { id: "m", role: "assistant", content: [{ type: "text", text: "x" }], stop_reason: "max_tokens" },
            { model: MODEL }
        );

        expect(completion.choices[0]?.finish_reason).toBe("length");
    });
});

describe("anthropicSseToOpenAiChatStream", () => {
    it("streams text deltas as chat.completion.chunk events ending in [DONE]", async () => {
        const anthropicSse = [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-haiku-4-5-20251001","usage":{"input_tokens":4}}}\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n',
        ].join("\n");

        const out = await collect(anthropicSseToOpenAiChatStream(streamFrom(anthropicSse), { model: MODEL }));
        const chunks = parseChunks(out);

        expect(out).toContain("data: [DONE]");
        expect(out).toContain('"object":"chat.completion.chunk"');

        // first chunk announces the assistant role
        const firstDelta = (chunks[0]?.choices as Array<{ delta: Record<string, unknown> }>)[0]?.delta;
        expect(firstDelta).toEqual({ role: "assistant" });

        // reassembled content
        const content = chunks
            .flatMap((c) => (c.choices as Array<{ delta: { content?: string } }>))
            .map((choice) => choice.delta.content ?? "")
            .join("");
        expect(content).toBe("Hello");

        // final chunk carries finish_reason stop
        const finishReasons = chunks
            .flatMap((c) => c.choices as Array<{ finish_reason: string | null }>)
            .map((choice) => choice.finish_reason)
            .filter((reason) => reason !== null);
        expect(finishReasons).toEqual(["stop"]);
    });

    it("streams tool_use as tool_call deltas", async () => {
        const anthropicSse = [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","model":"claude-haiku-4-5-20251001"}}\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"search"}}\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"cats\\"}"}}\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n',
        ].join("\n");

        const out = await collect(anthropicSseToOpenAiChatStream(streamFrom(anthropicSse), { model: MODEL }));
        const chunks = parseChunks(out);

        const toolCalls = chunks
            .flatMap((c) => c.choices as Array<{ delta: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>)
            .flatMap((choice) => choice.delta.tool_calls ?? []);

        // first tool_call chunk names the function
        expect(toolCalls[0]?.id).toBe("toolu_9");
        expect(toolCalls[0]?.function?.name).toBe("search");

        // arguments reassemble
        const args = toolCalls.map((tc) => tc.function?.arguments ?? "").join("");
        expect(args).toBe('{"q":"cats"}');

        const finishReasons = chunks
            .flatMap((c) => c.choices as Array<{ finish_reason: string | null }>)
            .map((choice) => choice.finish_reason)
            .filter((reason) => reason !== null);
        expect(finishReasons).toEqual(["tool_calls"]);
    });
});

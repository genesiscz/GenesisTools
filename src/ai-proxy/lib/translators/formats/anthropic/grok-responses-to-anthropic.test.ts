import { describe, expect, it } from "bun:test";
import {
    packReasoningSignature,
    unpackReasoningSignature,
} from "@app/ai-proxy/lib/translators/formats/anthropic/anthropic-to-responses";
import {
    grokResponsesSseToAnthropic,
    grokResponsesToAnthropicMessage,
} from "@app/ai-proxy/lib/translators/formats/anthropic/grok-responses-to-anthropic";
import { SafeJSON } from "@genesiscz/utils/json";

interface Frame {
    event: string;
    data: Record<string, unknown>;
}

function sse(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const text = events.map((event) => `event: ${event.type}\ndata: ${SafeJSON.stringify(event)}\n\n`).join("");

    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
        },
    });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<{ raw: string; frames: Frame[] }> {
    const raw = await new Response(stream).text();
    const frames: Frame[] = [];

    for (const chunk of raw.split("\n\n")) {
        const eventLine = chunk.split("\n").find((line) => line.startsWith("event: "));
        const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));

        if (eventLine && dataLine) {
            frames.push({
                event: eventLine.slice(7),
                data: SafeJSON.parse(dataLine.slice(6), { strict: true }) as Record<string, unknown>,
            });
        }
    }

    return { raw, frames };
}

function frameSummary(frames: Frame[]): string[] {
    return frames.map((frame) => {
        if (frame.event === "content_block_start") {
            const block = frame.data.content_block as Record<string, unknown>;
            return `start[${frame.data.index}]:${block.type}${block.name ? `:${block.name}` : ""}`;
        }

        if (frame.event === "content_block_delta") {
            const delta = frame.data.delta as Record<string, unknown>;
            return `delta[${frame.data.index}]:${delta.type}`;
        }

        if (frame.event === "content_block_stop") {
            return `stop[${frame.data.index}]`;
        }

        return frame.event;
    });
}

// The wire shape captured live 2026-08-21: one reasoning item (summary deltas,
// encrypted_content on the done frame), then each function_call as its own
// output item with its name on the added frame.
const REASONING_DONE = {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "I should call both tools." }],
    status: "completed",
    encrypted_content: "ENC==",
};

const CALL_A_DONE = {
    type: "function_call",
    call_id: "call-a-0",
    name: "list_agents",
    arguments: "{}",
    status: "completed",
};

const CALL_B_DONE = {
    type: "function_call",
    call_id: "call-a-1",
    name: "run_command",
    arguments: '{"command":"date"}',
    status: "completed",
};

const COMPLETED = {
    type: "response.completed",
    response: {
        id: "resp_1",
        status: "completed",
        output: [REASONING_DONE, CALL_A_DONE, CALL_B_DONE],
        usage: {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 384 },
            output_tokens: 50,
            total_tokens: 1050,
        },
    },
};

describe("grokResponsesSseToAnthropic", () => {
    it("gives every output item its own named content block", async () => {
        const { frames } = await collect(
            grokResponsesSseToAnthropic(
                sse([
                    { type: "response.created", response: { id: "resp_1" } },
                    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
                    { type: "response.reasoning_summary_part.added", output_index: 0 },
                    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "I should call " },
                    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "both tools." },
                    { type: "response.output_item.done", output_index: 0, item: REASONING_DONE },
                    {
                        type: "response.output_item.added",
                        output_index: 1,
                        item: { type: "function_call", call_id: "call-a-0", name: "list_agents", arguments: "" },
                    },
                    { type: "response.function_call_arguments.delta", output_index: 1, delta: "{}" },
                    { type: "response.output_item.done", output_index: 1, item: CALL_A_DONE },
                    {
                        type: "response.output_item.added",
                        output_index: 2,
                        item: { type: "function_call", call_id: "call-a-1", name: "run_command", arguments: "" },
                    },
                    { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"command":' },
                    { type: "response.function_call_arguments.delta", output_index: 2, delta: '"date"}' },
                    { type: "response.output_item.done", output_index: 2, item: CALL_B_DONE },
                    COMPLETED,
                ]),
                { model: "grok-4.6" }
            )
        );

        expect(frameSummary(frames)).toEqual([
            "message_start",
            "start[0]:thinking",
            "delta[0]:thinking_delta",
            "delta[0]:thinking_delta",
            "delta[0]:signature_delta",
            "stop[0]",
            "start[1]:tool_use:list_agents",
            "delta[1]:input_json_delta",
            "stop[1]",
            "start[2]:tool_use:run_command",
            "delta[2]:input_json_delta",
            "delta[2]:input_json_delta",
            "stop[2]",
            "message_delta",
            "message_stop",
        ]);

        const starts = frames.filter((frame) => frame.event === "content_block_start");
        expect((starts[1].data.content_block as Record<string, unknown>).id).toBe("call-a-0");
        expect((starts[2].data.content_block as Record<string, unknown>).id).toBe("call-a-1");

        // The signature round-trips the encrypted reasoning verbatim.
        const signatureDelta = frames.find(
            (frame) =>
                frame.event === "content_block_delta" &&
                (frame.data.delta as Record<string, unknown>).type === "signature_delta"
        );
        const signature = (signatureDelta?.data.delta as Record<string, unknown>).signature;
        expect(unpackReasoningSignature(signature)).toEqual({ id: "rs_1", encryptedContent: "ENC==" });

        const messageDelta = frames.find((frame) => frame.event === "message_delta");
        expect((messageDelta?.data.delta as Record<string, unknown>).stop_reason).toBe("tool_use");
        expect(messageDelta?.data.usage).toEqual({
            input_tokens: 616,
            output_tokens: 50,
            cache_read_input_tokens: 384,
        });
    });

    it("synthesizes an item that only appears in the terminal snapshot", async () => {
        const { frames } = await collect(
            grokResponsesSseToAnthropic(
                sse([
                    { type: "response.created", response: { id: "resp_1" } },
                    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
                    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "thinking…" },
                    { type: "response.output_item.done", output_index: 0, item: REASONING_DONE },
                    // call-a-0 streamed; call-a-1 arrives ONLY in the snapshot.
                    {
                        type: "response.output_item.added",
                        output_index: 1,
                        item: { type: "function_call", call_id: "call-a-0", name: "list_agents", arguments: "" },
                    },
                    { type: "response.function_call_arguments.delta", output_index: 1, delta: "{}" },
                    { type: "response.output_item.done", output_index: 1, item: CALL_A_DONE },
                    COMPLETED,
                ]),
                { model: "grok-4.6" }
            )
        );

        const summary = frameSummary(frames);
        expect(summary).toContain("start[2]:tool_use:run_command");
        expect(summary.filter((entry) => entry === "delta[2]:input_json_delta")).toHaveLength(1);

        const salvaged = frames.find(
            (frame) =>
                frame.event === "content_block_delta" &&
                frame.data.index === 2 &&
                (frame.data.delta as Record<string, unknown>).type === "input_json_delta"
        );
        expect((salvaged?.data.delta as Record<string, unknown>).partial_json).toBe('{"command":"date"}');
    });

    it("closes the message when the stream ends without a terminal frame", async () => {
        const { frames } = await collect(
            grokResponsesSseToAnthropic(
                sse([
                    { type: "response.created", response: { id: "resp_1" } },
                    {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { type: "function_call", call_id: "call-a-0", name: "list_agents", arguments: "" },
                    },
                    { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
                    // no output_item.done, no response.completed — the 1-in-38 case
                ]),
                { model: "grok-4.6" }
            )
        );

        expect(frameSummary(frames)).toEqual([
            "message_start",
            "start[0]:tool_use:list_agents",
            "delta[0]:input_json_delta",
            "stop[0]",
            "message_delta",
            "message_stop",
        ]);

        const messageDelta = frames.find((frame) => frame.event === "message_delta");
        expect((messageDelta?.data.delta as Record<string, unknown>).stop_reason).toBe("tool_use");
    });

    it("forwards keepalive comments and turns response.failed into an Anthropic error frame", async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(": keepalive\n"));
                controller.enqueue(
                    encoder.encode(
                        `data: ${SafeJSON.stringify({
                            type: "response.failed",
                            response: { error: { message: "upstream exploded" } },
                        })}\n\n`
                    )
                );
                controller.close();
            },
        });

        const { raw, frames } = await collect(grokResponsesSseToAnthropic(stream, { model: "grok-4.6" }));

        expect(raw).toContain(": keepalive");
        const error = frames.find((frame) => frame.event === "error");
        expect((error?.data.error as Record<string, unknown>).message).toBe("upstream exploded");
        // A failed response never fabricates a message_stop.
        expect(frames.some((frame) => frame.event === "message_stop")).toBe(false);
    });

    it("streams text deltas into a text block", async () => {
        const { frames } = await collect(
            grokResponsesSseToAnthropic(
                sse([
                    { type: "response.created", response: { id: "resp_1" } },
                    {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { type: "message", role: "assistant" },
                    },
                    { type: "response.output_text.delta", output_index: 0, delta: "Hello " },
                    { type: "response.output_text.delta", output_index: 0, delta: "world" },
                    {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: { type: "message", content: [{ type: "output_text", text: "Hello world" }] },
                    },
                    {
                        type: "response.completed",
                        response: {
                            id: "resp_1",
                            status: "completed",
                            output: [{ type: "message", content: [{ type: "output_text", text: "Hello world" }] }],
                            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
                        },
                    },
                ]),
                { model: "grok-4.6" }
            )
        );

        expect(frameSummary(frames)).toEqual([
            "message_start",
            "start[0]:text",
            "delta[0]:text_delta",
            "delta[0]:text_delta",
            "stop[0]",
            "message_delta",
            "message_stop",
        ]);

        const messageDelta = frames.find((frame) => frame.event === "message_delta");
        expect((messageDelta?.data.delta as Record<string, unknown>).stop_reason).toBe("end_turn");
    });
});

describe("grokResponsesToAnthropicMessage", () => {
    it("maps the whole envelope, packing the reasoning signature", () => {
        const message = grokResponsesToAnthropicMessage(
            {
                id: "resp_9",
                status: "completed",
                output: [
                    REASONING_DONE,
                    { type: "message", content: [{ type: "output_text", text: "running it" }] },
                    CALL_B_DONE,
                ],
                usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
            },
            { model: "grok-4.6" }
        );

        expect(message.content).toEqual([
            {
                type: "thinking",
                thinking: "I should call both tools.",
                signature: packReasoningSignature("rs_1", "ENC=="),
            },
            { type: "text", text: "running it" },
            { type: "tool_use", id: "call-a-1", name: "run_command", input: { command: "date" } },
        ]);
        expect(message.stop_reason).toBe("tool_use");
        expect(message.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
    });

    it("reports max_tokens when the response is incomplete for that reason", () => {
        const message = grokResponsesToAnthropicMessage(
            {
                id: "resp_9",
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output: [{ type: "message", content: [{ type: "output_text", text: "truncat" }] }],
            },
            { model: "grok-4.6" }
        );

        expect(message.stop_reason).toBe("max_tokens");
    });
});

import { describe, expect, it } from "bun:test";
import { createFoldedStreamState } from "@app/ai-proxy/lib/thinking-folded";
import {
    createToolCallIndexState,
    translateResponsesStreamEvent,
} from "@app/ai-proxy/lib/translators/responses-stream-translator";

describe("responses-stream-translator", () => {
    it("maps output_text delta to content", () => {
        const result = translateResponsesStreamEvent({
            event: { type: "response.output_text.delta", delta: "hello" },
        });

        expect(result?.delta?.content).toBe("hello");
    });

    it("maps Grok reasoning_text delta to content in raw mode (default)", () => {
        const result = translateResponsesStreamEvent({
            event: { type: "response.reasoning_text.delta", delta: "thinking" },
        });

        expect(result?.delta?.content).toBe("thinking");
        expect(result?.delta?.reasoning_content).toBeUndefined();
    });

    it("maps reasoning output_item.added to reasoning_items in cursor mode", () => {
        const result = translateResponsesStreamEvent({
            event: {
                type: "response.output_item.added",
                output_index: 0,
                item: {
                    id: "rs_1",
                    type: "reasoning",
                    summary: [],
                    status: "in_progress",
                },
            },
            thinkingMode: "cursor",
        });

        expect(result?.delta?.reasoning_items?.[0]?.id).toBe("rs_1");
        expect(result?.delta?.reasoning_content).toBeUndefined();
    });

    it("maps Grok reasoning_text delta to reasoning_content in cursor mode", () => {
        const result = translateResponsesStreamEvent({
            event: { type: "response.reasoning_text.delta", delta: "thinking" },
            thinkingMode: "cursor",
        });

        expect(result?.delta?.reasoning_content).toBe("thinking");
        expect(result?.delta?.content).toBeUndefined();
    });

    it("falls back to a string tool call id when upstream omits call_id", () => {
        const toolCallIndexState = createToolCallIndexState();
        const result = translateResponsesStreamEvent({
            event: {
                type: "response.output_item.added",
                output_index: 1,
                item: {
                    type: "function_call",
                    name: "read_file",
                },
            },
            toolCallIndexState,
        });

        expect(result?.delta?.tool_calls?.[0]?.id).toBe("call_0");
    });

    it("maps function_call added to contiguous tool_calls index", () => {
        const toolCallIndexState = createToolCallIndexState();
        const result = translateResponsesStreamEvent({
            event: {
                type: "response.output_item.added",
                output_index: 2,
                item: {
                    type: "function_call",
                    name: "read_file",
                    call_id: "call_abc",
                },
            },
            toolCallIndexState,
        });

        expect(result?.delta?.tool_calls?.[0]).toEqual({
            index: 0,
            id: "call_abc",
            type: "function",
            function: { name: "read_file", arguments: "" },
        });
    });

    it("prefers item.arguments on output_item.added", () => {
        const toolCallIndexState = createToolCallIndexState();
        const result = translateResponsesStreamEvent({
            event: {
                type: "response.output_item.added",
                output_index: 0,
                item: {
                    type: "function_call",
                    name: "read_file",
                    call_id: "call_item_args",
                    arguments: '{"path":"README.md"}',
                },
            },
            toolCallIndexState,
        });

        expect(result?.delta?.tool_calls?.[0]?.function?.arguments).toBe('{"path":"README.md"}');
    });

    it("maps function_call_arguments delta to tool argument chunks", () => {
        const toolCallIndexState = createToolCallIndexState();
        translateResponsesStreamEvent({
            event: {
                type: "response.output_item.added",
                output_index: 1,
                item: {
                    type: "function_call",
                    name: "grep",
                    call_id: "call_grep",
                },
            },
            toolCallIndexState,
        });

        const result = translateResponsesStreamEvent({
            event: {
                type: "response.function_call_arguments.delta",
                output_index: 1,
                delta: '{"path":',
            },
            toolCallIndexState,
        });

        expect(result?.delta?.tool_calls?.[0]).toEqual({
            index: 0,
            type: "function",
            function: { arguments: '{"path":' },
        });
    });

    it("maps response.completed to finish_reason tool_calls when output has function_call", () => {
        const result = translateResponsesStreamEvent({
            event: {
                type: "response.completed",
                response: {
                    output: [{ type: "function_call", name: "grep", call_id: "call_1" }],
                    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                },
            },
        });

        expect(result?.finishReason).toBe("tool_calls");
        expect(result?.usage).toEqual({
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
        });
    });

    it("maps response.completed reasoning_items for Cursor round-trip", () => {
        const result = translateResponsesStreamEvent({
            event: {
                type: "response.completed",
                response: {
                    output: [
                        {
                            id: "rs_1",
                            type: "reasoning",
                            content: [{ type: "reasoning_text", text: "Plan." }],
                        },
                        {
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: "hi" }],
                        },
                    ],
                    usage: {
                        input_tokens: 3,
                        output_tokens: 4,
                        output_tokens_details: { reasoning_tokens: 0 },
                        total_tokens: 7,
                    },
                },
            },
            thinkingMode: "cursor",
        });

        expect(result?.delta?.reasoning_items?.[0]?.id).toBe("rs_1");
        expect(result?.usage?.completion_tokens_details).toEqual({ reasoning_tokens: 0 });
    });

    it("wraps reasoning_text delta in details tags in folded mode", () => {
        const foldedState = createFoldedStreamState();
        const first = translateResponsesStreamEvent({
            event: { type: "response.reasoning_text.delta", delta: "Plan." },
            thinkingMode: "folded",
            foldedState,
        });
        const second = translateResponsesStreamEvent({
            event: { type: "response.reasoning_text.delta", delta: " More." },
            thinkingMode: "folded",
            foldedState,
        });
        const answer = translateResponsesStreamEvent({
            event: { type: "response.output_text.delta", delta: "Hi" },
            thinkingMode: "folded",
            foldedState,
        });

        expect(first?.delta?.content).toContain("<details>");
        expect(first?.delta?.content).toContain("Plan.");
        expect(second?.delta?.content).toBe(" More.");
        expect(answer?.delta?.content).toContain("</details>");
        expect(answer?.delta?.content).toContain("Hi");
    });

    it("omits reasoning_items on response.completed in raw mode", () => {
        const result = translateResponsesStreamEvent({
            event: {
                type: "response.completed",
                response: {
                    output: [
                        {
                            id: "rs_1",
                            type: "reasoning",
                            content: [{ type: "reasoning_text", text: "Plan." }],
                        },
                        {
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: "hi" }],
                        },
                    ],
                },
            },
        });

        expect(result?.delta?.reasoning_items).toBeUndefined();
    });

    it("maps response.completed to finish_reason stop for text-only output", () => {
        const result = translateResponsesStreamEvent({
            event: {
                type: "response.completed",
                response: {
                    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
                },
            },
        });

        expect(result?.finishReason).toBe("stop");
    });
});

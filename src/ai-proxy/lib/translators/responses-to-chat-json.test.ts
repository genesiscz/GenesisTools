import { describe, expect, it } from "bun:test";
import { transformResponsesToChatCompletion } from "@app/ai-proxy/lib/translators/responses-to-chat-json";

interface ChatCompletionFixture {
    object?: string;
    model?: string;
    usage?: Record<string, number>;
    choices?: Array<{
        finish_reason?: string;
        message?: {
            content?: string | null;
            reasoning_content?: string;
            reasoning_items?: Array<{ id?: string; type?: string }>;
            tool_calls?: Array<{
                id?: string;
                function?: { name?: string };
            }>;
        };
    }>;
}

describe("responses-to-chat-json", () => {
    it("merges reasoning into content in raw mode (default)", () => {
        const result = transformResponsesToChatCompletion({
            response: {
                id: "resp_123",
                created_at: 1700000000,
                model: "grok-composer-2.5-fast",
                output: [
                    {
                        type: "reasoning",
                        content: [{ type: "reasoning_text", text: "Plan the answer." }],
                    },
                    {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "hello" }],
                    },
                ],
                usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
            },
            proxyModel: "genesiscz/grok/grok-composer-2.5-fast",
        }) as ChatCompletionFixture;

        expect(result.object).toBe("chat.completion");
        expect(result.model).toBe("genesiscz/grok/grok-composer-2.5-fast");
        expect(result.choices?.[0]?.message?.content).toBe("Plan the answer.\n\nhello");
        expect(result.choices?.[0]?.message?.reasoning_content).toBeUndefined();
        expect(result.choices?.[0]?.message?.reasoning_items).toBeUndefined();
        expect(result.choices?.[0]?.finish_reason).toBe("stop");
        expect(result.usage).toEqual({
            prompt_tokens: 10,
            completion_tokens: 8,
            total_tokens: 18,
        });
    });

    it("wraps reasoning in details tags in folded mode", () => {
        const result = transformResponsesToChatCompletion({
            response: {
                id: "resp_folded",
                output: [
                    {
                        type: "reasoning",
                        content: [{ type: "reasoning_text", text: "Plan the answer." }],
                    },
                    {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "hello" }],
                    },
                ],
            },
            proxyModel: "genesiscz/grok/grok-composer-2.5-fast",
            thinkingMode: "folded",
        }) as ChatCompletionFixture;

        expect(result.choices?.[0]?.message?.content).toContain("<details>");
        expect(result.choices?.[0]?.message?.content).toContain("Plan the answer.");
        expect(result.choices?.[0]?.message?.content).toContain("</details>");
        expect(result.choices?.[0]?.message?.content).toContain("hello");
        expect(result.choices?.[0]?.message?.reasoning_content).toBeUndefined();
    });

    it("keeps reasoning separate in cursor mode", () => {
        const result = transformResponsesToChatCompletion({
            response: {
                id: "resp_123",
                output: [
                    {
                        type: "reasoning",
                        content: [{ type: "reasoning_text", text: "Plan the answer." }],
                    },
                    {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "hello" }],
                    },
                ],
            },
            proxyModel: "genesiscz/grok/grok-composer-2.5-fast",
            thinkingMode: "cursor",
        }) as ChatCompletionFixture;

        expect(result.choices?.[0]?.message?.content).toBe("hello");
        expect(result.choices?.[0]?.message?.reasoning_content).toBe("Plan the answer.");
        expect(result.choices?.[0]?.message?.reasoning_items?.[0]?.type).toBe("reasoning");
    });

    it("transforms function_call output to tool_calls finish_reason", () => {
        const result = transformResponsesToChatCompletion({
            response: {
                id: "resp_456",
                output: [
                    {
                        type: "function_call",
                        name: "Shell",
                        arguments: '{"command":"ls"}',
                        call_id: "call_shell",
                    },
                ],
            },
            proxyModel: "genesiscz/grok/grok-composer-2.5-fast",
        }) as ChatCompletionFixture;

        expect(result.choices?.[0]?.finish_reason).toBe("tool_calls");
        expect(result.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe("Shell");
        expect(result.choices?.[0]?.message?.tool_calls?.[0]?.id).toBe("call_shell");
    });
});

import { describe, expect, it } from "bun:test";
import { openAiChatToAnthropicMessages } from "./openai-to-anthropic-messages";

const MODEL = "claude-haiku-4-5-20251001";

describe("openAiChatToAnthropicMessages", () => {
    it("extracts system, maps roles, sets max_tokens", () => {
        const body = openAiChatToAnthropicMessages(
            {
                model: "martin/claude-sub/haiku",
                messages: [
                    { role: "system", content: "You are helpful." },
                    { role: "user", content: "Hi" },
                ],
                max_tokens: 256,
                temperature: 0.5,
            },
            { model: MODEL }
        );

        expect(body.model).toBe(MODEL);
        expect(body.max_tokens).toBe(256);
        expect(body.system).toBe("You are helpful.");
        expect(body.temperature).toBe(0.5);
        expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Hi" }] }]);
    });

    it("defaults max_tokens when the request omits it", () => {
        const body = openAiChatToAnthropicMessages(
            { messages: [{ role: "user", content: "yo" }] },
            { model: MODEL, maxTokensDefault: 1234 }
        );

        expect(body.max_tokens).toBe(1234);
    });

    it("maps assistant tool_calls to tool_use and tool results to a user tool_result turn", () => {
        const body = openAiChatToAnthropicMessages(
            {
                messages: [
                    { role: "user", content: "weather?" },
                    {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Prague"}' } },
                        ],
                    },
                    { role: "tool", tool_call_id: "call_1", content: "sunny" },
                ],
            },
            { model: MODEL }
        );

        expect(body.messages[1]).toEqual({
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Prague" } }],
        });
        expect(body.messages[2]).toEqual({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }],
        });
    });

    it("coalesces adjacent same-role turns (tool result + trailing user text)", () => {
        const body = openAiChatToAnthropicMessages(
            {
                messages: [
                    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
                    { role: "tool", tool_call_id: "c1", content: "r1" },
                    { role: "user", content: "and now this" },
                ],
            },
            { model: MODEL }
        );

        // the tool_result user turn and the plain user turn must merge into one
        const userTurns = body.messages.filter((m) => m.role === "user");
        expect(userTurns).toHaveLength(1);
        expect(userTurns[0]?.content).toEqual([
            { type: "tool_result", tool_use_id: "c1", content: "r1" },
            { type: "text", text: "and now this" },
        ]);
    });

    it("maps tools and tool_choice", () => {
        const body = openAiChatToAnthropicMessages(
            {
                messages: [{ role: "user", content: "go" }],
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "search",
                            description: "search the web",
                            parameters: { type: "object", properties: { q: { type: "string" } } },
                        },
                    },
                ],
                tool_choice: { type: "function", function: { name: "search" } },
            },
            { model: MODEL }
        );

        expect(body.tools).toEqual([
            { name: "search", description: "search the web", input_schema: { type: "object", properties: { q: { type: "string" } } } },
        ]);
        expect(body.tool_choice).toEqual({ type: "tool", name: "search" });
    });

    it("maps string and array stop to stop_sequences", () => {
        expect(
            openAiChatToAnthropicMessages({ messages: [{ role: "user", content: "x" }], stop: "END" }, { model: MODEL }).stop_sequences
        ).toEqual(["END"]);
        expect(
            openAiChatToAnthropicMessages({ messages: [{ role: "user", content: "x" }], stop: ["A", "B"] }, { model: MODEL }).stop_sequences
        ).toEqual(["A", "B"]);
    });

    it("maps multi-part text + image_url content", () => {
        const body = openAiChatToAnthropicMessages(
            {
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "what is this" },
                            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
                        ],
                    },
                ],
            },
            { model: MODEL }
        );

        expect(body.messages[0]?.content).toEqual([
            { type: "text", text: "what is this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ]);
    });
});

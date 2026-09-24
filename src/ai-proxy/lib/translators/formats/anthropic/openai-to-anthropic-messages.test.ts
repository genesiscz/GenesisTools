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

    it("maps reasoning_effort to an Anthropic thinking budget", () => {
        // A :xhigh model suffix stamps reasoning_effort on the body; the
        // allowlist dropped it, so the suffix was a no-op on claude-sub.
        const body = openAiChatToAnthropicMessages(
            { messages: [{ role: "user", content: "yo" }], max_tokens: 80000, reasoning_effort: "xhigh" },
            { model: MODEL }
        );

        expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
    });

    it("skips the thinking budget when the client pins a temperature", () => {
        // Extended thinking rejects temperature != 1; keeping the client's
        // sampling wins over silently overriding it.
        const body = openAiChatToAnthropicMessages(
            {
                messages: [{ role: "user", content: "yo" }],
                max_tokens: 64000,
                reasoning_effort: "high",
                temperature: 0.2,
            },
            { model: MODEL }
        );

        expect(body.thinking).toBeUndefined();
        expect(body.temperature).toBe(0.2);
    });

    it("keeps a pinned temperature and skips adaptive thinking on the 4.6 models that still take sampling", () => {
        for (const model of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
            const pinned = openAiChatToAnthropicMessages(
                { messages: [{ role: "user", content: "yo" }], reasoning_effort: "high", temperature: 0.2 },
                { model }
            );
            const free = openAiChatToAnthropicMessages(
                { messages: [{ role: "user", content: "yo" }], reasoning_effort: "high" },
                { model }
            );

            expect({
                thinking: pinned.thinking,
                effort: pinned.output_config,
                temperature: pinned.temperature,
            }).toEqual({
                thinking: undefined,
                effort: undefined,
                temperature: 0.2,
            });
            expect(free.thinking).toEqual({ type: "adaptive" });
        }
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
                            {
                                id: "call_1",
                                type: "function",
                                function: { name: "get_weather", arguments: '{"city":"Prague"}' },
                            },
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
                    {
                        role: "assistant",
                        content: null,
                        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
                    },
                    { role: "tool", tool_call_id: "c1", content: "r1" },
                    { role: "user", content: "and now this" },
                ],
            },
            { model: MODEL }
        );

        // the tool_result user turn and the plain user turn must merge into one
        // (the leading synthetic user turn from the first-user rule is separate)
        const toolResultTurns = body.messages.filter(
            (m) => m.role === "user" && m.content.some((block) => block.type === "tool_result")
        );
        expect(toolResultTurns).toHaveLength(1);
        expect(toolResultTurns[0]?.content).toEqual([
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
            {
                name: "search",
                description: "search the web",
                input_schema: { type: "object", properties: { q: { type: "string" } } },
            },
        ]);
        expect(body.tool_choice).toEqual({ type: "tool", name: "search" });
    });

    describe("Opus 5.5 request rules", () => {
        const OPUS_55 = "claude-opus-5-5";
        const searchTool = [{ type: "function", function: { name: "search", parameters: { type: "object" } } }];

        it("sends adaptive thinking with an effort level, never a budget", () => {
            const body = openAiChatToAnthropicMessages(
                { messages: [{ role: "user", content: "yo" }], max_tokens: 80000, reasoning_effort: "xhigh" },
                { model: OPUS_55 }
            );

            expect(body.thinking).toEqual({ type: "adaptive" });
            expect(body.output_config).toEqual({ effort: "xhigh" });
        });

        it("drops sampling params the model rejects and keeps the effort", () => {
            const body = openAiChatToAnthropicMessages(
                {
                    messages: [{ role: "user", content: "yo" }],
                    reasoning_effort: "minimal",
                    temperature: 0.2,
                    top_p: 0.9,
                },
                { model: OPUS_55 }
            );

            expect(body.temperature).toBeUndefined();
            expect(body.top_p).toBeUndefined();
            expect(body.output_config).toEqual({ effort: "low" });
        });

        it("turns a forced tool choice into auto", () => {
            for (const tool_choice of ["required", { type: "function", function: { name: "search" } }]) {
                const body = openAiChatToAnthropicMessages(
                    { messages: [{ role: "user", content: "go" }], tools: searchTool, tool_choice },
                    { model: OPUS_55 }
                );

                expect(body.tool_choice).toEqual({ type: "auto" });
            }
        });

        it("keeps a forced tool choice on Opus 5, which still accepts it", () => {
            const body = openAiChatToAnthropicMessages(
                { messages: [{ role: "user", content: "go" }], tools: searchTool, tool_choice: "required" },
                { model: "claude-opus-5" }
            );

            expect(body.tool_choice).toEqual({ type: "any" });
        });

        it("drops the forcing to auto once it turns thinking on, on the adaptive and the budget path", () => {
            for (const [model, maxTokens] of [
                ["claude-opus-4-6", undefined],
                ["claude-opus-5", undefined],
                ["claude-haiku-4-5-20251001", 64_000],
            ] as const) {
                const body = openAiChatToAnthropicMessages(
                    {
                        messages: [{ role: "user", content: "go" }],
                        tools: searchTool,
                        tool_choice: "required",
                        reasoning_effort: "high",
                        ...(maxTokens ? { max_tokens: maxTokens } : {}),
                    },
                    { model }
                );

                expect({ model, thinking: body.thinking !== undefined, toolChoice: body.tool_choice }).toEqual({
                    model,
                    thinking: true,
                    toolChoice: { type: "auto" },
                });
            }
        });

        it("closes a trailing assistant turn with a user turn, since prefill is a 400", () => {
            const history = {
                messages: [
                    { role: "user", content: "write json" },
                    { role: "assistant", content: "{" },
                ],
            };

            expect(openAiChatToAnthropicMessages(history, { model: OPUS_55 }).messages).toEqual([
                { role: "user", content: [{ type: "text", text: "write json" }] },
                { role: "assistant", content: [{ type: "text", text: "{" }] },
                { role: "user", content: [{ type: "text", text: "(continue)" }] },
            ]);
            // Haiku 4.5 still accepts a prefill, so its history is left alone.
            expect(openAiChatToAnthropicMessages(history, { model: MODEL }).messages.at(-1)?.role).toBe("assistant");
        });

        it("clamps xhigh to high on Opus 4.6, which predates it", () => {
            const body = openAiChatToAnthropicMessages(
                { messages: [{ role: "user", content: "yo" }], reasoning_effort: "xhigh" },
                { model: "claude-opus-4-6" }
            );

            expect(body.output_config).toEqual({ effort: "high" });
        });
    });

    it("maps tool_choice 'none' to Anthropic's native none while keeping tools", () => {
        const body = openAiChatToAnthropicMessages(
            {
                messages: [{ role: "user", content: "go" }],
                tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
                tool_choice: "none",
            },
            { model: MODEL }
        );

        expect(body.tools).toHaveLength(1);
        expect(body.tool_choice).toEqual({ type: "none" });
    });

    it("prepends a user turn when the first message is an assistant turn", () => {
        const body = openAiChatToAnthropicMessages(
            {
                messages: [
                    { role: "assistant", content: "earlier reply" },
                    { role: "user", content: "follow-up" },
                ],
            },
            { model: MODEL }
        );

        expect(body.messages[0]?.role).toBe("user");
        expect(body.messages[1]?.role).toBe("assistant");
    });

    it("maps string and array stop to stop_sequences", () => {
        expect(
            openAiChatToAnthropicMessages({ messages: [{ role: "user", content: "x" }], stop: "END" }, { model: MODEL })
                .stop_sequences
        ).toEqual(["END"]);
        expect(
            openAiChatToAnthropicMessages(
                { messages: [{ role: "user", content: "x" }], stop: ["A", "B"] },
                { model: MODEL }
            ).stop_sequences
        ).toEqual(["A", "B"]);
    });

    it("falls back to _raw for tool_call arguments that only lenient JSON would accept (trailing comma)", () => {
        const body = openAiChatToAnthropicMessages(
            {
                messages: [
                    { role: "user", content: "weather?" },
                    {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: "call_1",
                                type: "function",
                                function: { name: "get_weather", arguments: '{"city":"Prague",}' },
                            },
                        ],
                    },
                ],
            },
            { model: MODEL }
        );

        expect(body.messages[1]).toEqual({
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { _raw: '{"city":"Prague",}' } }],
        });
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

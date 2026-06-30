import { describe, expect, it } from "bun:test";
import { convertMessagesToInput, ensureResponsesInput } from "@app/ai-proxy/lib/chat-to-responses-body";
import { prepareGrokUpstreamBody } from "@app/ai-proxy/lib/rewrite-upstream-body";
import { SafeJSON } from "@app/utils/json";

describe("chat-to-responses-body", () => {
    it("converts simple user messages to responses input", () => {
        const input = convertMessagesToInput([{ role: "user", content: "hi" }]);
        expect(input).toEqual([
            {
                role: "user",
                content: [{ type: "input_text", text: "hi" }],
            },
        ]);
    });

    it("ensures responses bodies have input instead of messages", () => {
        const body = ensureResponsesInput({
            model: "grok-composer-2.5-fast",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
        });

        expect(Array.isArray(body.input)).toBe(true);
        expect(body.messages).toBeUndefined();
    });

    it("round-trips assistant reasoning_items into responses input", () => {
        const input = convertMessagesToInput([
            {
                role: "assistant",
                content: "Done.",
                reasoning_items: [
                    {
                        id: "rs_1",
                        type: "reasoning",
                        summary: [{ type: "summary_text", text: "Worked it out." }],
                        content: [{ type: "reasoning_text", text: "Worked it out." }],
                    },
                ],
            },
        ]);

        expect(input[0]).toEqual({
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "Worked it out." }],
            content: [{ type: "reasoning_text", text: "Worked it out." }],
        });
    });

    it("prepareGrokUpstreamBody converts messages for responses target", () => {
        const rewritten = prepareGrokUpstreamBody(
            SafeJSON.stringify({
                model: "genesiscz/grok/grok-composer-2.5-fast",
                messages: [{ role: "user", content: "hi" }],
                stream: true,
                max_tokens: 10,
            }),
            "grok-composer-2.5-fast",
            "responses"
        );

        const parsed = SafeJSON.parse(rewritten.bodyText) as { input?: unknown[]; messages?: unknown; model: string };
        expect(parsed.model).toBe("grok-composer-2.5-fast");
        expect(parsed.input?.length).toBe(1);
        expect(parsed.messages).toBeUndefined();
    });
});

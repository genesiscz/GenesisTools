import { describe, expect, it } from "bun:test";
import {
    buildReasoningItem,
    reasoningContentFromItem,
    reasoningItemsFromMessage,
    reasoningItemToInput,
    transformResponsesUsage,
} from "@app/ai-proxy/lib/translators/reasoning";

describe("reasoning helpers", () => {
    it("builds reasoning item from Grok content[].reasoning_text", () => {
        const item = buildReasoningItem({
            id: "rs_abc",
            type: "reasoning",
            summary: [],
            content: [{ type: "reasoning_text", text: "Plan the answer." }],
        });

        expect(item.summary).toEqual([{ type: "summary_text", text: "Plan the answer." }]);
        expect(reasoningContentFromItem(item)).toBe("Plan the answer.");
    });

    it("round-trips reasoning_items back to responses input", () => {
        const built = buildReasoningItem({
            id: "rs_abc",
            type: "reasoning",
            content: [{ type: "reasoning_text", text: "Think." }],
        });

        const input = reasoningItemToInput(built);
        expect(input.type).toBe("reasoning");
        expect(input.id).toBe("rs_abc");
        expect(input.content).toEqual([{ type: "reasoning_text", text: "Think." }]);
    });

    it("synthesizes reasoning_items from assistant reasoning_content", () => {
        const items = reasoningItemsFromMessage({
            role: "assistant",
            content: "Done.",
            reasoning_content: "Worked it out.",
        });

        expect(items).toHaveLength(1);
        expect(items[0]?.summary[0]?.text).toBe("Worked it out.");
    });

    it("maps Grok usage details including reasoning_tokens", () => {
        expect(
            transformResponsesUsage({
                input_tokens: 15,
                input_tokens_details: { cached_tokens: 14 },
                output_tokens: 101,
                output_tokens_details: { reasoning_tokens: 0 },
                total_tokens: 116,
                cost_in_usd_ticks: 1_834_000,
            })
        ).toEqual({
            prompt_tokens: 15,
            completion_tokens: 101,
            total_tokens: 116,
            prompt_tokens_details: { cached_tokens: 14 },
            completion_tokens_details: { reasoning_tokens: 0 },
            cost_in_usd_ticks: 1_834_000,
        });
    });
});

import { describe, expect, it } from "bun:test";
import {
    estimateUsageFromExchange,
    extractLatestUsageFromSse,
    extractUsageFromJsonBody,
} from "@app/ai-proxy/lib/usage/extract";

describe("extractLatestUsageFromSse", () => {
    it("reads top-level usage from chat completion chunks", () => {
        const sse =
            'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n' +
            'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n' +
            "data: [DONE]\n\n";

        expect(extractLatestUsageFromSse(sse)).toEqual({
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7,
        });
    });

    it("reads nested response.usage from Responses response.completed events (WHAM shape)", () => {
        const sse =
            'data: {"type":"response.output_text.delta","delta":"CODEX_OK"}\n\n' +
            'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}}\n\n';

        expect(extractLatestUsageFromSse(sse)).toEqual({
            prompt_tokens: 10,
            completion_tokens: 3,
            total_tokens: 13,
        });
    });

    it("returns undefined when no event carries usage", () => {
        const sse = 'data: {"type":"response.output_text.delta","delta":"x"}\n\n';
        expect(extractLatestUsageFromSse(sse)).toBeUndefined();
    });

    it("merges Anthropic's split usage — message_start holds the input count, message_delta the output", () => {
        // The native /v1/messages passthrough hands this shape straight to the
        // ledger. Reading only the last usage frame booked prompt_tokens as
        // absent, so every streamed Claude Code call was billed output-only.
        const sse =
            'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1200,"cache_read_input_tokens":800,"output_tokens":1}}}\n\n' +
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":57}}\n\n';

        expect(extractLatestUsageFromSse(sse)).toEqual({
            prompt_tokens: 1200,
            completion_tokens: 57,
            total_tokens: 1257,
            // Reported OUTSIDE input_tokens by Anthropic; recorded so the
            // ledger sees the real prompt volume, kept separate because cache
            // reads price differently.
            cache_read_input_tokens: 800,
        });
    });

    it("folds reasoning_tokens into completion_tokens when the totals exclude them", () => {
        // Grok's CLI proxy keeps reasoning out of completion_tokens;
        // booking completion alone hid 63,694 output tokens from the ledger.
        const sse =
            'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":195,"completion_tokens":2,"total_tokens":324,"completion_tokens_details":{"reasoning_tokens":127},"cost_in_usd_ticks":4318500}}\n\n';

        expect(extractLatestUsageFromSse(sse)).toEqual({
            prompt_tokens: 195,
            completion_tokens: 129,
            total_tokens: 324,
            cost_in_usd_ticks: 4318500,
        });
    });

    it("does not fold when completion_tokens already includes reasoning (OpenAI shape)", () => {
        // OpenAI and OpenRouter count reasoning INSIDE completion_tokens:
        // prompt+completion equals total, the details are only a breakdown.
        // Folding here would double-book every reasoning turn.
        const sse =
            'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":195,"completion_tokens":129,"total_tokens":324,"completion_tokens_details":{"reasoning_tokens":127}}}\n\n';

        expect(extractLatestUsageFromSse(sse)).toEqual({
            prompt_tokens: 195,
            completion_tokens: 129,
            total_tokens: 324,
        });
    });
});

describe("extractUsageFromJsonBody", () => {
    it("normalizes Responses-style input/output token names", () => {
        const body = '{"usage":{"input_tokens":4,"output_tokens":6}}';

        expect(extractUsageFromJsonBody(body)).toEqual({
            prompt_tokens: 4,
            completion_tokens: 6,
            total_tokens: 10,
        });
    });
});

describe("estimateUsageFromExchange", () => {
    it("estimates from message text and chat SSE deltas, tagged estimated", () => {
        const bodyText = '{"messages":[{"role":"user","content":"tell me a story about a dragon"}],"stream":true}';
        const responseBody =
            'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"Once upon a time"}}]}\n\n' +
            'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":" there was a dragon."}}]}\n\n' +
            "data: [DONE]\n\n";

        const usage = estimateUsageFromExchange({ bodyText, responseBody, stream: true });

        expect(usage.source).toBe("estimated");
        // "tell me a story about a dragon" = 31 chars → ceil(31/4) = 8
        expect(usage.prompt_tokens).toBe(8);
        // "Once upon a time there was a dragon." = 36 chars → 9
        expect(usage.completion_tokens).toBe(9);
        expect(usage.total_tokens).toBe(17);
    });

    it("estimates from non-stream chat completion message content", () => {
        const bodyText = '{"messages":[{"role":"user","content":"hi"}]}';
        const responseBody =
            '{"object":"chat.completion","choices":[{"message":{"role":"assistant","content":"hello there"}}]}';

        const usage = estimateUsageFromExchange({ bodyText, responseBody, stream: false });

        expect(usage.source).toBe("estimated");
        expect(usage.prompt_tokens).toBe(1);
        expect(usage.completion_tokens).toBe(3);
    });
});

describe("upstream-reported cost", () => {
    it("reads the charge OpenRouter reports alongside the tokens", () => {
        const usage = extractUsageFromJsonBody(
            '{"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14,"cost":0.000123,' +
                '"cost_details":{"upstream_inference_cost":0.0001}}}'
        );

        expect(usage?.cost_usd).toBe(0.000123);
        expect(usage?.upstream_cost_usd).toBe(0.0001);
        expect(usage?.prompt_tokens).toBe(10);
    });

    /** An exchange carrying only a cost is still a usage record. */
    it("keeps a cost-only usage block instead of bailing", () => {
        expect(extractUsageFromJsonBody('{"usage":{"cost":0.5}}')?.cost_usd).toBe(0.5);
    });

    /** A NaN added to a running total turns a whole month's invoice into NaN. */
    it("rejects a non-numeric cost rather than poisoning the total", () => {
        expect(extractUsageFromJsonBody('{"usage":{"prompt_tokens":1,"cost":"free"}}')?.cost_usd).toBeUndefined();
        expect(extractUsageFromJsonBody('{"usage":{"prompt_tokens":1,"cost":null}}')?.cost_usd).toBeUndefined();
        expect(
            extractUsageFromJsonBody('{"usage":{"prompt_tokens":1,"cost_details":{"upstream_inference_cost":"x"}}}')
                ?.upstream_cost_usd
        ).toBeUndefined();
    });

    it("an explicit zero cost is a booked zero, not an absent one", () => {
        expect(extractUsageFromJsonBody('{"usage":{"prompt_tokens":1,"cost":0}}')?.cost_usd).toBe(0);
    });

    /** SSE routes every payload through the same normalizer, so it comes along free. */
    it("survives the SSE path", () => {
        const sse =
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
            'data: {"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4,"cost":0.00009}}\n\n' +
            "data: [DONE]\n\n";

        expect(extractLatestUsageFromSse(sse)?.cost_usd).toBe(0.00009);
    });
});

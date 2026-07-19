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

import { describe, expect, it } from "bun:test";
import { enrichGrokChatResponse } from "@app/ai-proxy/lib/grok-chat-sse-enricher";

describe("grok-chat-sse-enricher", () => {
    it("cursor mode rewrites model to proxy id and adds reasoning_items on first thinking delta", async () => {
        const sse = [
            'data: {"model":"grok-build-0.1","choices":[{"index":0,"delta":{"reasoning_content":"Hmm","role":"assistant"}}]}',
            'data: {"model":"grok-build-0.1","choices":[{"index":0,"delta":{"content":"Answer"}}]}',
            "",
            "data: [DONE]\r",
            "",
        ].join("\n");

        const response = await enrichGrokChatResponse(
            new Response(sse, {
                headers: { "Content-Type": "text/event-stream" },
            }),
            "martin/grok/grok-build-0.1",
            "cursor"
        );

        const body = await response.text();

        expect(body).toContain('"model":"martin/grok/grok-build-0.1"');
        expect(body).toContain('"reasoning_content":"Hmm"');
        expect(body).toContain('"reasoning_items"');
        expect(body).toContain('"type":"reasoning"');
        expect(body).toContain('"content":"Answer"');
        expect(body).not.toContain("<details>");
    });

    it("folded mode moves reasoning into content only", async () => {
        const sse = [
            'data: {"model":"grok-composer-2.5-fast","choices":[{"delta":{"reasoning_content":"Hmm","role":"assistant"}}]}',
            "",
            "data: [DONE]",
            "",
        ].join("\n");

        const response = await enrichGrokChatResponse(
            new Response(sse, {
                headers: { "Content-Type": "text/event-stream" },
            }),
            "martin/grok/grok-composer-2.5-fast",
            "folded"
        );

        const body = await response.text();

        expect(body).toContain("<details>");
        expect(body).not.toContain("reasoning_content");
    });
});

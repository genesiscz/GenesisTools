import { describe, expect, it } from "bun:test";
import { enrichGrokChatResponse } from "@app/ai-proxy/lib/grok-chat-sse-enricher";
import { SafeJSON } from "@genesiscz/utils/json";

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

    /**
     * OpenRouter streams thinking as `reasoning`. Without the rename the cursor
     * enrichment below never fires and the client shows no thinking at all —
     * which is exactly what a live kimi-k3 transcript showed.
     */
    it("renames OpenRouter's `reasoning` delta to reasoning_content and still enriches it", async () => {
        const sse = [
            'data: {"model":"moonshotai/kimi-k3","choices":[{"index":0,"delta":{"reasoning":"Thinking","role":"assistant"}}]}',
            'data: {"model":"moonshotai/kimi-k3","choices":[{"index":0,"delta":{"content":"Answer"}}]}',
            "",
            "data: [DONE]",
            "",
        ].join("\n");

        const response = await enrichGrokChatResponse(
            new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
            "openrouter/openrouter/moonshotai/kimi-k3",
            "cursor"
        );

        const body = await response.text();

        expect(body).toContain('"reasoning_content":"Thinking"');
        expect(body).toContain('"reasoning_items"');
        // The upstream spelling must be gone, or a client that reads both
        // renders the thinking twice.
        expect(body).not.toContain('"reasoning":"Thinking"');
        expect(body).toContain('"content":"Answer"');
    });

    it("renames `reasoning` on a non-streaming message too", async () => {
        const json = SafeJSON.stringify({
            model: "moonshotai/kimi-k3",
            choices: [{ index: 0, message: { role: "assistant", reasoning: "Thinking", content: "Answer" } }],
        });

        const response = await enrichGrokChatResponse(
            new Response(json, { headers: { "Content-Type": "application/json" } }),
            "openrouter/openrouter/moonshotai/kimi-k3",
            "cursor"
        );

        const body = await response.text();

        expect(body).toContain('"reasoning_content":"Thinking"');
        expect(body).not.toContain('"reasoning":"Thinking"');
    });

    /** A client that already sent the Cursor-native spelling must win. */
    it("leaves an existing reasoning_content untouched", async () => {
        const sse = [
            'data: {"model":"m","choices":[{"delta":{"reasoning":"raw","reasoning_content":"native","role":"assistant"}}]}',
            "",
            "data: [DONE]",
            "",
        ].join("\n");

        const response = await enrichGrokChatResponse(
            new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
            "acct/openrouter/m",
            "cursor"
        );

        const body = await response.text();

        expect(body).toContain('"reasoning_content":"native"');
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

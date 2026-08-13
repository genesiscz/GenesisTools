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

    /**
     * 🛑 The exact live failure: OpenRouter puts `content: ""` on every thinking
     * delta, which used to close <details> per token and overwrite the thinking
     * with the close tag — the client got a wall of bare `</details>` and lost
     * both the reasoning and the answer.
     */
    it("folded mode survives empty-string content alongside reasoning", async () => {
        const sse = [
            'data: {"model":"m","choices":[{"delta":{"role":"assistant","content":"","reasoning":"Think A"}}]}',
            'data: {"model":"m","choices":[{"delta":{"content":"","reasoning":"Think B"}}]}',
            'data: {"model":"m","choices":[{"delta":{"content":"Answer"}}]}',
            "",
            "data: [DONE]",
            "",
        ].join("\n");

        const response = await enrichGrokChatResponse(
            new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
            "acct/openrouter/m",
            "folded"
        );

        const body = await response.text();
        const rendered = body
            .split("\n")
            .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
            .map((l) => SafeJSON.parse(l.slice(6)) as { choices?: { delta?: { content?: string } }[] })
            .map((p) => p.choices?.[0]?.delta?.content ?? "")
            .join("");

        expect(rendered).toContain("Think A");
        expect(rendered).toContain("Think B");
        expect(rendered).toContain("Answer");
        // Exactly one open and one close, not one per thinking token.
        expect(rendered.match(/<details>/g)).toHaveLength(1);
        expect(rendered.match(/<\/details>/g)).toHaveLength(1);
        // The thinking must sit inside the block, the answer after it.
        expect(rendered.indexOf("Think A")).toBeLessThan(rendered.indexOf("</details>"));
        expect(rendered.indexOf("Answer")).toBeGreaterThan(rendered.indexOf("</details>"));
    });

    /** Stopping mid-thought must not leave the client rendering an open block. */
    it("folded mode closes the details block when generation ends during thinking", async () => {
        const sse = [
            'data: {"model":"m","choices":[{"delta":{"role":"assistant","content":"","reasoning":"Cut off"}}]}',
            "",
            "data: [DONE]",
            "",
        ].join("\n");

        const response = await enrichGrokChatResponse(
            new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
            "acct/openrouter/m",
            "folded"
        );

        const body = await response.text();

        expect(body).toContain("Cut off");
        expect(body).toContain("</details>");
        // The closing chunk must precede the terminator or clients drop it.
        expect(body.indexOf("</details>")).toBeLessThan(body.indexOf("[DONE]"));
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

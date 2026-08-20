import { describe, expect, it } from "bun:test";
import { GrokSubscriptionProvider } from "@app/ai-proxy/lib/providers/grok-subscription";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { GrokSubscriptionClient } from "@genesiscz/utils/ai/grok";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

function makeProvider(): GrokSubscriptionProvider {
    const account: AiProxyAccountConfig = {
        name: "test-grok",
        provider: "grok-subscription",
        providerSlug: "grok",
        enabled: true,
    };
    // The base URL is unreachable on purpose: the paths under test must answer
    // before any dispatch, so a request that slips past them fails loudly here.
    const client = new GrokSubscriptionClient({
        token: "dummy",
        authPath: "/tmp/none",
        baseUrl: "http://127.0.0.1:1",
    });

    return new GrokSubscriptionProvider(account, client);
}

function webSearchBody(): string {
    return SafeJSON.stringify({
        model: "grok-4.6",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    });
}

describe("GrokSubscriptionProvider.messages server-tool handling", () => {
    it("rejects non-web-search server tools with a self-explaining 400 before dispatch", async () => {
        const provider = makeProvider();
        const body = SafeJSON.stringify({
            model: "grok-4.6",
            max_tokens: 100,
            messages: [{ role: "user", content: "hi" }],
            tools: [{ type: "code_execution_20250522", name: "code_execution" }],
        });
        const res = await provider.messages(
            new Request("http://proxy/v1/messages", { method: "POST", body }),
            "grok-4.6",
            body
        );

        expect(res.status).toBe(400);

        const parsed = SafeJSON.parse(await res.text(), { strict: true }) as {
            type: string;
            error: { type: string; message: string };
        };
        expect(parsed.type).toBe("error");
        expect(parsed.error.type).toBe("invalid_request_error");
        expect(parsed.error.message).toContain("code_execution_20250522");
    });

    it("rejects a mixed request even when web_search comes first (reversed-order regression)", async () => {
        const provider = makeProvider();
        const body = SafeJSON.stringify({
            model: "grok-4.6",
            max_tokens: 100,
            messages: [{ role: "user", content: "hi" }],
            tools: [
                { type: "web_search_20250305", name: "web_search" },
                { type: "code_execution_20250522", name: "code_execution" },
            ],
        });
        const res = await provider.messages(
            new Request("http://proxy/v1/messages", { method: "POST", body }),
            "grok-4.6",
            body
        );

        expect(res.status).toBe(400);
        expect(await res.text()).toContain("code_execution_20250522");
    });

    it("routes web_search to the emulation path even without a Brave key: 200 SSE, failure as in-stream error", async () => {
        await env.testing.withOverrides({ BRAVE_API_KEY: undefined }, async () => {
            const provider = makeProvider();
            const body = webSearchBody();
            const res = await provider.messages(
                new Request("http://proxy/v1/messages", { method: "POST", body }),
                "grok-4.6",
                body
            );

            // The native /responses path answers 200 and streams; the
            // unreachable upstream surfaces as an in-stream error event.
            expect(res.status).toBe(200);
            expect(res.headers.get("content-type")).toContain("text/event-stream");

            const text = await res.text();
            expect(text).toContain("event: error");
        });
    });
});

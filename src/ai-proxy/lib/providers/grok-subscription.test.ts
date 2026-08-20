import { describe, expect, it } from "bun:test";
import { GrokSubscriptionProvider } from "@app/ai-proxy/lib/providers/grok-subscription";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { GrokSubscriptionClient } from "@genesiscz/utils/ai/grok";
import { SafeJSON } from "@genesiscz/utils/json";

function makeProvider(): GrokSubscriptionProvider {
    const account: AiProxyAccountConfig = {
        name: "test-grok",
        provider: "grok-subscription",
        providerSlug: "grok",
        enabled: true,
    };
    // The base URL is unreachable on purpose: the guard under test must answer
    // before any dispatch, so a request that slips past it fails loudly here.
    const client = new GrokSubscriptionClient({
        token: "dummy",
        authPath: "/tmp/none",
        baseUrl: "http://127.0.0.1:1",
    });

    return new GrokSubscriptionProvider(account, client);
}

describe("GrokSubscriptionProvider.messages server-tool guard", () => {
    it("rejects an Anthropic server tool with a self-explaining 400 before dispatch", async () => {
        const provider = makeProvider();
        const body = SafeJSON.stringify({
            model: "grok-4.6",
            max_tokens: 100,
            messages: [{ role: "user", content: "hi" }],
            tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
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
        expect(parsed.error.message).toContain("web_search_20250305");
    });
});

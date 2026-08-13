import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OpenRouterApiKeyProvider } from "@app/ai-proxy/lib/providers/openrouter-api-key";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import type { AiProxyAccountConfig, AiProxyOpenRouterAccountConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * `fetchDirect` is a one-line wrapper over the global `fetch`, so swapping the
 * global captures exactly the request the upstream would have received.
 */

interface Captured {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
}

const captured: Captured[] = [];
const realFetch = globalThis.fetch;

function account(openrouter?: AiProxyOpenRouterAccountConfig): AiProxyAccountConfig {
    return {
        name: "router",
        provider: "openrouter",
        providerSlug: "openrouter",
        enabled: true,
        apiKey: "sk-or-config",
        ...(openrouter ? { openrouter } : {}),
    };
}

async function relay(
    config: AiProxyAccountConfig,
    body: Record<string, unknown>,
    upstreamModel = "anthropic/claude-sonnet-5"
): Promise<Captured> {
    const provider = await OpenRouterApiKeyProvider.create(config);
    const request = new Request("http://localhost/v1/chat/completions", { method: "POST" });

    await provider.chatCompletions(request, upstreamModel, SafeJSON.stringify(body) ?? "{}");

    return captured[captured.length - 1];
}

beforeEach(() => {
    captured.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({
            url: String(input),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: SafeJSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });

        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("the openrouter relay body", () => {
    /**
     * The body is the CLIENT's and sets neither field, so without this injection
     * the ledger has no upstream cost to book and the precise-cost story degrades
     * to an estimate — silently, because an absent field looks like no charge.
     */
    test("injects usage accounting the client did not ask for", async () => {
        const request = await relay(account(), { model: "whatever", messages: [] });

        expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(request.body.usage).toEqual({ include: true });
        expect(request.body.model).toBe("anthropic/claude-sonnet-5");
        expect(request.body.stream_options).toBeUndefined();
    });

    test("adds stream_options only for a streaming request", async () => {
        const streamed = await relay(account(), { model: "whatever", messages: [], stream: true });

        expect(streamed.body.stream_options).toEqual({ include_usage: true });
    });

    test("account provider routing fills in when the client sets none", async () => {
        const request = await relay(
            account({ provider: { order: ["Morph", "DeepInfra"], allow_fallbacks: false }, fallbackModels: ["a/b"] }),
            { model: "whatever", messages: [] }
        );

        expect(request.body.provider).toEqual({ order: ["Morph", "DeepInfra"], allow_fallbacks: false });
        expect(request.body.models).toEqual(["a/b"]);
    });

    test("a matching route overrides the account-level provider default", async () => {
        const request = await relay(
            account({
                provider: { sort: "price" },
                routes: [{ match: "moonshotai/kimi-k3", provider: { order: ["Morph"], allow_fallbacks: false } }],
            }),
            { model: "whatever", messages: [] },
            "moonshotai/kimi-k3"
        );

        expect(request.body.provider).toEqual({ order: ["Morph"], allow_fallbacks: false });
    });

    test("a trailing-* route glob matches the whole vendor prefix", async () => {
        const request = await relay(
            account({ routes: [{ match: "moonshotai/*", provider: { order: ["Morph"], allow_fallbacks: false } }] }),
            { model: "whatever", messages: [] },
            "moonshotai/kimi-k2"
        );

        expect(request.body.provider).toEqual({ order: ["Morph"], allow_fallbacks: false });
    });

    test("the first matching route wins over later ones", async () => {
        const request = await relay(
            account({
                routes: [
                    { match: "moonshotai/kimi-k3", provider: { sort: "throughput" } },
                    { match: "moonshotai/*", provider: { order: ["Morph"] } },
                ],
            }),
            { model: "whatever", messages: [] },
            "moonshotai/kimi-k3"
        );

        expect(request.body.provider).toEqual({ sort: "throughput" });
    });

    test("a model that matches no route falls back to the account-level default", async () => {
        const request = await relay(
            account({
                provider: { sort: "price" },
                routes: [{ match: "moonshotai/*", provider: { order: ["Morph"], allow_fallbacks: false } }],
            }),
            { model: "whatever", messages: [] },
            "qwen/qwen3.7-flash"
        );

        expect(request.body.provider).toEqual({ sort: "price" });
    });

    test("a route naming only fallbackModels still inherits the account's provider default", async () => {
        const request = await relay(
            account({
                provider: { order: ["Morph"], allow_fallbacks: false },
                routes: [{ match: "deepseek/*", fallbackModels: ["deepseek/deepseek-v4-flash"] }],
            }),
            { model: "whatever", messages: [] },
            "deepseek/deepseek-v4-flash-0731"
        );

        expect(request.body.provider).toEqual({ order: ["Morph"], allow_fallbacks: false });
        expect(request.body.models).toEqual(["deepseek/deepseek-v4-flash"]);
    });

    test("a client-supplied provider block wins over a matching route too", async () => {
        const clientProvider = { order: ["Together"] };
        const request = await relay(
            account({ routes: [{ match: "moonshotai/*", provider: { order: ["Morph"], allow_fallbacks: false } }] }),
            { model: "whatever", messages: [], provider: clientProvider },
            "moonshotai/kimi-k3"
        );

        expect(request.body.provider).toEqual(clientProvider);
    });

    /**
     * 🛑 The client wins. Merging would silently defeat a caller who pinned a
     * route on purpose, and there is no way for them to detect it happened.
     */
    test("a client-supplied provider block passes through verbatim", async () => {
        const clientProvider = { order: ["Together"], allow_fallbacks: true, sort: "price" };
        const request = await relay(
            account({ provider: { order: ["Morph"], allow_fallbacks: false }, fallbackModels: ["a/b"] }),
            { model: "whatever", messages: [], provider: clientProvider, models: ["c/d"] }
        );

        expect(request.body.provider).toEqual(clientProvider);
        expect(request.body.models).toEqual(["c/d"]);
    });

    test("a client-set usage key is not overwritten", async () => {
        const request = await relay(account(), { model: "whatever", messages: [], usage: { include: false } });

        expect(request.body.usage).toEqual({ include: false });
    });

    test("attribution headers identify this proxy", async () => {
        const request = await relay(account({ appName: "MyGateway", appUrl: "https://example.dev" }), {
            model: "whatever",
            messages: [],
        });

        expect(request.headers["x-title"]).toBe("MyGateway");
        expect(request.headers["http-referer"]).toBe("https://example.dev");
        expect(request.headers.authorization).toBe("Bearer sk-or-config");
    });

    test("account.baseUrl redirects the relay", async () => {
        const request = await relay(
            { ...account(), baseUrl: "https://gateway.example/api/v1/" },
            {
                model: "whatever",
                messages: [],
            }
        );

        expect(request.url).toBe("https://gateway.example/api/v1/chat/completions");
    });
});

describe("the openrouter provider surface", () => {
    /** Relaying would 404 upstream, which reads as "the proxy is broken". */
    test("responses() is an explicit 501 naming the endpoint that works", async () => {
        const provider = await OpenRouterApiKeyProvider.create(account());
        const response = await provider.responses();
        const body = SafeJSON.parse(await response.text()) as { error?: { message?: string; code?: string } };

        expect(response.status).toBe(501);
        expect(body.error?.code).toBe("responses_not_supported");
        expect(body.error?.message).toContain("/v1/chat/completions");
    });

    test("has no realtime methods", async () => {
        // Read through the interface: the optional members are absent from the
        // class on purpose, which is exactly what this asserts.
        const provider: ProxyProvider = await OpenRouterApiKeyProvider.create(account());

        expect(provider.realtimeConnect).toBeUndefined();
        expect(provider.realtimeClientSecrets).toBeUndefined();
        expect(provider.audioTranscriptions).toBeUndefined();
    });

    test("getUsage reads the key-scoped endpoint", async () => {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            captured.push({ url: String(input), headers: {}, body: {} });

            return new Response(SafeJSON.stringify({ data: { usage: 1.2345, limit: 10, limit_remaining: 8.7655 } }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as unknown as typeof fetch;

        const provider = await OpenRouterApiKeyProvider.create(account());
        const usage = await provider.getUsage();

        expect(captured[0].url).toBe("https://openrouter.ai/api/v1/key");
        expect(usage.provider).toBe("openrouter");
        expect(usage.summary).toContain("$1.2345 spent");
        expect(usage.summary).toContain("limit $10.00");
    });

    /** A failed usage lookup must report, never throw into the CLI. */
    test("getUsage survives a failing endpoint", async () => {
        globalThis.fetch = (async () => {
            throw new Error("offline");
        }) as unknown as typeof fetch;

        const provider = await OpenRouterApiKeyProvider.create(account());
        const usage = await provider.getUsage();

        expect(usage.summary).toContain("usage lookup failed");
    });

    /** The catalog is built once, in model-meta, from the public feed. */
    test("listModels defers to the shared catalog", async () => {
        const provider = await OpenRouterApiKeyProvider.create(account());

        expect(await provider.listModels()).toEqual([]);
    });

    test("a missing key names the variable that was checked", async () => {
        // The developer running this suite has a real OPENROUTER_API_KEY
        // exported; the ambient fallback would resolve it and trip the
        // env-source guard instead of the missing-key error under test.
        const envSnapshot = env.testing.snapshot();
        env.testing.unset("MY_OR_KEY");
        env.testing.unset("OPENROUTER_API_KEY");

        try {
            await expect(
                OpenRouterApiKeyProvider.create({ ...account(), apiKey: undefined, apiKeyEnv: "MY_OR_KEY" })
            ).rejects.toThrow("MY_OR_KEY / OPENROUTER_API_KEY");
        } finally {
            env.testing.restore(envSnapshot);
        }
    });
});

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { SUBSCRIPTION_BETAS } from "@genesiscz/utils/claude/subscription-billing";
import { SafeJSON } from "@genesiscz/utils/json";

const TEST_TOKEN = "sk-ant-oat01-TESTTOKEN";

mock.module("@genesiscz/utils/claude/subscription-auth", () => ({
    resolveAccountToken: async () => ({
        token: TEST_TOKEN,
        account: { name: "personal", accessToken: TEST_TOKEN },
        refreshed: false,
    }),
    resolveInferenceToken: async () => ({ token: TEST_TOKEN, kind: "long-lived", accountName: "personal" }),
    recoverInferenceToken: async () => ({ token: TEST_TOKEN, kind: "access", accountName: "personal" }),
}));

const account: AiProxyAccountConfig = {
    name: "martin",
    provider: "anthropic-subscription",
    providerSlug: "claude-sub",
    enabled: true,
    anthropicSub: { accountName: "personal" },
};

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("AnthropicSubscriptionProvider", () => {
    it("forwards the Claude Code spoof and maps the response to OpenAI shape", async () => {
        let capturedUrl: unknown;
        let capturedInit: RequestInit | undefined;

        globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
            capturedUrl = url;
            capturedInit = init;

            return new Response(
                SafeJSON.stringify({
                    id: "msg_test",
                    role: "assistant",
                    content: [{ type: "text", text: "OK from claude" }],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 5, output_tokens: 3 },
                }),
                { status: 200, headers: { "content-type": "application/json" } }
            );
        }) as typeof fetch;

        const { AnthropicSubscriptionProvider } = await import("./anthropic-subscription");
        const provider = await AnthropicSubscriptionProvider.create(account);

        const bodyText = SafeJSON.stringify({
            model: "martin/claude-sub/haiku",
            messages: [{ role: "user", content: "say OK" }],
        });
        const req = new Request("http://localhost/v1/chat/completions", { method: "POST", body: bodyText });
        const res = await provider.chatCompletions(req, "haiku", bodyText);

        expect(res.status).toBe(200);
        const completion = (await res.json()) as {
            object: string;
            choices: Array<{ message: { content: string } }>;
        };
        expect(completion.object).toBe("chat.completion");
        expect(completion.choices[0]?.message.content).toBe("OK from claude");

        // upstream targeted the Anthropic Messages API
        expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");

        // spoof headers: Bearer oat, betas, NO x-api-key
        const headers = new Headers(capturedInit?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${TEST_TOKEN}`);
        expect(headers.get("anthropic-beta")).toBe(SUBSCRIPTION_BETAS);
        expect(headers.get("x-api-key")).toBeNull();

        // body: concrete model id + billing header as system[0] + Claude Code prefix
        const sentBody = SafeJSON.parse(String(capturedInit?.body)) as {
            model: string;
            system: Array<{ text: string }>;
            messages: unknown[];
        };
        expect(sentBody.model).toBe("claude-haiku-5-5");
        expect(sentBody.system[0]?.text.startsWith("x-anthropic-billing-header")).toBe(true);
        expect(sentBody.system[1]?.text).toContain("You are Claude Code");
        expect(sentBody.messages).toHaveLength(1);
    });

    it("returns 400 (not a 502) for a non-object JSON body", async () => {
        const { AnthropicSubscriptionProvider } = await import("./anthropic-subscription");
        const provider = await AnthropicSubscriptionProvider.create(account);

        const req = new Request("http://localhost/v1/chat/completions", { method: "POST", body: "null" });
        const res = await provider.chatCompletions(req, "haiku", "null");

        expect(res.status).toBe(400);
    });

    it("streams as text/event-stream ending in [DONE]", async () => {
        const anthropicSse =
            'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"claude-haiku-4-5-20251001"}}\n\n' +
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n';

        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(anthropicSse));
                    controller.close();
                },
            });

            return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch;

        const { AnthropicSubscriptionProvider } = await import("./anthropic-subscription");
        const provider = await AnthropicSubscriptionProvider.create(account);

        const bodyText = SafeJSON.stringify({
            model: "martin/claude-sub/haiku",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        });
        const req = new Request("http://localhost/v1/chat/completions", { method: "POST", body: bodyText });
        const res = await provider.chatCompletions(req, "haiku", bodyText);

        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const text = await res.text();
        expect(text).toContain('"object":"chat.completion.chunk"');
        expect(text).toContain("Hi");
        expect(text).toContain("data: [DONE]");
    });

    it("/v1/messages passthrough: the cached prefix arrives byte-identical, behind one billing block stable per conversation", async () => {
        // Anthropic caches only at explicit cache_control breakpoints, and only on a byte-identical prefix.
        // Claude Code places them on the last tool, the system blocks and the latest user turn. The subscription
        // fetch puts its billing block before them (system[0]); it hashes only the FIRST user message, so it is
        // the same on every turn of one conversation and the prefix stays cacheable.
        const ephemeral = { type: "ephemeral" };
        const client = {
            model: "claude-haiku-4-5",
            max_tokens: 64,
            stream: false,
            metadata: {
                user_id: SafeJSON.stringify({ device_id: "dev", session_id: "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b" }),
            },
            tools: [
                {
                    name: "Read",
                    description: "read a file",
                    input_schema: { type: "object", properties: { path: { type: "string" } } },
                },
                {
                    name: "Bash",
                    description: "run",
                    input_schema: { type: "object", properties: {} },
                    cache_control: ephemeral,
                },
            ],
            system: [
                {
                    type: "text",
                    text: "You are Claude Code, Anthropic's official CLI for Claude.",
                    cache_control: ephemeral,
                },
                {
                    type: "text",
                    text: "You are an interactive agent. ünïcödé stays as sent.",
                    cache_control: ephemeral,
                },
            ],
            messages: [
                { role: "user", content: "first" },
                { role: "assistant", content: [{ type: "text", text: "ok" }] },
                { role: "user", content: [{ type: "text", text: "second", cache_control: ephemeral }] },
            ],
        };
        const sent: Array<Record<string, unknown>> = [];

        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);

            return new Response(
                SafeJSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [], usage: {} }),
                { status: 200, headers: { "content-type": "application/json" } }
            );
        }) as typeof fetch;

        const { AnthropicSubscriptionProvider } = await import("./anthropic-subscription");
        const provider = await AnthropicSubscriptionProvider.create(account);
        const send = async (body: typeof client) => {
            const bodyText = SafeJSON.stringify(body);
            const res = await provider.messages(
                new Request("http://localhost/v1/messages", { method: "POST", body: bodyText }),
                "haiku",
                bodyText
            );
            expect(res.status).toBe(200);
        };

        await send(client);
        await send({
            ...client,
            messages: [...client.messages, { role: "assistant", content: [{ type: "text", text: "done" }] }],
        });

        const [first, next] = sent;
        const system = first?.system as Array<{ text: string }>;

        for (const field of ["tools", "messages", "metadata"] as const) {
            expect(SafeJSON.stringify(first?.[field])).toBe(SafeJSON.stringify(client[field]));
        }

        expect(system[0]?.text).toStartWith("x-anthropic-billing-header:");
        expect(SafeJSON.stringify(system.slice(1))).toBe(SafeJSON.stringify(client.system));
        expect(SafeJSON.stringify(next?.system)).toBe(SafeJSON.stringify(first?.system));
        expect(SafeJSON.stringify(next?.tools)).toBe(SafeJSON.stringify(first?.tools));
    });
});

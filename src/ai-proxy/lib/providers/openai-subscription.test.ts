import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { resetCooldowns } from "@app/ai-proxy/lib/providers/cooldown";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";

const TEST_TOKEN = "codex-access-token";
const TEST_ACCOUNT_ID = "acct-123";

let primaryResolver: (options?: { forceRefresh?: boolean }) => Promise<{ token: string; accountId?: string }> =
    async () => ({ token: TEST_TOKEN, accountId: TEST_ACCOUNT_ID });
let failoverResolver: (
    name: string,
    options?: { forceRefresh?: boolean }
) => Promise<{ token: string; accountId?: string }> = async (name) => ({ token: `${name}-token` });

mock.module("@app/ai-proxy/lib/providers/openai-sub-token", () => ({
    resolveOpenAiSubToken: async (_account: unknown, options?: { forceRefresh?: boolean }) => primaryResolver(options),
    resolveOpenAiSubFailoverToken: async (name: string, options?: { forceRefresh?: boolean }) =>
        failoverResolver(name, options),
}));

interface StubWhamModel {
    slug: string;
    displayName: string;
    contextWindow: number;
    visibility: "list" | "hide";
    inputModalities?: string[];
}

let whamModelsStub: StubWhamModel[] | null = null;

mock.module("@genesiscz/utils/ai/openai/sub-models", () => ({
    OPENAI_SUB_STATIC_CATALOG: [],
    OPENAI_SUB_BUILTIN_ALIAS_NAMES: ["latest", "codex", "mini"],
    resolveOpenAiSubModel: (id: string, aliases?: Record<string, string>) => aliases?.[id] ?? id,
    tryFetchWhamModels: async () => whamModelsStub,
    fetchWhamModels: async () => whamModelsStub ?? [],
}));

const account: AiProxyAccountConfig = {
    name: "codex",
    provider: "openai-subscription",
    providerSlug: "codex",
    enabled: true,
    openaiSub: {},
};

const WHAM_SSE =
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5","status":"in_progress"}}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"CODEX"}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"_OK"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}}\n\n';

function whamStreamResponse(): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(WHAM_SSE));
            controller.close();
        },
    });

    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const realFetch = globalThis.fetch;

beforeEach(() => {
    resetCooldowns();
    primaryResolver = async () => ({ token: TEST_TOKEN, accountId: TEST_ACCOUNT_ID });
    failoverResolver = async (name) => ({ token: `${name}-token` });
    whamModelsStub = null;
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("buildWhamResponsesBody", () => {
    it("extracts system→instructions, maps messages→input, forces stream", async () => {
        const { buildWhamResponsesBody } = await import("./openai-subscription");
        const { body, dropped } = buildWhamResponsesBody(
            {
                model: "codex/codex/gpt-5.5",
                messages: [
                    { role: "system", content: "You are helpful." },
                    { role: "user", content: "hi" },
                ],
                max_tokens: 64,
            },
            "gpt-5.5"
        );

        expect(body.model).toBe("gpt-5.5");
        expect(body.stream).toBe(true);
        expect(body.store).toBe(false);
        expect(body.instructions).toBe("You are helpful.");
        expect(Array.isArray(body.input)).toBe(true);
        // WHAM rejects max_output_tokens ("Unsupported parameter"), so the
        // caller's max_tokens cap must NOT be forwarded (verified live 2026-07-12).
        expect(body.max_output_tokens).toBeUndefined();
        expect(dropped).toContain("max_tokens");
    });

    it("maps chat function tools to flat Responses tools", async () => {
        const { buildWhamResponsesBody } = await import("./openai-subscription");
        const { body } = buildWhamResponsesBody(
            {
                messages: [{ role: "user", content: "go" }],
                tools: [
                    {
                        type: "function",
                        function: { name: "search", description: "d", parameters: { type: "object" } },
                    },
                ],
            },
            "gpt-5.5"
        );

        expect(body.tools).toEqual([
            { type: "function", name: "search", description: "d", parameters: { type: "object" } },
        ]);
    });

    it("records dropped sampling params and unsupported tool types", async () => {
        const { buildWhamResponsesBody } = await import("./openai-subscription");
        const { body, dropped } = buildWhamResponsesBody(
            {
                messages: [{ role: "user", content: "go" }],
                temperature: 0.2,
                top_p: 0.9,
                tools: [{ type: "web_search" }, { type: "function", function: { name: "f", parameters: {} } }],
            },
            "gpt-5.5"
        );

        expect(dropped).toContain("temperature");
        expect(dropped).toContain("top_p");
        expect(dropped).toContain("tools[type=web_search]");
        expect(body.tools).toEqual([{ type: "function", name: "f", description: undefined, parameters: {} }]);
    });

    it("passes client reasoning through and clamps unknown efforts", async () => {
        const { buildWhamResponsesBody } = await import("./openai-subscription");

        const passthrough = buildWhamResponsesBody(
            { messages: [{ role: "user", content: "x" }], reasoning: { effort: "high" } },
            "gpt-5.5"
        );
        expect(passthrough.body.reasoning).toEqual({ effort: "high" });

        const clamped = buildWhamResponsesBody(
            { messages: [{ role: "user", content: "x" }], reasoning: { effort: "ultra-max" } },
            "gpt-5.5"
        );
        expect(clamped.body.reasoning).toEqual({ effort: "low" });
    });

    it("honours defaultReasoningEffort config, including none=omit", async () => {
        const { buildWhamResponsesBody } = await import("./openai-subscription");

        const highDefault = buildWhamResponsesBody({ messages: [{ role: "user", content: "x" }] }, "gpt-5.5", {
            defaultReasoningEffort: "high",
        });
        expect(highDefault.body.reasoning).toEqual({ effort: "high" });

        const omitted = buildWhamResponsesBody({ messages: [{ role: "user", content: "x" }] }, "gpt-5.5", {
            defaultReasoningEffort: "none",
        });
        expect(omitted.body.reasoning).toBeUndefined();

        const fallback = buildWhamResponsesBody({ messages: [{ role: "user", content: "x" }] }, "gpt-5.5");
        expect(fallback.body.reasoning).toEqual({ effort: "low" });
    });
});

describe("OpenAiSubscriptionProvider", () => {
    it("forwards a chat request to WHAM and maps the response to chat.completion", async () => {
        let capturedUrl: unknown;
        let capturedInit: RequestInit | undefined;

        globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
            capturedUrl = url;
            capturedInit = init;
            return whamStreamResponse();
        }) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);

        const bodyText = SafeJSON.stringify({
            model: "codex/codex/gpt-5.5",
            messages: [
                { role: "system", content: "Be terse." },
                { role: "user", content: "say ok" },
            ],
        });
        const req = new Request("http://localhost/v1/chat/completions", { method: "POST", body: bodyText });
        const res = await provider.chatCompletions(req, "gpt-5.5", bodyText);

        expect(res.status).toBe(200);
        const completion = (await res.json()) as {
            object: string;
            choices: Array<{ message: { content: string } }>;
            usage?: Record<string, unknown>;
        };
        expect(completion.object).toBe("chat.completion");
        expect(completion.choices[0]?.message.content).toBe("CODEX_OK");
        expect(completion.usage).toEqual({
            prompt_tokens: 10,
            completion_tokens: 3,
            total_tokens: 13,
        });

        // upstream targeted WHAM with the Codex token + account id
        expect(capturedUrl).toBe("https://chatgpt.com/backend-api/wham/responses");
        const headers = new Headers(capturedInit?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${TEST_TOKEN}`);
        expect(headers.get("chatgpt-account-id")).toBe(TEST_ACCOUNT_ID);
        expect(headers.get("openai-beta")).toBe("responses=experimental");

        // body was converted to Responses shape with the concrete model + stream
        const sentBody = SafeJSON.parse(String(capturedInit?.body)) as {
            model: string;
            stream: boolean;
            instructions: string;
            input: unknown[];
        };
        expect(sentBody.model).toBe("gpt-5.5");
        expect(sentBody.stream).toBe(true);
        expect(sentBody.instructions).toBe("Be terse.");
        expect(Array.isArray(sentBody.input)).toBe(true);
    });

    it("streams chat.completion.chunk when the client requests streaming", async () => {
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) =>
            whamStreamResponse()) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);

        const bodyText = SafeJSON.stringify({
            model: "codex/codex/gpt-5.5",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        });
        const req = new Request("http://localhost/v1/chat/completions", { method: "POST", body: bodyText });
        const res = await provider.chatCompletions(req, "gpt-5.5", bodyText);

        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const text = await res.text();
        expect(text).toContain('"object":"chat.completion.chunk"');
        expect(text).toContain("CODEX");
        expect(text).toContain("[DONE]");
        // WHAM's response.completed usage must survive into the chat stream.
        expect(text).toContain('"prompt_tokens":10');
        expect(text).toContain('"completion_tokens":3');
    });

    it("returns 400 (not a 502) for a non-object JSON body", async () => {
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);

        const req = new Request("http://localhost/v1/responses", { method: "POST", body: "null" });
        const res = await provider.responses(req, "gpt-5.5", "null");

        expect(res.status).toBe(400);
    });

    it("returns 502 (not 200 with empty output) when WHAM emits response.failed", async () => {
        const FAILED_SSE =
            'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5","status":"in_progress"}}\n\n' +
            'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"message":"upstream boom"}}}\n\n';

        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(FAILED_SSE));
                    controller.close();
                },
            });
            return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);

        const bodyText = SafeJSON.stringify({
            model: "codex/codex/gpt-5.5",
            messages: [{ role: "user", content: "hi" }],
        });
        const req = new Request("http://localhost/v1/responses", { method: "POST", body: bodyText });
        const res = await provider.responses(req, "gpt-5.5", bodyText);

        expect(res.status).toBe(502);
        const errorBody = (await res.json()) as { error: { message: string; type?: string } };
        expect(errorBody.error.message).toBe("upstream boom");
        expect(errorBody.error.type).toBe("upstream_error");
    });

    it("surfaces x-ai-proxy-dropped through the chat translation path", async () => {
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) =>
            whamStreamResponse()) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);

        const bodyText = SafeJSON.stringify({
            model: "codex/codex/gpt-5.5",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 32,
            temperature: 0.5,
        });
        const req = new Request("http://localhost/v1/chat/completions", { method: "POST", body: bodyText });
        const res = await provider.chatCompletions(req, "gpt-5.5", bodyText);

        expect(res.status).toBe(200);
        expect(res.headers.get("x-ai-proxy-dropped")).toBe("max_tokens,temperature");
    });

    it("fails over to the next account on 429 within one request", async () => {
        const authHeaders: Array<string | null> = [];
        let call = 0;

        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            authHeaders.push(new Headers(init?.headers).get("authorization"));
            call += 1;

            if (call === 1) {
                return new Response('{"error":{"message":"slow down"}}', {
                    status: 429,
                    headers: { "retry-after": "60" },
                });
            }

            return whamStreamResponse();
        }) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create({
            ...account,
            openaiSub: { failoverAccountNames: ["backup"] },
        });

        const bodyText = SafeJSON.stringify({
            model: "codex/codex/gpt-5.5",
            messages: [{ role: "user", content: "hi" }],
        });
        const req = new Request("http://localhost/v1/chat/completions", { method: "POST", body: bodyText });
        const res = await provider.chatCompletions(req, "gpt-5.5", bodyText);

        expect(res.status).toBe(200);
        expect(authHeaders).toEqual([`Bearer ${TEST_TOKEN}`, "Bearer backup-token"]);
    });

    it("returns a rate_limit_error envelope with Retry-After when every account is limited", async () => {
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) =>
            new Response('{"error":{"message":"slow down"}}', {
                status: 429,
                headers: { "retry-after": "45" },
            })) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);

        const bodyText = SafeJSON.stringify({
            model: "codex/codex/gpt-5.5",
            messages: [{ role: "user", content: "hi" }],
        });
        const req = new Request("http://localhost/v1/responses", { method: "POST", body: bodyText });
        const res = await provider.responses(req, "gpt-5.5", bodyText);

        expect(res.status).toBe(429);
        expect(res.headers.get("retry-after")).toBe("45");
        const body = (await res.json()) as { error: { type: string; message: string } };
        expect(body.error.type).toBe("rate_limit_error");
    });

    it("skips a cooling account on the next request instead of hitting upstream", async () => {
        let upstreamCalls = 0;

        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
            upstreamCalls += 1;
            return new Response('{"error":{"message":"slow down"}}', {
                status: 429,
                headers: { "retry-after": "60" },
            });
        }) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);

        const bodyText = SafeJSON.stringify({
            model: "codex/codex/gpt-5.5",
            messages: [{ role: "user", content: "hi" }],
        });

        const first = await provider.responses(
            new Request("http://localhost/v1/responses", { method: "POST", body: bodyText }),
            "gpt-5.5",
            bodyText
        );
        expect(first.status).toBe(429);
        expect(upstreamCalls).toBe(1);

        const second = await provider.responses(
            new Request("http://localhost/v1/responses", { method: "POST", body: bodyText }),
            "gpt-5.5",
            bodyText
        );
        expect(second.status).toBe(502);
        expect(upstreamCalls).toBe(1);
        const body = (await second.json()) as { error: { message: string } };
        expect(body.error.message).toContain("cooling down");
    });

    it("force-refreshes once on 401 and succeeds on retry", async () => {
        const refreshCalls: Array<boolean | undefined> = [];
        primaryResolver = async (options) => {
            refreshCalls.push(options?.forceRefresh);
            return {
                token: options?.forceRefresh ? "fresh-token" : "stale-token",
                accountId: TEST_ACCOUNT_ID,
            };
        };

        const authHeaders: Array<string | null> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            const auth = new Headers(init?.headers).get("authorization");
            authHeaders.push(auth);

            if (auth === "Bearer stale-token") {
                return new Response('{"detail":"Unauthorized"}', { status: 401 });
            }

            return whamStreamResponse();
        }) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);

        const bodyText = SafeJSON.stringify({
            model: "codex/codex/gpt-5.5",
            messages: [{ role: "user", content: "hi" }],
        });
        const req = new Request("http://localhost/v1/chat/completions", { method: "POST", body: bodyText });
        const res = await provider.chatCompletions(req, "gpt-5.5", bodyText);

        expect(res.status).toBe(200);
        expect(refreshCalls).toEqual([undefined, true]);
        expect(authHeaders).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
    });

    it("rejects image input for models known to lack the image modality", async () => {
        whamModelsStub = [
            {
                slug: "gpt-5.5",
                displayName: "GPT-5.5",
                contextWindow: 272_000,
                visibility: "list",
                inputModalities: ["text"],
            },
            {
                slug: "gpt-5.6-sol",
                displayName: "GPT-5.6-Sol",
                contextWindow: 372_000,
                visibility: "list",
                inputModalities: ["text", "image"],
            },
        ];

        let upstreamCalled = false;
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
            upstreamCalled = true;
            return whamStreamResponse();
        }) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);

        const bodyText = SafeJSON.stringify({
            model: "codex/codex/gpt-5.5",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "what is this?" },
                        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
                    ],
                },
            ],
        });
        const res = await provider.responses(
            new Request("http://localhost/v1/responses", { method: "POST", body: bodyText }),
            "gpt-5.5",
            bodyText
        );

        expect(res.status).toBe(400);
        expect(upstreamCalled).toBe(false);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("unsupported_modality");
        expect(body.error.message).toContain("gpt-5.6-sol");
    });

    it("lets image input pass when modalities are unknown", async () => {
        whamModelsStub = null;

        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) =>
            whamStreamResponse()) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);

        const bodyText = SafeJSON.stringify({
            model: "codex/codex/gpt-5.5",
            messages: [
                { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
            ],
        });
        const res = await provider.responses(
            new Request("http://localhost/v1/responses", { method: "POST", body: bodyText }),
            "gpt-5.5",
            bodyText
        );

        expect(res.status).toBe(200);
    });

    it("marks the account unhealthy after a second 401 and returns authentication_error", async () => {
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) =>
            new Response('{"detail":"Unauthorized"}', { status: 401 })) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);

        const bodyText = SafeJSON.stringify({
            model: "codex/codex/gpt-5.5",
            messages: [{ role: "user", content: "hi" }],
        });
        const res = await provider.responses(
            new Request("http://localhost/v1/responses", { method: "POST", body: bodyText }),
            "gpt-5.5",
            bodyText
        );

        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: { type: string; message: string } };
        expect(body.error.type).toBe("authentication_error");
        expect(body.error.message).toContain("accounts login codex");

        // Account is now cooling — next request short-circuits without upstream.
        let upstreamCalled = false;
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
            upstreamCalled = true;
            return whamStreamResponse();
        }) as typeof fetch;

        const second = await provider.responses(
            new Request("http://localhost/v1/responses", { method: "POST", body: bodyText }),
            "gpt-5.5",
            bodyText
        );
        expect(second.status).toBe(502);
        expect(upstreamCalled).toBe(false);
    });
});

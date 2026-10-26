import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCooldowns } from "@app/ai-proxy/lib/providers/cooldown";
import {
    CLAUDE_CODE_COMPACTION_MARK,
    isClaudeCodeModelProbe,
    modelProbeReply,
} from "@app/ai-proxy/lib/translators/formats/anthropic/claude-code-turns";
import {
    accountHash8,
    isReasoningReplayRejection,
    openReasoningEnvelope,
    packReasoningEnvelope,
} from "@app/ai-proxy/lib/translators/formats/anthropic/reasoning-envelope";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";
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
    // The catalog reads the Codex CLI cache through this mapper; the fixtures below need only these fields.
    whamModelRecordFromApi: (model: {
        slug: string;
        display_name: string;
        context_window: number;
        visibility: "list" | "hide";
        supported_reasoning_levels?: Array<{ effort: string }>;
        default_reasoning_level?: string;
        multi_agent_reasoning_effort?: string | null;
    }) => ({
        slug: model.slug,
        displayName: model.display_name,
        contextWindow: model.context_window,
        visibility: model.visibility,
        supportedEfforts: model.supported_reasoning_levels?.map((level) => level.effort),
        defaultEffort: model.default_reasoning_level,
        multiAgentReasoningEffort: model.multi_agent_reasoning_effort ?? undefined,
    }),
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

/** WHAM's usage limit, in the shape codex-rs parses. */
const USAGE_LIMIT_BODY =
    '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":5400}}';

beforeEach(() => {
    resetCooldowns();
    primaryResolver = async () => ({ token: TEST_TOKEN, accountId: TEST_ACCOUNT_ID });
    failoverResolver = async (name) => ({ token: `${name}-token` });
    whamModelsStub = null;
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

/** An arbitrary client partition of the item store; see wham-item-store.ts. */
const ITEM_SCOPE = "test-client";

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
            "gpt-5.5",
            { itemScope: ITEM_SCOPE }
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

    it("maps chat function tools to flat Responses tools, not strict unless the client says so", async () => {
        const { buildWhamResponsesBody } = await import("./openai-subscription");
        const { body } = buildWhamResponsesBody(
            {
                messages: [{ role: "user", content: "go" }],
                tools: [
                    {
                        type: "function",
                        function: { name: "search", description: "d", parameters: { type: "object" } },
                    },
                    { type: "function", function: { name: "exact", parameters: { type: "object" }, strict: true } },
                ],
            },
            "gpt-5.5",
            { itemScope: ITEM_SCOPE }
        );

        expect(body.tools).toEqual([
            { type: "function", name: "search", description: "d", parameters: { type: "object" }, strict: false },
            { type: "function", name: "exact", description: undefined, parameters: { type: "object" }, strict: true },
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
            "gpt-5.5",
            { itemScope: ITEM_SCOPE }
        );

        expect(dropped).toContain("temperature");
        expect(dropped).toContain("top_p");
        expect(dropped).toContain("tools[type=web_search]");
        expect(body.tools).toEqual([
            { type: "function", name: "f", description: undefined, parameters: {}, strict: false },
        ]);
    });

    it("passes client reasoning through and clamps unknown efforts", async () => {
        const { buildWhamResponsesBody } = await import("./openai-subscription");

        const passthrough = buildWhamResponsesBody(
            { messages: [{ role: "user", content: "x" }], reasoning: { effort: "high" } },
            "gpt-5.5",
            { itemScope: ITEM_SCOPE }
        );
        expect(passthrough.body.reasoning).toEqual({ effort: "high" });

        const clamped = buildWhamResponsesBody(
            { messages: [{ role: "user", content: "x" }], reasoning: { effort: "ultra-max" } },
            "gpt-5.5",
            { itemScope: ITEM_SCOPE }
        );
        expect(clamped.body.reasoning).toEqual({ effort: "low" });
    });

    it("honours defaultReasoningEffort config, including none=omit", async () => {
        const { buildWhamResponsesBody } = await import("./openai-subscription");

        const highDefault = buildWhamResponsesBody({ messages: [{ role: "user", content: "x" }] }, "gpt-5.5", {
            defaultReasoningEffort: "high",
            itemScope: ITEM_SCOPE,
        });
        expect(highDefault.body.reasoning).toEqual({ effort: "high" });

        const omitted = buildWhamResponsesBody({ messages: [{ role: "user", content: "x" }] }, "gpt-5.5", {
            defaultReasoningEffort: "none",
            itemScope: ITEM_SCOPE,
        });
        expect(omitted.body.reasoning).toBeUndefined();

        const fallback = buildWhamResponsesBody({ messages: [{ role: "user", content: "x" }] }, "gpt-5.5", {
            itemScope: ITEM_SCOPE,
        });
        expect(fallback.body.reasoning).toEqual({ effort: "low" });
    });

    it("honours a stamped top-level reasoning_effort from a model-id suffix", async () => {
        const { buildWhamResponsesBody } = await import("./openai-subscription");

        // `account/openai/gpt-5.5:xhigh` reaches this function as a top-level
        // reasoning_effort; without reading it the suffix silently ran at the
        // account default.
        const stamped = buildWhamResponsesBody(
            { messages: [{ role: "user", content: "x" }], reasoning_effort: "xhigh" },
            "gpt-5.5",
            { defaultReasoningEffort: "low", itemScope: ITEM_SCOPE }
        );
        expect(stamped.body.reasoning).toEqual({ effort: "xhigh" });

        // An explicit nested reasoning.effort still wins over the suffix.
        const explicit = buildWhamResponsesBody(
            { messages: [{ role: "user", content: "x" }], reasoning_effort: "xhigh", reasoning: { effort: "medium" } },
            "gpt-5.5",
            { itemScope: ITEM_SCOPE }
        );
        expect(explicit.body.reasoning).toEqual({ effort: "medium" });

        // `:max` is documented as a supported suffix but WHAM has no such
        // effort. Falling back to the default would make :max weaker than
        // :xhigh, so it maps to the strongest WHAM accepts.
        const max = buildWhamResponsesBody(
            { messages: [{ role: "user", content: "x" }], reasoning_effort: "max" },
            "gpt-5.5",
            { defaultReasoningEffort: "low", itemScope: ITEM_SCOPE }
        );
        expect(max.body.reasoning).toEqual({ effort: "xhigh" });

        // An unknown stamped value falls back to the configured default.
        const bogus = buildWhamResponsesBody(
            { messages: [{ role: "user", content: "x" }], reasoning_effort: "ultra-max" },
            "gpt-5.5",
            { defaultReasoningEffort: "high", itemScope: ITEM_SCOPE }
        );
        expect(bogus.body.reasoning).toEqual({ effort: "high" });
    });

    it("checks the effort against the model's catalog record instead of the fixed allowlist", async () => {
        const { buildWhamResponsesBody } = await import("./openai-subscription");
        const { mergeCodexModelRecords } = await import("@genesiscz/utils/ai/openai/codex-models");
        const catalog = mergeCodexModelRecords({
            live: [
                {
                    slug: "gpt-x-sol",
                    displayName: "X",
                    contextWindow: 500_000,
                    visibility: "list",
                    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
                    defaultEffort: "low",
                    multiAgentReasoningEffort: "xhigh",
                },
            ],
            fallback: [],
        }).get("gpt-x-sol");
        const build = (extra: Record<string, unknown>, defaultReasoningEffort?: "none" | "high") =>
            buildWhamResponsesBody({ messages: [{ role: "user", content: "x" }], ...extra }, "gpt-x-sol", {
                itemScope: ITEM_SCOPE,
                catalog,
                defaultReasoningEffort,
            });

        // `max` is a real backend effort for these models: it is sent as `max`, not clamped to xhigh.
        expect(build({ reasoning_effort: "max" }).body.reasoning).toEqual({ effort: "max" });
        expect(build({ reasoning: { effort: "max", summary: "auto" } }).body.reasoning).toEqual({
            effort: "max",
            summary: "auto",
        });
        // `ultra` is never sent (the backend answers 400): it resolves to the record's multi-agent effort.
        expect(build({ reasoning_effort: "ultra" }).body.reasoning).toEqual({ effort: "xhigh" });
        // No effort: the account default, else the model's own default.
        expect(build({}, "high").body.reasoning).toEqual({ effort: "high" });
        expect(build({}).body.reasoning).toEqual({ effort: "low" });
        expect(build({}, "none").body.reasoning).toBeUndefined();

        const refused = build({ reasoning_effort: "minimal" });
        expect(refused.effortError).toBe(
            'gpt-x-sol has no reasoning effort "minimal". Allowed: low, medium, high, xhigh, max, ultra (runs as xhigh).'
        );
        expect(refused.body.reasoning).toBeUndefined();

        // A configured default goes through the same check: `ultra` is mapped, never sent as is.
        const ultraDefault = { ...catalog, defaultEffort: "ultra" } as typeof catalog;
        const fromDefault = buildWhamResponsesBody({ messages: [{ role: "user", content: "x" }] }, "gpt-x-sol", {
            itemScope: ITEM_SCOPE,
            catalog: ultraDefault,
        });
        expect(fromDefault.body.reasoning).toEqual({ effort: "xhigh" });
        const lacking = buildWhamResponsesBody({ messages: [{ role: "user", content: "x" }] }, "gpt-x-sol", {
            itemScope: ITEM_SCOPE,
            catalog: { ...catalog, defaultEffort: "minimal" } as typeof catalog,
        });
        expect(lacking.effortError).toContain("(the default effort for gpt-x-sol)");
    });
});

describe("OpenAiSubscriptionProvider", () => {
    it("reads efforts from the Codex CLI model cache: max reaches WHAM, a missing effort is a 400 with no upstream call", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-codex-cache-"));
        const cachePath = join(dir, "models_cache.json");
        writeFileSync(
            cachePath,
            SafeJSON.stringify({
                models: [
                    {
                        slug: "gpt-x-luna",
                        display_name: "X Luna",
                        context_window: 272_000,
                        visibility: "list",
                        supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({
                            effort,
                        })),
                        default_reasoning_level: "medium",
                    },
                ],
            })
        );
        const sentBodies: Array<{ reasoning?: unknown }> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sentBodies.push(SafeJSON.parse(String(init?.body)) as { reasoning?: unknown });
            return whamStreamResponse();
        }) as typeof fetch;

        await env.testing.withOverrides({ GENESIS_TOOLS_CODEX_MODELS_CACHE: cachePath }, async () => {
            const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
            const provider = await OpenAiSubscriptionProvider.create(account);
            const send = (effort: string) => {
                const bodyText = SafeJSON.stringify({ input: "hi", reasoning: { effort }, stream: true });
                return provider.responses(
                    new Request("http://localhost/v1/responses", { method: "POST", body: bodyText }),
                    "gpt-x-luna",
                    bodyText
                );
            };

            expect((await send("max")).status).toBe(200);
            expect(sentBodies[0]?.reasoning).toEqual({ effort: "max" });

            const refused = await send("ultra");
            expect(refused.status).toBe(400);
            expect(await refused.json()).toEqual({
                error: {
                    message: 'gpt-x-luna has no reasoning effort "ultra". Allowed: low, medium, high, xhigh, max.',
                    type: "invalid_request_error",
                    param: "reasoning.effort",
                    code: "unsupported_effort",
                },
            });
            expect(sentBodies).toHaveLength(1);
        });
    });

    it("keeps one cache key per conversation: body prompt_cache_key and all three session headers, every turn", async () => {
        const sent: Array<{ key: unknown; headers: Headers }> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            const body = SafeJSON.parse(String(init?.body)) as { prompt_cache_key?: unknown };
            sent.push({ key: body.prompt_cache_key, headers: new Headers(init?.headers) });
            return whamStreamResponse();
        }) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);
        const turn = async (messages: unknown[], extra: Record<string, unknown> = {}) => {
            const bodyText = SafeJSON.stringify({
                messages: [{ role: "system", content: "Be terse." }, ...messages],
                ...extra,
            });
            const res = await provider.chatCompletions(
                new Request("http://localhost/v1/chat/completions", { method: "POST", body: bodyText }),
                "gpt-5.5",
                bodyText
            );
            await res.text();
        };
        const first = { role: "user", content: "say ok" };

        // A client that names no key: one key from model, instructions and first message, stable as turns grow.
        await turn([first]);
        await turn([first, { role: "assistant", content: "ok" }, { role: "user", content: "again" }]);
        // Tools are not hashed (model, instructions and the first message only), so their order does not move the key.
        const tool = (name: string) => ({ type: "function", function: { name, parameters: { type: "object" } } });
        await turn([first], { tools: [tool("a"), tool("b")] });
        await turn([first], { tools: [tool("b"), tool("a")] });
        // A client key (Claude Code's session id, stamped by the /v1/messages translation) wins as is.
        const session = "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b";
        await turn([first], { prompt_cache_key: session });

        const [a, b, withTools, reordered, c] = sent;
        expect(typeof a?.key).toBe("string");
        expect(b?.key).toBe(a?.key);
        expect(withTools?.key).toBe(a?.key);
        expect(reordered?.key).toBe(a?.key);
        expect(c?.key).toBe(session);

        for (const call of sent) {
            for (const header of ["session_id", "session-id", "thread-id"]) {
                expect(call.headers.get(header)).toBe(String(call.key));
            }
        }
    });

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

    it.each([
        "",
        'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"fixture","arguments":"{}"}}\n\n',
        'data: {"type":"response.completed","response":{}}\n\n',
        'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n',
        'data: {"type":"response.completed"\n\n',
    ])("rejects a nonterminal or malformed WHAM stream", async (sse) => {
        globalThis.fetch = Object.assign(async () => new Response(sse), { preconnect: realFetch.preconnect });
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);
        const body = SafeJSON.stringify({ messages: [{ role: "user", content: "hi" }] });
        const result = await provider.responses(
            new Request("http://localhost/v1/responses", { method: "POST", body }),
            "gpt-5.5",
            body
        );
        expect(result.status).toBe(502);
    });

    it.each([
        ["LF", "\n"],
        ["CRLF", "\r\n"],
        ["CR", "\r"],
    ])("decodes complete SSE frames with %s line ends and multibyte text split at every byte", async (_, eol) => {
        const bytes = new TextEncoder().encode(WHAM_SSE.replace("CODEX", "žluťoučký").replaceAll("\n", eol));
        globalThis.fetch = Object.assign(
            async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            for (const byte of bytes) {
                                controller.enqueue(Uint8Array.of(byte));
                            }
                            controller.close();
                        },
                    })
                ),
            { preconnect: realFetch.preconnect }
        );
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);
        const body = SafeJSON.stringify({ messages: [{ role: "user", content: "hi" }] });
        const result = await provider.responses(
            new Request("http://localhost/v1/responses", { method: "POST", body }),
            "gpt-5.5",
            body
        );
        expect(result.status).toBe(200);
        expect(await result.text()).toContain("žluťoučký_OK");
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

    it("with failover on, fails over to the next account on 429 within one request", async () => {
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
            failover: true,
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

    it("with failover off (the default), a usage limit reaches the client in words and no other account runs", async () => {
        const authHeaders: Array<string | null> = [];

        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            authHeaders.push(new Headers(init?.headers).get("authorization"));
            return new Response(USAGE_LIMIT_BODY, { status: 429 });
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
        const call = () =>
            provider.responses(
                new Request("http://localhost/v1/responses", { method: "POST", body: bodyText }),
                "gpt-5.5",
                bodyText
            );

        const first = await call();
        const body = (await first.json()) as { error: { type: string; code: string; message: string } };
        // No cooldown either: the next request asks the upstream again instead of answering "cooling down".
        const second = await call();

        expect(first.status).toBe(429);
        expect(body.error).toMatchObject({ type: "rate_limit_error", code: "usage_limit_reached" });
        expect(body.error.message).toContain(
            "Codex account codex hit its usage limit (gpt-5.5, upstream 429 usage_limit_reached)"
        );
        expect(body.error.message).toContain("tools ai-proxy accounts failover codex on");
        expect(second.status).toBe(429);
        expect(authHeaders).toEqual([`Bearer ${TEST_TOKEN}`, `Bearer ${TEST_TOKEN}`]);
    });

    it("with failover on, a failover name that is not a subscription login is never billed", async () => {
        const authHeaders: Array<string | null> = [];
        // What CodexAccountBinding.create answers for a name with no openai-sub account (account-binding.ts:57-63).
        failoverResolver = async (name) => {
            throw new Error(`No Codex account matches "${name}". Enabled OpenAI subscription accounts: work`);
        };
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            authHeaders.push(new Headers(init?.headers).get("authorization"));
            return new Response(USAGE_LIMIT_BODY, { status: 429 });
        }) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create({
            ...account,
            failover: true,
            openaiSub: { failoverAccountNames: ["billed"] },
        });
        const bodyText = SafeJSON.stringify({
            model: "codex/codex/gpt-5.5",
            messages: [{ role: "user", content: "hi" }],
        });
        const res = await provider.responses(
            new Request("http://localhost/v1/responses", { method: "POST", body: bodyText }),
            "gpt-5.5",
            bodyText
        );

        expect(res.status).toBe(502);
        expect(authHeaders).toEqual([`Bearer ${TEST_TOKEN}`]);
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

    it("with failover on, skips a cooling account on the next request instead of hitting upstream", async () => {
        let upstreamCalls = 0;

        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
            upstreamCalls += 1;
            return new Response('{"error":{"message":"slow down"}}', {
                status: 429,
                headers: { "retry-after": "60" },
            });
        }) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create({ ...account, failover: true });

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

    it("with failover on, marks the account unhealthy after a second 401 and returns authentication_error", async () => {
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) =>
            new Response('{"detail":"Unauthorized"}', { status: 401 })) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create({ ...account, failover: true });

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
        expect(body.error.message).toContain("was refused after a token refresh");
        expect(body.error.message).toContain("Log in again with `codex login`");

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

    it("does not cool the account when the forced refresh never reached the network", async () => {
        // A 401 sends us to force-refresh. If THAT fails because auth.openai.com
        // was unreachable, the grant is not dead and nothing was learned about it.
        // Cooling the account for 15 minutes told the client its login had died
        // because DNS blinked, and locked it out of the next request too.
        primaryResolver = async (options) => {
            if (options?.forceRefresh) {
                throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
                    code: "ConnectionRefused",
                });
            }

            return { token: "stale-token", accountId: TEST_ACCOUNT_ID };
        };

        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) =>
            new Response('{"detail":"Unauthorized"}', { status: 401 })) as typeof fetch;

        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create({ ...account, failover: true });

        const bodyText = SafeJSON.stringify({
            model: "codex/codex/gpt-5.5",
            messages: [{ role: "user", content: "hi" }],
        });
        const first = await provider.responses(
            new Request("http://localhost/v1/responses", { method: "POST", body: bodyText }),
            "gpt-5.5",
            bodyText
        );

        // 502 "upstream unreachable", not 401 "your login is dead".
        expect(first.status).toBe(502);

        // The account is still usable: a recovered network serves the next request.
        primaryResolver = async () => ({ token: TEST_TOKEN, accountId: TEST_ACCOUNT_ID });
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

        expect(second.status).toBe(200);
        expect(upstreamCalled).toBe(true);
    });
});

describe("native /v1/messages route: reasoning carried in gtr1 envelopes", () => {
    const fixture = readFileSync(join(import.meta.dir, "fixtures", "wham-reasoning-parallel-tools.sse"), "utf8");
    const sseResponse = (text: string) =>
        new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });

    interface Frame {
        event: string;
        data: Record<string, unknown>;
    }

    function frames(text: string): Frame[] {
        return text
            .split("\n\n")
            .filter((chunk) => chunk.includes("data:"))
            .map((chunk) => {
                const event = chunk.match(/^event: (.+)$/m)?.[1] ?? "";
                const data = SafeJSON.parse(chunk.slice(chunk.indexOf("data:") + 5).trim()) as Record<string, unknown>;
                return { event, data };
            });
    }

    async function send(
        body: Record<string, unknown>,
        context?: { promptCacheKey?: { key: string; source: "claude-session" } }
    ): Promise<Response> {
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);
        const bodyText = SafeJSON.stringify(body);
        const messages = provider.messages;

        if (!messages) {
            throw new Error("the native route is off");
        }

        return messages(
            new Request("http://localhost/v1/messages", { method: "POST", body: bodyText }),
            "gpt-6.1-sol",
            bodyText,
            context
        );
    }

    function turnOneThinking(text: string): { signature: string; thinking: string } {
        let thinking = "";
        let signature = "";

        for (const frame of frames(text)) {
            const delta = frame.data.delta as Record<string, unknown> | undefined;

            if (delta?.type === "thinking_delta") {
                thinking += String(delta.thinking);
            }

            if (delta?.type === "signature_delta") {
                signature = String(delta.signature);
            }
        }

        return { signature, thinking };
    }

    it("a recorded WHAM stream: thinking first with one gtr1 signature, text, four tool calls with .done-only arguments, never thinking last", async () => {
        globalThis.fetch = (async () => sseResponse(fixture)) as unknown as typeof fetch;
        const response = await send({
            model: "gpt-6.1-sol",
            stream: true,
            messages: [{ role: "user", content: "which capital?" }],
        });
        const text = await response.text();
        const all = frames(text);
        const starts = all
            .filter((frame) => frame.event === "content_block_start")
            .map((frame) => (frame.data.content_block as Record<string, unknown>).type);
        const signatures = all.filter(
            (frame) => (frame.data.delta as Record<string, unknown> | undefined)?.type === "signature_delta"
        );
        const toolInputs = new Map<number, string>();

        for (const frame of all) {
            const delta = frame.data.delta as Record<string, unknown> | undefined;

            if (delta?.type === "input_json_delta") {
                const index = Number(frame.data.index);
                toolInputs.set(index, (toolInputs.get(index) ?? "") + String(delta.partial_json));
            }
        }

        expect(response.status).toBe(200);
        expect(starts).toEqual(["thinking", "text", "tool_use", "tool_use", "tool_use", "tool_use"]);
        expect(signatures).toHaveLength(1);

        const { signature, thinking } = turnOneThinking(text);
        expect(thinking.length).toBeGreaterThan(0);
        expect(signature.startsWith(`gtr1.codex.${accountHash8("codex")}.gpt-6.1-sol.`)).toBe(true);
        expect(
            openReasoningEnvelope(signature, {
                provider: "codex",
                accountHash: accountHash8("codex"),
                compHash: signature.split(".").at(-2) ?? "",
            })
        ).toMatchObject({
            ok: true,
            item: { encrypted_content: "REDACTED-ENCRYPTED-2" },
        });
        expect([...toolInputs.values()].map((input) => SafeJSON.parse(input))).toHaveLength(4);
        expect(all.find((frame) => frame.event === "message_delta")?.data.usage).toMatchObject({
            input_tokens: 129,
            output_tokens: 312,
        });
    });

    it("the next turn replays the item whole, before its tool call, with the conversation's cache key; foreign signatures go silently", async () => {
        globalThis.fetch = (async () => sseResponse(fixture)) as unknown as typeof fetch;
        const { signature, thinking } = turnOneThinking(
            await (
                await send({ model: "gpt-6.1-sol", stream: true, messages: [{ role: "user", content: "q" }] })
            ).text()
        );
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return whamStreamResponse();
        }) as typeof fetch;
        const session = "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b";

        const response = await send(
            {
                model: "gpt-6.1-sol",
                stream: true,
                messages: [
                    { role: "user", content: "q" },
                    {
                        role: "assistant",
                        content: [
                            { type: "thinking", thinking: "old grok thought", signature: "grokrs1:rs_x:blob" },
                            { type: "thinking", thinking, signature },
                            { type: "tool_use", id: "call_1", name: "get_time", input: { timezone: "Europe/Prague" } },
                        ],
                    },
                    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "12:00" }] },
                ],
            },
            { promptCacheKey: { key: session, source: "claude-session" } }
        );
        await response.text();

        const input = sent[0]?.input as Array<Record<string, unknown>>;
        const types = input.map((item) => item.type ?? item.role);
        expect(response.status).toBe(200);
        expect(types.indexOf("reasoning")).toBeLessThan(types.indexOf("function_call"));
        expect(input.filter((item) => item.type === "reasoning")).toEqual([
            expect.objectContaining({ type: "reasoning", encrypted_content: "REDACTED-ENCRYPTED-2" }),
        ]);
        expect(((input.find((item) => item.type === "reasoning")?.summary ?? []) as unknown[]).length).toBeGreaterThan(
            0
        );
        expect(sent[0]?.prompt_cache_key).toBe(session);
        expect(sent[0]?.reasoning).toMatchObject({ summary: "auto" });
    });

    it("a 400 about the replayed blob retries once without reasoning, and that blob is never replayed again", async () => {
        const envelope = packReasoningEnvelope(
            { provider: "codex", accountHash: accountHash8("codex"), model: "gpt-6.1-sol", compHash: "0" },
            { id: "rs_dead", encrypted_content: "stale-blob", summary: [] }
        );
        const body = {
            model: "gpt-6.1-sol",
            stream: true,
            messages: [
                { role: "user", content: "q" },
                {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: "", signature: envelope },
                        { type: "text", text: "a" },
                    ],
                },
                { role: "user", content: "again" },
            ],
        };
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return sent.length === 1
                ? new Response(
                      SafeJSON.stringify({
                          error: { code: "invalid_encrypted_content", message: "could not be verified" },
                      }),
                      { status: 400, headers: { "content-type": "application/json" } }
                  )
                : whamStreamResponse();
        }) as typeof fetch;
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);
        const call = async () => {
            const bodyText = SafeJSON.stringify(body);
            const res = await provider.messages?.(
                new Request("http://localhost/v1/messages", { method: "POST", body: bodyText }),
                "gpt-6.1-sol",
                bodyText
            );
            await res?.text();
            return res;
        };

        expect((await call())?.status).toBe(200);
        expect(sent).toHaveLength(2);
        const reasoningIn = (index: number) =>
            ((sent[index]?.input ?? []) as Array<Record<string, unknown>>).filter((item) => item.type === "reasoning")
                .length;
        expect(reasoningIn(0)).toBe(1);
        expect(reasoningIn(1)).toBe(0);

        expect((await call())?.status).toBe(200);
        expect(sent).toHaveLength(3);
        expect(reasoningIn(2)).toBe(0);
    });

    it("with failover on, a backup login gets no replayed reasoning and signs its own reasoning with its login", async () => {
        const envelope = packReasoningEnvelope(
            { provider: "codex", accountHash: accountHash8("codex"), model: "gpt-6.1-sol", compHash: "0" },
            { id: "rs_primary", encrypted_content: "primary-blob", summary: [] }
        );
        const sse = (type: string, data: Record<string, unknown>) =>
            `event: ${type}\ndata: ${SafeJSON.stringify({ type, ...data })}\n\n`;
        // The terminal snapshot alone: the translator builds the blocks it never saw streamed.
        const backupStream =
            sse("response.created", { response: { id: "resp_b", status: "in_progress" } }) +
            sse("response.completed", {
                response: {
                    id: "resp_b",
                    status: "completed",
                    output: [
                        { type: "reasoning", id: "rs_backup", encrypted_content: "backup-blob", summary: [] },
                        { type: "message", content: [{ type: "output_text", text: "ok" }] },
                    ],
                    usage: { input_tokens: 5, output_tokens: 2 },
                },
            });
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return sent.length === 1
                ? new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { "retry-after": "60" } })
                : new Response(backupStream, { status: 200, headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch;
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create({
            ...account,
            failover: true,
            openaiSub: { failoverAccountNames: ["backup"] },
        });
        const bodyText = SafeJSON.stringify({
            model: "gpt-6.1-sol",
            stream: true,
            messages: [
                { role: "user", content: "q" },
                {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: "", signature: envelope },
                        { type: "text", text: "a" },
                    ],
                },
                { role: "user", content: "again" },
            ],
        });
        const res = await provider.messages?.(
            new Request("http://localhost/v1/messages", { method: "POST", body: bodyText }),
            "gpt-6.1-sol",
            bodyText
        );
        const text = (await res?.text()) ?? "";
        const reasoningIn = (index: number) =>
            ((sent[index]?.input ?? []) as Array<Record<string, unknown>>).filter((item) => item.type === "reasoning")
                .length;
        const signatures = text.match(/gtr1\.[A-Za-z0-9._-]+/g) ?? [];

        expect(res?.status).toBe(200);
        expect([reasoningIn(0), reasoningIn(1)]).toEqual([1, 0]);
        expect(signatures.length).toBeGreaterThan(0);
        expect(signatures.every((signature) => signature.split(".")[2] === accountHash8("backup"))).toBe(true);
    });

    it("Claude Code's compaction turn goes out with tool_choice none", async () => {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return whamStreamResponse();
        }) as typeof fetch;
        await (
            await send({
                model: "gpt-6.1-sol",
                stream: true,
                tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: {} } }],
                messages: [{ role: "user", content: `${CLAUDE_CODE_COMPACTION_MARK}\n\nSummarize the conversation.` }],
            })
        ).text();

        expect(sent[0]?.tool_choice).toBe("none");
        // WHAM treats a tool without `strict` as strict, and the model then fills every optional field.
        expect(sent[0]?.tools).toEqual([expect.objectContaining({ type: "function", name: "Read", strict: false })]);
    });

    it("Claude Code's /effort applies without an :effort suffix, and the suffix wins over it", async () => {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return whamStreamResponse();
        }) as typeof fetch;
        const turn = { model: "gpt-6.1-sol", stream: true, messages: [{ role: "user", content: "x" }] };

        await (await send({ ...turn, output_config: { effort: "xhigh" } })).text();
        // The server stamps a `:medium` suffix as `reasoning_effort` before the provider sees the body.
        await (await send({ ...turn, output_config: { effort: "xhigh" }, reasoning_effort: "medium" })).text();
        await (await send(turn)).text();

        const efforts = sent.map((body) => (body.reasoning as Record<string, unknown> | undefined)?.effort);
        expect(efforts.slice(0, 2)).toEqual(["xhigh", "medium"]);
        expect(efforts[2]).not.toBe("xhigh");
    });
});

describe("account failures on the Anthropic route (Claude Code)", () => {
    const body = {
        model: "codex/gpt-6.1-sol",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
    };

    async function send(upstream: () => Response, sessionId?: string) {
        globalThis.fetch = (async () => upstream()) as unknown as typeof fetch;
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);
        const bodyText = SafeJSON.stringify(body);
        const res = await provider.messages?.(
            new Request("http://localhost/v1/messages", { method: "POST", body: bodyText }),
            "gpt-6.1-sol",
            bodyText,
            sessionId ? { sessionId } : undefined
        );

        if (!res) {
            throw new Error("the native messages route is off");
        }

        return { res, json: (await res.json()) as { type: string; error: { type: string; message: string } } };
    }

    it("a usage limit is a 400 with this session's switch command, so Claude Code shows it at once", async () => {
        const { res, json } = await send(() => new Response(USAGE_LIMIT_BODY, { status: 429 }), "s-1");

        expect(res.status).toBe(400);
        expect(json.type).toBe("error");
        expect(json.error.message).toContain("hit its usage limit");
        expect(json.error.message).toContain("tools ai-proxy session s-1 use --codex <account>");
    });

    it("a short rate limit stays a 429 with its Retry-After, for Claude Code's own backoff", async () => {
        const { res, json } = await send(
            () =>
                new Response('{"error":{"message":"Rate limit reached","code":"rate_limit_exceeded"}}', {
                    status: 429,
                    headers: { "retry-after": "7" },
                })
        );

        expect(res.status).toBe(429);
        expect(res.headers.get("retry-after")).toBe("7");
        expect(json.error.type).toBe("rate_limit_error");
        expect(json.error.message).toContain("Retry after 7s.");
    });

    it("an overload before the first output is a 529, which Claude Code retries", async () => {
        const sse =
            'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n' +
            'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded","message":"busy"}}}\n\n';
        const { res, json } = await send(
            () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
        );

        expect(res.status).toBe(529);
        expect(json.error.type).toBe("overloaded_error");
        expect(json.error.message).toContain("answered that the model is overloaded");
    });
});

describe("Claude Code's WebSearch on the Codex agent", () => {
    // The shape WHAM streamed for a hosted search on 2026-10-26: the call and the citation arrive as their own
    // events, and response.completed carries an empty output.
    const event = (type: string, data: Record<string, unknown>) =>
        `event: ${type}\ndata: ${SafeJSON.stringify({ type, ...data })}\n\n`;
    const searchStream =
        event("response.created", { response: { id: "resp_ws", status: "in_progress" } }) +
        event("response.output_item.done", {
            item: {
                type: "web_search_call",
                id: "ws_1",
                status: "completed",
                action: {
                    type: "search",
                    query: "bun release",
                    sources: [{ type: "url", url: "https://bun.sh/blog" }],
                },
            },
        }) +
        event("response.output_text.delta", { delta: "Bun v1.4.4." }) +
        event("response.output_text.annotation.added", {
            annotation: { type: "url_citation", url: "https://bun.sh/blog?utm_source=openai", title: "Bun Blog" },
        }) +
        event("response.completed", {
            response: { id: "resp_ws", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 3 } },
        });

    it("runs the hosted web_search on WHAM and answers with search blocks that carry real titles and URLs", async () => {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return new Response(searchStream, { status: 200, headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch;
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);
        const bodyText = SafeJSON.stringify({
            model: "codex/gpt-6-luna",
            max_tokens: 4096,
            system: "You are an assistant for performing a web search tool use",
            tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8, allowed_domains: ["bun.sh"] }],
            messages: [{ role: "user", content: "Perform a web search for the query: bun release" }],
        });
        const res = await provider.messages?.(
            new Request("http://localhost/v1/messages", { method: "POST", body: bodyText }),
            "gpt-6-luna",
            bodyText
        );
        const message = (await res?.json()) as { content: Array<Record<string, unknown>> };

        expect(sent).toHaveLength(1);
        expect(sent[0]?.tools).toEqual([{ type: "web_search", filters: { allowed_domains: ["bun.sh"] } }]);
        expect(sent[0]?.include).toEqual(["reasoning.encrypted_content", "web_search_call.action.sources"]);
        expect(message.content.map((block) => block.type)).toEqual([
            "server_tool_use",
            "web_search_tool_result",
            "text",
        ]);
        expect(message.content[0]?.input).toEqual({ query: "bun release" });
        expect(message.content[1]?.content).toEqual([
            {
                type: "web_search_result",
                title: "Bun Blog",
                url: "https://bun.sh/blog",
                encrypted_content: "",
                page_age: null,
            },
        ]);
    });

    it("sends the hosted search with the conversation's cache key, not one derived from the search prompt", async () => {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return new Response(searchStream, { status: 200, headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch;
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);
        const bodyText = SafeJSON.stringify({
            model: "codex/gpt-6-luna",
            max_tokens: 4096,
            tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
            messages: [{ role: "user", content: "Perform a web search for the query: bun release" }],
        });
        const session = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
        const res = await provider.messages?.(
            new Request("http://localhost/v1/messages", { method: "POST", body: bodyText }),
            "gpt-6-luna",
            bodyText,
            { promptCacheKey: { key: session, source: "claude-session" } }
        );
        await res?.text();

        expect(sent).toHaveLength(1);
        expect(sent[0]?.prompt_cache_key).toBe(session);
    });
});

describe("Claude Code's model_validation probe", () => {
    const probe = {
        model: "codex/gpt-6.1-sol",
        max_tokens: 1,
        system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.296" }],
        messages: [{ role: "user", content: [{ type: "text", text: "Hi", cache_control: { type: "ephemeral" } }] }],
    };

    it("is the one-token Hi request and nothing else", () => {
        expect(isClaudeCodeModelProbe(probe)).toBe(true);
        expect(isClaudeCodeModelProbe({ ...probe, max_tokens: 2 })).toBe(false);
        expect(isClaudeCodeModelProbe({ ...probe, tools: [] })).toBe(false);
        expect(isClaudeCodeModelProbe({ ...probe, messages: [{ role: "user", content: "Hi there" }] })).toBe(false);
        expect(
            isClaudeCodeModelProbe({ ...probe, messages: [...probe.messages, { role: "assistant", content: "Hi" }] })
        ).toBe(false);
    });

    it("is answered with a one-token message under the requested model", () => {
        expect(modelProbeReply(probe.model)).toMatchObject({
            type: "message",
            role: "assistant",
            model: "codex/gpt-6.1-sol",
            content: [{ type: "text", text: "Hi" }],
            stop_reason: "max_tokens",
            usage: { input_tokens: 0, output_tokens: 1 },
        });
    });
});

describe("reasoning envelope", () => {
    const stamp = { provider: "codex", accountHash: accountHash8("work"), model: "gpt-6.1-sol", compHash: "3000" };
    const item = { id: "rs_1", encrypted_content: "blob", summary: [{ type: "summary_text", text: "t" }] };

    it("opens what it packed, the dotted model id included, and refuses another provider, account or comp_hash", () => {
        const signature = packReasoningEnvelope(stamp, item);
        const expect_ = { provider: "codex", accountHash: stamp.accountHash, compHash: "3000" };

        expect(openReasoningEnvelope(signature, expect_)).toEqual({ ok: true, item, stamp });
        expect(openReasoningEnvelope(signature, { ...expect_, provider: "grok" })).toEqual({
            ok: false,
            reason: "provider",
        });
        expect(openReasoningEnvelope(signature, { ...expect_, accountHash: accountHash8("personal") })).toEqual({
            ok: false,
            reason: "account",
        });
        expect(openReasoningEnvelope(signature, { ...expect_, compHash: "2000" })).toEqual({
            ok: false,
            reason: "comp-hash",
        });
        expect(openReasoningEnvelope(`${signature.slice(0, -4)}!!!!`, expect_)).toEqual({
            ok: false,
            reason: "malformed",
        });
        expect(openReasoningEnvelope("grokrs1:rs:blob", expect_)).toEqual({ ok: false, reason: "not-envelope" });
        expect(openReasoningEnvelope(undefined, expect_)).toEqual({ ok: false, reason: "not-envelope" });
    });

    it("knows the 400s that reject replayed reasoning, and nothing else", () => {
        expect(isReasoningReplayRejection(400, '{"error":{"code":"invalid_encrypted_content"}}')).toBe(true);
        expect(isReasoningReplayRejection(400, "Encrypted content was not issued to this caller")).toBe(true);
        expect(isReasoningReplayRejection(400, "Unsupported parameter: temperature")).toBe(false);
        expect(isReasoningReplayRejection(500, "could not decrypt")).toBe(false);
    });
});

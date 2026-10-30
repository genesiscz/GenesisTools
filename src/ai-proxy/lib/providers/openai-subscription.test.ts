import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCooldowns } from "@app/ai-proxy/lib/providers/cooldown";
import {
    rememberedMessageItems,
    rememberMessageItems,
    resetReasoningMemoryForTests,
} from "@app/ai-proxy/lib/providers/reasoning-memory";
import {
    type CompactionRecord,
    compactionFromSse,
    compactionNote,
    loadCompaction,
    saveCompaction,
    sweepCompactions,
} from "@app/ai-proxy/lib/sessions/codex-compaction";
import { createSessionRecord, readSessionRecord } from "@app/ai-proxy/lib/sessions/records";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import {
    CLAUDE_CODE_COMPACTION_MARK,
    ClaudeCodeTurn,
    modelProbeReply,
} from "@app/ai-proxy/lib/translators/formats/anthropic/claude-code-turns";
import {
    accountHash8,
    isReasoningReplayRejection,
    openReasoningEnvelope,
    packReasoningEnvelope,
} from "@app/ai-proxy/lib/translators/formats/anthropic/reasoning-envelope";
import type { AiProxyAccountConfig, SessionsInConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";

describe("reasoning message identity", () => {
    it("uses the shared JSON error helper for basic and typed envelopes", async () => {
        const { jsonError } = await import("@app/ai-proxy/lib/http-error");
        const basic = jsonError(502, "upstream failed");
        expect(basic.status).toBe(502);
        expect(basic.headers.get("content-type")).toBe("application/json");
        expect(await basic.json()).toEqual({ error: { message: "upstream failed" } });
        const typed = jsonError(403, "denied", { type: "forbidden", code: "not_allowed" });
        expect(await typed.json()).toEqual({ error: { message: "denied", type: "forbidden", code: "not_allowed" } });
    });

    it("replays a cache notice on the same historical message", async () => {
        const { preserveCacheReminders, resetCacheShapeForTests } = await import(
            "@app/ai-proxy/lib/sessions/cache-shape"
        );
        resetCacheShapeForTests();
        const input = [{ role: "user", content: "question" }];
        const first = preserveCacheReminders("thread", input, "changed");
        const continuation = preserveCacheReminders("thread", [...input, { role: "assistant", content: "answer" }]);
        expect(continuation[0]).toEqual(first[0]);
        expect(preserveCacheReminders("thread", [{ role: "user", content: "new history" }])[0]).toEqual({
            role: "user",
            content: "new history",
        });
    });

    it("bounds the number of remembered notices per thread", async () => {
        const { preserveCacheReminders, resetCacheShapeForTests } = await import(
            "@app/ai-proxy/lib/sessions/cache-shape"
        );
        resetCacheShapeForTests();
        const input: Array<{ role: string; content: string }> = [];
        for (let index = 0; index < 130; index++) {
            input.push({ role: "user", content: `message ${index}` });
            preserveCacheReminders("thread", input, `notice ${index}`);
        }
        const restored = preserveCacheReminders("thread", input);
        expect(restored[0]).toEqual(input[0]);
        expect(restored[1]).toEqual(input[1]);
        expect(SafeJSON.stringify(restored[2])).toContain("notice 2");
        expect(SafeJSON.stringify(restored[129])).toContain("notice 129");
    });

    it("times out an idle WHAM stream", async () => {
        const { whamSsePayloads } = await import("@app/ai-proxy/lib/providers/codex/wham-stream");
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
        });
        await expect(whamSsePayloads(stream, 10).next()).rejects.toThrow("timed out");
        expect(cancelled).toBe(true);
    });

    it("does not restore ambiguous identical text from different reasoning replies", () => {
        resetReasoningMemoryForTests();
        const content = [{ type: "text", text: "Done." }];
        const first = [
            { type: "reasoning", id: "first" },
            { type: "message", role: "assistant", content: "Done." },
        ];
        const second = [
            { type: "reasoning", id: "second" },
            { type: "message", role: "assistant", content: "Done." },
        ];
        rememberMessageItems("conversation", content, first);
        rememberMessageItems("conversation", content, first);
        expect(rememberedMessageItems("conversation", content)).toEqual(first);
        rememberMessageItems("conversation", content, second);
        expect(rememberedMessageItems("conversation", content)).toBeUndefined();
        rememberMessageItems("conversation", content, first);
        expect(rememberedMessageItems("conversation", content)).toBeUndefined();
        resetReasoningMemoryForTests();
    });

    it("does not restore a tool call whose name or arguments changed", () => {
        resetReasoningMemoryForTests();
        const tool = { type: "tool_use", id: "call-1", name: "read", input: { path: "first" } };
        const items = [
            { type: "reasoning", id: "reason-1" },
            { type: "function_call", call_id: "call-1" },
        ];
        rememberMessageItems("conversation", [tool], items);
        expect(rememberedMessageItems("conversation", [tool])).toEqual(items);
        expect(rememberedMessageItems("conversation", [{ ...tool, input: { path: "second" } }])).toBeUndefined();
        expect(rememberedMessageItems("conversation", [{ ...tool, name: "write" }])).toBeUndefined();
        resetReasoningMemoryForTests();
    });
});

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

/** WHAM's answer to a `compaction_trigger`: one compaction item, and the usage of the cached prefix. */
function whamCompactionResponse(encrypted: string, summary?: string): Response {
    const item = { type: "compaction", id: "cmp_1", encrypted_content: encrypted };
    const readable = summary
        ? `event: response.output_text.delta\ndata: ${SafeJSON.stringify({ type: "response.output_text.delta", delta: summary })}\n\n`
        : "";
    const sse =
        readable +
        `event: response.output_item.done\ndata: ${SafeJSON.stringify({ type: "response.output_item.done", item })}\n\n` +
        `event: response.completed\ndata: ${SafeJSON.stringify({
            type: "response.completed",
            response: { usage: { input_tokens: 400, input_tokens_details: { cached_tokens: 380 }, output_tokens: 50 } },
        })}\n\n`;

    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
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
        const { buildWhamResponsesBody } = await import("./codex/wham-body");
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
        const { buildWhamResponsesBody } = await import("./codex/wham-body");
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
        const { buildWhamResponsesBody } = await import("./codex/wham-body");
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
        const { buildWhamResponsesBody } = await import("./codex/wham-body");

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
        const { buildWhamResponsesBody } = await import("./codex/wham-body");

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
        const { buildWhamResponsesBody } = await import("./codex/wham-body");

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

    it("resolves explicit, default and catalog-mapped effort without reading input", async () => {
        const { buildWhamResponsesBody, resolveWhamReasoning } = await import("./codex/wham-body");
        const { mergeCodexModelRecords } = await import("@genesiscz/utils/ai/openai/codex-models");
        const catalog = mergeCodexModelRecords({
            live: [
                {
                    slug: "gpt-x-sol",
                    displayName: "X",
                    contextWindow: 500_000,
                    visibility: "list",
                    supportedEfforts: ["low", "high", "xhigh", "ultra"],
                    defaultEffort: "low",
                    multiAgentReasoningEffort: "xhigh",
                },
            ],
            fallback: [],
        }).get("gpt-x-sol");
        const cases = [{ reasoning: { effort: "high" } }, { reasoning: {} }, { reasoning: { effort: "ultra" } }];
        for (const [index, options] of cases.entries()) {
            const input = {
                ...options,
                get input(): never {
                    throw new Error("resolver read input");
                },
            };
            const resolved = resolveWhamReasoning(input, "gpt-x-sol", { catalog });
            const built = buildWhamResponsesBody({ ...options, input: [] }, "gpt-x-sol", {
                catalog,
                itemScope: ITEM_SCOPE,
            });
            expect(built.body.reasoning).toEqual(resolved.reasoning);
            expect(resolved.reasoning?.effort).toBe(["high", "low", "xhigh"][index]);
        }
    });

    it("checks the effort against the model's catalog record instead of the fixed allowlist", async () => {
        const { buildWhamResponsesBody } = await import("./codex/wham-body");
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

describe("compaction dispatch", () => {
    it("keeps native readable text without fabricating it from an encrypted item", async () => {
        const encryptedOnly = await whamCompactionResponse("opaque").text();
        const doneOnly = `data: ${SafeJSON.stringify({ type: "response.output_text.done", text: "Earlier work." })}\n\n`;
        const both = `data: ${SafeJSON.stringify({ type: "response.output_text.delta", delta: "Earlier work." })}\n\n${doneOnly}`;
        const messageOnly = `data: ${SafeJSON.stringify({
            type: "response.output_item.done",
            item: { type: "message", content: [{ type: "output_text", text: "Earlier work." }] },
        })}\n\n`;

        const completedOnly = `data: ${SafeJSON.stringify({
            type: "response.completed",
            response: { output: [{ type: "message", content: [{ type: "output_text", text: "Earlier work." }] }] },
        })}\n\n`;

        expect(compactionFromSse(encryptedOnly).summary).toBeUndefined();
        expect(compactionFromSse(doneOnly).summary).toBe("Earlier work.");
        expect(compactionFromSse(both).summary).toBe("Earlier work.");
        expect(compactionFromSse(messageOnly).summary).toBe("Earlier work.");
        expect(compactionFromSse(completedOnly).summary).toBe("Earlier work.");
    });

    const frame = (event: Record<string, unknown>) => `data: ${SafeJSON.stringify(event)}\n\n`;
    const compactionDone = (item: Record<string, unknown>) => frame({ type: "response.output_item.done", item });
    const completed = frame({ type: "response.completed", response: { usage: { input_tokens: 1 } } });

    it("installs a compaction item only from a finished response", async () => {
        expect(compactionFromSse(await whamCompactionResponse("ENC").text()).item?.encrypted_content).toBe("ENC");
        const fromOutput = frame({
            type: "response.completed",
            response: { output: [{ type: "compaction", encrypted_content: "ENC-OUT" }] },
        });
        expect(compactionFromSse(fromOutput).item?.encrypted_content).toBe("ENC-OUT");
    });

    it("refuses a malformed compaction item", () => {
        expect(compactionFromSse(compactionDone({ type: "compaction" }) + completed).item).toBeUndefined();
        expect(
            compactionFromSse(compactionDone({ type: "compaction", encrypted_content: "" }) + completed).item
        ).toBeUndefined();
    });

    it("refuses a compaction item from a stream that ended before response.completed", () => {
        expect(
            compactionFromSse(compactionDone({ type: "compaction", encrypted_content: "ENC" })).item
        ).toBeUndefined();
    });

    it("refuses a compaction item when the response failed or stopped early", () => {
        const item = compactionDone({ type: "compaction", encrypted_content: "ENC" });

        for (const type of ["response.failed", "response.incomplete", "error"]) {
            expect(compactionFromSse(item + frame({ type, response: {} }) + completed).item).toBeUndefined();
        }
    });

    it("sends keepalives and aborts a stalled preparation at its deadline", async () => {
        const { compactionDispatch } = await import("./codex/compaction-flow");
        let aborted = false;
        const response = await compactionDispatch({
            signal: new AbortController().signal,
            stream: true,
            timeoutMs: 100,
            pingMs: 10,
            run: (signal) =>
                new Promise<Response>((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => {
                            aborted = true;
                            reject(new Error("aborted"));
                        },
                        { once: true }
                    );
                }),
        });
        const text = await response.text();

        expect(text).toContain(": keepalive");
        expect(text).toContain("event: error");
        expect(text).toContain("Compaction timed out");
        expect(aborted).toBe(true);
    });

    it("cancels a compaction body that stops sending data", async () => {
        const { readCompactionText } = await import("./codex/wham-stream");
        let cancelled = false;
        const response = new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode("data: first\n\n"));
                },
                cancel() {
                    cancelled = true;
                },
            })
        );

        await expect(readCompactionText(response, 100)).rejects.toThrow("Compaction upstream stream timed out");
        expect(cancelled).toBe(true);
    });

    it("bounds a stalled body after upstream headers", async () => {
        const { compactionDispatch } = await import("./codex/compaction-flow");
        let aborted = false;
        const response = await compactionDispatch({
            signal: new AbortController().signal,
            stream: false,
            timeoutMs: 100,
            run: async (signal) => {
                const upstream = new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            signal.addEventListener(
                                "abort",
                                () => {
                                    aborted = true;
                                    controller.error(new Error("aborted"));
                                },
                                { once: true }
                            );
                        },
                    })
                );
                await upstream.text();
                return new Response("unexpected");
            },
        });

        expect(response.status).toBe(504);
        expect(await response.text()).toContain("Compaction timed out");
        expect(aborted).toBe(true);
    });

    it("cancels stalled upstream preparation when the client stops reading", async () => {
        const { compactionDispatch } = await import("./codex/compaction-flow");
        let aborted = false;
        const response = await compactionDispatch({
            signal: new AbortController().signal,
            stream: true,
            pingMs: 10,
            run: (signal) =>
                new Promise<Response>((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => {
                            aborted = true;
                            reject(new Error("cancelled"));
                        },
                        { once: true }
                    );
                }),
        });

        await response.body?.cancel();
        expect(aborted).toBe(true);
    });

    it("preserves early HTTP failures before the first keepalive", async () => {
        const { compactionDispatch } = await import("./codex/compaction-flow");

        for (const status of [400, 503, 529]) {
            const response = await compactionDispatch({
                signal: new AbortController().signal,
                stream: true,
                run: async () => new Response("failure", { status }),
            });
            expect(response.status).toBe(status);
            expect(await response.text()).toBe("failure");
        }
    });

    it("forwards a healthy prepared stream", async () => {
        const { compactionDispatch } = await import("./codex/compaction-flow");
        const response = await compactionDispatch({
            signal: new AbortController().signal,
            stream: true,
            run: async () => new Response("event: message_stop\ndata: {}\n\n"),
        });

        expect(await response.text()).toContain("event: message_stop");
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
        context?: {
            promptCacheKey?: { key: string; source: "claude-session" };
            sessionId?: string;
            sessionsIn?: SessionsInConfig;
        },
        signal?: AbortSignal
    ): Promise<Response> {
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);
        const bodyText = SafeJSON.stringify(body);
        const messages = provider.messages;

        if (!messages) {
            throw new Error("the native route is off");
        }

        return messages(
            new Request("http://localhost/v1/messages", { method: "POST", body: bodyText, signal }),
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
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) =>
            sseResponse(fixture)) as typeof fetch;
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
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) =>
            sseResponse(fixture)) as typeof fetch;
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

    it("a written-summary compaction goes out with tool_choice none", async () => {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return whamStreamResponse();
        }) as typeof fetch;
        await (
            await send(
                {
                    model: "gpt-6.1-sol",
                    stream: true,
                    tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: {} } }],
                    messages: [
                        { role: "user", content: `${CLAUDE_CODE_COMPACTION_MARK}\n\nSummarize the conversation.` },
                    ],
                    output_config: { effort: "xhigh" },
                    reasoning_effort: "xhigh",
                },
                { sessionsIn: { claude: { providers: { codex: { compaction: { mode: "summary" } } } } } }
            )
        ).text();

        expect(sent).toHaveLength(1);
        expect(sent[0]?.tool_choice).toBe("none");
        expect(SafeJSON.stringify(sent[0]?.input)).not.toContain("compaction_trigger");
        // The summary keeps the session's effort (another effort misses the cache) and is asked for a length, at the
        // end of the input so the cached prefix stays.
        expect((sent[0]?.reasoning as Record<string, unknown> | undefined)?.effort).toBe("xhigh");
        const input = (sent[0]?.input ?? []) as Array<Record<string, unknown>>;
        expect(SafeJSON.stringify(input.at(-1))).toContain("under 5000 words");
        // WHAM treats a tool without `strict` as strict, and the model then fills every optional field.
        expect(sent[0]?.tools).toEqual([expect.objectContaining({ type: "function", name: "Read", strict: false })]);
    });

    it("sessionsIn.claude.providers.codex.compaction sets another effort and drops the length", async () => {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return whamStreamResponse();
        }) as typeof fetch;

        await (
            await send(
                {
                    model: "gpt-6.1-sol",
                    stream: true,
                    messages: [{ role: "user", content: `${CLAUDE_CODE_COMPACTION_MARK}\n\nSummarize.` }],
                    output_config: { effort: "xhigh" },
                },
                {
                    sessionsIn: {
                        claude: { providers: { codex: { compaction: { mode: "summary", effort: "low", words: 0 } } } },
                    },
                }
            )
        ).text();

        expect((sent[0]?.reasoning as Record<string, unknown> | undefined)?.effort).toBe("low");
        expect(SafeJSON.stringify(sent[0]?.input)).not.toContain("words");
    });

    it("cancels stalled native compaction and cross-login recompaction when the client disconnects", async () => {
        for (const crossLogin of [false, true]) {
            let upstreamSignal: AbortSignal | undefined;
            let started: () => void = () => {};
            const upstreamStarted = new Promise<void>((resolve) => {
                started = resolve;
            });
            globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
                upstreamSignal = init?.signal ?? undefined;
                const signal = upstreamSignal;
                started();
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            signal?.addEventListener("abort", () => controller.error(new Error("cancelled")), {
                                once: true,
                            });
                        },
                    }),
                    { headers: { "Content-Type": "text/event-stream" } }
                );
            }) as typeof fetch;
            const id = `gtc1.${crypto.randomUUID()}`;

            if (crossLogin) {
                saveCompaction({
                    id,
                    model: "gpt-6.1-sol",
                    createdAt: new Date().toISOString(),
                    items: { otherlgn: { type: "compaction", encrypted_content: "old" } },
                    history: [{ role: "user", content: [{ type: "input_text", text: "earlier" }] }],
                });
            }

            const client = new AbortController();
            const pending = send(
                {
                    model: "gpt-6.1-sol",
                    stream: true,
                    messages: [
                        {
                            role: "user",
                            content: crossLogin ? compactionNote(id) : `${CLAUDE_CODE_COMPACTION_MARK}\nSummarize.`,
                        },
                    ],
                },
                undefined,
                client.signal
            );
            await upstreamStarted;
            client.abort();
            const response = await pending;
            expect(upstreamSignal?.aborted).toBe(true);
            await response.body?.cancel();
        }
    });

    it("a native compaction sends the turn plus compaction_trigger at the session's effort, and a marker comes back", async () => {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return sent.length === 1 ? whamCompactionResponse("ENC-A") : whamStreamResponse();
        }) as typeof fetch;
        const history = [
            { role: "user", content: "Which shelf holds line 12?" },
            { role: "assistant", content: "Shelf 12." },
        ];
        const reply = await (
            await send({
                model: "gpt-6.1-sol",
                stream: false,
                output_config: { effort: "xhigh" },
                messages: [...history, { role: "user", content: `${CLAUDE_CODE_COMPACTION_MARK}\n\nSummarize.` }],
            })
        ).json();
        const input = (sent[0]?.input ?? []) as Array<Record<string, unknown>>;

        expect(input.at(-1)).toEqual({ type: "compaction_trigger" });
        expect(SafeJSON.stringify(input)).not.toContain(CLAUDE_CODE_COMPACTION_MARK);
        expect((sent[0]?.reasoning as Record<string, unknown> | undefined)?.effort).toBe("xhigh");
        expect(sent[0]?.tool_choice).toBeUndefined();
        const note = String(reply.content?.[0]?.text ?? "");
        const id = note.match(/\[codex-compaction (gtc1\.[0-9a-f-]{36})\]/)?.[1];
        expect(id).toBeDefined();
        expect(reply.usage).toEqual({ input_tokens: 20, cache_read_input_tokens: 380, output_tokens: 50 });
        expect(sent).toHaveLength(1);
        expect(note).not.toContain("codex-compaction-fallback");

        // The next turn carries Claude Code's summary message; the proxy puts the item back in front of it.
        await (
            await send({
                model: "gpt-6.1-sol",
                stream: true,
                messages: [{ role: "user", content: `This session is being continued.\n\n${note}\n\nGo on.` }],
            })
        ).text();
        const next = (sent[1]?.input ?? []) as Array<Record<string, unknown>>;
        expect(next[0]).toEqual({ type: "compaction", id: "cmp_1", encrypted_content: "ENC-A" });
        expect(SafeJSON.stringify(next)).not.toContain("codex-compaction");
        expect(SafeJSON.stringify(next)).toContain("Go on.");
    });

    it("answers inside summary tags, and restores the note Claude Code keeps from inside them", async () => {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return sent.length === 1 ? whamCompactionResponse("ENC-TAG") : whamStreamResponse();
        }) as typeof fetch;
        const reply = await (
            await send({
                model: "gpt-6.1-sol",
                stream: false,
                messages: [{ role: "user", content: `${CLAUDE_CODE_COMPACTION_MARK}\nSummarize.` }],
            })
        ).json();
        const text = String(reply.content?.[0]?.text ?? "");
        const inner = text.match(/^<summary>\n([\s\S]*)\n<\/summary>$/)?.[1];

        expect(inner).toBeDefined();
        await (
            await send({
                model: "gpt-6.1-sol",
                stream: true,
                messages: [
                    { role: "user", content: `This session is being continued.\n\nSummary:\n${inner}\n\nGo on.` },
                ],
            })
        ).text();
        const next = (sent[1]?.input ?? []) as Array<Record<string, unknown>>;
        expect(next[0]).toEqual({ type: "compaction", id: "cmp_1", encrypted_content: "ENC-TAG" });
    });

    it("compacts natively when Claude Code sends a system message after the compaction prompt", async () => {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return whamCompactionResponse("ENC-SYS");
        }) as typeof fetch;
        const reply = await (
            await send({
                model: "gpt-6.1-sol",
                stream: false,
                messages: [
                    { role: "user", content: "Which shelf?" },
                    { role: "assistant", content: "Shelf 12." },
                    { role: "user", content: [{ type: "text", text: `${CLAUDE_CODE_COMPACTION_MARK}\nSummarize.` }] },
                    { role: "system", content: "<total_tokens>15000000 tokens left</total_tokens>" },
                ],
            })
        ).json();
        const input = (sent[0]?.input ?? []) as Array<Record<string, unknown>>;

        expect(sent).toHaveLength(1);
        expect(input.at(-1)).toEqual({ type: "compaction_trigger" });
        expect(SafeJSON.stringify(input)).not.toContain(CLAUDE_CODE_COMPACTION_MARK);
        expect(String(reply.content?.[0]?.text ?? "")).toContain("[codex-compaction gtc1.");
    });

    it("keeps readable text supplied by native compaction without a second model request", async () => {
        let requests = 0;
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
            requests++;
            return whamCompactionResponse("ENC-A", "The earlier answer is on shelf 12.");
        }) as typeof fetch;
        const reply = await (
            await send({
                model: "gpt-6.1-sol",
                stream: false,
                messages: [{ role: "user", content: `${CLAUDE_CODE_COMPACTION_MARK}\nSummarize.` }],
            })
        ).json();
        const note = String(reply.content?.[0]?.text ?? "");

        expect(requests).toBe(1);
        expect(note).toContain("The earlier answer is on shelf 12.");
        expect(note).toContain("codex-compaction-fallback");
    });

    it("a marker from another login compacts the saved history again there, once", async () => {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return SafeJSON.stringify(init?.body).includes("compaction_trigger")
                ? whamCompactionResponse("ENC-HERE")
                : whamStreamResponse();
        }) as typeof fetch;
        const id = `gtc1.${crypto.randomUUID()}`;
        saveCompaction({
            id,
            model: "gpt-6.1-sol",
            createdAt: new Date().toISOString(),
            items: { otherlgn: { type: "compaction", id: "cmp_other", encrypted_content: "ENC-OTHER" } },
            history: [
                { role: "user", content: [{ type: "input_text", text: "the earlier work" }] },
                { type: "reasoning", id: "rs_old", encrypted_content: "old-login-reasoning", summary: [] },
            ],
        });
        const turn = {
            model: "gpt-6.1-sol",
            stream: true,
            messages: [{ role: "user", content: `Summary:\n${compactionNote(id)}\n\nGo on.` }],
        };

        await (await send(turn)).text();
        await (await send(turn)).text();
        const triggers = sent.filter((body) => SafeJSON.stringify(body.input).includes("compaction_trigger"));

        expect(triggers.length).toBe(1);
        expect(SafeJSON.stringify(triggers[0]?.input)).toContain("the earlier work");
        expect(SafeJSON.stringify(triggers[0]?.input)).not.toContain("old-login-reasoning");
        const turns = sent.filter((body) => !SafeJSON.stringify(body.input).includes("compaction_trigger"));
        expect(turns.map((body) => (body.input as Array<Record<string, unknown>>)[0]?.encrypted_content)).toEqual([
            "ENC-HERE",
            "ENC-HERE",
        ]);
        expect(loadCompaction(id)?.items.otherlgn?.encrypted_content).toBe("ENC-OTHER");
    });

    it("does not restore quoted markers or a compaction note inside a tool result", async () => {
        let requests = 0;
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
            requests++;
            return whamStreamResponse();
        }) as typeof fetch;
        const id = `gtc1.${crypto.randomUUID()}`;
        const response = await send({
            model: "gpt-6.1-sol",
            stream: true,
            messages: [
                {
                    role: "user",
                    content: [{ type: "tool_result", tool_use_id: "tool_1", content: compactionNote(id) }],
                },
                { role: "user", content: `The log mentions [codex-compaction ${id}].` },
            ],
        });

        expect(response.status).toBe(200);
        await response.text();
        expect(requests).toBe(1);
    });

    it("preserves usage-limit and overload HTTP statuses on ordinary post-compaction turns", async () => {
        const id = `gtc1.${crypto.randomUUID()}`;
        saveCompaction({
            id,
            model: "gpt-6.1-sol",
            createdAt: new Date().toISOString(),
            items: { [accountHash8("codex")]: { type: "compaction", encrypted_content: "held" } },
            history: [{ role: "user", content: [{ type: "input_text", text: "earlier" }] }],
        });
        const turn = {
            model: "gpt-6.1-sol",
            stream: true,
            messages: [{ role: "user", content: `${compactionNote(id)}\nGo on.` }],
        };
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) =>
            new Response(USAGE_LIMIT_BODY, { status: 429 })) as typeof fetch;
        const limited = await send(turn, { sessionId: "s-1" });
        expect(limited.status).toBe(400);
        expect(await limited.text()).toContain("tools ai-proxy session s-1 use --codex '<account>'");

        const overloaded =
            'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n' +
            'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded","message":"busy"}}}\n\n';
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) =>
            new Response(overloaded, {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            })) as typeof fetch;
        const busy = await send(turn);
        expect(busy.status).toBe(529);
        expect(await busy.text()).toContain("overloaded_error");
    });

    it("refuses to continue when a compaction record is missing", async () => {
        let requests = 0;
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
            requests++;
            return whamStreamResponse();
        }) as typeof fetch;
        const id = `gtc1.${crypto.randomUUID()}`;
        const response = await send({
            model: "gpt-6.1-sol",
            stream: true,
            messages: [{ role: "user", content: `Summary:\n${compactionNote(id)}\n\nGo on.` }],
        });

        expect(response.status).toBe(400);
        const errorBody = await response.text();
        expect(errorBody).toContain(`Compaction record ${id} is missing or unreadable`);
        expect(errorBody).toContain("start a new session with a readable handoff");
        expect(requests).toBe(0);
    });

    it("offers record restore and explicit loss acknowledgement for the blocked session", async () => {
        const sessionId = crypto.randomUUID();
        const id = `gtc1.${crypto.randomUUID()}`;
        createSessionRecord({ id: sessionId });
        const response = await send(
            {
                model: "gpt-6.1-sol",
                stream: true,
                messages: [{ role: "user", content: compactionNote(id) }],
            },
            { sessionId }
        );

        expect(response.status).toBe(400);
        const message = await response.text();
        expect(message).toContain(`session ${sessionId} compaction-restore --marker ${id} --from`);
        expect(message).toContain(`session ${sessionId} compaction-drop --marker ${id} --acknowledge-context-loss`);
        expect(readSessionRecord(sessionId)?.blockedCompactions).toContain(id);
        expect(readSessionRecord(sessionId)?.droppedCompactions).toBeUndefined();
    });

    it("uses the readable summary when a compaction record is missing", async () => {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return whamStreamResponse();
        }) as typeof fetch;
        const id = `gtc1.${crypto.randomUUID()}`;
        const response = await send({
            model: "gpt-6.1-sol",
            stream: true,
            messages: [{ role: "user", content: compactionNote(id, "Shelf 12 holds the answer.") }],
        });

        expect(response.status).toBe(200);
        await response.text();
        expect(SafeJSON.stringify(sent[0]?.input)).toContain("Shelf 12 holds the answer.");
    });

    it("refuses to continue when another login cannot recompact the saved history", async () => {
        let requests = 0;
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
            requests++;
            return whamStreamResponse();
        }) as typeof fetch;
        const id = `gtc1.${crypto.randomUUID()}`;
        saveCompaction({
            id,
            model: "gpt-6.1-sol",
            createdAt: new Date().toISOString(),
            items: { otherlgn: { type: "compaction", encrypted_content: "old" } },
            history: [{ role: "user", content: [{ type: "input_text", text: "earlier" }] }],
        });
        const response = await send({
            model: "gpt-6.1-sol",
            stream: true,
            messages: [{ role: "user", content: compactionNote(id) }],
        });

        expect(response.status).toBe(503);
        const errorBody = await response.text();
        expect(errorBody).toContain(`Could not restore compaction ${id}`);
        expect(requests).toBe(1);
    });

    it("preserves transient upstream failures while restoring on another login", async () => {
        const id = `gtc1.${crypto.randomUUID()}`;
        saveCompaction({
            id,
            model: "gpt-6.1-sol",
            createdAt: new Date().toISOString(),
            items: { otherlgn: { type: "compaction", encrypted_content: "old" } },
            history: [{ role: "user", content: [{ type: "input_text", text: "earlier" }] }],
        });
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) =>
            new Response(USAGE_LIMIT_BODY, { status: 429 })) as typeof fetch;
        const response = await send(
            {
                model: "gpt-6.1-sol",
                stream: true,
                messages: [{ role: "user", content: compactionNote(id) }],
            },
            { sessionId: "s-1" }
        );

        expect(response.status).toBe(400);
        expect(await response.text()).toContain("tools ai-proxy session s-1 use --codex '<account>'");
    });

    it("uses the readable summary when cross-login recompaction fails", async () => {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return whamStreamResponse();
        }) as typeof fetch;
        const id = `gtc1.${crypto.randomUUID()}`;
        saveCompaction({
            id,
            model: "gpt-6.1-sol",
            createdAt: new Date().toISOString(),
            items: { otherlgn: { type: "compaction", encrypted_content: "old" } },
            history: [{ role: "user", content: [{ type: "input_text", text: "earlier" }] }],
        });
        const response = await send({
            model: "gpt-6.1-sol",
            stream: true,
            messages: [{ role: "user", content: compactionNote(id, "Earlier work is on shelf 12.") }],
        });

        expect(response.status).toBe(200);
        await response.text();
        expect(sent).toHaveLength(2);
        expect(SafeJSON.stringify(sent[1]?.input)).toContain("Earlier work is on shelf 12.");
    });

    it("retains old ancestor records of active compactions", () => {
        const ancestor = `gtc1.${crypto.randomUUID()}`;
        const child = `gtc1.${crypto.randomUUID()}`;
        const unrelated = `gtc1.${crypto.randomUUID()}`;
        const record = (id: string, history: unknown[]) => ({
            id,
            model: "gpt-6.1-sol",
            createdAt: new Date().toISOString(),
            items: {},
            history,
        });
        saveCompaction(record(ancestor, [{ role: "user", content: [{ type: "input_text", text: "earlier" }] }]));
        saveCompaction(
            record(child, [{ role: "user", content: [{ type: "input_text", text: compactionNote(ancestor) }] }])
        );
        saveCompaction(record(unrelated, []));
        const dir = join(getAiProxyStorage().getBaseDir(), "compactions");
        const old = new Date(Date.now() - 3 * 86_400_000);
        utimesSync(join(dir, `${ancestor}.json`), old, old);
        utimesSync(join(dir, `${unrelated}.json`), old, old);

        const pruned = sweepCompactions(1);

        expect(pruned).toContain(`${unrelated}.json`);
        expect(pruned).not.toContain(`${ancestor}.json`);
        expect(loadCompaction(ancestor)?.history).toHaveLength(1);
    });

    it("a native compaction with no compaction item writes the text summary instead", async () => {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return whamStreamResponse();
        }) as typeof fetch;

        await (
            await send({
                model: "gpt-6.1-sol",
                stream: true,
                messages: [{ role: "user", content: `${CLAUDE_CODE_COMPACTION_MARK}\n\nSummarize.` }],
            })
        ).text();

        expect(sent.length).toBe(2);
        expect(sent[1]?.tool_choice).toBe("none");
        expect(SafeJSON.stringify(sent[1]?.input)).toContain("under 5000 words");
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
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => upstream()) as typeof fetch;
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
        expect(json.error.message).toContain("tools ai-proxy session s-1 use --codex '<account>'");
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
        expect(ClaudeCodeTurn.read(probe).isModelProbe).toBe(true);
        expect(ClaudeCodeTurn.read({ ...probe, max_tokens: 2 }).isModelProbe).toBe(false);
        expect(ClaudeCodeTurn.read({ ...probe, tools: [] }).isModelProbe).toBe(false);
        expect(ClaudeCodeTurn.read({ ...probe, messages: [{ role: "user", content: "Hi there" }] }).isModelProbe).toBe(
            false
        );
        expect(
            ClaudeCodeTurn.read({ ...probe, messages: [...probe.messages, { role: "assistant", content: "Hi" }] })
                .isModelProbe
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

describe("background compaction (Codex async_compaction for Claude Code)", () => {
    const claudeSession = "11111111-2222-4333-8444-555555555555";
    const metadata = { user_id: SafeJSON.stringify({ session_id: claudeSession }) };
    let eventsFile = "";

    beforeEach(async () => {
        const { setCompactionEventsPathForTests } = await import("@app/ai-proxy/lib/sessions/compaction-events");
        const { resetBackgroundForTests } = await import("@app/ai-proxy/lib/sessions/background-compaction");
        eventsFile = join(mkdtempSync(join(tmpdir(), "gt-bgc-")), "events.jsonl");
        setCompactionEventsPathForTests(eventsFile);
        resetBackgroundForTests();
    });

    afterEach(async () => {
        const { setCompactionEventsPathForTests } = await import("@app/ai-proxy/lib/sessions/compaction-events");
        setCompactionEventsPathForTests(undefined);
    });

    it("sweeps expired persisted background data and rejects malformed records", async () => {
        const { backgroundResult, forgetBackgroundInMemoryForTests, sweepBackgroundCompactions, trackBackground } =
            await import("@app/ai-proxy/lib/sessions/background-compaction");
        const key = "retention-test";
        const result = {
            item: { type: "compaction" },
            accountHash: "work",
            prefixLength: 0,
            prefixHash: "hash",
            prefix: [],
            contextTokens: 100,
            startedAt: Date.now(),
            readyAt: Date.now(),
        };
        trackBackground(key, 100, Promise.resolve(result));
        await Promise.resolve();
        const name = `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`;
        const path = join(getAiProxyStorage().getBaseDir(), "background", name);
        expect(existsSync(path)).toBe(true);
        forgetBackgroundInMemoryForTests();
        expect(backgroundResult(key)).toEqual(result);
        forgetBackgroundInMemoryForTests();
        writeFileSync(path, SafeJSON.stringify({ key, result: { ...result, readyAt: undefined } }));
        expect(backgroundResult(key)).toBeUndefined();
        expect(existsSync(path)).toBe(false);
        writeFileSync(path, "{invalid json");
        expect(backgroundResult(key)).toBeUndefined();
        expect(existsSync(path)).toBe(false);
        trackBackground(key, 100, Promise.resolve(result));
        await Promise.resolve();
        const old = new Date(Date.now() - 3 * 86_400_000);
        utimesSync(path, old, old);
        const temporary = `${path}.1.2.3.tmp`;
        writeFileSync(temporary, "unfinished");
        utimesSync(temporary, old, old);
        expect(sweepBackgroundCompactions(1)).toEqual(expect.arrayContaining([name, `${name}.1.2.3.tmp`]));
        expect(existsSync(path)).toBe(false);
        expect(existsSync(temporary)).toBe(false);
    });

    it("keeps the previous background file when a replacement write fails", async () => {
        const { backgroundResult, forgetBackgroundInMemoryForTests, trackBackground } = await import(
            "@app/ai-proxy/lib/sessions/background-compaction"
        );
        const { atomicWriteIo } = await import("@genesiscz/utils/storage/atomic-file");
        const key = "atomic-replacement";
        const result = {
            item: { type: "compaction" },
            accountHash: "work",
            prefixLength: 0,
            prefixHash: "hash",
            prefix: [],
            contextTokens: 100,
            startedAt: Date.now(),
            readyAt: Date.now(),
        };
        trackBackground(key, 100, Promise.resolve(result));
        await Promise.resolve();
        const write = atomicWriteIo.writeSync;
        try {
            atomicWriteIo.writeSync = () => {
                throw new Error("injected write failure");
            };
            trackBackground(key, 200, Promise.resolve({ ...result, contextTokens: 200 }));
            await Promise.resolve();
        } finally {
            atomicWriteIo.writeSync = write;
        }
        forgetBackgroundInMemoryForTests();
        expect(backgroundResult(key)).toEqual(result);
    });

    /** A normal WHAM turn whose usage reports this much context. */
    function turnResponse(text: string, inputTokens: number): Response {
        const sse =
            `event: response.output_text.delta\ndata: ${SafeJSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n` +
            `event: response.completed\ndata: ${SafeJSON.stringify({
                type: "response.completed",
                response: {
                    status: "completed",
                    output: [],
                    usage: {
                        input_tokens: inputTokens,
                        input_tokens_details: { cached_tokens: inputTokens - 10 },
                        output_tokens: 3,
                    },
                },
            })}\n\n`;
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }

    const isCompaction = (body: Record<string, unknown>) => {
        const input = Array.isArray(body.input) ? body.input : [];
        return SafeJSON.stringify(input.at(-1)) === SafeJSON.stringify({ type: "compaction_trigger" });
    };

    async function send(body: Record<string, unknown>, sessionId: string): Promise<string> {
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);
        const bodyText = SafeJSON.stringify({ model: "gpt-6.1-sol", stream: true, system: "S", metadata, ...body });
        const response = await provider.messages?.(
            new Request("http://localhost/v1/messages", { method: "POST", body: bodyText }),
            "gpt-6.1-sol",
            bodyText,
            { sessionId }
        );
        return (await response?.text()) ?? "";
    }

    function events(): Array<Record<string, unknown>> {
        try {
            return readFileSync(eventsFile, "utf8")
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => SafeJSON.parse(line) as Record<string, unknown>);
        } catch {
            return [];
        }
    }

    const u1 = { role: "user", content: "The code word is KESTREL." };
    const a1 = { role: "assistant", content: "Noted." };
    const u2 = { role: "user", content: "Also remember shelf 31." };
    const a2 = { role: "assistant", content: "Shelf 31 noted." };
    const compactTurn = (first: Record<string, unknown>) => [
        first,
        a1,
        u2,
        a2,
        { role: "user", content: [{ type: "text", text: `${CLAUDE_CODE_COMPACTION_MARK}\nSummarize.` }] },
    ];

    async function primeBackground(sent: Array<Record<string, unknown>>) {
        const sessionId = crypto.randomUUID();
        createSessionRecord({ id: sessionId, window: 1000, compactPercent: 50 });
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            const body = SafeJSON.parse(String(init?.body)) as Record<string, unknown>;
            sent.push(body);
            return isCompaction(body) ? whamCompactionResponse("ENC-BG") : turnResponse("ok", 450);
        }) as typeof fetch;
        // 450 of a 500-token compaction point is past the 0.8 start: this turn starts the background run.
        await send({ messages: [u1] }, sessionId);
        const { backgroundInFlight } = await import("@app/ai-proxy/lib/sessions/background-compaction");
        const { backgroundKey } = await import("@app/ai-proxy/lib/sessions/background-compaction");
        await backgroundInFlight(backgroundKey(claudeSession, "S"));
        return sessionId;
    }

    it("answers the compaction turn from the background run and keeps the later turns behind its item", async () => {
        const sent: Array<Record<string, unknown>> = [];
        const sessionId = await primeBackground(sent);

        expect(sent.filter(isCompaction)).toHaveLength(1);
        const reply = await send({ messages: compactTurn(u1) }, sessionId);
        const inner = reply.match(/<summary>\\n([\s\S]*?)\\n<\/summary>/)?.[1] ?? "";

        // No second compaction request: the background item answered.
        expect(sent.filter(isCompaction)).toHaveLength(1);
        expect(inner).toContain("[codex-compaction gtc1.");

        await send(
            { messages: [{ role: "user", content: `Summary:\n${inner.replaceAll("\\n", "\n")}\n\nGo on.` }] },
            sessionId
        );
        const next = (sent.at(-1)?.input ?? []) as Array<Record<string, unknown>>;
        expect(next[0]).toEqual({ type: "compaction", id: "cmp_1", encrypted_content: "ENC-BG" });
        const text = SafeJSON.stringify(next);
        expect(text).toContain("Also remember shelf 31.");
        expect(text).toContain("Shelf 31 noted.");
        expect(text).not.toContain("KESTREL");
        expect(events().map((event) => event.kind)).toEqual(
            expect.arrayContaining(["background-start", "background-ready", "background-used", "done"])
        );
    });

    it("sends a kept turn once when Claude Code also keeps it after the summary", async () => {
        const sent: Array<Record<string, unknown>> = [];
        const sessionId = await primeBackground(sent);
        const reply = await send({ messages: compactTurn(u1) }, sessionId);
        const inner = (reply.match(/<summary>\\n([\s\S]*?)\\n<\/summary>/)?.[1] ?? "").replaceAll("\\n", "\n");
        await send(
            {
                messages: [{ role: "user", content: `Summary:\n${inner}` }, a2, { role: "user", content: "Go on." }],
            },
            sessionId
        );
        const text = SafeJSON.stringify(sent.at(-1)?.input);

        expect(text.split("Shelf 31 noted.").length - 1).toBe(1);
        expect(text).toContain("Also remember shelf 31.");
    });

    it("records the older ready run as wasted when a newer run replaces it unused", async () => {
        // Regression test: 2026-10-28-Research-Session8cf9eff2Slowdowns.sonnet.md Bug 5 — a replaced run (03:15 to
        // 03:17, 363K tokens read) left no event at all.
        const sent: Array<Record<string, unknown>> = [];
        const sessionId = await primeBackground(sent);
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            const body = SafeJSON.parse(String(init?.body)) as Record<string, unknown>;
            sent.push(body);
            return isCompaction(body) ? whamCompactionResponse("ENC-BG-2") : turnResponse("ok", 600);
        }) as typeof fetch;
        // 600 is 33% past the first run's 450: a refresh run starts and replaces the unused first result.
        await send({ messages: [u1, a1, u2] }, sessionId);
        const { backgroundInFlight, backgroundKey } = await import("@app/ai-proxy/lib/sessions/background-compaction");
        await backgroundInFlight(backgroundKey(claudeSession, "S"));

        expect(sent.filter(isCompaction)).toHaveLength(2);
        expect(
            events()
                .filter((event) => event.kind === "background-wasted")
                .map((event) => event.reason)
        ).toEqual(["superseded"]);
    });

    it("answers the compaction turn from a run that finished before the proxy restarted", async () => {
        // Regression test: Bug 5 — the run lived only in process memory; 17 restarts in one session lost such runs.
        const sent: Array<Record<string, unknown>> = [];
        const sessionId = await primeBackground(sent);
        const { forgetBackgroundInMemoryForTests } = await import("@app/ai-proxy/lib/sessions/background-compaction");
        forgetBackgroundInMemoryForTests();

        const reply = await send({ messages: compactTurn(u1) }, sessionId);

        expect(sent.filter(isCompaction)).toHaveLength(1);
        expect(reply).toContain("[codex-compaction gtc1.");
    });

    it("does not start a second run after a restart while the saved run is still fresh", async () => {
        const sent: Array<Record<string, unknown>> = [];
        const sessionId = await primeBackground(sent);
        const { forgetBackgroundInMemoryForTests } = await import("@app/ai-proxy/lib/sessions/background-compaction");
        forgetBackgroundInMemoryForTests();

        // 460 is only 2% past the saved run's 450: no refresh is due.
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            const body = SafeJSON.parse(String(init?.body)) as Record<string, unknown>;
            sent.push(body);
            return isCompaction(body) ? whamCompactionResponse("ENC-BG-2") : turnResponse("ok", 460);
        }) as typeof fetch;
        await send({ messages: [u1, a1, u2] }, sessionId);
        const { backgroundInFlight, backgroundKey } = await import("@app/ai-proxy/lib/sessions/background-compaction");
        await backgroundInFlight(backgroundKey(claudeSession, "S"));

        expect(sent.filter(isCompaction)).toHaveLength(1);
    });

    it("compacts again and tells the agent when the history changed under the background run", async () => {
        const sent: Array<Record<string, unknown>> = [];
        const sessionId = await primeBackground(sent);
        const reply = await send(
            { messages: compactTurn({ role: "user", content: "The code word is FALCON." }) },
            sessionId
        );

        expect(sent.filter(isCompaction)).toHaveLength(2);
        expect(reply).toContain("Proxy notice");
        expect(reply).toContain("the conversation before it changed");
        const wasted = events().find((event) => event.kind === "background-wasted");
        expect(wasted?.reason).toBe("history_changed");

        // The next turn carries a one-time reminder to tell the user; the turn after it does not.
        await send({ messages: [{ role: "user", content: "Go on." }] }, sessionId);
        expect(SafeJSON.stringify(sent.at(-1)?.input)).toContain("Start your next reply with one sentence");
        await send({ messages: [{ role: "user", content: "Go on." }] }, sessionId);
        expect(SafeJSON.stringify(sent.at(-1)?.input)).not.toContain("Start your next reply");
    });

    it("does not start a background run below the start fraction or outside a ccx session", async () => {
        const sent: Array<Record<string, unknown>> = [];
        const sessionId = crypto.randomUUID();
        createSessionRecord({ id: sessionId, window: 1000, compactPercent: 50 });
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return turnResponse("ok", 300);
        }) as typeof fetch;
        await send({ messages: [u1] }, sessionId);
        const plain = crypto.randomUUID();
        createSessionRecord({ id: plain });
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return turnResponse("ok", 900_000);
        }) as typeof fetch;
        await send({ messages: [u1] }, plain);
        await Bun.sleep(20);

        expect(sent.filter(isCompaction)).toHaveLength(0);
    });

    it("logs Claude Code's second ask for a summary as a retry", async () => {
        const sessionId = crypto.randomUUID();
        createSessionRecord({ id: sessionId });
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) =>
            whamCompactionResponse("ENC-R")) as typeof fetch;
        await send(
            {
                messages: [
                    u1,
                    {
                        role: "user",
                        content: `${CLAUDE_CODE_COMPACTION_MARK}\nSummarize.\n\nFor this reply only: put the summary inside <summary></summary> tags.`,
                    },
                ],
            },
            sessionId
        );

        expect(events().find((event) => event.kind === "retry")).toBeDefined();
    });
});

describe("background compaction matching", () => {
    const settings = { enabled: true, startAt: 0.8, refreshFraction: 0.15, maxTailFraction: 0.4 };

    async function result(prefix: unknown[]) {
        const { prefixHash } = await import("@app/ai-proxy/lib/sessions/background-compaction");
        return {
            item: { type: "compaction", encrypted_content: "E" },
            accountHash: "loginaaa",
            prefixLength: prefix.length,
            prefixHash: prefixHash(prefix),
            prefix,
            contextTokens: 100,
            startedAt: 0,
            readyAt: 0,
        };
    }

    it("names each reason a background result cannot answer the turn", async () => {
        const { matchBackground } = await import("@app/ai-proxy/lib/sessions/background-compaction");
        const prefix = [{ role: "user", content: [{ type: "input_text", text: "a" }] }];
        const done = await result(prefix);
        const tail = [{ role: "assistant", content: [{ type: "output_text", text: "b" }] }];
        const base = { result: done, point: 1000, tailTokens: () => 10, settings };

        expect(matchBackground({ ...base, rawInput: [...prefix, ...tail], accountHash: "loginaaa" })).toEqual({
            use: true,
            tail,
        });
        expect(matchBackground({ ...base, rawInput: [...prefix, ...tail], accountHash: "loginbbb" })).toEqual({
            use: false,
            reason: "login_changed",
        });
        expect(matchBackground({ ...base, rawInput: tail, accountHash: "loginaaa" })).toEqual({
            use: false,
            reason: "history_changed",
        });
        expect(
            matchBackground({ ...base, tailTokens: () => 401, rawInput: [...prefix, ...tail], accountHash: "loginaaa" })
        ).toEqual({ use: false, reason: "tail_too_large" });
    });

    it("starts once per growth step and never while a run is in flight", async () => {
        const { resetBackgroundForTests, shouldStartBackground, trackBackground } = await import(
            "@app/ai-proxy/lib/sessions/background-compaction"
        );
        resetBackgroundForTests();
        const at = (contextTokens: number) => shouldStartBackground({ key: "k", contextTokens, point: 1000, settings });

        expect(at(799)).toBe(false);
        expect(at(800)).toBe(true);
        let finish: (value: undefined) => void = () => {};
        trackBackground("k", 800, new Promise((resolve) => (finish = resolve)));
        expect(at(990)).toBe(false);
        finish(undefined);
        await Bun.sleep(1);
        expect(at(900)).toBe(false);
        expect(at(950)).toBe(true);
    });
});

describe("background compaction thread key", () => {
    it("ignores the cache marks on the system blocks", async () => {
        const { backgroundKey } = await import("@app/ai-proxy/lib/sessions/background-compaction");
        const block = { type: "text", text: "You are Claude Code." };

        expect(backgroundKey("s", [{ ...block, cache_control: { type: "ephemeral", ttl: "1h" } }])).toBe(
            backgroundKey("s", [{ ...block, cache_control: { type: "ephemeral" } }])
        );
        expect(backgroundKey("s", [block])).not.toBe(backgroundKey("s", [{ ...block, text: "A subagent." }]));
    });
});

describe("tools that Claude Code's tool search loads, on the Codex agent", () => {
    // Regression test: the live tool-list probe of 2026-10-28 — any change
    // of `tools` reads 0% of the WHAM prompt cache, also an append; session 8cf9eff2 lost 1.15M tokens in 5 loads.
    const tool = (name: string, deferred = false) => ({
        name,
        description: `${name} tool`,
        input_schema: { type: "object", properties: { value: { type: "string" } } },
        ...(deferred ? { defer_loading: true } : {}),
    });
    const before = [
        { role: "user", content: "check the bus" },
        {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_search", name: "ToolSearch", input: { query: "select:Monitor" } }],
        },
    ];
    const loaded = [
        ...before,
        {
            role: "user",
            content: [
                {
                    type: "tool_result",
                    tool_use_id: "call_search",
                    content: [{ type: "tool_reference", tool_name: "Monitor" }],
                },
            ],
        },
    ];

    async function sentBody(
        messages: unknown[],
        tools: unknown[],
        clientKey?: string,
        cacheKey?: { key: string; source: "client" | "content" }
    ): Promise<Record<string, unknown>> {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return whamStreamResponse();
        }) as typeof fetch;
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);
        const bodyText = SafeJSON.stringify({ model: "gpt-6.1-sol", stream: true, max_tokens: 1024, tools, messages });
        const res = await provider.messages?.(
            new Request("http://localhost/v1/messages", {
                method: "POST",
                body: bodyText,
                headers: clientKey ? { authorization: `Bearer ${clientKey}` } : {},
            }),
            "gpt-6.1-sol",
            bodyText,
            cacheKey ? { promptCacheKey: cacheKey } : undefined
        );
        await res?.text();
        return sent[0] ?? {};
    }

    it("does not introduce deferred tools on a never-loaded first turn", async () => {
        const body = await sentBody([{ role: "user", content: "check the bus" }], [tool("Monitor", true)]);
        const input = body.input as Array<Record<string, unknown>>;
        expect(input.some((item) => item.type === "additional_tools")).toBe(false);
    });

    it("introduces a surviving tool use once without changing earlier input prefixes", async () => {
        const tools = [tool("Monitor", true), tool("TaskStop", true)];
        const first = [{ role: "user", content: "check status" }];
        const call = (name: string, id: string) => ({
            role: "assistant",
            content: [{ type: "tool_use", id, name, input: {} }],
        });
        const result = (id: string) => ({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, content: "done" }],
        });
        const used = [...first, call("Monitor", "call-one"), result("call-one")];
        const more = [...used, call("Monitor", "call-two"), result("call-two"), call("TaskStop", "call-three")];
        const initial = (await sentBody(first, tools)).input as Array<Record<string, unknown>>;
        const second = (await sentBody(used, tools)).input as Array<Record<string, unknown>>;
        const third = (await sentBody(more, tools)).input as Array<Record<string, unknown>>;
        expect(second.slice(0, initial.length)).toEqual(initial);
        expect(third.slice(0, second.length)).toEqual(second);
        const additions = third.filter((item) => item.type === "additional_tools");
        expect(additions.map((item) => (item.tools as Array<{ name: string }>).map((entry) => entry.name))).toEqual([
            ["Monitor"],
            ["TaskStop"],
        ]);
        const monitor = third.findIndex((item) => item.type === "function_call" && item.name === "Monitor");
        expect(third[monitor - 1]?.type).toBe("additional_tools");
    });

    it("does not reintroduce a tool whose search reference survived", async () => {
        const history = [
            ...loaded,
            { role: "assistant", content: [{ type: "tool_use", id: "m1", name: "Monitor", input: {} }] },
        ];
        const body = await sentBody(history, [tool("Monitor", true), tool("ToolSearch")]);
        const additions = (body.input as Array<Record<string, unknown>>).filter(
            (item) => item.type === "additional_tools"
        );
        expect(additions).toHaveLength(1);
    });

    it("keeps compacted introductions stable across later searches and new deferred tools", async () => {
        const first = [
            { role: "user", content: "This session is being continued.\n\nSummary: cache regression case." },
        ];
        const search = (id: string, name: string) => [
            { role: "assistant", content: [{ type: "tool_use", id, name: "ToolSearch", input: { query: name } }] },
            {
                role: "user",
                content: [
                    { type: "tool_result", tool_use_id: id, content: [{ type: "tool_reference", tool_name: name }] },
                ],
            },
        ];
        const initialTools = [tool("Monitor", true), tool("ToolSearch")];
        const nextTools = [tool("Monitor", true), tool("TaskStop", true), tool("ToolSearch")];
        const afterMonitor = [...first, ...search("search-one", "Monitor")];
        const afterTask = [...afterMonitor, ...search("search-two", "TaskStop")];
        const cacheKey = { key: "continuation-a", source: "client" as const };
        const initial = (await sentBody(first, initialTools, "client-a", cacheKey)).input as Array<
            Record<string, unknown>
        >;
        const second = (await sentBody(afterMonitor, nextTools, "client-a", cacheKey)).input as Array<
            Record<string, unknown>
        >;
        const third = (await sentBody(afterTask, nextTools, "client-a", cacheKey)).input as Array<
            Record<string, unknown>
        >;
        expect(second.slice(0, initial.length)).toEqual(initial);
        expect(third.slice(0, second.length)).toEqual(second);
        const names = third
            .filter((item) => item.type === "additional_tools")
            .map((item) => (item.tools as Array<{ name: string }>).map((entry) => entry.name));
        expect(names).toEqual([["Monitor"], ["TaskStop"]]);
    });

    it("isolates remembered compacted introductions by client", async () => {
        const history = [{ role: "user", content: "This session is being continued.\n\nSummary: separate clients." }];
        const cacheKey = { key: "shared-id", source: "client" as const };
        const first = await sentBody(history, [tool("Monitor", true)], "client-a", cacheKey);
        const second = await sentBody(history, [tool("TaskStop", true)], "client-b", cacheKey);
        const names = (body: Record<string, unknown>) => {
            const input = body.input as Array<Record<string, unknown>>;
            return (input[0]?.tools as Array<{ name: string }> | undefined)?.map((entry) => entry.name);
        };
        expect(names(first)).toEqual(["Monitor"]);
        expect(names(second)).toEqual(["TaskStop"]);
    });

    it("does not share recovery snapshots without a trusted conversation identity", async () => {
        const names = (body: Record<string, unknown>) => {
            const input = body.input as Array<Record<string, unknown>>;
            return (input[0]?.tools as Array<{ name: string }> | undefined)?.map((entry) => entry.name);
        };
        for (const cacheKey of [undefined, { key: "same-content", source: "content" as const }]) {
            const suffix = cacheKey ? "content" : "anonymous";
            const history = [{ role: "user", content: `This session is being continued.\n\nSummary: ${suffix} test.` }];
            const first = await sentBody(history, [tool("Monitor", true)], "client-a", cacheKey);
            const second = await sentBody(history, [tool("TaskStop", true)], "client-a", cacheKey);
            expect(names(first)).toEqual(["Monitor"]);
            expect(names(second)).toEqual(["TaskStop"]);
        }
    });

    it("still introduces every tool when the recovery snapshot exceeds its memory limit", async () => {
        const history = [{ role: "user", content: "This session is being continued.\n\nSummary: many tools." }];
        const tools = Array.from({ length: 513 }, (_, index) => tool(`Deferred${index}`, true));
        const body = await sentBody(history, tools, "client-a", { key: "many-tools", source: "client" });
        const input = body.input as Array<Record<string, unknown>>;
        expect((input[0]?.tools as unknown[] | undefined)?.length).toBe(513);
    });

    it("introduces a deferred tool whose search result is absent after compaction", async () => {
        const body = await sentBody(
            [{ role: "user", content: "This session is being continued.\n\nSummary:\nMonitor was loaded." }],
            [tool("Monitor", true)]
        );
        const input = body.input as Array<Record<string, unknown>>;
        expect(input[0]?.type).toBe("additional_tools");
        expect((input[0]?.tools as Array<{ name: string }> | undefined)?.map((item) => item.name)).toEqual(["Monitor"]);
    });

    it("keeps `tools` the same after a load and makes the loaded tool callable from the input, after its search result", async () => {
        const first = await sentBody(before, [tool("Bash"), tool("ToolSearch")]);
        // Claude Code 2.1.310 inserts the loaded tool by name order, with defer_loading.
        const second = await sentBody(loaded, [tool("Bash"), tool("Monitor", true), tool("ToolSearch")]);
        const names = (body: Record<string, unknown>) =>
            (body.tools as Array<{ name: string }> | undefined)?.map((t) => t.name);

        expect(names(second)).toEqual(["Bash", "ToolSearch"]);
        expect(names(second)).toEqual(names(first));

        const input = second.input as Array<Record<string, unknown>>;
        const output = input.findIndex(
            (item) => item.type === "function_call_output" && item.call_id === "call_search"
        );
        const added = input[output + 1];
        expect(added?.type).toBe("additional_tools");
        expect(added?.role).toBe("developer");
        expect((added?.tools as Array<{ name: string }> | undefined)?.map((t) => t.name)).toEqual(["Monitor"]);
    });

    it("sends what an earlier request sent as an exact prefix when a second tool loads, each tool once", async () => {
        const tools = [tool("Bash"), tool("Monitor", true), tool("TaskStop", true), tool("ToolSearch")];
        const second = await sentBody(loaded, [tool("Bash"), tool("Monitor", true), tool("ToolSearch")]);
        const third = await sentBody(
            [
                ...loaded,
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            id: "call_again",
                            name: "ToolSearch",
                            input: { query: "select:Monitor,TaskStop" },
                        },
                    ],
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "call_again",
                            content: [
                                { type: "tool_reference", tool_name: "Monitor" },
                                { type: "tool_reference", tool_name: "TaskStop" },
                            ],
                        },
                    ],
                },
            ],
            tools
        );
        const secondInput = second.input as Array<Record<string, unknown>>;
        const thirdInput = third.input as Array<Record<string, unknown>>;

        expect(thirdInput.slice(0, secondInput.length)).toEqual(secondInput);
        expect(third.tools).toEqual(second.tools);
        const added = thirdInput.filter((item) => item.type === "additional_tools");
        expect(added.map((item) => (item.tools as Array<{ name: string }>).map((t) => t.name))).toEqual([
            ["Monitor"],
            ["TaskStop"],
        ]);
    });
});

describe("final reasoning reply at the next typed turn", () => {
    function reasoningReply(status: "completed" | "incomplete" = "completed", text = "answer"): Response {
        const reasoning = {
            type: "reasoning",
            id: "rs_final",
            encrypted_content: "encrypted",
            summary: [{ type: "summary_text", text: "think" }],
        };
        const message = { type: "message", content: [{ type: "output_text", text }] };
        const events: Array<Record<string, unknown>> = [
            { type: "response.output_item.added", output_index: 0, item: reasoning },
            { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "think" },
            { type: "response.output_item.done", output_index: 0, item: reasoning },
            { type: "response.output_item.added", output_index: 1, item: message },
        ];
        for (let offset = 0; offset < text.length; offset += 512) {
            events.push({
                type: "response.output_text.delta",
                output_index: 1,
                delta: text.slice(offset, offset + 512),
            });
        }
        events.push(
            { type: "response.output_item.done", output_index: 1, item: message },
            { type: `response.${status}`, response: { id: "resp_final", status, output: [reasoning, message] } }
        );
        return new Response(events.map((event) => `data: ${SafeJSON.stringify(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
        });
    }

    async function visibleContent(response: Response, stream: boolean): Promise<Array<Record<string, unknown>>> {
        if (!stream) {
            const body: unknown = await response.json();
            return isObject(body) && Array.isArray(body.content) ? body.content.filter(isObject) : [];
        }
        const content: Array<Record<string, unknown>> = [];
        for (const line of (await response.text()).split("\n")) {
            if (!line.startsWith("data: ")) {
                continue;
            }
            const event: unknown = SafeJSON.parse(line.slice(6), { strict: true });
            if (!isObject(event) || typeof event.index !== "number") {
                continue;
            }
            if (event.type === "content_block_start" && isObject(event.content_block)) {
                content[event.index] = { ...event.content_block };
            } else if (event.type === "content_block_delta" && isObject(event.delta)) {
                const block = content[event.index];
                if (!block) {
                    continue;
                }
                if (event.delta.type === "thinking_delta") {
                    block.thinking = String(block.thinking ?? "") + String(event.delta.thinking ?? "");
                } else if (event.delta.type === "signature_delta") {
                    block.signature = event.delta.signature;
                } else if (event.delta.type === "text_delta") {
                    block.text = String(block.text ?? "") + String(event.delta.text ?? "");
                }
            }
        }
        return content;
    }

    it("does not remember an incomplete streamed reply", async () => {
        const { responsesSseToAnthropic } = await import(
            "@app/ai-proxy/lib/translators/formats/anthropic/grok-responses-to-anthropic"
        );
        const body = reasoningReply("incomplete").body;
        if (!body) {
            throw new Error("fixture has no stream");
        }
        let called = false;
        const stream = responsesSseToAnthropic(body, {
            model: "test-model",
            signReasoning: () => "signature",
            onTextResponse: () => {
                called = true;
            },
        });
        await new Response(stream).text();
        expect(called).toBe(false);
    });

    for (const stream of [true, false]) {
        it(`delivers but does not remember an oversized ${stream ? "streamed" : "non-streamed"} reply`, async () => {
            resetReasoningMemoryForTests();
            const { MAX_REPLAY_RESPONSE_CHARS } = await import(
                "@app/ai-proxy/lib/translators/formats/anthropic/grok-responses-to-anthropic"
            );
            const answer = "x".repeat(MAX_REPLAY_RESPONSE_CHARS + 1);
            const sent: Array<Record<string, unknown>> = [];
            globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
                sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
                return sent.length === 1 ? reasoningReply("completed", answer) : whamStreamResponse();
            }) as typeof fetch;
            const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
            const provider = await OpenAiSubscriptionProvider.create(account);
            const context = { promptCacheKey: { key: `oversized-${stream}`, source: "client" as const } };
            const send = async (messages: unknown[], streaming: boolean) => {
                const body = SafeJSON.stringify({ model: "gpt-6.1-sol", stream: streaming, messages });
                const result = await provider.messages?.(
                    new Request("http://localhost/v1/messages", { method: "POST", body }),
                    "gpt-6.1-sol",
                    body,
                    context
                );
                if (!result) {
                    throw new Error("provider returned no response");
                }
                return result;
            };
            const first = [{ role: "user", content: "question" }];
            const visible = await visibleContent(await send(first, stream), stream);
            expect(visible.find((block) => block.type === "text")?.text).toBe(answer);
            await (
                await send(
                    [
                        ...first,
                        { role: "assistant", content: visible.filter((block) => block.type !== "thinking") },
                        { role: "user", content: "follow-up" },
                    ],
                    true
                )
            ).text();
            const input = sent[1]?.input;
            expect(Array.isArray(input)).toBe(true);
            expect(Array.isArray(input) && input.some((item) => isObject(item) && item.type === "reasoning")).toBe(
                false
            );
        });
        for (const trusted of [true, false]) {
            it(`${trusted ? "restores" : "does not restore"} reasoning from a final ${stream ? "streamed" : "non-streamed"} reply ${trusted ? "with a trusted identity" : "with a content-only identity"}`, async () => {
                resetReasoningMemoryForTests();
                const sent: Array<Record<string, unknown>> = [];
                globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
                    sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
                    return sent.length === 1 ? reasoningReply() : whamStreamResponse();
                }) as typeof fetch;
                const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
                const provider = await OpenAiSubscriptionProvider.create(account);
                const context = {
                    promptCacheKey: {
                        key: `reply-${stream}`,
                        source: trusted ? ("client" as const) : ("content" as const),
                    },
                };
                const send = async (messages: unknown[], streaming: boolean) => {
                    const body = SafeJSON.stringify({ model: "gpt-6.1-sol", stream: streaming, messages });
                    const result = await provider.messages?.(
                        new Request("http://localhost/v1/messages", { method: "POST", body }),
                        "gpt-6.1-sol",
                        body,
                        context
                    );
                    if (!result) {
                        throw new Error("provider returned no response");
                    }
                    return result;
                };
                const first = [{ role: "user", content: "question" }];
                const visible = await visibleContent(await send(first, stream), stream);
                expect(visible.map((block) => block.type)).toEqual(["thinking", "text"]);
                const next = [
                    ...first,
                    { role: "assistant", content: visible.filter((block) => block.type !== "thinking") },
                    { role: "user", content: "follow-up" },
                ];
                await (await send(next, true)).text();
                const input = sent[1]?.input;
                expect(Array.isArray(input)).toBe(true);
                const reasoning = Array.isArray(input)
                    ? input.find((item) => isObject(item) && item.type === "reasoning" && item.id === "rs_final")
                    : undefined;
                if (trusted) {
                    expect(reasoning).toEqual({
                        type: "reasoning",
                        id: "rs_final",
                        encrypted_content: "encrypted",
                        summary: [{ type: "summary_text", text: "think" }],
                    });
                } else {
                    expect(reasoning).toBeUndefined();
                }
            });
        }
    }
});

describe("Claude Code's turn-start thinking flip, on the Codex agent", () => {
    // Regression test: the 2026-10-28 analysis of session 8cf9eff2, Bug 2 — the first request of a typed turn carries no earlier thinking, so the upstream history changed at the
    // first reasoning item and the request read 0% of the cache (1.41M uncached tokens in 4 requests).
    const session = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
    const thinking = {
        type: "thinking",
        thinking: "check the clock",
        signature: packReasoningEnvelope(
            { provider: "codex", accountHash: accountHash8("codex"), model: "gpt-6.1-sol", compHash: "0" },
            { id: "rs_flip", encrypted_content: "blob-flip", summary: [] }
        ),
    };
    const toolUse = { type: "tool_use", id: "call_clock", name: "get_time", input: { zone: "UTC" } };
    const toolResult = {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_clock", content: "12:00" }],
    };

    async function sentInput(
        messages: unknown[],
        options: { source?: "content" | "claude-session"; accountName?: string } = {}
    ): Promise<Array<Record<string, unknown>>> {
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return whamStreamResponse();
        }) as typeof fetch;
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(
            options.accountName ? { ...account, name: options.accountName } : account
        );
        const bodyText = SafeJSON.stringify({ model: "gpt-6.1-sol", stream: true, max_tokens: 1024, messages });
        const res = await provider.messages?.(
            new Request("http://localhost/v1/messages", { method: "POST", body: bodyText }),
            "gpt-6.1-sol",
            bodyText,
            { promptCacheKey: { key: session, source: options.source ?? "claude-session" } }
        );
        await res?.text();
        return (sent[0]?.input ?? []) as Array<Record<string, unknown>>;
    }

    it("puts the reasoning back that the first request of a new turn left out, so the earlier input stays a prefix", async () => {
        const toolLoop = await sentInput([
            { role: "user", content: "what time is it" },
            { role: "assistant", content: [thinking, toolUse] },
            toolResult,
        ]);
        const nextTurn = await sentInput([
            { role: "user", content: "what time is it" },
            { role: "assistant", content: [toolUse] },
            toolResult,
            { role: "assistant", content: [{ type: "text", text: "It is 12:00." }] },
            { role: "user", content: "and in Prague?" },
        ]);

        expect(toolLoop.some((item) => item.type === "reasoning")).toBe(true);
        expect(nextTurn.slice(0, toolLoop.length)).toEqual(toolLoop);
    });

    it("does not restore across accounts or from a content-only identity", async () => {
        resetReasoningMemoryForTests();
        const original = [
            { role: "user", content: "question" },
            { role: "assistant", content: [thinking, toolUse] },
            toolResult,
        ];
        const omitted = [{ role: "user", content: "question" }, { role: "assistant", content: [toolUse] }, toolResult];
        expect((await sentInput(original)).some((item) => item.type === "reasoning")).toBe(true);
        expect((await sentInput(omitted, { accountName: "other" })).some((item) => item.type === "reasoning")).toBe(
            false
        );
        resetReasoningMemoryForTests();
        await sentInput(original, { source: "content" });
        expect((await sentInput(omitted, { source: "content" })).some((item) => item.type === "reasoning")).toBe(false);
    });

    it("never gives one conversation's remembered reasoning to another conversation", async () => {
        await sentInput([
            { role: "user", content: "what time is it" },
            { role: "assistant", content: [thinking, toolUse] },
            toolResult,
        ]);
        const sent: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return whamStreamResponse();
        }) as typeof fetch;
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(account);
        const bodyText = SafeJSON.stringify({
            model: "gpt-6.1-sol",
            stream: true,
            max_tokens: 1024,
            messages: [
                { role: "user", content: "what time is it" },
                { role: "assistant", content: [toolUse] },
                toolResult,
            ],
        });
        const res = await provider.messages?.(
            new Request("http://localhost/v1/messages", { method: "POST", body: bodyText }),
            "gpt-6.1-sol",
            bodyText,
            { promptCacheKey: { key: "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e", source: "claude-session" } }
        );
        await res?.text();

        const input = (sent[0]?.input ?? []) as Array<Record<string, unknown>>;
        expect(input.filter((item) => item.type === "reasoning")).toEqual([]);
    });
});

describe("a changed effort on one Claude Code thread, on the Codex agent", () => {
    // Regression test: 2026-10-28-Research-Session8cf9eff2Slowdowns.sonnet.md Bug 3 — Codex keeps one prompt cache per
    // effort, so /effort re-read up to 430K tokens without the cache, and nothing said so.
    const claudeSession = "22222222-3333-4444-8555-666666666666";
    const metadata = { user_id: SafeJSON.stringify({ session_id: claudeSession }) };
    let eventsFile = "";
    let sent: Array<Record<string, unknown>> = [];

    beforeEach(async () => {
        const { setCompactionEventsPathForTests } = await import("@app/ai-proxy/lib/sessions/compaction-events");
        const { resetCacheShapeForTests } = await import("@app/ai-proxy/lib/sessions/cache-shape");
        eventsFile = join(mkdtempSync(join(tmpdir(), "gt-effort-")), "events.jsonl");
        setCompactionEventsPathForTests(eventsFile);
        resetCacheShapeForTests();
        sent = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            sent.push(SafeJSON.parse(String(init?.body)) as Record<string, unknown>);
            return whamStreamResponse();
        }) as typeof fetch;
    });

    afterEach(async () => {
        const { setCompactionEventsPathForTests } = await import("@app/ai-proxy/lib/sessions/compaction-events");
        setCompactionEventsPathForTests(undefined);
    });

    async function send(
        effort: string | undefined,
        system = "Lead system prompt",
        identity: { accountName?: string; clientKey?: string; conversation?: string } = {}
    ): Promise<unknown> {
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const { prefixDiffFor } = await import("@app/ai-proxy/lib/usage/prefix-diff");
        const provider = await OpenAiSubscriptionProvider.create({
            ...account,
            name: identity.accountName ?? account.name,
            openaiSub: { defaultReasoningEffort: "low" },
        });
        const bodyText = SafeJSON.stringify({
            model: "gpt-6.1-sol",
            stream: true,
            system,
            metadata,
            output_config: { effort },
            messages: [{ role: "user", content: "go on" }],
        });
        const req = new Request("http://localhost/v1/messages", {
            method: "POST",
            body: bodyText,
            headers: identity.clientKey ? { authorization: `Bearer ${identity.clientKey}` } : {},
        });
        const res = await provider.messages?.(
            req,
            "gpt-6.1-sol",
            bodyText,
            identity.conversation ? { promptCacheKey: { key: identity.conversation, source: "client" } } : undefined
        );
        await res?.text();
        return prefixDiffFor(req);
    }

    function events(): Array<Record<string, unknown>> {
        try {
            return readFileSync(eventsFile, "utf8")
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => SafeJSON.parse(line) as Record<string, unknown>);
        } catch {
            return [];
        }
    }

    it("isolates shape, reminders and prefix diagnostics across accounts, clients and conversations", async () => {
        const owner = { accountName: "work", clientKey: "client-a", conversation: "conversation-a" };
        await send("high", undefined, owner);
        await send("xhigh", undefined, owner);
        expect(SafeJSON.stringify(sent[1]?.input)).toContain("<system-reminder>");
        for (const other of [
            { ...owner, accountName: "personal" },
            { ...owner, clientKey: "client-b" },
            { ...owner, conversation: "conversation-b" },
        ]) {
            const index = sent.length;
            expect(await send("high", undefined, other)).toEqual({ part: "first" });
            expect(SafeJSON.stringify(sent[index]?.input)).not.toContain("<system-reminder>");
        }
        expect(events().filter((event) => event.kind === "cache-reset")).toHaveLength(1);
        await send("xhigh", undefined, owner);
        expect(SafeJSON.stringify(sent.at(-1)?.input)).toContain("<system-reminder>");
    });

    it("records a cache-reset event that names both efforts", async () => {
        await send("high");
        await send("xhigh");

        expect(
            events()
                .filter((event) => event.kind === "cache-reset")
                .map((event) => event.reason)
        ).toEqual(["effort high -> xhigh"]);
    });

    it("tells the agent in that request that the whole context was re-read without the cache", async () => {
        await send("high");
        await send("xhigh");

        const last = SafeJSON.stringify(sent[1]?.input);
        expect(last).toContain("<system-reminder>");
        expect(last).toContain("high to xhigh");
        expect(SafeJSON.stringify(sent[0]?.input)).not.toContain("<system-reminder>");
    });

    it("keeps the reminder in a continuation at the same effort", async () => {
        await send("high");
        await send("xhigh");
        await send("xhigh");
        expect(sent[2]?.input).toEqual(sent[1]?.input);
    });

    it("does not report a change for an explicit default effort", async () => {
        await send(undefined);
        await send("low");
        expect(events().filter((event) => event.kind === "cache-reset")).toEqual([]);
    });

    it("stays quiet when the effort repeats, and for a subagent that has its own system prompt", async () => {
        await send("high");
        await send("high");
        await send("low", "Subagent system prompt");

        expect(events().filter((event) => event.kind === "cache-reset")).toEqual([]);
    });
});

describe("where a Codex request's prefix first differs from the thread's previous request", () => {
    // Regression test: 2026-10-28-Research-Session8cf9eff2Slowdowns.sonnet.md Bug 4 — three full misses could not be
    // explained, because nothing recorded what the upstream request looked like next to the one before it.
    const claudeSession = "33333333-4444-4555-8666-777777777777";
    const metadata = { user_id: SafeJSON.stringify({ session_id: claudeSession }) };

    async function diffOf(body: Record<string, unknown>): Promise<unknown> {
        globalThis.fetch = (async () => whamStreamResponse()) as unknown as typeof fetch;
        const { OpenAiSubscriptionProvider } = await import("./openai-subscription");
        const { prefixDiffFor } = await import("@app/ai-proxy/lib/usage/prefix-diff");
        const provider = await OpenAiSubscriptionProvider.create(account);
        const bodyText = SafeJSON.stringify({ model: "gpt-6.1-sol", stream: true, metadata, ...body });
        const req = new Request("http://localhost/v1/messages", { method: "POST", body: bodyText });
        const res = await provider.messages?.(req, "gpt-6.1-sol", bodyText);
        await res?.text();
        return prefixDiffFor(req);
    }

    const turn1 = [{ role: "user", content: "first question" }];
    const turn2 = [...turn1, { role: "assistant", content: "first answer" }, { role: "user", content: "second" }];

    it("names no change when the earlier request is a prefix, and the first changed input item otherwise", async () => {
        const system = `thread ${crypto.randomUUID()}`;
        const first = await diffOf({ system, messages: turn1 });
        const grown = await diffOf({ system, messages: turn2 });
        const edited = await diffOf({
            system,
            messages: [turn2[0], { role: "assistant", content: "an edited answer" }, turn2[2]],
        });

        expect(first).toEqual({ part: "first" });
        expect(grown).toEqual({ part: "none" });
        expect(edited).toEqual({ part: "input", index: 1, of: 3, itemType: "message" });
    });

    it("names an instruction change within the same conversation", async () => {
        const messages = [{ role: "user", content: crypto.randomUUID() }];
        await diffOf({ system: "original instructions", messages });
        expect(await diffOf({ system: "changed instructions", messages })).toEqual({ part: "instructions" });
    });

    it("names the tools when the tool list changed", async () => {
        const system = `thread ${crypto.randomUUID()}`;
        const tool = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {} } });
        await diffOf({ system, messages: turn1, tools: [tool("Bash")] });
        const changed = await diffOf({ system, messages: turn2, tools: [tool("Bash"), tool("Write")] });

        expect(changed).toEqual({ part: "tools" });
    });
});

describe("CodexCompactionFlow through its ports", () => {
    // The flow's own interface, with a store in memory and the upstream faked at the HTTP boundary: the second adapter
    // of the CompactionStore port (the first is the file store under ai-proxy/compactions/).
    async function flowWith(records: Map<string, CompactionRecord>, upstream: () => Response) {
        const { CodexCompactionFlow } = await import("./codex/compaction-flow");
        const calls: Array<Record<string, unknown>> = [];
        const flow = new CodexCompactionFlow({
            upstream: async (_req, _model, body) => {
                calls.push(body);
                return upstream();
            },
            writtenSummary: async () => new Response("written"),
            store: {
                load: (id) => records.get(id),
                save: (record) => {
                    records.set(record.id, record);
                },
                newId: () => "gtc1.test",
            },
            usage: () => {},
            account: "work",
            provider: "openai-subscription",
        });
        return { flow, calls };
    }
    const input = (accountHash: string) => ({
        id: "gtc1.saved",
        req: new Request("http://localhost/v1/messages", { method: "POST" }),
        model: "gpt-6.1-sol",
        template: { model: "gpt-6.1-sol" },
        accountHash,
        client: { anthropic: true },
    });

    it("gives back the login's own item without an upstream request", async () => {
        const records = new Map<string, CompactionRecord>([
            [
                "gtc1.saved",
                {
                    id: "gtc1.saved",
                    model: "m",
                    createdAt: "x",
                    items: { aaaa: { type: "compaction", encrypted_content: "A" } },
                    history: [],
                },
            ],
        ]);
        const { flow, calls } = await flowWith(records, () => new Response("", { status: 500 }));

        expect(await flow.compactionItem(input("aaaa"))).toEqual([{ type: "compaction", encrypted_content: "A" }]);
        expect(calls).toHaveLength(0);
    });

    it("compacts the saved history again for another login and keeps both items in the store", async () => {
        const history = [{ role: "user", content: [{ type: "input_text", text: "remember KESTREL" }] }];
        const records = new Map<string, CompactionRecord>([
            [
                "gtc1.saved",
                {
                    id: "gtc1.saved",
                    model: "m",
                    createdAt: "x",
                    items: { aaaa: { type: "compaction", encrypted_content: "A" } },
                    history,
                },
            ],
        ]);
        const { flow, calls } = await flowWith(records, () => whamCompactionResponse("B"));

        const item = await flow.compactionItem(input("bbbb"));

        expect(item).toEqual([{ type: "compaction", id: "cmp_1", encrypted_content: "B" }]);
        expect(calls[0]?.input).toEqual([...history, { type: "compaction_trigger" }]);
        expect(Object.keys(records.get("gtc1.saved")?.items ?? {}).sort()).toEqual(["aaaa", "bbbb"]);
    });
});

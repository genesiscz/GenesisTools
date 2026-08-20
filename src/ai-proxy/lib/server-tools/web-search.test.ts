import { describe, expect, it } from "bun:test";
import { parseResponseBody } from "@app/ai-proxy/lib/usage/transcripts";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    buildResponsesWebSearchBody,
    domainAllowed,
    emulateWebSearch,
    emulationStream,
    messageToAnthropicSse,
    nativeTranslationLoss,
    nativeWebSearch,
    parseWebSearchServerTool,
    type WebSearchResult,
} from "./web-search";

function jsonResponse(body: unknown): Response {
    return new Response(SafeJSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const TOOL = { name: "web_search", maxUses: 8 };

describe("parseWebSearchServerTool", () => {
    it("parses the server tool entry with its limits and domain filters", () => {
        const tool = parseWebSearchServerTool({
            tools: [
                { name: "Read", description: "x", input_schema: {} },
                { type: "web_search_20250305", name: "web_search", max_uses: 3, allowed_domains: ["x.ai"] },
            ],
        });

        expect(tool).toEqual({ name: "web_search", maxUses: 3, allowedDomains: ["x.ai"], blockedDomains: undefined });
    });

    it("returns undefined when no web_search server tool is offered", () => {
        expect(
            parseWebSearchServerTool({ tools: [{ type: "code_execution_20250522", name: "code_execution" }] })
        ).toBeUndefined();
        expect(parseWebSearchServerTool({})).toBeUndefined();
    });
});

describe("nativeTranslationLoss", () => {
    it("clears a request the /responses translation carries faithfully", () => {
        // Text-only, web_search-only: the shape Claude Code actually sends.
        expect(
            nativeTranslationLoss(
                {
                    tools: [{ type: "web_search_20250305", name: "web_search" }],
                    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
                },
                TOOL
            )
        ).toBeUndefined();
        expect(nativeTranslationLoss({ messages: [{ role: "user", content: "hi" }] })).toBeUndefined();
    });

    it("names client tools and blocks the flattener would drop", () => {
        expect(
            nativeTranslationLoss({
                tools: [{ type: "web_search_20250305" }, { name: "Read", description: "x", input_schema: {} }],
                messages: [],
            })
        ).toBe("1 client tool");

        expect(
            nativeTranslationLoss({
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "and now" },
                            { type: "tool_result", tool_use_id: "toolu_1", content: "42" },
                            { type: "image", source: {} },
                        ],
                    },
                ],
            })
        ).toBe("image, tool_result content blocks");
    });

    it("names domain filters the upstream cannot express", () => {
        // One list of at most five: pairing the two would silently drop every
        // exclusion, so a request excluding gist.github.com while allowing
        // github.com must not take this path.
        expect(
            nativeTranslationLoss({ messages: [] }, { ...TOOL, allowedDomains: ["github.com"], blockedDomains: ["gist.github.com"] })
        ).toBe("both allowed_domains and blocked_domains");

        expect(
            nativeTranslationLoss({ messages: [] }, { ...TOOL, blockedDomains: ["a", "b", "c", "d", "e", "f"] })
        ).toBe("6 blocked_domains (the upstream takes 5)");

        // An over-long ALLOW list only tightens the request, so it stays native.
        expect(
            nativeTranslationLoss({ messages: [] }, { ...TOOL, allowedDomains: ["a", "b", "c", "d", "e", "f"] })
        ).toBeUndefined();
    });
});

describe("domainAllowed", () => {
    it("suffix-matches allowed and blocked domains", () => {
        expect(domainAllowed("https://gist.github.com/a", { allowed: ["github.com"] })).toBe(true);
        expect(domainAllowed("https://github.com.evil.com/a", { allowed: ["github.com"] })).toBe(false);
        expect(domainAllowed("https://x.ai/news", { allowed: ["github.com", "x.ai"] })).toBe(true);
        expect(domainAllowed("https://spam.example/a", { blocked: ["spam.example"] })).toBe(false);
        expect(domainAllowed("https://anything.example/a", {})).toBe(true);
        expect(domainAllowed("not a url", { allowed: ["x.ai"] })).toBe(false);
    });
});

describe("max_uses hardening", () => {
    it("clamps client-controlled max_uses and rejects non-integers", () => {
        const huge = parseWebSearchServerTool({
            tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5000 }],
        });
        expect(huge?.maxUses).toBe(20);

        const fractional = parseWebSearchServerTool({
            tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3.5 }],
        });
        expect(fractional?.maxUses).toBe(8);
    });
});

describe("abort handling", () => {
    it("an aborted signal stops the loop before any upstream call", async () => {
        const abort = new AbortController();
        abort.abort();
        let upstreamCalls = 0;

        await expect(
            emulateWebSearch({
                body: { messages: [] },
                tool: TOOL,
                signal: abort.signal,
                search: async () => [],
                callUpstream: async () => {
                    upstreamCalls += 1;
                    return jsonResponse({ content: [], stop_reason: "end_turn" });
                },
            })
        ).rejects.toThrow(/aborted/);
        expect(upstreamCalls).toBe(0);
    });

    it("cancelling the emulation stream aborts the signal handed to run", async () => {
        let seenSignal: AbortSignal | undefined;
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const stream = emulationStream(async (signal) => {
            seenSignal = signal;
            await gate;
            return new Response("late", { status: 500 });
        });

        const reader = stream.getReader();
        const cancelled = reader.cancel("client gone");
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(seenSignal?.aborted).toBe(true);
        release();
        await cancelled;
    });
});

describe("emulateWebSearch", () => {
    it("answers the model's search call with results and returns the final turn", async () => {
        const upstreamBodies: Record<string, unknown>[] = [];
        const queries: string[] = [];
        const results: WebSearchResult[] = [
            { title: "Grok 4.6", url: "https://x.ai/news/grok-4-6", snippet: "announcement" },
            { title: "Elsewhere", url: "https://blog.example/grok", snippet: "blog" },
        ];
        const turns = [
            {
                content: [{ type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "grok 4.6" } }],
                stop_reason: "tool_use",
                usage: { input_tokens: 10, output_tokens: 5 },
            },
            {
                content: [{ type: "text", text: "Grok 4.6 shipped." }],
                stop_reason: "end_turn",
                usage: { input_tokens: 50, output_tokens: 7 },
            },
        ];

        const outcome = await emulateWebSearch({
            body: {
                messages: [{ role: "user", content: "search it" }],
                tools: [{ type: "web_search_20250305", name: "web_search", allowed_domains: ["x.ai"] }],
                stream: true,
            },
            tool: { ...TOOL, allowedDomains: ["x.ai"] },
            search: async (q) => {
                queries.push(q);
                return results;
            },
            callUpstream: async (body) => {
                upstreamBodies.push(body);
                return jsonResponse(turns[upstreamBodies.length - 1]);
            },
        });

        expect(outcome).not.toBeInstanceOf(Response);
        if (outcome instanceof Response) {
            throw new Error("unreachable");
        }

        expect(queries).toEqual(["grok 4.6"]);
        expect(outcome.searches).toBe(1);
        expect(outcome.message.content).toEqual([{ type: "text", text: "Grok 4.6 shipped." }]);
        // Output tokens are summed across turns; input reflects the last turn.
        expect(outcome.message.usage).toMatchObject({ input_tokens: 50, output_tokens: 12 });

        // The upstream never sees the server tool, only the custom rewrite.
        const firstTools = upstreamBodies[0].tools as Record<string, unknown>[];
        expect(firstTools[0].type).toBeUndefined();
        expect(firstTools[0].name).toBe("web_search");
        expect(typeof firstTools[0].description).toBe("string");
        expect(upstreamBodies[0].stream).toBe(false);

        // Turn 2 carries the assistant call plus a tool_result with ONLY the
        // allowed-domain result.
        const messages = upstreamBodies[1].messages as Record<string, unknown>[];
        expect(messages).toHaveLength(3);
        const resultBlocks = messages[2].content as Record<string, unknown>[];
        expect(resultBlocks[0].tool_use_id).toBe("toolu_1");
        expect(resultBlocks[0].content).toContain("x.ai/news/grok-4-6");
        expect(resultBlocks[0].content).not.toContain("blog.example");
    });

    it("stops searching past max_uses and tells the model why", async () => {
        let calls = 0;
        let searches = 0;
        const outcome = await emulateWebSearch({
            body: { messages: [] },
            tool: { ...TOOL, maxUses: 1 },
            search: async () => {
                searches += 1;
                return [];
            },
            callUpstream: async (body) => {
                calls += 1;

                if (calls <= 2) {
                    return jsonResponse({
                        content: [
                            { type: "tool_use", id: `toolu_${calls}`, name: "web_search", input: { query: "q" } },
                        ],
                        stop_reason: "tool_use",
                        usage: { output_tokens: 1 },
                    });
                }

                const messages = body.messages as Record<string, unknown>[];
                const lastResult = (messages.at(-1)?.content as Record<string, unknown>[])[0];
                return jsonResponse({
                    content: [{ type: "text", text: `done: ${lastResult.content}` }],
                    stop_reason: "end_turn",
                    usage: { output_tokens: 1 },
                });
            },
        });

        if (outcome instanceof Response) {
            throw new Error("unreachable");
        }

        expect(searches).toBe(1);
        expect(outcome.searches).toBe(1);
        expect((outcome.message.content as Record<string, unknown>[])[0].text).toContain("limit reached");
    });

    it("returns the upstream error response untouched", async () => {
        const outcome = await emulateWebSearch({
            body: { messages: [] },
            tool: TOOL,
            search: async () => [],
            callUpstream: async () =>
                new Response(SafeJSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }), {
                    status: 502,
                }),
        });

        expect(outcome).toBeInstanceOf(Response);
        if (outcome instanceof Response) {
            expect(outcome.status).toBe(502);
        }
    });

    it("fails loudly when the model never stops calling", async () => {
        const outcome = await emulateWebSearch({
            body: { messages: [] },
            tool: { ...TOOL, maxUses: 1 },
            search: async () => [],
            callUpstream: async () =>
                jsonResponse({
                    content: [{ type: "tool_use", id: "toolu_x", name: "web_search", input: { query: "q" } }],
                    stop_reason: "tool_use",
                    usage: {},
                }),
        });

        expect(outcome).toBeInstanceOf(Response);
        if (outcome instanceof Response) {
            expect(outcome.status).toBe(502);
            const parsed = SafeJSON.parse(await outcome.text(), { strict: true }) as { error: { message: string } };
            expect(parsed.error.message).toContain("did not converge");
        }
    });
});

describe("nativeWebSearch (/responses server-side search)", () => {
    const RESPONSES_REPLY = {
        id: "resp_1",
        model: "grok-4.6-build",
        status: "completed",
        output: [
            { type: "reasoning", summary: [{ type: "summary_text", text: "checking x.ai" }] },
            { type: "web_search_call", status: "completed", action: { type: "search", query: "latest grok" } },
            { type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://x.ai/news" } },
            {
                type: "message",
                content: [
                    {
                        type: "output_text",
                        text: "Grok 4.6 shipped.",
                        annotations: [
                            { type: "url_citation", url: "https://x.ai/news/grok-4-6", start_index: 0, end_index: 1 },
                        ],
                    },
                ],
            },
        ],
        usage: { input_tokens: 43044, output_tokens: 2205, num_server_side_tools_used: 2 },
    };

    it("builds a /responses body with the native tool, domain filters, and flattened input", () => {
        const built = buildResponsesWebSearchBody(
            {
                model: "martin/grok/grok-4.6",
                stream: true,
                system: [
                    { type: "text", text: "You are Claude Code" },
                    { type: "text", text: "search assistant" },
                ],
                messages: [{ role: "user", content: [{ type: "text", text: "Perform a web search for: grok" }] }],
                tools: [{ type: "web_search_20250305", name: "web_search" }],
            },
            { name: "web_search", maxUses: 8, allowedDomains: ["x.ai"], blockedDomains: ["spam.example"] }
        );

        expect(built.stream).toBe(false);
        expect(built.instructions).toContain("search assistant");
        expect(built.input).toEqual([{ role: "user", content: "Perform a web search for: grok" }]);
        const tools = built.tools as Record<string, unknown>[];
        // The upstream cannot combine the lists — allowed wins.
        expect(tools).toEqual([{ type: "web_search", allowed_domains: ["x.ai"] }]);
    });

    it("clamps domain filters to the upstream max of 5", () => {
        const many = ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com", "g.com"];
        const allowed = buildResponsesWebSearchBody(
            { model: "m", messages: [] },
            { name: "web_search", maxUses: 8, allowedDomains: many }
        );
        expect((allowed.tools as Record<string, unknown>[])[0].allowed_domains).toEqual(many.slice(0, 5));

        const excluded = buildResponsesWebSearchBody(
            { model: "m", messages: [] },
            { name: "web_search", maxUses: 8, blockedDomains: many }
        );
        expect((excluded.tools as Record<string, unknown>[])[0].excluded_domains).toEqual(many.slice(0, 5));
    });

    it("translates the completed response into an Anthropic message with citations and search count", async () => {
        const outcome = await nativeWebSearch({
            body: { model: "grok-4.6", messages: [{ role: "user", content: "q" }] },
            tool: TOOL,
            callResponses: async () => jsonResponse(RESPONSES_REPLY),
        });

        if (outcome instanceof Response) {
            throw new Error("unreachable");
        }

        expect(outcome.searches).toBe(2);
        const blocks = outcome.message.content as Record<string, unknown>[];
        expect(blocks[0]).toMatchObject({ type: "thinking", thinking: "checking x.ai" });
        expect(blocks[1].type).toBe("text");
        expect(blocks[1].text).toContain("Grok 4.6 shipped.");
        expect(blocks[1].text).toContain("Sources:\n- https://x.ai/news/grok-4-6");
        // The count the upstream actually spent, in the field Anthropic
        // reports it in — max_uses cannot bound it, so it must be visible.
        expect(outcome.message.usage).toEqual({
            input_tokens: 43044,
            output_tokens: 2205,
            server_tool_use: { web_search_requests: 2 },
        });
        expect(outcome.message.stop_reason).toBe("end_turn");
    });

    it("always carries an id and a model, which Anthropic SDKs read as required", async () => {
        const outcome = await nativeWebSearch({
            body: { messages: [] },
            tool: TOOL,
            // A reply with neither field: undefined would be dropped by
            // SafeJSON and reach the client as a message missing both keys.
            callResponses: async () => jsonResponse({ output: [], usage: {} }),
        });

        if (outcome instanceof Response) {
            throw new Error("unreachable");
        }

        expect(outcome.message.id).toMatch(/^msg_/);
        expect(outcome.message.model).toBe("");
    });

    it("hands a non-OK response back for the caller's fallback", async () => {
        const outcome = await nativeWebSearch({
            body: { messages: [] },
            tool: TOOL,
            callResponses: async () => new Response("nope", { status: 503 }),
        });

        expect(outcome).toBeInstanceOf(Response);
        if (outcome instanceof Response) {
            expect(outcome.status).toBe(503);
        }
    });
});

describe("messageToAnthropicSse", () => {
    it("produces a spec-shaped stream that reassembles to the same message", () => {
        const sse = messageToAnthropicSse({
            id: "msg_1",
            model: "grok-4.6",
            content: [
                { type: "thinking", thinking: "hm", signature: "" },
                { type: "text", text: "Grok 4.6 shipped." },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 50, output_tokens: 12 },
        });

        expect(sse).toContain("event: message_start");
        expect(sse).toContain("event: message_stop");

        const parsed = parseResponseBody(sse, true);
        expect(parsed.text).toBe("Grok 4.6 shipped.");
        expect(parsed.thinking).toBe("hm");
        expect(parsed.finishReason).toBe("end_turn");
        expect(parsed.usage).toMatchObject({ input_tokens: 50, output_tokens: 12 });
    });
});

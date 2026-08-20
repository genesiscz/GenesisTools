import { describe, expect, it } from "bun:test";
import { parseResponseBody } from "@app/ai-proxy/lib/usage/transcripts";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    domainAllowed,
    emulateWebSearch,
    messageToAnthropicSse,
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
        expect(parseWebSearchServerTool({ tools: [{ type: "code_execution_20250522", name: "code_execution" }] })).toBeUndefined();
        expect(parseWebSearchServerTool({})).toBeUndefined();
    });
});

describe("domainAllowed", () => {
    it("suffix-matches allowed and blocked domains", () => {
        expect(domainAllowed("https://gist.github.com/a", ["github.com"])).toBe(true);
        expect(domainAllowed("https://github.com.evil.com/a", ["github.com"])).toBe(false);
        expect(domainAllowed("https://x.ai/news", ["github.com", "x.ai"])).toBe(true);
        expect(domainAllowed("https://spam.example/a", undefined, ["spam.example"])).toBe(false);
        expect(domainAllowed("https://anything.example/a")).toBe(true);
        expect(domainAllowed("not a url", ["x.ai"])).toBe(false);
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
                        content: [{ type: "tool_use", id: `toolu_${calls}`, name: "web_search", input: { query: "q" } }],
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

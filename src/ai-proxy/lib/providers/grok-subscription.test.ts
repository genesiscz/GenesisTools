import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { GrokSubscriptionProvider } from "@app/ai-proxy/lib/providers/grok-subscription";
import { resetWhamItemStore } from "@app/ai-proxy/lib/providers/wham-item-store";
import { TOOL_ROUTING_TAG } from "@app/ai-proxy/lib/translators/formats/anthropic/tool-routing-tag";
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

    it("cancelling the SSE stream aborts the in-flight native /responses call", async () => {
        const provider = makeProvider();
        const client = provider as unknown as {
            client: { fetch: (path: string, init: RequestInit) => Promise<Response> };
        };
        let seen: AbortSignal | undefined;
        let markDispatched: () => void = () => {};
        const dispatched = new Promise<void>((resolve) => {
            markDispatched = resolve;
        });
        // A native search that never answers on its own: only the client's
        // cancellation can end it, which is exactly the leak under test.
        client.client.fetch = async (_path, init) => {
            seen = init.signal ?? undefined;
            markDispatched();
            return await new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
        };

        const body = webSearchBody();
        const res = await provider.messages(
            new Request("http://proxy/v1/messages", { method: "POST", body }),
            "grok-4.6",
            body
        );
        const reader = res.body?.getReader();
        await dispatched;
        // The stream stays quiet until the first ping, so cancel without
        // reading — that is what a client walking away looks like.
        await reader?.cancel("client gone");

        // Wait on the abort itself rather than a fixed delay, so a loaded
        // machine cannot make this pass or fail by timing.
        if (seen?.aborted === false) {
            await new Promise<void>((resolve) => seen?.addEventListener("abort", () => resolve()));
        }

        expect(seen?.aborted).toBe(true);
    });

    it("never sends a request the native translation would truncate: no Brave key → self-explaining error", async () => {
        await env.testing.withOverrides({ BRAVE_API_KEY: undefined }, async () => {
            const provider = makeProvider();
            // web_search plus a client tool: the /responses body carries
            // web_search only, so answering natively would drop Read.
            const body = SafeJSON.stringify({
                model: "grok-4.6",
                max_tokens: 100,
                stream: false,
                messages: [{ role: "user", content: "hi" }],
                tools: [
                    { type: "web_search_20250305", name: "web_search" },
                    { name: "Read", description: "read a file", input_schema: { type: "object" } },
                ],
            });
            const res = await provider.messages(
                new Request("http://proxy/v1/messages", { method: "POST", body }),
                "grok-4.6",
                body
            );

            // 400, not the ConnectionRefused a dispatched native call would
            // give against the unreachable base URL — proof it never dispatched.
            expect(res.status).toBe(400);

            const text = await res.text();
            expect(text).toContain("1 client tool");
            expect(text).toContain("BRAVE_API_KEY");
        });
    });
});

describe("GrokSubscriptionProvider.messages tool tagging", () => {
    // These tests pin the SHIM fallback (AI_PROXY_GROK_MESSAGES_ROUTE=shim).
    // The default route translates to /responses and never tags a schema.
    beforeAll(() => {
        env.testing.set("AI_PROXY_GROK_MESSAGES_ROUTE", "shim");
    });

    afterAll(() => {
        env.testing.unset("AI_PROXY_GROK_MESSAGES_ROUTE");
    });

    const noArg = (name: string) => ({
        name,
        description: "x",
        input_schema: { type: "object", properties: {}, required: [] },
    });
    const withArg = (name: string) => ({
        name,
        description: "x",
        input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    });

    /** The body this provider actually put on the wire. */
    async function dispatchedBody(requestBody: Record<string, unknown>): Promise<Record<string, unknown>> {
        const provider = makeProvider();
        const client = provider as unknown as {
            client: { fetch: (path: string, init: RequestInit) => Promise<Response> };
        };
        let sent = "";
        client.client.fetch = async (_path, init) => {
            sent = String(init.body);
            return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
        };

        const body = SafeJSON.stringify(requestBody);
        await provider.messages(new Request("http://proxy/v1/messages", { method: "POST", body }), "grok-4.6", body);
        return SafeJSON.parse(sent, { strict: true }) as Record<string, unknown>;
    }

    function schemaOf(body: Record<string, unknown>, name: string): Record<string, unknown> {
        const tools = body.tools as Record<string, unknown>[];
        const tool = tools.find((t) => t.name === name);
        return tool?.input_schema as Record<string, unknown>;
    }

    it("tags every no-arg tool when two or more are offered, so a merged `{}` names itself", async () => {
        const sent = await dispatchedBody({
            model: "grok-4.6",
            max_tokens: 100,
            stream: true,
            messages: [{ role: "user", content: "hi" }],
            tools: [noArg("ListAgents"), noArg("TaskList"), withArg("Bash")],
        });

        for (const name of ["ListAgents", "TaskList"]) {
            const schema = schemaOf(sent, name);
            expect(schema.required).toEqual([TOOL_ROUTING_TAG]);
            expect((schema.properties as Record<string, unknown>)[TOOL_ROUTING_TAG]).toMatchObject({ enum: [name] });
        }

        // The tool that already carries arguments is left exactly as the client wrote it.
        expect(schemaOf(sent, "Bash")).toEqual({
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
        });
    });

    it("leaves schemas untouched when nothing is ambiguous, and when not streaming", async () => {
        // One no-arg tool resolves by key matching; tagging it would change the
        // model's view of the schema for no gain.
        const single = await dispatchedBody({
            model: "grok-4.6",
            max_tokens: 100,
            stream: true,
            messages: [{ role: "user", content: "hi" }],
            tools: [noArg("ListAgents"), withArg("Bash")],
        });
        expect(schemaOf(single, "ListAgents").required).toEqual([]);

        // Non-streaming replies name every call already — nothing to repair.
        const nonStreaming = await dispatchedBody({
            model: "grok-4.6",
            max_tokens: 100,
            stream: false,
            messages: [{ role: "user", content: "hi" }],
            tools: [noArg("ListAgents"), noArg("TaskList")],
        });
        expect(schemaOf(nonStreaming, "ListAgents").required).toEqual([]);
        expect(schemaOf(nonStreaming, "TaskList").required).toEqual([]);
    });
});

describe("GrokSubscriptionProvider.messages /responses route (default)", () => {
    interface Sent {
        path: string;
        body: Record<string, unknown>;
    }

    function stubbedProvider(respond: (sent: Sent[]) => Response): {
        provider: GrokSubscriptionProvider;
        sent: Sent[];
    } {
        const provider = makeProvider();
        const client = provider as unknown as {
            client: { fetch: (path: string, init: { body?: unknown }) => Promise<Response> };
        };
        const sent: Sent[] = [];
        client.client.fetch = async (path, init) => {
            sent.push({ path, body: SafeJSON.parse(String(init.body), { strict: true }) as Record<string, unknown> });
            return respond(sent);
        };

        return { provider, sent };
    }

    const envelope = SafeJSON.stringify({
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "4" }] }],
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    });

    it("translates the Anthropic body onto the /responses wire and the reply back", async () => {
        const { provider, sent } = stubbedProvider(
            () => new Response(envelope, { status: 200, headers: { "content-type": "application/json" } })
        );

        const body = SafeJSON.stringify({
            model: "grok-4.6",
            max_tokens: 100,
            system: "be terse",
            messages: [{ role: "user", content: "2+2?" }],
            tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }],
        });
        const res = await provider.messages(
            new Request("http://proxy/v1/messages", { method: "POST", body }),
            "grok-4.6",
            body
        );

        expect(sent).toHaveLength(1);
        expect(sent[0].path).toBe("/responses");
        expect(sent[0].body.store).toBe(false);
        expect(sent[0].body.instructions).toBe("be terse");
        expect(sent[0].body.max_output_tokens).toBe(100);
        // ensureToolRequiredArrays ran before the translation.
        expect((sent[0].body.tools as Record<string, unknown>[])[0].parameters).toEqual({
            type: "object",
            required: [],
        });

        const message = SafeJSON.parse(await res.text(), { strict: true }) as Record<string, unknown>;
        expect(message.type).toBe("message");
        expect(message.content).toEqual([{ type: "text", text: "4" }]);
        expect(message.stop_reason).toBe("end_turn");
    });

    it("retries once without reasoning items when the upstream cannot decrypt them", async () => {
        const { provider, sent } = stubbedProvider((calls) =>
            calls.length === 1
                ? new Response(
                      SafeJSON.stringify({
                          code: "invalid-argument",
                          error: "Could not decrypt the provided encrypted_content. Ensure the value is the unmodified encrypted_content from a previous response.",
                      }),
                      { status: 400, headers: { "content-type": "application/json" } }
                  )
                : new Response(envelope, { status: 200, headers: { "content-type": "application/json" } })
        );

        const body = SafeJSON.stringify({
            model: "grok-4.6",
            max_tokens: 100,
            messages: [
                { role: "user", content: "hi" },
                {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: "old reasoning", signature: "grokrs1:rs_x:STALEENC==" },
                        { type: "text", text: "earlier answer" },
                    ],
                },
                { role: "user", content: "again?" },
            ],
        });
        const res = await provider.messages(
            new Request("http://proxy/v1/messages", { method: "POST", body }),
            "grok-4.6",
            body
        );

        expect(sent).toHaveLength(2);
        const firstItems = (sent[0].body.input as Record<string, unknown>[]).map((item) => item.type ?? item.role);
        const retryItems = (sent[1].body.input as Record<string, unknown>[]).map((item) => item.type ?? item.role);
        expect(firstItems).toContain("reasoning");
        expect(retryItems).not.toContain("reasoning");

        expect(res.status).toBe(200);
    });

    it("does not retry on unrelated errors", async () => {
        const { provider, sent } = stubbedProvider(
            () =>
                new Response(SafeJSON.stringify({ code: "invalid-argument", error: "some other problem" }), {
                    status: 400,
                    headers: { "content-type": "application/json" },
                })
        );

        const body = SafeJSON.stringify({
            model: "grok-4.6",
            max_tokens: 100,
            messages: [{ role: "user", content: "hi" }],
        });
        const res = await provider.messages(
            new Request("http://proxy/v1/messages", { method: "POST", body }),
            "grok-4.6",
            body
        );

        expect(sent).toHaveLength(1);
        expect(res.status).toBe(400);

        // The client speaks Anthropic, so the error must be Anthropic-shaped.
        const parsed = SafeJSON.parse(await res.text(), { strict: true }) as Record<string, unknown>;
        expect(parsed.type).toBe("error");
        expect((parsed.error as Record<string, unknown>).message).toContain("some other problem");
    });
});

describe("GrokSubscriptionProvider.responses item_reference chaining", () => {
    afterEach(() => {
        resetWhamItemStore();
    });

    const reasoning = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "opaque" };
    const call = { id: "fc_1", type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" };

    function stubbedProvider(respond: (path: string) => Response): {
        provider: GrokSubscriptionProvider;
        sent: Array<Record<string, unknown>>;
    } {
        const provider = makeProvider();
        const client = provider as unknown as {
            client: { fetch: (path: string, init: { body?: unknown }) => Promise<Response> };
        };
        const sent: Array<Record<string, unknown>> = [];
        client.client.fetch = async (path, init) => {
            sent.push(SafeJSON.parse(String(init.body), { strict: true }) as Record<string, unknown>);
            return respond(path);
        };

        return { provider, sent };
    }

    async function send(provider: GrokSubscriptionProvider, input: unknown[]): Promise<Response> {
        const body = SafeJSON.stringify({ model: "grok-4.6", input, stream: false });

        return provider.responses(new Request("http://proxy/v1/responses", { method: "POST", body }), "grok-4.6", body);
    }

    it("inlines turn-1 output items where turn 2 sends item_reference pointers (JSON reply)", async () => {
        const envelope = SafeJSON.stringify({ id: "resp_1", object: "response", output: [reasoning, call] });
        const { provider, sent } = stubbedProvider(
            () => new Response(envelope, { status: 200, headers: { "content-type": "application/json" } })
        );

        const first = await send(provider, [{ role: "user", content: "weather?" }]);
        expect(await first.text()).toBe(envelope);

        await send(provider, [
            { role: "user", content: "weather?" },
            { type: "item_reference", id: "rs_1" },
            { type: "item_reference", id: "fc_1" },
            { type: "function_call_output", call_id: "call_1", output: "sunny" },
        ]);

        expect(sent).toHaveLength(2);
        expect(sent[1].input).toEqual([
            { role: "user", content: "weather?" },
            reasoning,
            call,
            { type: "function_call_output", call_id: "call_1", output: "sunny" },
        ]);
    });

    it("harvests items from a streamed reply without changing the bytes", async () => {
        const sse = `data: {"type":"response.output_item.done","item":${SafeJSON.stringify(call)}}\n\ndata: [DONE]\n\n`;
        const { provider, sent } = stubbedProvider(
            () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
        );

        const first = await send(provider, [{ role: "user", content: "weather?" }]);
        expect(await first.text()).toBe(sse);

        await send(provider, [{ type: "item_reference", id: "fc_1" }]);

        expect(sent[1].input).toEqual([call]);
    });
});

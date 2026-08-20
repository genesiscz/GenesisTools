import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { anthropicBodyToOpenAiBody, anthropicMessagesPipeline, countAnthropicInputTokens } from "./anthropic-messages";
import type { OpenAiModel, ProxyProvider } from "./providers/types";
import type { UsageSummary } from "./types";

const PROXY_MODEL = "martin/grok/grok-4.5";
const UPSTREAM_MODEL = "grok-4.5";

/** Records what the provider was handed, and answers with a canned upstream body. */
function fakeProvider(response: () => Response): ProxyProvider & { seen: { model: string; bodyText: string }[] } {
    const seen: { model: string; bodyText: string }[] = [];

    return {
        id: "grok-subscription",
        accountFingerprint: "test",
        seen,
        async listModels(): Promise<OpenAiModel[]> {
            return [];
        },
        async chatCompletions(_req: Request, model: string, bodyText: string): Promise<Response> {
            seen.push({ model, bodyText });
            return response();
        },
        async responses(): Promise<Response> {
            throw new Error("not used");
        },
        async getUsage(): Promise<UsageSummary> {
            throw new Error("not used");
        },
    };
}

function request(): Request {
    return new Request("http://127.0.0.1/v1/messages", { method: "POST" });
}

function sseResponse(frames: string[]): Response {
    const encoder = new TextEncoder();

    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                for (const frame of frames) {
                    controller.enqueue(encoder.encode(frame));
                }

                controller.close();
            },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
}

function chunk(delta: Record<string, unknown>, finishReason?: string): string {
    return `data: ${SafeJSON.stringify({
        choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    })}\n\n`;
}

async function readAll(response: Response): Promise<string> {
    return await response.text();
}

describe("anthropicBodyToOpenAiBody", () => {
    it("folds the Anthropic system field into a system message and rewrites the model", () => {
        const body = SafeJSON.parse(
            anthropicBodyToOpenAiBody(
                {
                    model: PROXY_MODEL,
                    system: "be terse",
                    max_tokens: 1024,
                    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
                },
                UPSTREAM_MODEL
            ),
            { strict: true }
        ) as Record<string, unknown>;

        expect(body.model).toBe(UPSTREAM_MODEL);
        expect(body.max_tokens).toBe(1024);
        expect(body.system).toBeUndefined();
        expect(body.messages).toEqual([
            { role: "system", content: "be terse" },
            { role: "user", content: "hi" },
        ]);
    });

    it("translates Anthropic tools into OpenAI function tools", () => {
        const body = SafeJSON.parse(
            anthropicBodyToOpenAiBody(
                {
                    model: PROXY_MODEL,
                    max_tokens: 16,
                    messages: [{ role: "user", content: "go" }],
                    tools: [{ name: "read", description: "read a file", input_schema: { type: "object" } }],
                    tool_choice: { type: "auto" },
                },
                UPSTREAM_MODEL
            ),
            { strict: true }
        ) as Record<string, unknown>;

        expect(body.tools).toEqual([
            {
                type: "function",
                function: { name: "read", description: "read a file", parameters: { type: "object" } },
            },
        ]);
        expect(body.tool_choice).toBe("auto");
    });

    it("turns a tool_result turn into an OpenAI tool message", () => {
        const body = SafeJSON.parse(
            anthropicBodyToOpenAiBody(
                {
                    model: PROXY_MODEL,
                    max_tokens: 16,
                    messages: [
                        {
                            role: "assistant",
                            content: [{ type: "tool_use", id: "call_1", name: "read", input: { p: "a" } }],
                        },
                        {
                            role: "user",
                            content: [{ type: "tool_result", tool_use_id: "call_1", content: "file body" }],
                        },
                    ],
                },
                UPSTREAM_MODEL
            ),
            { strict: true }
        ) as { messages: Record<string, unknown>[] };

        expect(body.messages[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "file body" });
    });

    it("marks a failed tool_result so the model can tell it from a success", () => {
        // The OpenAI tool message has no error flag; 32 recorded failures crossed
        // this path indistinguishable from successes before the prefix existed.
        const body = SafeJSON.parse(
            anthropicBodyToOpenAiBody(
                {
                    model: PROXY_MODEL,
                    max_tokens: 16,
                    messages: [
                        {
                            role: "assistant",
                            content: [{ type: "tool_use", id: "call_1", name: "run", input: {} }],
                        },
                        {
                            role: "user",
                            content: [
                                { type: "tool_result", tool_use_id: "call_1", content: "exit 2", is_error: true },
                            ],
                        },
                    ],
                },
                UPSTREAM_MODEL
            ),
            { strict: true }
        ) as { messages: Record<string, unknown>[] };

        expect(body.messages[1]).toEqual({
            role: "tool",
            tool_call_id: "call_1",
            content: "[Tool call failed] exit 2",
        });
    });

    it("translates output_config.format into response_format instead of deleting it", () => {
        // Deleting the structured-output request let one recorded call run
        // free-form for 11m44s / 152k characters until stop_reason=length.
        const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
        const body = SafeJSON.parse(
            anthropicBodyToOpenAiBody(
                {
                    model: PROXY_MODEL,
                    max_tokens: 16,
                    messages: [{ role: "user", content: "title this" }],
                    output_config: { effort: "high", format: { type: "json_schema", schema } },
                },
                UPSTREAM_MODEL
            ),
            { strict: true }
        ) as Record<string, unknown>;

        expect(body.response_format).toEqual({
            type: "json_schema",
            json_schema: { name: "structured_output", schema },
        });
        expect(body.reasoning_effort).toBe("high");
        expect(body.output_config).toBeUndefined();
    });

    it("translates images to image_url for claude-named upstreams too", () => {
        // The playground port replaced these with the text "[Image Omitted]"
        // whenever the model id contained "claude", silently blinding
        // claude-named models on translated paths (e.g. OpenRouter's).
        const body = SafeJSON.parse(
            anthropicBodyToOpenAiBody(
                {
                    model: PROXY_MODEL,
                    max_tokens: 16,
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: "what is this" },
                                {
                                    type: "image",
                                    source: { type: "base64", media_type: "image/png", data: "AAAA" },
                                },
                            ],
                        },
                    ],
                },
                "claude-sonnet-4"
            ),
            { strict: true }
        ) as { messages: { content: unknown }[] };

        expect(body.messages[0].content).toEqual([
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ]);
    });

    it("does not mutate the caller's parsed body", () => {
        const parsed = { model: PROXY_MODEL, system: "keep me", messages: [{ role: "user", content: "hi" }] };
        anthropicBodyToOpenAiBody(parsed, UPSTREAM_MODEL);

        expect(parsed.system).toBe("keep me");
        expect(parsed.model).toBe(PROXY_MODEL);
    });

    it("does not mutate the caller's messages ARRAY", () => {
        // The spread is shallow, so this array used to be shared with the
        // normalizer, which unshifts the system turn into it. Translating the
        // same body twice appended two system messages and corrupted the
        // transcript capture with a request nobody sent.
        const parsed = {
            model: PROXY_MODEL,
            system: "be terse",
            messages: [{ role: "user", content: "hi" }],
        };

        anthropicBodyToOpenAiBody(parsed, UPSTREAM_MODEL);
        anthropicBodyToOpenAiBody(parsed, UPSTREAM_MODEL);

        expect(parsed.messages).toEqual([{ role: "user", content: "hi" }]);
    });
});

describe("countAnthropicInputTokens", () => {
    it("counts the text in system, messages and tools", () => {
        const tokens = countAnthropicInputTokens(
            SafeJSON.stringify({
                model: PROXY_MODEL,
                system: "a".repeat(40),
                messages: [{ role: "user", content: [{ type: "text", text: "b".repeat(40) }] }],
            })
        );

        expect(tokens).toBeGreaterThan(15);
        expect(tokens).toBeLessThan(40);
    });

    it("falls back to the raw body when it is not JSON", () => {
        expect(countAnthropicInputTokens("not json at all")).toBeGreaterThan(0);
    });
});

describe("anthropicMessagesPipeline", () => {
    it("translates a non-streaming answer into an Anthropic message", async () => {
        const provider = fakeProvider(
            () =>
                new Response(
                    SafeJSON.stringify({
                        id: "chatcmpl-1",
                        choices: [
                            { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
                        ],
                        usage: { prompt_tokens: 3, completion_tokens: 2 },
                    }),
                    { status: 200, headers: { "Content-Type": "application/json" } }
                )
        );

        const result = await anthropicMessagesPipeline({
            provider,
            upstreamModel: UPSTREAM_MODEL,
            proxyModel: PROXY_MODEL,
            req: request(),
            bodyText: SafeJSON.stringify({
                model: PROXY_MODEL,
                max_tokens: 32,
                messages: [{ role: "user", content: "hi" }],
            }),
        });

        const message = SafeJSON.parse(await readAll(result.response), { strict: true }) as Record<string, unknown>;

        expect(result.response.status).toBe(200);
        expect(message.type).toBe("message");
        expect(message.model).toBe(PROXY_MODEL);
        expect(message.content).toEqual([{ type: "text", text: "hello" }]);
        expect(message.stop_reason).toBe("end_turn");

        // Usage must see the OpenAI exchange, not the Anthropic frames.
        expect(SafeJSON.parse(result.openAiBodyText, { strict: true })).toMatchObject({ model: UPSTREAM_MODEL });
        expect(await result.responseBody).toContain("chatcmpl-1");
    });

    it("streams Anthropic SSE frames while booking the upstream body", async () => {
        const provider = fakeProvider(() =>
            sseResponse([
                chunk({ role: "assistant" }),
                chunk({ content: "Hel" }),
                chunk({ content: "lo" }),
                chunk({}, "stop"),
                "data: [DONE]\n\n",
            ])
        );

        const result = await anthropicMessagesPipeline({
            provider,
            upstreamModel: UPSTREAM_MODEL,
            proxyModel: PROXY_MODEL,
            req: request(),
            bodyText: SafeJSON.stringify({
                model: PROXY_MODEL,
                max_tokens: 32,
                stream: true,
                messages: [{ role: "user", content: "hi" }],
            }),
        });

        expect(result.response.headers.get("Content-Type")).toBe("text/event-stream");

        const sse = await readAll(result.response);
        const eventTypes = sse
            .split("\n")
            .filter((line) => line.startsWith("event:"))
            .map((line) => line.slice("event:".length).trim());

        expect(eventTypes).toEqual([
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]);
        expect(sse).toContain('"text":"Hel"');

        // The captured body is the OpenAI stream the upstream sent, which is the
        // only shape the usage/billing layer knows how to parse.
        const captured = await result.responseBody;
        expect(captured).toContain('"delta":{"content":"Hel"}');
        expect(captured).not.toContain("content_block_delta");
    });

    it("reports an upstream failure as an Anthropic-shaped error", async () => {
        const provider = fakeProvider(() => new Response("upstream exploded", { status: 502 }));

        const result = await anthropicMessagesPipeline({
            provider,
            upstreamModel: UPSTREAM_MODEL,
            proxyModel: PROXY_MODEL,
            req: request(),
            bodyText: SafeJSON.stringify({
                model: PROXY_MODEL,
                max_tokens: 32,
                messages: [{ role: "user", content: "hi" }],
            }),
        });

        expect(result.response.status).toBe(502);

        const error = SafeJSON.parse(await readAll(result.response), { strict: true }) as Record<string, unknown>;
        expect(error.type).toBe("error");
        expect(SafeJSON.stringify(error.error)).toContain("upstream exploded");
    });
});

describe("stream opening", () => {
    it("sends message_start before the model has produced anything", async () => {
        // A reasoning model can stay silent for ~16s. Emitting message_start lazily
        // on the first content delta made Claude Code look completely dead for that
        // whole span; the real Anthropic API opens the message immediately.
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const encoder = new TextEncoder();
        const provider = fakeProvider(
            () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        async pull(controller) {
                            await gate;
                            controller.enqueue(encoder.encode(chunk({ content: "hi" }, "stop")));
                            controller.close();
                        },
                    }),
                    { status: 200, headers: { "Content-Type": "text/event-stream" } }
                )
        );

        const result = await anthropicMessagesPipeline({
            provider,
            upstreamModel: UPSTREAM_MODEL,
            proxyModel: PROXY_MODEL,
            req: request(),
            bodyText: SafeJSON.stringify({
                model: PROXY_MODEL,
                max_tokens: 32,
                stream: true,
                messages: [{ role: "user", content: "hi" }],
            }),
        });

        const reader = result.response.body?.getReader();
        const first = await reader?.read();
        const opening = new TextDecoder().decode(first?.value);

        expect(opening).toContain("event: message_start");

        release();
        await reader?.cancel();
    });

    it("cancels the upstream reader when the client goes away mid-stream", async () => {
        // Note what this does and does not prove. In production a real
        // disconnect also aborts `req.signal`, which every provider forwards
        // upstream, so the read rejects on its own. This Request's signal never
        // aborts, so the test isolates the body-cancel path alone — the one a
        // provider that forgot to forward the signal would depend on.
        let upstreamCancelled = false;
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const encoder = new TextEncoder();
        const provider = fakeProvider(
            () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        async pull(controller) {
                            await gate;
                            controller.enqueue(encoder.encode(chunk({ content: "hi" }, "stop")));
                            controller.close();
                        },
                        cancel() {
                            upstreamCancelled = true;
                        },
                    }),
                    { status: 200, headers: { "Content-Type": "text/event-stream" } }
                )
        );

        const result = await anthropicMessagesPipeline({
            provider,
            upstreamModel: UPSTREAM_MODEL,
            proxyModel: PROXY_MODEL,
            req: request(),
            bodyText: SafeJSON.stringify({
                model: PROXY_MODEL,
                max_tokens: 32,
                stream: true,
                messages: [{ role: "user", content: "hi" }],
            }),
        });

        const reader = result.response.body?.getReader();
        await reader?.read();

        // The client leaves BEFORE the upstream ever produces a frame.
        await reader?.cancel("client disconnected");
        await Bun.sleep(1);

        expect(upstreamCancelled).toBe(true);

        release();
    });
});

describe("Claude Code /effort", () => {
    it("maps output_config.effort onto reasoning_effort", () => {
        // `/effort xhigh` in Claude Code travels as output_config.effort. It was
        // being deleted unread, so 23 recorded xhigh requests all ran at the
        // model's default instead.
        const body = SafeJSON.parse(
            anthropicBodyToOpenAiBody(
                {
                    model: PROXY_MODEL,
                    max_tokens: 64,
                    messages: [{ role: "user", content: "hi" }],
                    output_config: { effort: "xhigh" },
                },
                UPSTREAM_MODEL
            ),
            { strict: true }
        ) as Record<string, unknown>;

        expect(body.reasoning_effort).toBe("xhigh");
        // The Anthropic-only wrapper itself must still not reach the upstream.
        expect(body.output_config).toBeUndefined();
    });

    it("lets an explicit reasoning_effort win over the session setting", () => {
        // A `model:xhigh` pin is stamped before this runs; it is the more
        // deliberate choice and must not be overwritten by /effort.
        const body = SafeJSON.parse(
            anthropicBodyToOpenAiBody(
                {
                    model: PROXY_MODEL,
                    max_tokens: 64,
                    messages: [{ role: "user", content: "hi" }],
                    reasoning_effort: "low",
                    output_config: { effort: "xhigh" },
                },
                UPSTREAM_MODEL
            ),
            { strict: true }
        ) as Record<string, unknown>;

        expect(body.reasoning_effort).toBe("low");
    });

    it("ignores a malformed output_config instead of forwarding junk", () => {
        // `{ effort: "banana" }` is the case a type check alone lets through:
        // a well-formed string that no upstream knows. Forwarding it 400s the
        // whole request.
        for (const oc of [null, "high", { effort: "" }, { effort: 5 }, [], { effort: "banana" }]) {
            const body = SafeJSON.parse(
                anthropicBodyToOpenAiBody(
                    {
                        model: PROXY_MODEL,
                        max_tokens: 64,
                        messages: [{ role: "user", content: "hi" }],
                        output_config: oc,
                    },
                    UPSTREAM_MODEL
                ),
                { strict: true }
            ) as Record<string, unknown>;

            expect(body.reasoning_effort).toBeUndefined();
            expect(body.output_config).toBeUndefined();
        }
    });
});

describe("Anthropic-only request fields", () => {
    it("strips every field the OpenAI upstream has no meaning for", () => {
        // Claude Code sends all of these on every turn. context_management and
        // output_config were forwarded verbatim until 2026-08-19; Grok ignores
        // unknown params but xAI and OpenAI answer 400.
        const body = SafeJSON.parse(
            anthropicBodyToOpenAiBody(
                {
                    model: PROXY_MODEL,
                    max_tokens: 64,
                    messages: [{ role: "user", content: "hi" }],
                    thinking: { type: "adaptive", display: "summarized" },
                    context_management: { edits: [] },
                    output_config: { effort: "high" },
                    metadata: { user_id: "x" },
                    anthropic_version: "2023-06-01",
                    top_k: 5,
                },
                UPSTREAM_MODEL
            ),
            { strict: true }
        ) as Record<string, unknown>;

        for (const field of [
            "thinking",
            "context_management",
            "output_config",
            "metadata",
            "anthropic_version",
            "top_k",
        ]) {
            expect(body[field]).toBeUndefined();
        }

        // ...while the fields that DO translate survive.
        expect(body.max_tokens).toBe(64);
        expect(body.model).toBe(UPSTREAM_MODEL);
    });
});

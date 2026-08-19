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

    it("does not mutate the caller's parsed body", () => {
        const parsed = { model: PROXY_MODEL, system: "keep me", messages: [{ role: "user", content: "hi" }] };
        anthropicBodyToOpenAiBody(parsed, UPSTREAM_MODEL);

        expect(parsed.system).toBe("keep me");
        expect(parsed.model).toBe(PROXY_MODEL);
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

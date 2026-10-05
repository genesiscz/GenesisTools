import { describe, expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { SafeJSON } from "@genesiscz/utils/json";
import { generateObject } from "ai";
import { z } from "zod";
import { fetchWhamResponse, toWhamRequest } from "./wham-request";

const URL = "https://chatgpt.com/backend-api/wham/responses";

function bodyOf(init: RequestInit): Record<string, unknown> {
    return SafeJSON.parse(String(init.body), { strict: true }) as Record<string, unknown>;
}

describe("toWhamRequest", () => {
    test("forces stream and store, adds the encrypted-reasoning include, drops what WHAM rejects", async () => {
        const out = await toWhamRequest(URL, {
            method: "POST",
            body: SafeJSON.stringify({
                model: "gpt-5.4-mini",
                input: [{ role: "user", content: "hi" }],
                max_output_tokens: 5,
                temperature: 0.2,
                top_p: 1,
                previous_response_id: "resp_1",
                store: true,
            }),
        });

        expect(bodyOf(out)).toEqual({
            model: "gpt-5.4-mini",
            input: [{ role: "user", content: "hi" }],
            stream: true,
            store: false,
            include: ["reasoning.encrypted_content"],
        });
        const headers = new Headers(out.headers);
        expect(headers.get("OpenAI-Beta")).toBe("responses=experimental");
        expect(headers.get("originator")).toBe("codex_cli_rs");
        expect(headers.get("Accept")).toBe("text/event-stream");
        expect(headers.get("session_id")).toMatch(/^[0-9a-f-]{36}$/);
    });

    test("keeps an existing include list and does not duplicate the reasoning entry", async () => {
        const out = await toWhamRequest(URL, {
            body: SafeJSON.stringify({ model: "m", input: [], include: ["reasoning.encrypted_content", "x"] }),
        });
        expect(bodyOf(out).include).toEqual(["reasoning.encrypted_content", "x"]);
    });

    test("leaves non-responses calls and non-JSON bodies alone, headers aside", async () => {
        const models = await toWhamRequest("https://chatgpt.com/backend-api/wham/models", { method: "GET" });
        expect(models.body).toBeUndefined();
        expect(new Headers(models.headers).get("originator")).toBe("codex_cli_rs");

        const raw = await toWhamRequest(URL, { body: "not json" });
        expect(raw.body).toBe("not json");
    });
});
// The SDK sends `(url, init)`, but a caller that builds a `Request` first must keep
// its Content-Type and body: headers built from `undefined` dropped both.
test("reads headers and body from a Request input when init does not override them", async () => {
    const request = new Request(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify({ model: "m", input: [], temperature: 1 }),
    });
    const out = await toWhamRequest(request);

    expect(new Headers(out.headers).get("Content-Type")).toBe("application/json");
    expect(bodyOf(out)).toMatchObject({ model: "m", stream: true, store: false });
    expect(bodyOf(out).temperature).toBeUndefined();

    const overridden = await toWhamRequest(request, { body: SafeJSON.stringify({ model: "n", input: [] }) });
    expect(bodyOf(overridden).model).toBe("n");
});

const completedMessage = {
    type: "message",
    id: "msg_fixture",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: '{"title":"Build the Mac app"}', annotations: [] }],
};
const completedResponse = {
    id: "resp_fixture",
    object: "response",
    model: "gpt-5.4-mini",
    created_at: 1_700_000_000,
    status: "completed",
    output: [],
    usage: {
        input_tokens: 12,
        output_tokens: 7,
        total_tokens: 19,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 },
    },
};

function eventsResponse(events: unknown[]): Response {
    return new Response(events.map((event) => `data: ${SafeJSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
    });
}

test("SDK non-streaming structured generation receives the completed item when terminal output is empty", async () => {
    const provider = createOpenAI({
        apiKey: "fixture",
        baseURL: "https://chatgpt.com/backend-api/wham",
        fetch: Object.assign(
            (input: RequestInfo | globalThis.URL, init?: RequestInit) =>
                fetchWhamResponse({
                    input,
                    init,
                    fetch: async (_input, wham) => {
                        expect(bodyOf(wham ?? {}).stream).toBe(true);
                        return eventsResponse([
                            { type: "response.output_item.done", output_index: 0, item: completedMessage },
                            { type: "response.completed", response: completedResponse },
                        ]);
                    },
                }),
            { preconnect: fetch.preconnect }
        ),
    });
    const result = await generateObject({
        model: provider.responses("gpt-5.4-mini"),
        schema: z.object({ title: z.string() }),
        prompt: "Create a fixture task",
        maxRetries: 0,
    });
    expect(result.object).toEqual({ title: "Build the Mac app" });
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(7);
    expect(result.response.id).toBe("resp_fixture");
});

async function collectFixture(events: unknown[]): Promise<Response> {
    return fetchWhamResponse({
        input: URL,
        init: { method: "POST", body: '{"model":"fixture"}' },
        fetch: async () => eventsResponse(events),
    });
}

test("terminal output alone works, and repeated done items do not duplicate the final output", async () => {
    const terminal = { ...completedResponse, output: [completedMessage] };
    for (const events of [
        [{ type: "response.completed", response: terminal }],
        [
            { type: "response.output_item.done", output_index: 0, item: completedMessage },
            { type: "response.output_item.done", output_index: 0, item: completedMessage },
            { type: "response.completed", response: terminal },
        ],
    ]) {
        const response = await collectFixture(events);
        expect(await response.json()).toEqual(terminal);
    }
});

test("retains complete reasoning, tool arguments, output order and terminal metadata", async () => {
    const reasoning = {
        type: "reasoning",
        id: "rs_fixture",
        summary: [{ type: "summary_text", text: "A short reason" }],
        encrypted_content: "fixture-cipher",
    };
    const call = {
        type: "function_call",
        id: "fc_fixture",
        call_id: "call_fixture",
        name: "inspect",
        arguments: '{"file":"example.txt"}',
    };
    const terminal = { ...completedResponse, service_tier: "default", reasoning: { context: "fixture-context" } };
    const response = await collectFixture([
        { type: "response.created", response: { id: completedResponse.id } },
        { type: "response.output_item.done", output_index: 1, item: call },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        { type: "response.output_item.done", output_index: 2, item: completedMessage },
        { type: "response.completed", response: terminal },
    ]);
    expect(await response.json()).toEqual({ ...terminal, output: [reasoning, call, completedMessage] });
});

test("decodes fragmented UTF-8, CRLF and multiline SSE data and removes stale transfer headers", async () => {
    const item = { ...completedMessage, content: [{ type: "output_text", text: "Příliš 🧪", annotations: [] }] };
    const wire =
        ': heartbeat\r\nevent: response.output_item.done\r\ndata: {"type":"response.output_item.done",\r\ndata: "output_index":0,"item":' +
        SafeJSON.stringify(item) +
        "}\r\n\r\n" +
        "data: " +
        SafeJSON.stringify({ type: "response.completed", response: completedResponse }) +
        "\r\n\r\n";
    const bytes = new TextEncoder().encode(wire);
    let offset = 0;
    const response = await fetchWhamResponse({
        input: URL,
        init: { body: '{"stream":false}' },
        fetch: async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    pull(controller) {
                        if (offset < bytes.length) {
                            controller.enqueue(bytes.slice(offset, ++offset));
                        } else {
                            controller.close();
                        }
                    },
                }),
                {
                    headers: {
                        "content-type": "text/event-stream; charset=utf-8",
                        "content-length": "123",
                        "content-encoding": "gzip",
                        "transfer-encoding": "chunked",
                        "x-request-id": "fixture-request",
                    },
                }
            ),
    });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe("fixture-request");
    expect((await response.json()).output).toEqual([item]);
});

test("requested streaming, non-Responses requests, HTTP errors and JSON replies pass through untouched", async () => {
    for (const fixture of [
        { input: URL, body: '{"stream":true}', response: eventsResponse([{ type: "fixture" }]) },
        {
            input: "https://chatgpt.com/backend-api/wham/models",
            body: undefined,
            response: eventsResponse([{ type: "fixture" }]),
        },
        {
            input: URL,
            body: '{"stream":false}',
            response: new Response('{"error":"fixture"}', {
                status: 429,
                headers: { "content-type": "application/json" },
            }),
        },
        {
            input: URL,
            body: "{}",
            response: new Response(SafeJSON.stringify(completedResponse), {
                headers: { "content-type": "application/json" },
            }),
        },
    ]) {
        const response = await fetchWhamResponse({
            input: fixture.input,
            init: { body: fixture.body },
            fetch: async () => fixture.response,
        });
        expect(response).toBe(fixture.response);
        expect(response.bodyUsed).toBe(false);
        await response.body?.cancel();
    }
});

test("Request bodies and init overrides decide the response mode before rewriting", async () => {
    const request = new Request(URL, { method: "POST", body: '{"stream":true}' });
    const response = await fetchWhamResponse({
        input: request,
        init: { body: '{"stream":false}' },
        fetch: async () =>
            eventsResponse([
                { type: "response.completed", response: { ...completedResponse, output: [completedMessage] } },
            ]),
    });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect((await response.json()).output).toEqual([completedMessage]);
});

for (const [name, events] of [
    ["premature EOF", [{ type: "response.output_text.delta", output_index: 0, delta: "partial" }]],
    ["failure", [{ type: "response.failed", response: { status: "failed" } }]],
    ["incomplete", [{ type: "response.incomplete", response: { status: "incomplete" } }]],
    ["error event", [{ type: "error", message: "do not expose this body" }]],
    ["false completion", [{ type: "response.completed", response: { ...completedResponse, status: "in_progress" } }]],
    [
        "error in terminal",
        [{ type: "response.completed", response: { ...completedResponse, error: { message: "private" } } }],
    ],
    [
        "missing item completion",
        [
            { type: "response.output_text.delta", output_index: 0, delta: "partial" },
            { type: "response.completed", response: completedResponse },
        ],
    ],
    ["missing index", [{ type: "response.output_item.done", item: completedMessage }]],
    ["out-of-bounds index", [{ type: "response.output_item.done", output_index: 1024, item: completedMessage }]],
    [
        "conflicting terminal item",
        [
            { type: "response.output_item.done", output_index: 0, item: completedMessage },
            {
                type: "response.completed",
                response: { ...completedResponse, output: [{ ...completedMessage, id: "msg_other" }] },
            },
        ],
    ],
    [
        "changed response identity",
        [
            { type: "response.created", response: { id: "resp_other" } },
            { type: "response.completed", response: completedResponse },
        ],
    ],
] as const) {
    test(`rejects ${name} without returning partial success`, async () => {
        await expect(collectFixture([...events])).rejects.toThrow("OpenAI subscription");
    });
}

test("malformed data fails without reflecting its raw contents in the error", async () => {
    await expect(
        fetchWhamResponse({
            input: URL,
            init: { body: "{}" },
            fetch: async () =>
                new Response("data: private broken json\n\n", { headers: { "content-type": "text/event-stream" } }),
        })
    ).rejects.toThrow("OpenAI subscription returned a malformed response event");
});

test("aborting a stalled body cancels its reader and preserves the caller's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("fixture cancelled");
    let cancelled = false;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
        reading = resolve;
    });
    const response = new Response(
        new ReadableStream<Uint8Array>({
            pull() {
                reading();
            },
            cancel() {
                cancelled = true;
            },
        }),
        { headers: { "content-type": "text/event-stream" } }
    );
    const pending = fetchWhamResponse({
        input: URL,
        init: { body: "{}", signal: controller.signal },
        fetch: async () => response,
    });
    await started;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
});

test("a pre-aborted Request never reaches fetch", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    let calls = 0;
    await expect(
        fetchWhamResponse({
            input: new Request(URL, { method: "POST", body: "{}", signal: controller.signal }),
            fetch: async () => {
                calls++;
                return new Response();
            },
        })
    ).rejects.toThrow("already cancelled");
    expect(calls).toBe(0);
});

test("deadlines cover a custom fetch that never answers", async () => {
    let signal: AbortSignal | null | undefined;
    await expect(
        fetchWhamResponse({
            input: URL,
            init: { body: "{}" },
            timeoutMs: 10,
            fetch: (_input, init) => {
                signal = init?.signal;
                return new Promise<Response>(() => {});
            },
        })
    ).rejects.toThrow("deadline exceeded");
    expect(signal?.aborted).toBe(true);
});

test("deadline ends a stalled event stream even if cancellation itself never resolves", async () => {
    let cancelled = false;
    await expect(
        fetchWhamResponse({
            input: URL,
            init: { body: "{}" },
            timeoutMs: 10,
            fetch: async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        cancel() {
                            cancelled = true;
                            return new Promise<void>(() => {});
                        },
                    }),
                    { headers: { "content-type": "text/event-stream" } }
                ),
        })
    ).rejects.toThrow("deadline exceeded");
    await Promise.resolve();
    expect(cancelled).toBe(true);
});

test("oversized streams fail before JSON parsing and cancel the upstream source", async () => {
    let cancelled = false;
    await expect(
        fetchWhamResponse({
            input: URL,
            init: { body: "{}" },
            fetch: async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
                        },
                        cancel() {
                            cancelled = true;
                        },
                    }),
                    { headers: { "content-type": "text/event-stream" } }
                ),
        })
    ).rejects.toThrow("16 MiB limit");
    expect(cancelled).toBe(true);
});

test("headerless SSE split across bytes is collected without losing the inspected prefix", async () => {
    const wire = new TextEncoder().encode(
        "\uFEFF: heartbeat\r\n\r\ndata: " +
            SafeJSON.stringify({ type: "response.output_item.done", output_index: 0, item: completedMessage }) +
            "\n\ndata: " +
            SafeJSON.stringify({ type: "response.completed", response: completedResponse }) +
            "\n\n"
    );
    let offset = 0;
    const response = await fetchWhamResponse({
        input: URL,
        init: { body: "{}" },
        fetch: async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    pull(controller) {
                        if (offset === wire.length) {
                            controller.close();
                            return;
                        }
                        controller.enqueue(wire.slice(offset, ++offset));
                    },
                })
            ),
    });
    expect((await response.json()).output).toEqual([completedMessage]);
});

test("headerless JSON keeps its original response and all inspected bytes", async () => {
    const raw = new TextEncoder().encode(`  ${SafeJSON.stringify(completedResponse)}`);
    const original = new Response(raw);
    const response = await fetchWhamResponse({ input: URL, init: { body: "{}" }, fetch: async () => original });
    expect(response).toBe(original);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe(new TextDecoder().decode(raw));
});

test("the deadline also bounds a headerless response stalled during inspection", async () => {
    let cancelled = false;
    await expect(
        fetchWhamResponse({
            input: URL,
            init: { body: "{}" },
            timeoutMs: 10,
            fetch: async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode("ev"));
                        },
                        cancel() {
                            cancelled = true;
                        },
                    })
                ),
        })
    ).rejects.toThrow("deadline exceeded");
    await Promise.resolve();
    expect(cancelled).toBe(true);
});

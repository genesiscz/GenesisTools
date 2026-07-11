import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { SafeJSON } from "@app/utils/json";

const TEST_TOKEN = "codex-access-token";
const TEST_ACCOUNT_ID = "acct-123";

mock.module("@app/ai-proxy/lib/providers/openai-sub-token", () => ({
    resolveOpenAiSubToken: async () => ({ token: TEST_TOKEN, accountId: TEST_ACCOUNT_ID }),
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

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("buildWhamResponsesBody", () => {
    it("extracts system→instructions, maps messages→input, forces stream", async () => {
        const { buildWhamResponsesBody } = await import("./openai-subscription");
        const body = buildWhamResponsesBody(
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
        expect(body.max_output_tokens).toBe(64);
    });

    it("maps chat function tools to flat Responses tools", async () => {
        const { buildWhamResponsesBody } = await import("./openai-subscription");
        const body = buildWhamResponsesBody(
            {
                messages: [{ role: "user", content: "go" }],
                tools: [{ type: "function", function: { name: "search", description: "d", parameters: { type: "object" } } }],
            },
            "gpt-5.5"
        );

        expect(body.tools).toEqual([{ type: "function", name: "search", description: "d", parameters: { type: "object" } }]);
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
        };
        expect(completion.object).toBe("chat.completion");
        expect(completion.choices[0]?.message.content).toBe("CODEX_OK");

        // upstream targeted WHAM with the Codex token + account id
        expect(capturedUrl).toBe("https://chatgpt.com/backend-api/wham/responses");
        const headers = new Headers(capturedInit?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${TEST_TOKEN}`);
        expect(headers.get("chatgpt-account-id")).toBe(TEST_ACCOUNT_ID);
        expect(headers.get("openai-beta")).toBe("responses=experimental");

        // body was converted to Responses shape with the concrete model + stream
        const sentBody = SafeJSON.parse(String(capturedInit?.body)) as { model: string; stream: boolean; instructions: string; input: unknown[] };
        expect(sentBody.model).toBe("gpt-5.5");
        expect(sentBody.stream).toBe(true);
        expect(sentBody.instructions).toBe("Be terse.");
        expect(Array.isArray(sentBody.input)).toBe(true);
    });

    it("streams chat.completion.chunk when the client requests streaming", async () => {
        globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => whamStreamResponse()) as typeof fetch;

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
    });
});

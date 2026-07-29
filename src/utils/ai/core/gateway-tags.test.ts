import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import type { AccountEntry } from "../config/schema";
import { aiProxyPlugin } from "../providers/plugins/ai-proxy";
import { coreChat } from "./call";

/**
 * The ai-proxy groups its transcripts and usage records by the `x-gt-*` tags a
 * caller sends (src/ai-proxy/lib/usage/transcripts.ts:419), and those tags change
 * per REQUEST while a binding is built once per account. This pins the seam that
 * carries them: `coreChat({ headers })` → the ai-sdk call → the wire.
 */

const ACCOUNT: AccountEntry = {
    id: "acc_proxy",
    name: "local-proxy",
    provider: "ai-proxy",
    enabled: true,
    billing: { mode: "free" },
    endpoint: "http://127.0.0.1:9999/v1",
    credentials: { apiKey: "proxy-key-abc" },
    useEnvApiKey: false,
};

interface Captured {
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
}

function capturingFetch(captured: Captured[]): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        captured.push({
            url: String(input instanceof Request ? input.url : input),
            headers: new Headers(init?.headers),
            body: SafeJSON.parse(String(init?.body ?? "{}"), { strict: true }),
        });

        return new Response(
            SafeJSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                created: 0,
                model: "grok/grok-4.5",
                choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
        );
    }) as typeof fetch;
}

async function callThroughGateway(headers?: Record<string, string | undefined>): Promise<Captured> {
    const captured: Captured[] = [];
    const binding = await aiProxyPlugin.bind({ account: ACCOUNT, fetch: capturingFetch(captured) });

    const result = await coreChat({
        target: {
            model: binding.language("grok/grok-4.5"),
            providerType: binding.providerId,
            label: `${ACCOUNT.name}/grok-4.5`,
        },
        prompt: "ping",
        ...(headers ? { headers } : {}),
    });

    expect(result.content).toBe("pong");
    expect(captured).toHaveLength(1);
    return captured[0];
}

describe("ai-proxy gateway binding", () => {
    test("reaches the account's endpoint with its client key", async () => {
        const request = await callThroughGateway();

        expect(request.url).toBe("http://127.0.0.1:9999/v1/chat/completions");
        expect(request.headers.get("authorization")).toBe("Bearer proxy-key-abc");
        expect(request.body.model).toBe("grok/grok-4.5");
    });

    test("carries per-request x-gt-* job tags to the proxy", async () => {
        const request = await callThroughGateway({
            "x-gt-session": "sess-1",
            "x-gt-stage": "judge",
            "x-gt-run": "run-7",
            "x-gt-label": "vote",
        });

        expect(request.headers.get("x-gt-session")).toBe("sess-1");
        expect(request.headers.get("x-gt-stage")).toBe("judge");
        expect(request.headers.get("x-gt-run")).toBe("run-7");
        expect(request.headers.get("x-gt-label")).toBe("vote");
        // Tags must not cost the request its auth.
        expect(request.headers.get("authorization")).toBe("Bearer proxy-key-abc");
    });

    test("sends no tag headers when none were asked for", async () => {
        const request = await callThroughGateway();

        expect(request.headers.get("x-gt-session")).toBeNull();
    });
});

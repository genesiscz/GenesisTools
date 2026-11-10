import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { GithubCopilotSubscriptionProvider } from "@app/ai-proxy/lib/providers/github-copilot-subscription";
import { type ExchangeFetch, type ExchangeInput, exchange } from "@app/ai-proxy/lib/providers/http-relay";
import { OpenAiApiKeyProvider } from "@app/ai-proxy/lib/providers/openai-api-key";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { CopilotAuthExpiredError, GithubCopilotApi } from "@genesiscz/utils/ai/github-copilot";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

interface Sent {
    input: string | URL | Request;
    init?: RequestInit;
}

/** A fetch that records what it was handed and answers with `answer`, or rejects the way Bun does on an abort. */
function fakeFetch(answer: () => Response | Promise<Response>): { fetch: ExchangeFetch; sent: Sent[] } {
    const sent: Sent[] = [];
    const fetch: ExchangeFetch = async (input, init) => {
        sent.push({ input, init });

        if (init?.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        return answer();
    };

    return { fetch, sent };
}

function send(overrides: Partial<ExchangeInput> & Pick<ExchangeInput, "fetch">): Promise<Response> {
    return exchange({
        request: { url: "https://upstream.example/v1/chat/completions", init: { method: "POST", body: "{}" } },
        signal: new AbortController().signal,
        log: { provider: "example", account: "work", route: "/chat/completions" },
        failureCode: "example_fetch_failed",
        ...overrides,
    });
}

function abortedSignal(): AbortSignal {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
}

afterEach(() => {
    mock.restore();
});

describe("exchange", () => {
    /**
     * Pinned from the forwards before the exchange existed: every upstream header goes through except the framing
     * that Bun's decoded body made stale (content-encoding, content-length, transfer-encoding).
     */
    it("relays the upstream headers without the stale framing headers", async () => {
        const { fetch } = fakeFetch(
            () =>
                new Response('{"ok":true}', {
                    status: 200,
                    headers: {
                        "content-type": "application/json",
                        "content-encoding": "gzip",
                        "content-length": "999",
                        "transfer-encoding": "chunked",
                        "x-request-id": "req_1",
                        "retry-after": "7",
                        "set-cookie": "a=b",
                    },
                })
        );
        const response = await send({ fetch });

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('{"ok":true}');
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(response.headers.get("x-request-id")).toBe("req_1");
        expect(response.headers.get("retry-after")).toBe("7");
        expect(response.headers.get("set-cookie")).toBe("a=b");
        expect(response.headers.get("content-encoding")).toBeNull();
        expect(response.headers.get("transfer-encoding")).toBeNull();
        expect(response.headers.get("content-length")).not.toBe("999");
    });

    it("sends the url and init it was given, with the exchange's signal", async () => {
        const { fetch, sent } = fakeFetch(() => new Response("{}"));
        const signal = new AbortController().signal;

        await send({ fetch, signal });

        expect(sent).toHaveLength(1);
        expect(sent[0].input).toBe("https://upstream.example/v1/chat/completions");
        expect(sent[0].init?.method).toBe("POST");
        expect(sent[0].init?.signal).toBe(signal);
    });

    it("sends a Request as it is", async () => {
        const { fetch, sent } = fakeFetch(() => new Response("{}"));
        const request = new Request("https://upstream.example/v1/models");

        await send({ fetch, request });

        expect(sent[0].input).toBe(request);
    });

    it("answers a client abort with 499 and logs it at debug, not as an error", async () => {
        const debug = spyOn(logger, "debug");
        const warn = spyOn(logger, "warn");
        const error = spyOn(logger, "error");
        const { fetch } = fakeFetch(() => new Response("{}"));

        const response = await send({ fetch, signal: abortedSignal() });

        expect(response.status).toBe(499);
        expect(response.body).toBeNull();
        expect(debug.mock.calls.some((call) => String(call[1]).includes("client aborted"))).toBe(true);
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    it("wraps a thrown fetch as a 502 in the OpenAI error envelope", async () => {
        const warn = spyOn(logger, "warn");
        const fetch: ExchangeFetch = async () => {
            throw new Error("Unable to connect");
        };

        const response = await send({ fetch });
        const body = SafeJSON.parse(await response.text(), { strict: true });

        expect(response.status).toBe(502);
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(body).toEqual({
            error: { message: "Unable to connect", type: "upstream_error", code: "example_fetch_failed" },
        });
        expect(warn).toHaveBeenCalled();
    });

    it("lets the provider answer a thrown error it knows, and falls back to the 502 for one it does not", async () => {
        const known = new Error("login expired");
        const fetchThrowing =
            (err: Error): ExchangeFetch =>
            async () => {
                throw err;
            };
        const mapThrown = (err: unknown) => (err === known ? new Response("relogin", { status: 502 }) : undefined);

        const mapped = await send({ fetch: fetchThrowing(known), mapThrown });
        const fallback = await send({ fetch: fetchThrowing(new Error("other")), mapThrown });

        expect(await mapped.text()).toBe("relogin");
        expect(fallback.status).toBe(502);
        expect(await fallback.text()).toContain("example_fetch_failed");
    });

    it("hands a non-OK answer to mapNonOk and returns its answer", async () => {
        const { fetch } = fakeFetch(() => new Response('{"code":"x","error":"bad"}', { status: 400 }));
        const seen: number[] = [];

        const response = await send({
            fetch,
            mapNonOk: async (upstream) => {
                seen.push(upstream.status);
                return new Response(`mapped ${await upstream.text()}`, { status: 418 });
            },
        });

        expect(seen).toEqual([400]);
        expect(response.status).toBe(418);
        expect(await response.text()).toBe('mapped {"code":"x","error":"bad"}');
    });

    it("never hands an OK answer to mapNonOk", async () => {
        const { fetch } = fakeFetch(() => new Response("fine"));
        let called = false;

        const response = await send({
            fetch,
            mapNonOk: () => {
                called = true;
                return new Response("mapped", { status: 500 });
            },
        });

        expect(called).toBe(false);
        expect(await response.text()).toBe("fine");
    });

    it("relays a non-OK answer as it came when there is no mapper", async () => {
        const { fetch } = fakeFetch(
            () => new Response("rate limited", { status: 429, headers: { "retry-after": "3", "x-request-id": "r" } })
        );

        const response = await send({ fetch });

        expect(response.status).toBe(429);
        expect(await response.text()).toBe("rate limited");
        expect(response.headers.get("retry-after")).toBe("3");
        expect(response.headers.get("x-request-id")).toBe("r");
    });
});

describe("the forwards that use the exchange", () => {
    const openai: AiProxyAccountConfig = { name: "work", provider: "openai", providerSlug: "openai", enabled: true };

    it("openai-api-key sends the rewritten body with its key through the injected fetch", async () => {
        const { fetch, sent } = fakeFetch(() => new Response("{}"));
        const provider = new OpenAiApiKeyProvider(openai, "sk-test-key-0000", fetch);

        await provider.chatCompletions(
            new Request("http://proxy/v1/chat/completions", { method: "POST" }),
            "gpt-test",
            SafeJSON.stringify({ model: "work/openai/gpt-test", messages: [] })
        );

        expect(sent[0].input).toBe("https://api.openai.com/v1/chat/completions");
        expect(new Headers(sent[0].init?.headers).get("authorization")).toBe("Bearer sk-test-key-0000");
        expect(SafeJSON.parse(String(sent[0].init?.body), { strict: true })).toEqual({
            model: "gpt-test",
            messages: [],
        });
    });

    it("openai-api-key answers a thrown fetch with its own 502 code", async () => {
        const provider = new OpenAiApiKeyProvider(openai, "sk-test-key-0000", async () => {
            throw new Error("offline");
        });

        const response = await provider.responses(new Request("http://proxy/v1/responses"), "gpt-test", "{}");

        expect(response.status).toBe(502);
        expect(await response.text()).toContain("openai_api_fetch_failed");
    });

    function copilot(fetch: GithubCopilotApi["fetch"]): GithubCopilotSubscriptionProvider {
        const client = new GithubCopilotApi({ dataDir: "/tmp/none", apiBaseUrl: "https://copilot.example" });
        client.fetch = fetch;

        return new GithubCopilotSubscriptionProvider(
            { name: "work", provider: "github-copilot-subscription", providerSlug: "copilot", enabled: true },
            client
        );
    }

    /** It used to log every client abort at error level and rethrow it. */
    it("copilot answers a client abort with 499 and logs no error", async () => {
        const error = spyOn(logger, "error");
        const provider = copilot(async (_path, init) => {
            if (init?.signal?.aborted) {
                throw new DOMException("The operation was aborted.", "AbortError");
            }

            return new Response("{}");
        });
        const request = new Request("http://proxy/v1/chat/completions", { method: "POST", signal: abortedSignal() });

        const response = await provider.chatCompletions(request, "gpt-test", "{}");

        expect(response.status).toBe(499);
        expect(error).not.toHaveBeenCalled();
    });

    it("copilot sends the path through the client's own fetch", async () => {
        const paths: string[] = [];
        const provider = copilot(async (path) => {
            paths.push(path);
            return new Response("{}", { headers: { "x-request-id": "c1" } });
        });

        const response = await provider.responses(new Request("http://proxy/v1/responses"), "gpt-test", "{}");

        expect(paths).toEqual(["/responses"]);
        expect(response.headers.get("x-request-id")).toBe("c1");
    });

    it("copilot answers an expired login with its auth envelope", async () => {
        const provider = copilot(async () => {
            throw new CopilotAuthExpiredError("/tmp/none");
        });

        const response = await provider.responses(new Request("http://proxy/v1/responses"), "gpt-test", "{}");
        const body = SafeJSON.parse(await response.text(), { strict: true });

        expect(response.status).toBe(502);
        expect(body).toMatchObject({ error: { type: "upstream_auth_error", code: "github_copilot_auth_expired" } });
    });
});

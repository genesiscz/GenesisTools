import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProxyRoute } from "@app/ai-proxy/lib/account-model-ref";
import { loadConfigFresh } from "@app/ai-proxy/lib/config";
import { getAiProxyConfigStore, resetAiProxyConfigStore } from "@app/ai-proxy/lib/config-store";
import { acquireProvider } from "@app/ai-proxy/lib/providers/pool";
import { routeProviderKey } from "@app/ai-proxy/lib/providers/provider-key";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { createRuntime, startAiProxyServer } from "@app/ai-proxy/lib/server";
import { createSessionRecord } from "@app/ai-proxy/lib/sessions/records";
import { getAiProxyStorage, resetAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

// Hermetic: the real server module on a spare port, a fake provider in the provider map (no upstream, no network), and
// a session record in the sandboxed home. Every model door answers the same cases, so a door that drifts shows here.

const PROXY_KEY = "test-proxy-key-0123456789abcdef";
const MODEL = "work/grok/grok-test";
const THROWING_MODEL = "grok-throws";

interface UpstreamCall {
    kind: "chat" | "responses";
    model: string;
    body: Record<string, unknown>;
}

const upstreamCalls: UpstreamCall[] = [];

let proxy: ReturnType<typeof startAiProxyServer>;
let baseUrl: string;
let sessionKey: string;
const originalHome = env.get("GENESIS_TOOLS_HOME");

function parseBody(bodyText: string): Record<string, unknown> {
    return SafeJSON.parse(bodyText, { strict: true }) as Record<string, unknown>;
}

function fakeProvider(accountFingerprint: string): ProxyProvider {
    return {
        id: "xai-api-key",
        accountFingerprint,
        listModels: async () => [],
        getUsage: async () => ({ accountName: "work", provider: "xai-api-key", summary: "" }),
        chatCompletions: async (_req, model, bodyText) => {
            upstreamCalls.push({ kind: "chat", model, body: parseBody(bodyText) });

            if (model === THROWING_MODEL) {
                throw new Error("the fake upstream fell over");
            }

            return Response.json({
                id: "chatcmpl-test",
                object: "chat.completion",
                created: 1,
                model,
                choices: [{ index: 0, message: { role: "assistant", content: "fake reply" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            });
        },
        responses: async (_req, model, bodyText) => {
            upstreamCalls.push({ kind: "responses", model, body: parseBody(bodyText) });

            if (model === THROWING_MODEL) {
                throw new Error("the fake upstream fell over");
            }

            return Response.json({
                id: "resp-test",
                object: "response",
                status: "completed",
                model,
                output: [
                    {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "fake reply" }],
                    },
                ],
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            });
        },
    };
}

/** One request body per door, for a given model id. */
const DOORS = {
    messages: {
        path: "/v1/messages",
        body: (model: string) => ({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    },
    chat: {
        path: "/v1/chat/completions",
        body: (model: string) => ({ model, messages: [{ role: "user", content: "hi" }] }),
    },
    responses: {
        path: "/v1/responses",
        body: (model: string) => ({ model, input: "hi" }),
    },
} as const;

type DoorName = keyof typeof DOORS;
const DOOR_NAMES = Object.keys(DOORS) as DoorName[];

async function post(path: string, init: { key: string; body?: string }): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${init.key}`, "Content-Type": "application/json" },
        body: init.body,
    });
    const text = await res.text();

    return { status: res.status, json: text ? SafeJSON.parse(text, { strict: true }) : undefined };
}

beforeAll(async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ai-proxy-doors-"));
    env.testing.set("GENESIS_TOOLS_HOME", tempDir);
    resetAiProxyConfigStore();
    resetAiProxyStorage();

    const config: AiProxyConfig = {
        listen: { host: "127.0.0.1", port: 0 },
        proxyApiKey: PROXY_KEY,
        translation: { cursorAgent: "off", thinking: "raw" },
        accounts: [
            {
                name: "work",
                provider: "xai-api-key",
                providerSlug: "grok",
                enabled: true,
                apiKey: "xai-test-key-not-real",
                baseUrl: "http://127.0.0.1:9",
            },
            {
                name: "personal",
                provider: "xai-api-key",
                providerSlug: "grok",
                enabled: true,
                apiKey: "xai-test-key-not-real-2",
                baseUrl: "http://127.0.0.1:9",
            },
        ],
    };

    mkdirSync(getAiProxyStorage().getBaseDir(), { recursive: true });
    await getAiProxyConfigStore().save(config);

    // The server reloads the stored config per request, so the fake must carry the fingerprint of the stored account.
    const stored = await loadConfigFresh();
    const runtime = await createRuntime(stored);

    for (const model of [MODEL, "personal/grok/grok-test"]) {
        const route = await resolveProxyRoute(model, stored.accounts);
        const real = await acquireProvider(runtime.providers, route);

        if (!real) {
            throw new Error(`the test account for ${model} did not build`);
        }

        runtime.providers.set(routeProviderKey(route), fakeProvider(real.accountFingerprint));
    }

    sessionKey = createSessionRecord({
        id: "door-test-session",
        grokProxyAccount: "work",
        meteredConfirmed: [{ account: "work", confirmedAt: new Date(0).toISOString(), how: "flag" }],
    }).key;

    proxy = startAiProxyServer(runtime);
    baseUrl = `http://127.0.0.1:${proxy.port}`;
});

afterAll(() => {
    proxy?.stop(true);
    resetAiProxyConfigStore();
    resetAiProxyStorage();

    if (originalHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", originalHome);
    }
});

const OPENAI_AUTH = { error: { message: "Invalid proxy API key", type: "auth_error" } };
const OPENAI_INVALID_JSON = { error: { message: "Invalid JSON body" } };
const OPENAI_MISSING_MODEL = { error: { message: "Missing model" } };

function anthropicError(type: string, message: string) {
    return { type: "error", error: { type, message } };
}

const ANTHROPIC_AUTH = anthropicError("authentication_error", "Invalid proxy API key");

/** What each door answers for each failure: its own protocol's envelope, the Anthropic one on `/v1/messages`. */
const FAILURES: Record<DoorName, { auth: unknown; invalidJson: unknown; missingModel: unknown }> = {
    messages: {
        auth: ANTHROPIC_AUTH,
        invalidJson: anthropicError("invalid_request_error", "Invalid JSON body"),
        missingModel: anthropicError("invalid_request_error", "Missing model"),
    },
    chat: { auth: OPENAI_AUTH, invalidJson: OPENAI_INVALID_JSON, missingModel: OPENAI_MISSING_MODEL },
    responses: { auth: OPENAI_AUTH, invalidJson: OPENAI_INVALID_JSON, missingModel: OPENAI_MISSING_MODEL },
};

describe("model doors: failures in each door's envelope", () => {
    for (const door of DOOR_NAMES) {
        it(`${door}: a wrong key is a 401`, async () => {
            const res = await post(DOORS[door].path, {
                key: "wrong-key-0123456789",
                body: SafeJSON.stringify(DOORS[door].body(MODEL)),
            });

            expect(res).toEqual({ status: 401, json: FAILURES[door].auth });
        });

        it(`${door}: a missing body is a 400`, async () => {
            const res = await post(DOORS[door].path, { key: PROXY_KEY });

            expect(res).toEqual({ status: 400, json: FAILURES[door].invalidJson });
        });

        it(`${door}: a body that is not JSON is a 400`, async () => {
            const res = await post(DOORS[door].path, { key: PROXY_KEY, body: "{not json" });

            expect(res).toEqual({ status: 400, json: FAILURES[door].invalidJson });
        });

        it(`${door}: a body without a model is a 400`, async () => {
            const res = await post(DOORS[door].path, { key: PROXY_KEY, body: "{}" });

            expect(res).toEqual({ status: 400, json: FAILURES[door].missingModel });
        });
    }

    /** The server's own handler, with a body stream that errors after its first chunk (no socket can carry that). */
    async function postBrokenBody(path: string): Promise<{ status: number; json: unknown }> {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"model":'));
                controller.error(new Error("the client's body stream broke"));
            },
        });
        const res = await proxy.fetch(
            new Request(`${baseUrl}${path}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${PROXY_KEY}`, "Content-Type": "application/json" },
                body,
            })
        );
        const text = await res.text();

        return { status: res.status, json: text ? SafeJSON.parse(text, { strict: true }) : undefined };
    }

    const BODY_UNREADABLE: Record<DoorName, unknown> = {
        messages: anthropicError("invalid_request_error", "Could not read the request body"),
        chat: { error: { message: "Could not read the request body" } },
        responses: { error: { message: "Could not read the request body" } },
    };

    for (const door of DOOR_NAMES) {
        it(`${door}: a body stream that fails is a 400 in the door's envelope`, async () => {
            expect(await postBrokenBody(DOORS[door].path)).toEqual({ status: 400, json: BODY_UNREADABLE[door] });
        });
    }

    it("count_tokens and realtime client_secrets: a body stream that fails is a 400 in their envelopes", async () => {
        expect(await postBrokenBody("/v1/messages/count_tokens")).toEqual({
            status: 400,
            json: BODY_UNREADABLE.messages,
        });
        expect(await postBrokenBody("/v1/realtime/client_secrets")).toEqual({
            status: 400,
            json: BODY_UNREADABLE.chat,
        });
    });

    it("count_tokens: a wrong key is a 401", async () => {
        const res = await post("/v1/messages/count_tokens", { key: "wrong-key-0123456789", body: "{}" });

        expect(res).toEqual({ status: 401, json: ANTHROPIC_AUTH });
    });

    it("count_tokens: a good key counts", async () => {
        const res = await post("/v1/messages/count_tokens", {
            key: PROXY_KEY,
            body: SafeJSON.stringify(DOORS.messages.body(MODEL)),
        });

        expect(res.status).toBe(200);
        expect(res.json).toEqual({ input_tokens: expect.any(Number) });
    });
});

describe("model doors: a routed request reaches the provider", () => {
    const THROWN: Record<DoorName, unknown> = {
        messages: anthropicError("api_error", "Request failed"),
        chat: { error: { message: "Request failed" } },
        responses: { error: { message: "Request failed" } },
    };

    for (const door of DOOR_NAMES) {
        it(`${door}: a provider that throws is a 502 in the door's envelope`, async () => {
            const res = await post(DOORS[door].path, {
                key: PROXY_KEY,
                body: SafeJSON.stringify(DOORS[door].body(`work/grok/${THROWING_MODEL}`)),
            });

            expect(res).toEqual({ status: 502, json: THROWN[door] });
        });
    }

    it("an unknown model is a 400 with the reason", async () => {
        const res = await post(DOORS.chat.path, {
            key: PROXY_KEY,
            body: SafeJSON.stringify(DOORS.chat.body("nobody/grok/grok-test")),
        });

        expect(res.status).toBe(400);
        expect(res.json).toEqual({ error: { message: expect.stringContaining("No enabled account") } });
    });

    it("messages: answers in Anthropic's shape through the translated path", async () => {
        const before = upstreamCalls.length;
        const res = await post(DOORS.messages.path, {
            key: PROXY_KEY,
            body: SafeJSON.stringify(DOORS.messages.body(MODEL)),
        });

        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "fake reply" }],
        });
        expect(upstreamCalls.slice(before).map((call) => [call.kind, call.model])).toEqual([["chat", "grok-test"]]);
    });

    it("chat: answers in the chat completion shape", async () => {
        const res = await post(DOORS.chat.path, { key: PROXY_KEY, body: SafeJSON.stringify(DOORS.chat.body(MODEL)) });

        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({
            object: "chat.completion",
            choices: [{ message: { content: "fake reply" } }],
        });
    });

    it("responses: answers in the responses shape", async () => {
        const res = await post(DOORS.responses.path, {
            key: PROXY_KEY,
            body: SafeJSON.stringify(DOORS.responses.body(MODEL)),
        });

        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ object: "response", status: "completed" });
    });
});

describe("model doors: a session key", () => {
    for (const door of DOOR_NAMES) {
        it(`${door}: the short form routes to the session's account and stamps its effort suffix`, async () => {
            const before = upstreamCalls.length;
            const res = await post(DOORS[door].path, {
                key: sessionKey,
                body: SafeJSON.stringify(DOORS[door].body("grok/grok-test:high")),
            });

            expect(res.status).toBe(200);
            const calls = upstreamCalls.slice(before);
            expect(calls.map((call) => call.model)).toEqual(["grok-test"]);
            expect(calls[0]?.body.reasoning_effort).toBe("high");
        });
    }

    const SESSION_DENIAL: Record<DoorName, unknown> = {
        messages: {
            type: "error",
            error: { type: "permission_error", message: expect.stringContaining('account "personal"') },
        },
        chat: {
            error: {
                message: expect.stringContaining('account "personal"'),
                type: "forbidden",
                code: "provider_not_allowed",
            },
        },
        responses: {
            error: {
                message: expect.stringContaining('account "personal"'),
                type: "forbidden",
                code: "provider_not_allowed",
            },
        },
    };

    for (const door of DOOR_NAMES) {
        it(`${door}: an account outside the session is refused by the gate in the door's envelope`, async () => {
            const before = upstreamCalls.length;
            const res = await post(DOORS[door].path, {
                key: sessionKey,
                body: SafeJSON.stringify(DOORS[door].body("personal/grok/grok-test")),
            });

            expect(res).toEqual({ status: 403, json: SESSION_DENIAL[door] });
            expect(upstreamCalls.length).toBe(before);
        });
    }
});

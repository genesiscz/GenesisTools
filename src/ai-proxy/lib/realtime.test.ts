import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAiProxyConfigStore, resetAiProxyConfigStore } from "@app/ai-proxy/lib/config-store";
import { createRuntime, startAiProxyServer } from "@app/ai-proxy/lib/server";
import { getAiProxyStorage, resetAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

// Integration: real proxy server + mock upstream realtime WS (xAI credits are
// exhausted, so live verification is pending — see REALTIME.md). The mock
// stands in for wss://api.x.ai/v1/realtime via the account's realtimeBaseUrl.

const PROXY_KEY = "test-proxy-key-0123456789abcdef";

interface UpstreamSession {
    authorization: string | null;
    model: string | null;
}

const upstreamSessions: UpstreamSession[] = [];

let mockUpstream: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof startAiProxyServer>;
let proxyUrl: string;

const originalHome = env.get("GENESIS_TOOLS_HOME");
const originalKey = env.get("AI_PROXY_TEST_XAI_KEY");

function startMockUpstream() {
    return Bun.serve<UpstreamSession, never>({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req, server) {
            const url = new URL(req.url);

            if (url.pathname !== "/realtime") {
                return new Response("Not Found", { status: 404 });
            }

            const session: UpstreamSession = {
                authorization: req.headers.get("Authorization"),
                model: url.searchParams.get("model"),
            };
            upstreamSessions.push(session);

            if (server.upgrade(req, { data: session })) {
                return undefined;
            }

            return new Response("upgrade failed", { status: 426 });
        },
        websocket: {
            open(ws) {
                ws.send(SafeJSON.stringify({ type: "session.created", model: ws.data.model }));
            },
            message(ws, message) {
                if (typeof message === "string") {
                    if (message === "close-me") {
                        ws.close(4321, "mock upstream bye");
                        return;
                    }

                    if (message === "report-usage") {
                        ws.send(
                            SafeJSON.stringify({
                                type: "response.done",
                                response: { usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 } },
                            })
                        );
                        return;
                    }

                    ws.send(`echo:${message}`);
                    return;
                }

                // Binary frames echo back verbatim.
                ws.send(message);
            },
        },
    });
}

async function connectClient(query: string, headers?: Record<string, string>) {
    const events: (string | ArrayBuffer)[] = [];
    const opened = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<{ code: number; reason: string }>();
    const ws = new WebSocket(`${proxyUrl}/v1/realtime${query}`, headers ? ({ headers } as never) : undefined);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => opened.resolve();
    ws.onerror = () => opened.reject(new Error("client WS errored"));
    ws.onclose = (event) => closed.resolve({ code: event.code, reason: event.reason });
    ws.onmessage = (event) => events.push(event.data as string | ArrayBuffer);

    return { ws, events, opened: opened.promise, closed: closed.promise };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const started = Date.now();

    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error("waitFor timed out");
        }

        await Bun.sleep(10);
    }
}

beforeAll(async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ai-proxy-realtime-"));
    env.testing.set("GENESIS_TOOLS_HOME", tempDir);
    env.testing.set("AI_PROXY_TEST_XAI_KEY", "xai-mock-key");
    resetAiProxyConfigStore();
    resetAiProxyStorage();

    mockUpstream = startMockUpstream();

    const config: AiProxyConfig = {
        listen: { host: "127.0.0.1", port: 0 },
        proxyApiKey: PROXY_KEY,
        translation: { cursorAgent: "off", thinking: "raw" },
        accounts: [
            {
                name: "martin",
                provider: "xai-api-key",
                providerSlug: "grok",
                enabled: true,
                apiKeyEnv: "AI_PROXY_TEST_XAI_KEY",
                baseUrl: `http://127.0.0.1:${mockUpstream.port}`,
                realtimeBaseUrl: `ws://127.0.0.1:${mockUpstream.port}`,
            },
        ],
    };

    mkdirSync(getAiProxyStorage().getBaseDir(), { recursive: true });
    await getAiProxyConfigStore().save(config);

    const runtime = await createRuntime(config);
    proxy = startAiProxyServer(runtime);
    proxyUrl = `ws://127.0.0.1:${proxy.port}`;
});

afterAll(() => {
    proxy?.stop(true);
    mockUpstream?.stop(true);
    resetAiProxyConfigStore();
    resetAiProxyStorage();

    if (originalHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", originalHome);
    }

    if (originalKey === undefined) {
        env.testing.unset("AI_PROXY_TEST_XAI_KEY");
    } else {
        env.testing.set("AI_PROXY_TEST_XAI_KEY", originalKey);
    }
});

describe("realtime WS tunnel", () => {
    it("rejects a bad proxy key with 401 before upgrading", async () => {
        const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/realtime?model=martin/grok/grok-voice-latest`, {
            headers: { Authorization: "Bearer wrong-key" },
        });

        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: { type: string } };
        expect(body.error.type).toBe("auth_error");
    });

    it("rejects a missing model with 400", async () => {
        const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/realtime`, {
            headers: { Authorization: `Bearer ${PROXY_KEY}` },
        });

        expect(res.status).toBe(400);
    });

    it("rejects an unknown model with 400", async () => {
        const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/realtime?model=nope/nope/nope`, {
            headers: { Authorization: `Bearer ${PROXY_KEY}` },
        });

        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { message: string } };
        expect(body.error.message).toContain("No enabled account");
    });

    it("pipes text and binary frames both ways with routed model + upstream auth", async () => {
        const sessionsBefore = upstreamSessions.length;
        const client = await connectClient("?model=martin/grok/grok-voice-latest", {
            Authorization: `Bearer ${PROXY_KEY}`,
        });
        await client.opened;

        // Sent before the upstream leg opens — must be queued, not dropped.
        client.ws.send(SafeJSON.stringify({ type: "session.update" }));
        const audio = new Uint8Array([0, 1, 2, 250, 251, 252]);
        client.ws.send(audio);

        await waitFor(() => client.events.length >= 3);

        // Upstream saw the resolved upstream model id + the ACCOUNT key (not the proxy key).
        expect(upstreamSessions.length).toBe(sessionsBefore + 1);
        const session = upstreamSessions[sessionsBefore];
        expect(session.model).toBe("grok-voice-latest");
        expect(session.authorization).toBe("Bearer xai-mock-key");

        expect(client.events[0]).toBe('{"type":"session.created","model":"grok-voice-latest"}');
        expect(client.events[1]).toBe('echo:{"type":"session.update"}');
        expect(client.events[2]).toBeInstanceOf(ArrayBuffer);
        expect(Array.from(new Uint8Array(client.events[2] as ArrayBuffer))).toEqual(Array.from(audio));

        client.ws.close(1000);
    });

    it("accepts the proxy key via ?key= for browser clients", async () => {
        const client = await connectClient(`?model=martin/grok/grok-voice-latest&key=${PROXY_KEY}`);
        await client.opened;
        await waitFor(() => client.events.length >= 1);
        expect(client.events[0]).toBe('{"type":"session.created","model":"grok-voice-latest"}');
        client.ws.close(1000);
    });

    it("closes the client when the upstream closes", async () => {
        const client = await connectClient("?model=martin/grok/grok-voice-latest", {
            Authorization: `Bearer ${PROXY_KEY}`,
        });
        await client.opened;
        await waitFor(() => client.events.length >= 1);

        client.ws.send("close-me");
        const closeEvent = await client.closed;

        expect(closeEvent.code).toBe(4321);
        expect(closeEvent.reason).toBe("mock upstream bye");
    });

    it("records usage from response.done events without breaking the pipe", async () => {
        const client = await connectClient("?model=martin/grok/grok-voice-latest", {
            Authorization: `Bearer ${PROXY_KEY}`,
        });
        await client.opened;
        await waitFor(() => client.events.length >= 1);

        client.ws.send("report-usage");
        await waitFor(() => client.events.length >= 2);

        // The usage event is relayed verbatim to the client (transparent tunnel).
        expect(client.events[1]).toContain('"response.done"');
        client.ws.close(1000);
    });
});

describe("realtime client_secrets mint", () => {
    it("rejects a bad proxy key with 401", async () => {
        const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/realtime/client_secrets`, {
            method: "POST",
            headers: { Authorization: "Bearer wrong-key", "Content-Type": "application/json" },
            body: SafeJSON.stringify({ session: { type: "realtime", model: "martin/grok/grok-voice-latest" } }),
        });

        expect(res.status).toBe(401);
    });

    it("requires a model in the body", async () => {
        const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/realtime/client_secrets`, {
            method: "POST",
            headers: { Authorization: `Bearer ${PROXY_KEY}`, "Content-Type": "application/json" },
            body: SafeJSON.stringify({ session: { type: "realtime" } }),
        });

        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { message: string } };
        expect(body.error.message).toContain("Missing model");
    });
});

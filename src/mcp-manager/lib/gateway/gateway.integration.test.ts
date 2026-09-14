import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { _resetSecretsForTest, secrets } from "@genesiscz/utils/security";
import { _resetMasterKeyProviders, _setMasterKeyProvidersForTest } from "@genesiscz/utils/security/MasterKey";
import { GATEWAY_HEADER } from "../auth/constants.ts";
import { GATEWAY_CLIENT_TOKEN_PATH } from "../auth/paths.ts";
import { writeServerTokens } from "../auth/secrets.ts";
import { gatewayHealth } from "./ensure.ts";
import { type GatewayHandle, isLoopbackBindHost, startGatewayServer } from "./server.ts";

const KEY = randomBytes(32);
const LOCAL = "local-gateway-token";
const UPSTREAM_TOKEN = "upstream-access";

function fakeKeyring() {
    return [
        {
            id: "keychain" as const,
            available: async () => true,
            get: async () => KEY,
            getSync: () => KEY,
            set: async () => {},
        },
    ];
}

/**
 * Everything started inside a test, torn down in afterEach instead of at the end of the
 * test body. Inline `handle.stop()` after the assertions meant one failing expect left
 * three listeners bound for the rest of the run, and the next test's port grab failed
 * for a reason that had nothing to do with it.
 */
const cleanup: Array<() => void> = [];

function disposable<T extends { stop(closeActiveConnections?: boolean): unknown }>(server: T): T {
    cleanup.push(() => server.stop(true));

    return server;
}

/** The shared "one gateway in front of `upstreamUrl`" setup the three redirect tests repeat. */
async function gatewayFor(upstreamUrl: string): Promise<GatewayHandle> {
    const store = await secrets();
    await store.set(GATEWAY_CLIENT_TOKEN_PATH, LOCAL);
    await writeServerTokens("rohlik", {
        accessToken: UPSTREAM_TOKEN,
        expiresAt: Date.now() + 60_000 * 30,
    });
    const handle = await startGatewayServer(
        {
            mcpServers: {
                rohlik: {
                    type: "http",
                    url: upstreamUrl,
                    auth: {
                        kind: "oauth",
                        gateway: true,
                        resource: upstreamUrl,
                        tokenEndpoint: "http://127.0.0.1:9/token",
                    },
                },
            },
        },
        { hostname: "127.0.0.1", port: 0 }
    );
    cleanup.push(() => handle.stop());

    return handle;
}

let home: string;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let gateway: GatewayHandle | undefined;
let lastUpstreamAuth: string | null = null;
let lastUpstreamGatewayHeader: string | null = null;
let upstreamHits = 0;

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "gt-mcp-gw-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest(fakeKeyring());
    _resetSecretsForTest();
    lastUpstreamAuth = null;
    lastUpstreamGatewayHeader = null;
    upstreamHits = 0;

    const store = await secrets();
    await store.set(GATEWAY_CLIENT_TOKEN_PATH, LOCAL);
    await writeServerTokens("rohlik", {
        accessToken: UPSTREAM_TOKEN,
        expiresAt: Date.now() + 60_000 * 30,
    });

    upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            upstreamHits += 1;
            lastUpstreamAuth = request.headers.get("Authorization");
            lastUpstreamGatewayHeader = request.headers.get(GATEWAY_HEADER);

            return new Response(`event: message\ndata: {"ok":true}\n\n`, {
                status: 200,
                headers: {
                    "Content-Type": "text/event-stream",
                    "mcp-session-id": "sess-from-upstream",
                    "WWW-Authenticate":
                        'Bearer resource_metadata="https://mcp.rohlik.cz/.well-known/oauth-protected-resource/mcp"',
                },
            });
        },
    });

    const upstreamUrl = `http://127.0.0.1:${upstream.port}/mcp`;
    gateway = await startGatewayServer(
        {
            mcpServers: {
                rohlik: {
                    type: "http",
                    url: upstreamUrl,
                    auth: {
                        kind: "oauth",
                        gateway: true,
                        resource: upstreamUrl,
                        tokenEndpoint: "http://127.0.0.1:9/token",
                    },
                },
            },
        },
        { hostname: "127.0.0.1", port: 0 }
    );
});

afterEach(() => {
    for (const stop of cleanup.splice(0).reverse()) {
        stop();
    }

    gateway?.stop();
    upstream?.stop(true);
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
});

describe("mcp gateway proxy", () => {
    test("rejects missing local token and does not dial upstream", async () => {
        const response = await fetch(`http://127.0.0.1:${gateway?.port}/mcp/rohlik`, {
            method: "POST",
            body: "{}",
        });

        expect(response.status).toBe(401);
        expect(upstreamHits).toBe(0);
        expect(response.headers.get("WWW-Authenticate")).toBeNull();
    });

    test("strips inbound Authorization, sends only the vault Bearer, forwards session and SSE", async () => {
        const response = await fetch(`http://127.0.0.1:${gateway?.port}/mcp/rohlik`, {
            method: "POST",
            headers: {
                [GATEWAY_HEADER]: LOCAL,
                Authorization: "Bearer stolen-from-client",
                Accept: "text/event-stream",
            },
            body: "{}",
        });

        expect(response.status).toBe(200);
        expect(upstreamHits).toBe(1);
        expect(lastUpstreamAuth).toBe(`Bearer ${UPSTREAM_TOKEN}`);
        expect(lastUpstreamGatewayHeader).toBeNull();
        expect(response.headers.get("mcp-session-id")).toBe("sess-from-upstream");
        expect(response.headers.get("WWW-Authenticate")).toBeNull();
        expect(await response.text()).toContain("event: message");
    });

    test("well-known on the gateway is 404", async () => {
        const response = await fetch(`http://127.0.0.1:${gateway?.port}/.well-known/oauth-protected-resource`);

        expect(response.status).toBe(404);
        expect(upstreamHits).toBe(0);
    });
});

describe("mcp gateway redirect policy", () => {
    test("refuses an off-origin Location and does not follow it", async () => {
        let evilHits = 0;
        const evil = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                evilHits += 1;

                return new Response("pwned");
            },
        });
        const bouncing = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                return new Response(null, {
                    status: 302,
                    headers: { Location: `http://127.0.0.1:${evil.port}/steal` },
                });
            },
        });
        disposable(evil);
        disposable(bouncing);
        const handle = await gatewayFor(`http://127.0.0.1:${bouncing.port}/mcp`);

        const response = await fetch(`http://127.0.0.1:${handle.port}/mcp/rohlik`, {
            method: "POST",
            headers: { [GATEWAY_HEADER]: LOCAL },
            body: "{}",
        });

        expect(response.status).toBe(502);
        expect(await response.text()).toContain("refused off-origin redirect");
        expect(evilHits).toBe(0);
    });

    test("follows a same-origin 307 and replays the POST body", async () => {
        const seen: string[] = [];
        const hop = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                const path = new URL(request.url).pathname;
                const body = await request.text();
                seen.push(`${request.method} ${path} ${body}`);

                if (path === "/mcp") {
                    return new Response(null, {
                        status: 307,
                        headers: { Location: "/session/abc" },
                    });
                }

                return new Response(body, { status: 200 });
            },
        });
        disposable(hop);
        const handle = await gatewayFor(`http://127.0.0.1:${hop.port}/mcp`);

        const payload = '{"jsonrpc":"2.0"}';
        const response = await fetch(`http://127.0.0.1:${handle.port}/mcp/rohlik`, {
            method: "POST",
            headers: { [GATEWAY_HEADER]: LOCAL },
            body: payload,
        });

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(payload);
        expect(seen).toEqual([`POST /mcp ${payload}`, `POST /session/abc ${payload}`]);
    });

    test("refuses a same-origin hop that then redirects off-origin", async () => {
        let evilHits = 0;
        const evil = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                evilHits += 1;

                return new Response("pwned");
            },
        });
        const bouncing = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                const path = new URL(request.url).pathname;

                if (path === "/mcp") {
                    return new Response(null, {
                        status: 302,
                        headers: { Location: "/bounce" },
                    });
                }

                return new Response(null, {
                    status: 302,
                    headers: { Location: `http://127.0.0.1:${evil.port}/steal` },
                });
            },
        });
        disposable(evil);
        disposable(bouncing);
        const handle = await gatewayFor(`http://127.0.0.1:${bouncing.port}/mcp`);

        const response = await fetch(`http://127.0.0.1:${handle.port}/mcp/rohlik`, {
            method: "POST",
            headers: { [GATEWAY_HEADER]: LOCAL },
            body: "{}",
        });

        expect(response.status).toBe(502);
        expect(await response.text()).toContain("refused off-origin redirect");
        expect(evilHits).toBe(0);
    });
});

describe("gateway bind address", () => {
    test("isLoopbackBindHost accepts every loopback spelling and nothing else", () => {
        for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"]) {
            expect(isLoopbackBindHost(host)).toBe(true);
        }

        for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.1", "example.com", ""]) {
            expect(isLoopbackBindHost(host)).toBe(false);
        }
    });

    test("startGatewayServer refuses to publish the vault on a non-loopback interface", async () => {
        const config = {
            mcpServers: {
                rohlik: {
                    type: "http" as const,
                    url: "https://mcp.rohlik.cz/mcp",
                    auth: { kind: "oauth" as const, gateway: true },
                },
            },
        };

        await expect(startGatewayServer(config, { hostname: "0.0.0.0", port: 0 })).rejects.toThrow(
            /refusing to bind the mcp gateway to 0\.0\.0\.0/
        );
        await expect(
            startGatewayServer({ ...config, gateway: { listen: { host: "0.0.0.0" } } }, { port: 0 })
        ).rejects.toThrow(/must be a loopback address/);
    });
});

describe("gatewayHealth", () => {
    test("a stranger that accepts the socket and never answers reads as down, not as a hang", async () => {
        const mute = disposable(
            Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch: () => new Promise<Response>(() => {}),
            })
        );

        const started = Date.now();
        const health = await gatewayHealth("127.0.0.1", mute.port ?? 0);
        const elapsed = Date.now() - started;

        expect(health).toBe("down");
        // The probe's own deadline is 1500ms; without it this never returns at all.
        expect(elapsed).toBeLessThan(5000);
    });

    test("a closed port is down", async () => {
        expect(await gatewayHealth("127.0.0.1", 9)).toBe("down");
    });

    test("the real gateway answers ok", async () => {
        expect(await gatewayHealth("127.0.0.1", gateway?.port ?? 0)).toBe("ok");
    });
});

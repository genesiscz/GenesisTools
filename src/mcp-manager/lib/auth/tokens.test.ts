import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { _resetSecretsForTest } from "@genesiscz/utils/security";
import { _resetMasterKeyProviders, _setMasterKeyProvidersForTest } from "@genesiscz/utils/security/MasterKey";
import { vaultAdmin } from "@genesiscz/utils/security/SecretStore";
import { ACCESS_SKEW_MS } from "./constants.ts";
import {
    _resetMcpFetchForTest,
    _setMcpFetchForTest,
    MAX_AUTH_RESPONSE_BYTES,
    MCP_CREDENTIAL_TIMEOUT_MS,
    mcpFetch,
    readJsonRecord,
} from "./fetch.ts";
import { CREDENTIALS_LOCK_WAIT_MS } from "./lock.ts";
import { secretPath } from "./paths.ts";
import { deleteServerTokens, readSecret, replaceServerTokens, writeServerTokens } from "./secrets.ts";
import { readAuthStatus } from "./status.ts";
import { accessTokenForRequest, DiagnosticRefreshError, peekAccessToken } from "./tokens.ts";
import { _resetLookupForTest, _setLookupForTest } from "./url-policy.ts";

const KEY = randomBytes(32);

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

let home: string;
let tokenPosts = 0;
let lastTokenBody = "";

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-mcp-auth-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest(fakeKeyring());
    _resetSecretsForTest();
    tokenPosts = 0;
    lastTokenBody = "";
    _setLookupForTest(async () => [{ address: "93.184.216.34" }]);
    _setMcpFetchForTest(async (input, init) => {
        const url = String(input);

        if (url.includes("/token") && init?.method === "POST") {
            tokenPosts += 1;
            lastTokenBody = String(init.body ?? "");

            return Response.json({
                access_token: "refreshed-access",
                refresh_token: "rotated-refresh",
                expires_in: 3600,
            });
        }

        return new Response("no", { status: 404 });
    });
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetMcpFetchForTest();
    _resetLookupForTest();
});

describe("peekAccessToken", () => {
    test("reports missing and expired without calling the token endpoint", async () => {
        expect(await peekAccessToken("rohlik")).toEqual({
            accessToken: undefined,
            expiresAt: undefined,
            expired: false,
            hasRefresh: false,
        });
        expect(tokenPosts).toBe(0);
    });

    test("checks refresh-token presence without decrypting its plaintext", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "live",
            refreshToken: "r1",
            expiresAt: Date.now() + 600_000,
        });
        const vault = vaultAdmin.read();
        vault.entries[secretPath("rohlik", "refresh-token")].tag = Buffer.alloc(16).toString("base64");
        vaultAdmin.write(vault);

        expect(await peekAccessToken("rohlik")).toEqual({
            accessToken: "live",
            expiresAt: expect.any(Number),
            expired: false,
            hasRefresh: true,
        });
    });
});

describe("accessTokenForRequest", () => {
    test("returns a live token without refresh", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "live",
            refreshToken: "r1",
            expiresAt: Date.now() + 60_000 * 10,
        });

        const token = await accessTokenForRequest("rohlik", {
            tokenEndpoint: "https://identity.example/token",
            resource: "https://mcp.example/mcp",
            trustBaseline: "https://mcp.example/mcp",
            allowRefresh: true,
        });

        expect(token).toBe("live");
        expect(tokenPosts).toBe(0);
    });

    test("diagnostic path with an expired token never POSTs", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "stale",
            refreshToken: "r1",
            expiresAt: Date.now() - ACCESS_SKEW_MS,
        });
        _setMcpFetchForTest(async () => {
            tokenPosts += 1;
            throw new Error("single-use refresh POST reached");
        });

        await expect(
            accessTokenForRequest("rohlik", {
                tokenEndpoint: "https://identity.example/token",
                resource: "https://mcp.example/mcp",
                trustBaseline: "https://mcp.example/mcp",
                allowRefresh: false,
            })
        ).rejects.toBeInstanceOf(DiagnosticRefreshError);
        expect(tokenPosts).toBe(0);
    });

    test("a public resource cannot refresh against a private token endpoint", async () => {
        await writeServerTokens("work", {
            accessToken: "stale",
            refreshToken: "synthetic-refresh",
            expiresAt: Date.now() - ACCESS_SKEW_MS,
        });
        _setMcpFetchForTest(async () => {
            tokenPosts += 1;
            throw new Error("private credential POST reached");
        });

        await expect(
            accessTokenForRequest("work", {
                tokenEndpoint: "http://127.0.0.1:3042/token",
                resource: "https://mcp.example/mcp",
                trustBaseline: "https://mcp.example/mcp",
                allowRefresh: true,
            })
        ).rejects.toThrow(/private address 127\.0\.0\.1/);
        expect(tokenPosts).toBe(0);
    });

    test("a loopback resource advertised by a public server does not lift the private-address rule", async () => {
        await writeServerTokens("work", {
            accessToken: "stale",
            refreshToken: "synthetic-refresh",
            expiresAt: Date.now() - ACCESS_SKEW_MS,
        });
        _setLookupForTest(async () => [{ address: "127.0.0.1" }]);
        _setMcpFetchForTest(async () => {
            tokenPosts += 1;
            throw new Error("credential POST reached a rebound loopback address");
        });

        await expect(
            accessTokenForRequest("work", {
                tokenEndpoint: "https://identity.example/token",
                resource: "http://127.0.0.1:9331/mcp",
                trustBaseline: "https://mcp.example/mcp",
                allowRefresh: true,
            })
        ).rejects.toThrow(/private address 127\.0\.0\.1/);
        expect(tokenPosts).toBe(0);
    });

    test("logout waits for an in-flight refresh and leaves the credential bundle deleted", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "stale",
            refreshToken: "r1",
            expiresAt: Date.now() - ACCESS_SKEW_MS,
            clientId: "client-old",
        });
        let markPostStarted: (() => void) | undefined;
        let releasePost: (() => void) | undefined;
        const postStarted = new Promise<void>((resolve) => {
            markPostStarted = resolve;
        });
        const postRelease = new Promise<void>((resolve) => {
            releasePost = resolve;
        });
        _setMcpFetchForTest(async () => {
            tokenPosts += 1;
            markPostStarted?.();
            await postRelease;

            return Response.json({
                access_token: "refreshed-access",
                refresh_token: "rotated-refresh",
                expires_in: 3600,
            });
        });

        const refresh = accessTokenForRequest("rohlik", {
            tokenEndpoint: "https://identity.example/token",
            resource: "https://mcp.example/mcp",
            trustBaseline: "https://mcp.example/mcp",
            allowRefresh: true,
        });
        await postStarted;
        const logout = deleteServerTokens("rohlik");
        releasePost?.();
        await refresh;
        await logout;

        expect(tokenPosts).toBe(1);
        expect(await readSecret(secretPath("rohlik", "access-token"))).toBeUndefined();
        expect(await readSecret(secretPath("rohlik", "refresh-token"))).toBeUndefined();
        expect(await readSecret(secretPath("rohlik", "client-id"))).toBeUndefined();
    });

    test("a re-login commit after an in-flight refresh keeps only the new bundle", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "stale",
            refreshToken: "r1",
            expiresAt: Date.now() - ACCESS_SKEW_MS,
            clientId: "client-old",
            clientSecret: "secret-old",
        });
        let markPostStarted: (() => void) | undefined;
        let releasePost: (() => void) | undefined;
        const postStarted = new Promise<void>((resolve) => {
            markPostStarted = resolve;
        });
        const postRelease = new Promise<void>((resolve) => {
            releasePost = resolve;
        });
        _setMcpFetchForTest(async () => {
            tokenPosts += 1;
            markPostStarted?.();
            await postRelease;

            return Response.json({
                access_token: "refreshed-old-access",
                refresh_token: "rotated-old-refresh",
                expires_in: 3600,
            });
        });

        const refresh = accessTokenForRequest("rohlik", {
            tokenEndpoint: "https://identity.example/token",
            resource: "https://mcp.example/mcp",
            trustBaseline: "https://mcp.example/mcp",
            allowRefresh: true,
        });
        await postStarted;
        const login = replaceServerTokens("rohlik", {
            accessToken: "login-new-access",
            refreshToken: "login-new-refresh",
            clientId: "client-new",
        });
        releasePost?.();
        await refresh;
        await login;

        expect(await readSecret(secretPath("rohlik", "access-token"))).toBe("login-new-access");
        expect(await readSecret(secretPath("rohlik", "refresh-token"))).toBe("login-new-refresh");
        expect(await readSecret(secretPath("rohlik", "client-id"))).toBe("client-new");
        expect(await readSecret(secretPath("rohlik", "client-secret"))).toBeUndefined();
    });

    test("request path refreshes under lock and stores the new access token", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "stale",
            refreshToken: "r1",
            expiresAt: Date.now() - ACCESS_SKEW_MS,
        });

        const token = await accessTokenForRequest("rohlik", {
            tokenEndpoint: "https://identity.example/token",
            resource: "https://mcp.example/mcp",
            trustBaseline: "https://mcp.example/mcp",
            allowRefresh: true,
        });

        expect(token).toBe("refreshed-access");
        expect(tokenPosts).toBe(1);
        expect((await peekAccessToken("rohlik")).accessToken).toBe("refreshed-access");
    });

    test("the refresh POST connects to the address the policy check approved, not a second lookup", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "stale",
            refreshToken: "r1",
            expiresAt: Date.now() - ACCESS_SKEW_MS,
        });
        let lookups = 0;
        // A rebinding resolver: public for the check, loopback for any later lookup.
        _setLookupForTest(async () => {
            lookups += 1;
            return [{ address: lookups === 1 ? "93.184.216.34" : "127.0.0.1" }];
        });
        let pinned: string | undefined;
        _setMcpFetchForTest(async (_input, _init, pinnedAddress) => {
            pinned = pinnedAddress;
            return Response.json({ access_token: "pinned-access", expires_in: 3600 });
        });

        const token = await accessTokenForRequest("rohlik", {
            tokenEndpoint: "https://identity.example/token",
            resource: "https://mcp.example/mcp",
            trustBaseline: "https://mcp.example/mcp",
            allowRefresh: true,
        });

        expect(token).toBe("pinned-access");
        expect(pinned).toBe("93.184.216.34");
        expect(lookups).toBe(1);
    });

    test("a private resource talks to its token endpoint without a pin", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "stale",
            refreshToken: "r1",
            expiresAt: Date.now() - ACCESS_SKEW_MS,
        });
        let pinned: string | undefined = "unset";
        _setMcpFetchForTest(async (_input, _init, pinnedAddress) => {
            pinned = pinnedAddress;
            return Response.json({ access_token: "local-access", expires_in: 3600 });
        });

        await accessTokenForRequest("rohlik", {
            tokenEndpoint: "http://127.0.0.1:9331/token",
            resource: "http://127.0.0.1:9331/mcp",
            trustBaseline: "http://127.0.0.1:9331/mcp",
            allowRefresh: true,
        });

        expect(pinned).toBeUndefined();
    });

    test("invalid_grant deletes the refresh token so the next call does not POST again", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "stale",
            refreshToken: "dead-refresh",
            expiresAt: Date.now() - ACCESS_SKEW_MS,
        });
        _setMcpFetchForTest(async (input, init) => {
            const url = String(input);

            if (url.includes("/token") && init?.method === "POST") {
                tokenPosts += 1;

                return Response.json({ error: "invalid_grant" }, { status: 400 });
            }

            return new Response("no", { status: 404 });
        });

        const opts = {
            tokenEndpoint: "https://identity.example/token",
            resource: "https://mcp.example/mcp",
            trustBaseline: "https://mcp.example/mcp",
            allowRefresh: true as const,
        };

        await expect(accessTokenForRequest("rohlik", opts)).rejects.toThrow(/auth login rohlik/);
        expect(tokenPosts).toBe(1);
        expect((await peekAccessToken("rohlik")).hasRefresh).toBe(false);

        await expect(accessTokenForRequest("rohlik", opts)).rejects.toThrow(/No refresh token/);
        expect(tokenPosts).toBe(1);
    });

    test("refresh posts a stored client secret", async () => {
        await writeServerTokens("figma", {
            accessToken: "stale",
            refreshToken: "r1",
            expiresAt: Date.now() - ACCESS_SKEW_MS,
            clientId: "figma-client",
            clientSecret: "figma-secret",
        });

        const token = await accessTokenForRequest("figma", {
            tokenEndpoint: "https://identity.example/token",
            resource: "https://mcp.example/mcp",
            trustBaseline: "https://mcp.example/mcp",
            allowRefresh: true,
        });

        expect(token).toBe("refreshed-access");
        expect(lastTokenBody).toContain("client_id=figma-client");
        expect(lastTokenBody).toContain("client_secret=figma-secret");
    });
});

describe("refresh failures never persist provider text", () => {
    test("a non-JSON 500 body is stored and thrown as the status alone", async () => {
        const leak = "access_token=figu_live_LEAKED_SECRET for martin@example.com";
        await writeServerTokens("rohlik", {
            accessToken: "stale",
            refreshToken: "r1",
            expiresAt: Date.now() - ACCESS_SKEW_MS,
        });
        _setMcpFetchForTest(async (input, init) => {
            if (String(input).includes("/token") && init?.method === "POST") {
                return new Response(leak, { status: 500 });
            }

            return new Response("no", { status: 404 });
        });

        await expect(
            accessTokenForRequest("rohlik", {
                tokenEndpoint: "https://identity.example/token",
                resource: "https://mcp.example/mcp",
                trustBaseline: "https://mcp.example/mcp",
                allowRefresh: true,
            })
        ).rejects.toThrow(/HTTP 500/);

        const status = (await readAuthStatus("rohlik")) as { lastError?: string };

        expect(status.lastError).toBe("HTTP 500");
        expect(SafeJSON.stringify(await readAuthStatus())).not.toContain("figu_live_LEAKED_SECRET");
    });

    test("a registered error code still reaches the status file, so triage survives", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "stale",
            refreshToken: "r1",
            expiresAt: Date.now() - ACCESS_SKEW_MS,
        });
        _setMcpFetchForTest(async (input, init) => {
            if (String(input).includes("/token") && init?.method === "POST") {
                return Response.json({ error: "invalid_scope" }, { status: 400 });
            }

            return new Response("no", { status: 404 });
        });

        await expect(
            accessTokenForRequest("rohlik", {
                tokenEndpoint: "https://identity.example/token",
                resource: "https://mcp.example/mcp",
                trustBaseline: "https://mcp.example/mcp",
                allowRefresh: true,
            })
        ).rejects.toThrow(/invalid_scope/);
        expect(((await readAuthStatus("rohlik")) as { lastError?: string }).lastError).toBe("invalid_scope");
    });
});

describe("bounded MCP credential responses", () => {
    test("rejects a declared oversized response without reading it, and cancels its body", async () => {
        let pulled = false;
        let cancelled = false;
        const response = new Response(
            new ReadableStream<Uint8Array>({
                pull: () => {
                    pulled = true;
                },
                cancel: () => {
                    cancelled = true;
                },
            }),
            { headers: { "content-length": String(MAX_AUTH_RESPONSE_BYTES + 1) } }
        );

        await expect(readJsonRecord(response)).rejects.toThrow(/exceeds.*MCP auth response limit/);
        expect(cancelled).toBe(true);
        expect(pulled).toBe(false);
    });

    test("rejects a streamed response once the actual bytes exceed the cap", async () => {
        const chunk = new Uint8Array(64 * 1024);
        const response = new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    for (let bytes = 0; bytes <= MAX_AUTH_RESPONSE_BYTES; bytes += chunk.byteLength) {
                        controller.enqueue(chunk);
                    }
                    controller.close();
                },
            })
        );

        await expect(readJsonRecord(response)).rejects.toThrow(/exceeds.*MCP auth response limit/);
    });

    test("keeps the abort signal of a Request input", async () => {
        let capturedSignal: AbortSignal | null | undefined;
        _setMcpFetchForTest(async (_input, init) => {
            capturedSignal = init?.signal;
            return Response.json({ ok: true });
        });
        const controller = new AbortController();

        await mcpFetch(new Request("https://identity.example/token", { signal: controller.signal }));
        controller.abort();

        expect(capturedSignal?.aborted).toBe(true);
    });

    test("attaches a default deadline signal to credential fetches", async () => {
        let capturedSignal: AbortSignal | null | undefined;
        _setMcpFetchForTest(async (_input, init) => {
            capturedSignal = init?.signal;
            return Response.json({ ok: true });
        });

        await mcpFetch("https://identity.example/token", { method: "POST" });

        expect(capturedSignal).toBeInstanceOf(AbortSignal);
        expect(capturedSignal?.aborted).toBe(false);
    });
});

describe("replaceServerTokens", () => {
    test("a re-login with no refresh token clears the previous one", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "a1",
            refreshToken: "old-refresh",
            clientId: "old-client",
            clientSecret: "old-secret",
            expiresAt: Date.now() + 60_000,
        });

        // A fresh DCR registration: new client_id, no refresh token in the grant.
        await replaceServerTokens("rohlik", { accessToken: "a2", clientId: "new-client" });

        const peek = await peekAccessToken("rohlik");

        expect(peek.accessToken).toBe("a2");
        expect(peek.hasRefresh).toBe(false);
        expect(peek.expiresAt).toBeUndefined();
        expect(await readSecret(secretPath("rohlik", "client-secret"))).toBeUndefined();
        expect(await readSecret(secretPath("rohlik", "client-id"))).toBe("new-client");
    });

    test("writeServerTokens still patches, so a refresh keeps the client secret", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "a1",
            refreshToken: "r1",
            clientId: "c1",
            clientSecret: "s1",
        });
        await writeServerTokens("rohlik", { accessToken: "a2" });

        expect((await peekAccessToken("rohlik")).hasRefresh).toBe(true);
        expect(await readSecret(secretPath("rohlik", "client-secret"))).toBe("s1");
    });
});

describe("the refusal log line carries bounded values only", () => {
    test("neither error nor error_description reaches logger.warn", async () => {
        const leak = "client secret figu_live_LEAKED_IN_DESCRIPTION rejected";
        const seen: Array<Record<string, unknown>> = [];
        const original = logger.warn;
        // Spy on the durable channel itself, not on a symptom downstream. The spy does
        // not forward: the assertion is about what was HANDED to the logger, and
        // forwarding would need `as never` casts this repo forbids.
        (logger as unknown as { warn: typeof logger.warn }).warn = ((payload: unknown) => {
            if (payload && typeof payload === "object") {
                seen.push(payload as Record<string, unknown>);
            }
        }) as typeof logger.warn;

        try {
            await writeServerTokens("rohlik", {
                accessToken: "stale",
                refreshToken: "r1",
                expiresAt: Date.now() - ACCESS_SKEW_MS,
            });
            _setMcpFetchForTest(async (input, init) => {
                if (String(input).includes("/token") && init?.method === "POST") {
                    return Response.json({ error: leak, error_description: leak }, { status: 400 });
                }

                return new Response("no", { status: 404 });
            });

            await expect(
                accessTokenForRequest("rohlik", {
                    tokenEndpoint: "https://identity.example/token",
                    resource: "https://mcp.example/mcp",
                    trustBaseline: "https://mcp.example/mcp",
                    allowRefresh: true,
                })
            ).rejects.toThrow(/HTTP 400/);
        } finally {
            (logger as unknown as { warn: typeof logger.warn }).warn = original;
        }

        expect(seen.length).toBeGreaterThan(0);
        expect(SafeJSON.stringify(seen)).not.toContain("figu_live_LEAKED_IN_DESCRIPTION");
        expect(seen.some((row) => row.code === "HTTP 400" && row.status === 400)).toBe(true);
    });
});

describe("credentials lock budget", () => {
    test("a waiter (logout) outlasts a refresh holding the lock across its credential request", () => {
        // The refresh holds the lock for one bounded request plus its vault write; an equal
        // budget expired just as the holder released, and logout then left the tokens stored.
        expect(MCP_CREDENTIAL_TIMEOUT_MS * 2).toBeLessThan(CREDENTIALS_LOCK_WAIT_MS);
    });
});

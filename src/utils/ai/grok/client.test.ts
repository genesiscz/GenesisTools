import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { GrokAuthExpiredError } from "./auth-errors";
import { GrokSubscriptionClient } from "./client";
import type { GrokAuthEntry } from "./types";

// Synthetic unsigned JWTs and a replaced `fetch`: nothing here reaches
// cli-chat-proxy.grok.com or the user's real ~/.grok/auth.json.

const ISSUER = "https://auth.example.test";
const ENTRY_KEY = `${ISSUER}::11111111-2222-3333-4444-555555555555`;
const BASE_URL = "https://cli-chat-proxy.example.test/v1";

function jwt(expSecondsFromNow: number): string {
    const payload = Buffer.from(SafeJSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }), "utf-8")
        .toString("base64url")
        .replace(/=+$/, "");

    return `e30.${payload}.sig`;
}

/** Time-valid, so nothing on the expiry path fires — only upstream's 401 does. */
const FRESH = jwt(3_600);
const ROTATED = jwt(7_200);
const EXPIRED = jwt(-3_600);

let authPath: string;
const originalFetch = globalThis.fetch;

function writeAuth(key: string): void {
    const entries: Record<string, GrokAuthEntry> = {
        [ENTRY_KEY]: {
            key,
            refresh_token: "refresh-one",
            expires_at: "2020-01-01T00:00:00.000Z",
            oidc_issuer: ISSUER,
            oidc_client_id: "client-abc",
            auth_mode: "oidc",
        },
    };

    writeFileSync(authPath, SafeJSON.stringify(entries, { strict: true }, 2), { mode: 0o600 });
}

function readAuth(): Record<string, GrokAuthEntry> {
    return SafeJSON.parse(readFileSync(authPath, "utf-8"), { strict: true }) as Record<string, GrokAuthEntry>;
}

/**
 * `apiStatuses` is consumed one per `/models` request, so a `[401, 200]` script
 * says "reject the first attempt, accept the retry". `grantedToken` is what the
 * OIDC token endpoint hands back.
 */
function stubFetch(options: { calls: string[]; apiStatuses: number[]; grantedToken?: string }): void {
    let apiCall = 0;

    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        options.calls.push(url);

        if (url.endsWith("/.well-known/openid-configuration")) {
            return new Response("no", { status: 404 });
        }

        if (url.endsWith("/oauth2/token")) {
            return new Response(
                SafeJSON.stringify({ access_token: options.grantedToken ?? ROTATED, refresh_token: "refresh-two" }),
                { status: 200, headers: { "Content-Type": "application/json" } }
            );
        }

        const status = options.apiStatuses[apiCall] ?? 200;
        apiCall += 1;

        return new Response(SafeJSON.stringify({ data: [] }), {
            status,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;
}

/**
 * The refresh primitive, spied on where it is actually SPENT: the OIDC token
 * endpoint. It records the call AND throws, so any path that reaches it fails
 * loudly instead of passing quietly.
 */
function stubFetchRefusingGrant(options: { grantCalls: string[] }): void {
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();

        if (url.endsWith("/.well-known/openid-configuration")) {
            return new Response("no", { status: 404 });
        }

        if (url.endsWith("/oauth2/token")) {
            options.grantCalls.push(url);
            throw new Error("the OIDC grant must not be spent on this path");
        }

        return new Response(SafeJSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;
}

beforeEach(() => {
    authPath = join(mkdtempSync(join(tmpdir(), "grok-client-")), "auth.json");
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("GrokSubscriptionClient 401 recovery", () => {
    it("forces an OIDC grant and retries once when upstream rejects a still-valid token", async () => {
        writeAuth(FRESH);
        const calls: string[] = [];
        stubFetch({ calls, apiStatuses: [401, 200] });

        const client = new GrokSubscriptionClient({ token: FRESH, authPath, baseUrl: BASE_URL });
        await client.getModels();

        // The whole point: a revoked token is normally still inside its `exp`, so
        // an unforced refresh would return it unchanged and skip the retry.
        expect(client.getToken()).toBe(ROTATED);
        expect(calls.filter((url) => url === `${BASE_URL}/models`)).toHaveLength(2);
        expect(calls).toContain(`${ISSUER}/oauth2/token`);
        expect(readAuth()[ENTRY_KEY]?.key).toBe(ROTATED);
    });

    it("throws GrokAuthExpiredError without retrying when the grant returns the rejected token", async () => {
        writeAuth(FRESH);
        const calls: string[] = [];
        stubFetch({ calls, apiStatuses: [401, 401], grantedToken: FRESH });

        const client = new GrokSubscriptionClient({ token: FRESH, authPath, baseUrl: BASE_URL });

        await expect(client.getModels()).rejects.toThrow(GrokAuthExpiredError);
        expect(calls.filter((url) => url === `${BASE_URL}/models`)).toHaveLength(1);
    });
});

/**
 * `tools ai-proxy config detect` rotated a live Grok token just by printing an
 * account's plan name. Both halves are needed: proving the probe path never
 * spends the grant, AND proving the normal path still does — a guard that leaked
 * into normal use would break every account at token expiry, which is worse than
 * the bug it fixed.
 */
describe("GrokSubscriptionClient probe purity", () => {
    it("refuses to refresh an expired token and never reaches the OIDC grant", async () => {
        writeAuth(EXPIRED);
        const before = readFileSync(authPath, "utf-8");
        const grantCalls: string[] = [];
        stubFetchRefusingGrant({ grantCalls });

        const client = new GrokSubscriptionClient({ token: EXPIRED, authPath, baseUrl: BASE_URL, probe: true });

        await expect(client.getSettings()).rejects.toThrow(/Refusing to refresh the Grok token/);
        expect(grantCalls).toEqual([]);
        // The auth file the Grok CLI owns is byte-identical.
        expect(readFileSync(authPath, "utf-8")).toBe(before);
    });

    it("refuses on the upstream-401 path too, where the token is still time-valid", async () => {
        writeAuth(FRESH);
        const before = readFileSync(authPath, "utf-8");
        const grantCalls: string[] = [];
        let apiCall = 0;

        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();

            if (url.endsWith("/.well-known/openid-configuration")) {
                return new Response("no", { status: 404 });
            }

            if (url.endsWith("/oauth2/token")) {
                grantCalls.push(url);
                throw new Error("the OIDC grant must not be spent on this path");
            }

            apiCall += 1;
            return new Response(SafeJSON.stringify({ data: [] }), { status: apiCall === 1 ? 401 : 200 });
        }) as typeof fetch;

        const client = new GrokSubscriptionClient({ token: FRESH, authPath, baseUrl: BASE_URL, probe: true });

        await expect(client.getModels()).rejects.toThrow(/Refusing to refresh the Grok token/);
        expect(grantCalls).toEqual([]);
        expect(readFileSync(authPath, "utf-8")).toBe(before);
    });

    /** Negative control: normal use MUST still reach the refresh. */
    it("without probe, an expired token still reaches the OIDC grant", async () => {
        writeAuth(EXPIRED);
        const grantCalls: string[] = [];
        stubFetchRefusingGrant({ grantCalls });

        const client = new GrokSubscriptionClient({ token: EXPIRED, authPath, baseUrl: BASE_URL });

        // The spy throws, so this rejects — but for the OPPOSITE reason: the call
        // was attempted. That is what the assertion below pins.
        await expect(client.getSettings()).rejects.toThrow();
        expect(grantCalls).toHaveLength(1);
    });

    /** Negative control: the working 401 recovery is untouched when probe is off. */
    it("without probe, the 401 path still rotates and retries", async () => {
        writeAuth(FRESH);
        const calls: string[] = [];
        stubFetch({ calls, apiStatuses: [401, 200] });

        const client = new GrokSubscriptionClient({ token: FRESH, authPath, baseUrl: BASE_URL });
        await client.getModels();

        expect(client.getToken()).toBe(ROTATED);
        expect(calls).toContain(`${ISSUER}/oauth2/token`);
    });
});

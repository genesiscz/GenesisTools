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

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { SafeJSON } from "@genesiscz/utils/json";

// Tokens are synthetic unsigned JWTs carrying only an `exp`, and `fetch` is
// replaced per test, so nothing here reaches auth.x.ai or the user's real
// ~/.genesis-tools/ai/config.json.

const ISSUER = "https://auth.example.test";
const ENTRY_KEY = `${ISSUER}::11111111-2222-3333-4444-555555555555`;

let account: AIAccountEntry | undefined;

mock.module("@genesiscz/utils/ai/AIConfig", () => ({
    AIConfig: {
        load: async () => ({
            getAccount: (name: string) => (account?.name === name ? account : undefined),
            getAccountsByProvider: (provider: string) => (account && account.provider === provider ? [account] : []),
        }),
    },
}));

import { resolveGrokSubToken } from "./account";
import { GrokAuthExpiredError } from "./auth-errors";
import type { GrokAuthEntry } from "./types";

function jwt(expSecondsFromNow: number): string {
    const payload = Buffer.from(SafeJSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }), "utf-8")
        .toString("base64url")
        .replace(/=+$/, "");

    return `e30.${payload}.sig`;
}

const EXPIRED = jwt(-3_600);
const FRESH = jwt(3_600);

let authPath: string;
const originalFetch = globalThis.fetch;

function writeAuth(entries: Record<string, GrokAuthEntry>): void {
    writeFileSync(authPath, SafeJSON.stringify(entries, { strict: true }, 2), { mode: 0o600 });
}

function readAuth(): Record<string, GrokAuthEntry> {
    return SafeJSON.parse(readFileSync(authPath, "utf-8"), { strict: true }) as Record<string, GrokAuthEntry>;
}

function expiredEntries(overrides: Partial<GrokAuthEntry> = {}): Record<string, GrokAuthEntry> {
    return {
        [ENTRY_KEY]: {
            key: EXPIRED,
            refresh_token: "refresh-one",
            expires_at: "2020-01-01T00:00:00.000Z",
            oidc_issuer: ISSUER,
            oidc_client_id: "client-abc",
            auth_mode: "oidc",
            ...overrides,
        },
    };
}

/** Records every request; the token endpoint answers with `token` when given. */
function stubFetch(options: { calls: string[]; token?: { status?: number; body?: string } }): void {
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        options.calls.push(url);

        if (url.endsWith("/.well-known/openid-configuration")) {
            return new Response("no", { status: 404 });
        }

        const token = options.token ?? {};

        return new Response(token.body ?? SafeJSON.stringify({ access_token: FRESH, refresh_token: "refresh-two" }), {
            status: token.status ?? 200,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;
}

beforeEach(() => {
    authPath = join(mkdtempSync(join(tmpdir(), "grok-account-")), "auth.json");
    account = { name: "grok", provider: "grok-sub", tokens: { authFile: authPath } };
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("resolveGrokSubToken", () => {
    it("refreshes an expired token instead of throwing, and persists it", async () => {
        writeAuth(expiredEntries());
        const calls: string[] = [];
        stubFetch({ calls });

        const resolved = await resolveGrokSubToken("grok");

        expect(resolved.token).toBe(FRESH);
        expect(resolved.authPath).toBe(authPath);
        expect(calls.some((url) => url === `${ISSUER}/oauth2/token`)).toBe(true);

        const entry = readAuth()[ENTRY_KEY];
        expect(entry?.key).toBe(FRESH);
        expect(entry?.refresh_token).toBe("refresh-two");
        expect(Date.parse(entry?.expires_at ?? "")).toBeGreaterThan(Date.now());
    });

    it("does not touch the network when the on-disk token is still fresh", async () => {
        writeAuth(expiredEntries({ key: FRESH }));
        const calls: string[] = [];
        stubFetch({ calls });

        const resolved = await resolveGrokSubToken("grok");

        expect(resolved.token).toBe(FRESH);
        expect(calls).toHaveLength(0);
    });

    it("throws when the issuer rejects the refresh grant", async () => {
        writeAuth(expiredEntries());
        stubFetch({ calls: [], token: { status: 400, body: '{"error":"invalid_grant"}' } });

        await expect(resolveGrokSubToken("grok")).rejects.toThrow(GrokAuthExpiredError);
    });

    it("returns a still-valid stored accessToken without touching the network", async () => {
        account = { name: "grok", provider: "grok-sub", tokens: { accessToken: FRESH } };
        const calls: string[] = [];
        stubFetch({ calls });

        expect((await resolveGrokSubToken("grok")).token).toBe(FRESH);
        expect(calls).toHaveLength(0);
    });

    it("refuses an expired stored accessToken rather than refreshing the default auth file", async () => {
        account = { name: "grok", provider: "grok-sub", tokens: { accessToken: EXPIRED } };
        const calls: string[] = [];
        stubFetch({ calls });

        // The default ~/.grok/auth.json holds whichever account the Grok CLI
        // logged in last, so refreshing from it would cross a billing boundary.
        await expect(resolveGrokSubToken("grok")).rejects.toThrow(GrokAuthExpiredError);
        expect(calls).toHaveLength(0);
    });

    it("throws when the entry carries no refresh token to spend", async () => {
        writeAuth(expiredEntries({ refresh_token: undefined }));
        const calls: string[] = [];
        stubFetch({ calls });

        await expect(resolveGrokSubToken("grok")).rejects.toThrow(GrokAuthExpiredError);
        expect(calls).toHaveLength(0);
    });
});

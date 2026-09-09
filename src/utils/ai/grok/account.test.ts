import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { env } from "@genesiscz/utils/env";
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

/** The vault path is a separate unit (stored-grant.test.ts); here only the routing to it is pinned. */
const storedGrantCalls: Array<{ name: string; options: unknown }> = [];

mock.module("./stored-grant", () => ({
    resolveStoredGrokGrant: async (name: string, options: unknown) => {
        storedGrantCalls.push({ name, options });
        return "stored-token";
    },
}));

import { resolveGrokSubToken } from "./account";
import { GrokAuthExpiredError } from "./auth-errors";
import type { GrokAuthEntry } from "./types";

function jwt(expSecondsFromNow: number, sub?: string): string {
    const claims = { exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, ...(sub ? { sub } : {}) };
    const payload = Buffer.from(SafeJSON.stringify(claims), "utf-8").toString("base64url").replace(/=+$/, "");

    return `e30.${payload}.sig`;
}

const EXPIRED = jwt(-3_600);
const FRESH = jwt(3_600);

/** Two identities, so "same user" and "some other user" are distinguishable. */
const MINE = "user-1111";
const THEIRS = "user-9999";
const EXPIRED_MINE = jwt(-3_600, MINE);
const FRESH_MINE = jwt(3_600, MINE);
const EXPIRED_THEIRS = jwt(-3_600, THEIRS);

let authPath: string;
let grokHome: string;
const envSnapshot = env.testing.snapshot();
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
    grokHome = mkdtempSync(join(tmpdir(), "grok-account-"));
    authPath = join(grokHome, "auth.json");
    // `grokAuthPath()` reads GROK_HOME, so the "default" auth file the
    // stored-copy branch reaches for is this temp file, never ~/.grok/auth.json.
    env.testing.set("GROK_HOME", grokHome);
    account = { name: "grok", provider: "grok-sub", tokens: { authFile: authPath } };
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    env.testing.restore(envSnapshot);
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

    // The state `logout --auth-file` leaves behind: the entry survives, its file
    // reference is gone, and the CLI's default home still holds a live login
    // (PR #360 review t1). That login belongs to whoever ran `grok login`, not
    // to this account.
    it("refuses an account holding neither a file nor a token, even with a live default auth file", async () => {
        account = { name: "grok", provider: "grok-sub", tokens: {} };
        writeAuth({ [ENTRY_KEY]: { ...expiredEntries()[ENTRY_KEY], key: EXPIRED_MINE } });
        const calls: string[] = [];
        stubFetch({ calls });

        await expect(resolveGrokSubToken("grok")).rejects.toThrow(/holds no grok credential/);
        expect(calls).toHaveLength(0);
        expect(readAuth()[ENTRY_KEY]?.refresh_token).toBe("refresh-one");
    });

    it("NEGATIVE CONTROL: the same default file still serves an account that references it", async () => {
        account = { name: "grok", provider: "grok-sub", tokens: { authFile: authPath } };
        writeAuth({ [ENTRY_KEY]: { ...expiredEntries()[ENTRY_KEY], key: FRESH_MINE } });
        const calls: string[] = [];
        stubFetch({ calls });

        expect((await resolveGrokSubToken("grok")).token).toBe(FRESH_MINE);
        expect(calls).toHaveLength(0);
    });
});

describe("resolveGrokSubToken: an expired stored copy beside the default auth file", () => {
    it("refreshes from the default auth file when it proves the same identity", async () => {
        // The regression: the only grok-sub account on a migrated config holds a
        // token copy and no authFile, so it could never refresh and every poll
        // threw GrokAuthExpiredError forever, while ~/.grok/auth.json stayed fresh.
        account = { name: "grok", provider: "grok-sub", tokens: { accessToken: EXPIRED_MINE } };
        writeAuth(expiredEntries({ key: EXPIRED_MINE, user_id: MINE }));
        const calls: string[] = [];
        stubFetch({ calls, token: { body: SafeJSON.stringify({ access_token: FRESH_MINE }) } });

        const resolved = await resolveGrokSubToken("grok");

        expect(resolved.token).toBe(FRESH_MINE);
        expect(resolved.authPath).toBe(authPath);
        expect(calls.some((url) => url === `${ISSUER}/oauth2/token`)).toBe(true);
    });

    it("uses a still-fresh default auth file without spending the grant", async () => {
        account = { name: "grok", provider: "grok-sub", tokens: { accessToken: EXPIRED_MINE } };
        writeAuth(expiredEntries({ key: FRESH_MINE }));
        const calls: string[] = [];
        stubFetch({ calls });

        expect((await resolveGrokSubToken("grok")).token).toBe(FRESH_MINE);
        expect(calls).toHaveLength(0);
    });

    it("refuses the default auth file when it belongs to a DIFFERENT identity", async () => {
        account = { name: "grok", provider: "grok-sub", tokens: { accessToken: EXPIRED_MINE } };
        writeAuth(expiredEntries({ key: EXPIRED_THEIRS, user_id: THEIRS }));
        const calls: string[] = [];
        stubFetch({ calls });

        // Refreshing here would hand back the other account's token and bill them.
        await expect(resolveGrokSubToken("grok")).rejects.toThrow(GrokAuthExpiredError);
        expect(calls).toHaveLength(0);
    });

    it("refuses when neither side names an identity", async () => {
        account = { name: "grok", provider: "grok-sub", tokens: { accessToken: EXPIRED } };
        writeAuth(expiredEntries());
        const calls: string[] = [];
        stubFetch({ calls });

        await expect(resolveGrokSubToken("grok")).rejects.toThrow(GrokAuthExpiredError);
        expect(calls).toHaveLength(0);
    });

    it("does not spend the grant on the identity-matched path during a probe", async () => {
        account = { name: "grok", provider: "grok-sub", tokens: { accessToken: EXPIRED_MINE } };
        writeAuth(expiredEntries({ key: EXPIRED_MINE, user_id: MINE }));
        const calls: string[] = [];
        stubFetch({ calls });

        await expect(resolveGrokSubToken("grok", { noRefresh: true })).rejects.toThrow(/disabled for diagnosis/);
        expect(calls).toHaveLength(0);
    });
});

describe("resolveGrokSubToken: a grant stored by tools grok login", () => {
    it("routes to the stored grant, never to an auth file, and hands back its refresh path", async () => {
        account = {
            name: "grok",
            provider: "grok-sub",
            tokens: { accessToken: FRESH, refreshToken: "refresh-stored" },
        };
        storedGrantCalls.length = 0;

        const resolved = await resolveGrokSubToken("grok", { noRefresh: true });

        expect(resolved.token).toBe("stored-token");
        expect(resolved.authPath).toBeUndefined();
        expect(resolved.storedGrant?.hint).toBe("Run: tools grok login grok");
        expect(storedGrantCalls).toEqual([{ name: "grok", options: { noRefresh: true } }]);

        await resolved.storedGrant?.refresh("upstream returned 401", true);
        expect(storedGrantCalls[1]).toEqual({ name: "grok", options: { force: true } });
    });

    // The issuer may answer a grant without a new refresh token. Routing that on the
    // refresh token alone sent it to `~/.grok/auth.json`, whoever the Grok CLI is logged
    // in as, which is the cross-account read the branch exists to prevent. The expiry the
    // login stored beside the token is what still names the shape.
    it("routes a grant the issuer gave no refresh token for, on its stored expiry", async () => {
        account = {
            name: "grok",
            provider: "grok-sub",
            tokens: { accessToken: FRESH, expiresAt: Date.now() + 3_600_000 },
        };
        storedGrantCalls.length = 0;
        const calls: string[] = [];
        stubFetch({ calls });

        const resolved = await resolveGrokSubToken("grok");

        expect(resolved.token).toBe("stored-token");
        expect(resolved.authPath).toBeUndefined();
        expect(storedGrantCalls).toEqual([{ name: "grok", options: {} }]);
        // Nothing reached the Grok CLI's own auth file or its issuer.
        expect(calls).toEqual([]);
    });

    // Negative control: a plain stored token with no refresh token and no expiry is the
    // older pasted shape and keeps the identity-proof path (the describe above).
    it("a stored token without a refresh token still resolves as before", async () => {
        account = { name: "grok", provider: "grok-sub", tokens: { accessToken: FRESH } };
        storedGrantCalls.length = 0;

        expect((await resolveGrokSubToken("grok")).token).toBe(FRESH);
        expect(storedGrantCalls).toEqual([]);
    });
});

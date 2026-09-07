import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { NETWORKED_LOCK_WAIT_MS } from "@genesiscz/utils/storage/file-lock";
import {
    codexOAuth,
    extractAccountId,
    extractEmail,
    readCodexAuthJson,
    TOKEN_REQUEST_TIMEOUT_MS,
    writeCodexAuthJson,
} from "./codex-auth";

function jwt(payload: Record<string, unknown>): string {
    return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(SafeJSON.stringify(payload)).toString("base64url")}.signature`;
}

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gt-codex-auth-"));
});

afterEach(() => {
    dir = "";
});

describe("writeCodexAuthJson", () => {
    // Decision D3: the file we write must be the file the official CLI reads,
    // so a login here and a `codex` invocation share one token per profile.
    test("round-trips through readCodexAuthJson", async () => {
        const idToken = jwt({ email: "alice@example.com" });
        const accessToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
        const path = join(dir, "profile", "auth.json");

        await writeCodexAuthJson(path, {
            accessToken,
            refreshToken: "rt-1",
            expiresAt: 0,
            accountId: "acct-1",
            idToken,
        });

        const read = await readCodexAuthJson(path);

        expect(read?.accessToken).toBe(accessToken);
        expect(read?.refreshToken).toBe("rt-1");
        expect(read?.accountId).toBe("acct-1");
        expect(read?.idToken).toBe(idToken);
        expect(extractEmail(read?.idToken ?? "")).toBe("alice@example.com");
        // The expiry comes back off the access token's `exp` claim.
        expect(read?.expiresAt).toBeGreaterThan(Date.now());
    });

    test("creates the profile directory and keeps the file owner-only", async () => {
        const path = join(dir, "fresh-home", "auth.json");

        await writeCodexAuthJson(path, { accessToken: jwt({}), refreshToken: "rt", expiresAt: 0 });

        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    test("an account id absent from the tokens is still recoverable from the claims", async () => {
        const accessToken = jwt({ chatgpt_account_id: "acct-from-claims" });
        const path = join(dir, "auth.json");

        await writeCodexAuthJson(path, { accessToken, refreshToken: "rt", expiresAt: 0 });
        const read = await readCodexAuthJson(path);

        expect(read?.accountId).toBeUndefined();
        expect(extractAccountId(read?.accessToken ?? "")).toBe("acct-from-claims");
    });
});

describe("CodexOAuthClient.refresh runs inside the config lock, so it must be bounded", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test("the request carries a deadline", async () => {
        let seen: RequestInit | undefined;

        globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            seen = init;

            return new Response(
                SafeJSON.stringify({ access_token: jwt({}), refresh_token: "rt-2", expires_in: 3600 }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }) as typeof fetch;

        // Negative control: the normal path still completes and returns the pair.
        const tokens = await codexOAuth.refresh("rt-1");

        expect(tokens.refreshToken).toBe("rt-2");
        expect(seen?.signal).toBeInstanceOf(AbortSignal);
    });

    test("a wedged token endpoint gives the lock back instead of holding it open", async () => {
        // Local server that accepts the connection and never answers, which is
        // what an unbounded refresh used to hold the config lock across.
        const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
        const stalled = `http://127.0.0.1:${server.port}/`;

        globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
            originalFetch(stalled, { ...init, signal: AbortSignal.timeout(120) })) as typeof fetch;

        try {
            await codexOAuth.refresh("rt-1");
            throw new Error("the wedged endpoint did not abort");
        } catch (err) {
            expect((err as Error).name).toBe("TimeoutError");
        } finally {
            server.stop(true);
        }
    });

    test("the request deadline fits inside the lock budget it nests in", () => {
        // The invariant the two constants exist to keep: a holder that outlasts
        // the wait budget makes that budget meaningless, which is how one stalled
        // refresh timed every other account out.
        expect(TOKEN_REQUEST_TIMEOUT_MS).toBeLessThan(NETWORKED_LOCK_WAIT_MS);
    });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { refreshGrokAuth } from "./refresh";
import type { GrokAuthEntry } from "./types";

// Every token here is synthetic: an unsigned JWT whose payload carries only an
// `exp`, plus placeholder refresh tokens. Nothing in this file touches
// auth.x.ai — `fetch` is replaced for the duration of each test.

const ISSUER = "https://auth.example.test";
const ENTRY_KEY = `${ISSUER}::11111111-2222-3333-4444-555555555555`;

function jwt(expSecondsFromNow: number): string {
    const payload = Buffer.from(SafeJSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }), "utf-8")
        .toString("base64url")
        .replace(/=+$/, "");

    return `e30.${payload}.sig`;
}

const EXPIRED = jwt(-3_600);
const FRESH = jwt(3_600);
/** A second usable token, so "which one came back?" is answerable. */
const ROTATED = jwt(7_200);

let dir: string;
let authPath: string;
const originalFetch = globalThis.fetch;

interface FetchCall {
    url: string;
    body?: string;
}

function writeAuth(entries: Record<string, GrokAuthEntry>): void {
    writeFileSync(authPath, SafeJSON.stringify(entries, { strict: true }, 2), { mode: 0o600 });
}

function readAuth(): Record<string, GrokAuthEntry> {
    return SafeJSON.parse(readFileSync(authPath, "utf-8"), { strict: true }) as Record<string, GrokAuthEntry>;
}

function defaultEntries(): Record<string, GrokAuthEntry> {
    return {
        [ENTRY_KEY]: {
            key: EXPIRED,
            refresh_token: "refresh-one",
            expires_at: "2020-01-01T00:00:00.000Z",
            oidc_issuer: ISSUER,
            oidc_client_id: "client-abc",
            auth_mode: "oidc",
        },
    };
}

/**
 * Replace fetch with a recorder. `discovery` decides what the well-known
 * endpoint answers; `token` builds the token-endpoint response; `onToken` runs
 * while the token request is in flight, which is where a concurrent `grok` CLI
 * write is simulated.
 */
function stubFetch(options: {
    calls: FetchCall[];
    discovery?: { ok: boolean; tokenEndpoint?: string };
    token?: { status?: number; body?: string };
    onToken?: () => void;
}): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        options.calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });

        if (url.endsWith("/.well-known/openid-configuration")) {
            const discovery = options.discovery ?? { ok: false };

            if (!discovery.ok) {
                return new Response("no", { status: 404 });
            }

            return Response.json({ token_endpoint: discovery.tokenEndpoint });
        }

        options.onToken?.();
        const token = options.token ?? {};

        return new Response(token.body ?? SafeJSON.stringify({ access_token: FRESH, refresh_token: "refresh-two" }), {
            status: token.status ?? 200,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grok-refresh-"));
    mkdirSync(dir, { recursive: true });
    authPath = join(dir, "auth.json");
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("refreshGrokAuth", () => {
    it("performs exactly one token request for concurrent callers and hands them the same token", async () => {
        writeAuth(defaultEntries());
        const calls: FetchCall[] = [];
        stubFetch({ calls });

        const results = await Promise.all(Array.from({ length: 5 }, () => refreshGrokAuth({ path: authPath })));

        expect(results).toEqual([FRESH, FRESH, FRESH, FRESH, FRESH]);
        // Burning a single-use refresh token twice can invalidate the grant, so
        // this count is the point of the whole single-flight design.
        expect(calls.filter((call) => !call.url.includes(".well-known")).length).toBe(1);
        expect(calls[calls.length - 1]?.body).toContain("grant_type=refresh_token");
        expect(calls[calls.length - 1]?.body).toContain("refresh_token=refresh-one");
    });

    it("rewrites auth.json with the rotated tokens, leaving no temp file behind", async () => {
        writeAuth(defaultEntries());
        stubFetch({ calls: [] });

        await refreshGrokAuth({ path: authPath });

        const entries = readAuth();
        expect(entries[ENTRY_KEY]?.key).toBe(FRESH);
        expect(entries[ENTRY_KEY]?.refresh_token).toBe("refresh-two");
        expect(entries[ENTRY_KEY]?.oidc_client_id).toBe("client-abc");
        expect(new Date(entries[ENTRY_KEY]?.expires_at ?? 0).getTime()).toBeGreaterThan(Date.now());
        expect(readdirSync(dir)).toEqual(["auth.json"]);
    });

    it("keeps the rewritten file owner-only", async () => {
        writeAuth(defaultEntries());
        stubFetch({ calls: [] });

        await refreshGrokAuth({ path: authPath });

        expect(statSync(authPath).mode & 0o777).toBe(0o600);
    });

    it("falls back to {issuer}/oauth2/token when discovery is unusable", async () => {
        writeAuth(defaultEntries());
        const calls: FetchCall[] = [];
        stubFetch({ calls, discovery: { ok: false } });

        await refreshGrokAuth({ path: authPath });

        expect(calls[0]?.url).toBe(`${ISSUER}/.well-known/openid-configuration`);
        expect(calls[1]?.url).toBe(`${ISSUER}/oauth2/token`);
    });

    it("uses the token_endpoint that discovery advertises", async () => {
        writeAuth(defaultEntries());
        const calls: FetchCall[] = [];
        stubFetch({ calls, discovery: { ok: true, tokenEndpoint: `${ISSUER}/custom/token` } });

        await refreshGrokAuth({ path: authPath });

        expect(calls[1]?.url).toBe(`${ISSUER}/custom/token`);
    });

    it("returns null and leaves the file untouched when the token endpoint rejects the grant", async () => {
        writeAuth(defaultEntries());
        stubFetch({ calls: [], token: { status: 400, body: '{"error":"invalid_grant"}' } });

        expect(await refreshGrokAuth({ path: authPath })).toBeNull();
        expect(readAuth()[ENTRY_KEY]?.key).toBe(EXPIRED);
        expect(readdirSync(dir)).toEqual(["auth.json"]);
    });

    it("returns null on a malformed token response instead of writing a corrupt file", async () => {
        writeAuth(defaultEntries());
        stubFetch({ calls: [], token: { body: "not json at all" } });

        expect(await refreshGrokAuth({ path: authPath })).toBeNull();
        expect(readAuth()[ENTRY_KEY]?.key).toBe(EXPIRED);
    });

    it("returns null when the response carries no access_token", async () => {
        writeAuth(defaultEntries());
        stubFetch({ calls: [], token: { body: '{"refresh_token":"refresh-two"}' } });

        expect(await refreshGrokAuth({ path: authPath })).toBeNull();
        expect(readAuth()[ENTRY_KEY]?.key).toBe(EXPIRED);
    });

    it("does not attempt a grant when the entry lacks the OIDC fields", async () => {
        writeAuth({ [ENTRY_KEY]: { key: EXPIRED, oidc_issuer: ISSUER } });
        const calls: FetchCall[] = [];
        stubFetch({ calls });

        expect(await refreshGrokAuth({ path: authPath })).toBeNull();
        expect(calls).toHaveLength(0);
    });

    it("returns the on-disk token without a network call when it is already fresh", async () => {
        writeAuth({ [ENTRY_KEY]: { ...defaultEntries()[ENTRY_KEY], key: FRESH } as GrokAuthEntry });
        const calls: FetchCall[] = [];
        stubFetch({ calls });

        expect(await refreshGrokAuth({ path: authPath })).toBe(FRESH);
        expect(calls).toHaveLength(0);
    });

    it("preserves what another writer added to auth.json while the grant was in flight", async () => {
        const otherKey = `${ISSUER}::99999999-8888-7777-6666-555555555555`;
        writeAuth(defaultEntries());
        stubFetch({
            calls: [],
            onToken: () => {
                // Stand-in for the `grok` CLI writing the file mid-refresh.
                writeAuth({
                    ...defaultEntries(),
                    [otherKey]: { key: FRESH, refresh_token: "other-refresh" },
                });
            },
        });

        await refreshGrokAuth({ path: authPath });

        const entries = readAuth();
        expect(entries[otherKey]?.key).toBe(FRESH);
        expect(entries[otherKey]?.refresh_token).toBe("other-refresh");
        expect(entries[ENTRY_KEY]?.key).toBe(FRESH);
    });

    it("preserves top-level fields that are not auth entries", async () => {
        // `parseAuthEntries` keeps only objects carrying a non-empty `key`, so a
        // rewrite built from that map alone would silently delete whatever else
        // the `grok` CLI stores beside the entries in a file we do not own.
        writeFileSync(
            authPath,
            SafeJSON.stringify(
                {
                    ...defaultEntries(),
                    version: 2,
                    settings: { theme: "dark" },
                    "https://auth.x.ai::logged-out": { auth_mode: "oidc", key: "" },
                },
                { strict: true },
                2
            ),
            { mode: 0o600 }
        );
        stubFetch({ calls: [] });

        await refreshGrokAuth({ path: authPath });

        const raw = SafeJSON.parse(readFileSync(authPath, "utf-8"), { strict: true }) as Record<string, unknown>;
        expect(raw.version).toBe(2);
        expect(raw.settings).toEqual({ theme: "dark" });
        expect(raw["https://auth.x.ai::logged-out"]).toEqual({ auth_mode: "oidc", key: "" });
        expect((raw[ENTRY_KEY] as GrokAuthEntry).key).toBe(FRESH);
    });

    // Revoking directory write access does not stop root, so under a root CI
    // image the write would succeed and this would fail for the wrong reason.
    it.skipIf(process.getuid?.() === 0)(
        "leaves no temp file behind when the atomic write cannot complete",
        async () => {
            // The temp file carries the access AND refresh tokens, so a write that
            // fails partway must not leave one on disk. The directory is revoked
            // mid-grant, after the initial read has already succeeded.
            writeAuth(defaultEntries());
            stubFetch({
                calls: [],
                onToken: () => {
                    chmodSync(dir, 0o500);
                },
            });

            expect(await refreshGrokAuth({ path: authPath })).toBeNull();

            chmodSync(dir, 0o700);
            expect(readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
            // The original token is untouched, so the account is no worse off.
            expect(readAuth()[ENTRY_KEY]?.key).toBe(EXPIRED);
        }
    );

    it("preserves sibling data in a file the lenient reader accepts but strict JSON rejects", async () => {
        // The reader (`readAuthFileAsync`) parses leniently, so a trailing comma
        // is a file this code happily refreshes. If the rewrite re-parsed it
        // strictly it would fall back and delete everything else — the very data
        // loss this rewrite path exists to prevent.
        writeFileSync(
            authPath,
            `{
                "version": 2,
                ${SafeJSON.stringify(ENTRY_KEY, { strict: true })}: ${SafeJSON.stringify(defaultEntries()[ENTRY_KEY], { strict: true })},
            }`,
            { mode: 0o600 }
        );
        stubFetch({ calls: [] });

        expect(await refreshGrokAuth({ path: authPath })).toBe(FRESH);

        const raw = SafeJSON.parse(readFileSync(authPath, "utf-8"), { strict: true }) as Record<string, unknown>;
        expect(raw.version).toBe(2);
        expect((raw[ENTRY_KEY] as GrokAuthEntry).key).toBe(FRESH);
    });

    it("keeps every other entry when the file turns unparseable mid-grant", async () => {
        const otherKey = `${ISSUER}::99999999-8888-7777-6666-555555555555`;
        writeAuth({ ...defaultEntries(), [otherKey]: { key: FRESH, refresh_token: "other-refresh" } });
        stubFetch({
            calls: [],
            onToken: () => {
                writeFileSync(authPath, "{ this is not json at all", { mode: 0o600 });
            },
        });

        await refreshGrokAuth({ path: authPath });

        // Falling back to an empty document would have dropped the other account.
        const entries = readAuth();
        expect(entries[otherKey]?.key).toBe(FRESH);
        expect(entries[ENTRY_KEY]?.key).toBe(FRESH);
    });

    it("keeps a concurrent refresh of the SAME entry rather than clobbering it", async () => {
        writeAuth(defaultEntries());
        stubFetch({
            calls: [],
            onToken: () => {
                // The `grok` CLI wins the race and rotates the active entry. Its
                // refresh token is the one the issuer now expects, so ours must lose.
                writeAuth({
                    [ENTRY_KEY]: {
                        ...defaultEntries()[ENTRY_KEY],
                        key: ROTATED,
                        refresh_token: "cli-refresh",
                    } as GrokAuthEntry,
                });
            },
        });

        expect(await refreshGrokAuth({ path: authPath })).toBe(ROTATED);

        const entry = readAuth()[ENTRY_KEY];
        expect(entry?.key).toBe(ROTATED);
        expect(entry?.refresh_token).toBe("cli-refresh");
    });

    it("still performs the grant for an unexpired on-disk token when forced", async () => {
        writeAuth({ [ENTRY_KEY]: { ...defaultEntries()[ENTRY_KEY], key: FRESH } as GrokAuthEntry });
        const calls: FetchCall[] = [];
        stubFetch({
            calls,
            token: { body: SafeJSON.stringify({ access_token: ROTATED, refresh_token: "refresh-two" }) },
        });

        // Without `force` this returns FRESH untouched (see the test above); a 401
        // recovery needs the grant to happen anyway.
        expect(await refreshGrokAuth({ path: authPath, force: true })).toBe(ROTATED);
        expect(calls.filter((call) => !call.url.includes(".well-known"))).toHaveLength(1);
        expect(readAuth()[ENTRY_KEY]?.key).toBe(ROTATED);
    });
});

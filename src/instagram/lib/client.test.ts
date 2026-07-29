import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { __testing as __clientTesting, getJson } from "./client";
import type { InstagramError } from "./types";

const realFetch = globalThis.fetch;

beforeAll(() => {
    // Otherwise the module-level limiter sleeps for real (jitter runs to 15s).
    __clientTesting.useInstantLimiter();
});

beforeEach(() => {
    __clientTesting.resetWwwClaim();
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

function mockResponse(body: string, status: number, headers?: Record<string, string>): void {
    globalThis.fetch = mock(async () => new Response(body, { status, headers })) as unknown as typeof fetch;
}

describe("getJson error classification", () => {
    test("reads Instagram's `login_required` as session-required, not a generic 403", async () => {
        // Verified against i.instagram.com on 2026-07-27: this exact body is what
        // the mobile endpoints return for gated story content.
        mockResponse(
            '{"message":"login_required","logout_reason":33,"logout_expectedness":"logged_out","status":"fail"}',
            403
        );

        const error = (await getJson("/x", { label: "test" }).catch((err) => err)) as InstagramError;

        expect(error.kind).toBe("session-required");
        expect(error.status).toBe(403);
    });

    test("separates checkpoint (account-level) from rate limiting (IP-level)", async () => {
        mockResponse('{"message":"checkpoint_required"}', 403);
        const checkpoint = (await getJson("/x", { label: "test" }).catch((err) => err)) as InstagramError;
        expect(checkpoint.kind).toBe("checkpoint");

        // Deliberately NOT the "please wait a few minutes" body — that is a
        // caller-scoped throttle with its own kind, not an IP-level rate limit.
        mockResponse('{"message":"rate_limit_error","status":"fail"}', 429);
        const limited = (await getJson("/x", { label: "test" }).catch((err) => err)) as InstagramError;
        expect(limited.kind).toBe("rate-limited");
        expect(limited.isTerminal).toBe(false);
    });

    test("treats the logged-out HTML shell as an auth failure rather than parsing it", async () => {
        // A 200 carrying ~600KB of SPA shell is Instagram's anonymous response for
        // gated pages. Feeding that to a JSON parser would throw something useless.
        mockResponse("<!DOCTYPE html><html><head></head><body></body></html>", 200);

        const error = (await getJson("/x", { label: "test" }).catch((err) => err)) as InstagramError;

        expect(error.kind).toBe("session-required");
    });

    test("blames the session when the HTML shell comes back despite a cookie", async () => {
        mockResponse("<!DOCTYPE html><html></html>", 200);

        const error = (await getJson("/x", { label: "test", sessionId: "c" }).catch((err) => err)) as InstagramError;

        expect(error.kind).toBe("session-invalid");
    });

    test("classifies the login redirect that several endpoints use instead of an error", async () => {
        mockResponse("", 302, { location: "https://www.instagram.com/accounts/login/" });

        const error = (await getJson("/x", { label: "test" }).catch((err) => err)) as InstagramError;

        expect(error.kind).toBe("session-required");
    });

    test("returns parsed JSON and reports which auth mode produced it", async () => {
        mockResponse('{"ok":true}', 200, { "content-type": "application/json" });

        const anonymous = await getJson<{ ok: boolean }>("/x", { label: "test" });
        expect(anonymous.data.ok).toBe(true);
        expect(anonymous.authMode).toBe("anonymous");

        const authenticated = await getJson<{ ok: boolean }>("/x", { label: "test", sessionId: "c" });
        expect(authenticated.authMode).toBe("session");
    });
});

describe("request headers", () => {
    test("omits the cookie entirely when anonymous, and sends it when not", async () => {
        const seen: Array<Record<string, string>> = [];
        globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
            seen.push((init?.headers ?? {}) as Record<string, string>);
            return new Response('{"ok":true}', { status: 200 });
        }) as unknown as typeof fetch;

        await getJson("/x", { label: "test" });
        await getJson("/x", { label: "test", sessionId: "abc123" });

        expect(seen[0].cookie).toBeUndefined();
        expect(seen[1].cookie).toBe("sessionid=abc123");
        expect(seen[0]["x-ig-app-id"]).toBe("936619743392459");
    });
});

describe("enforcement classification (post-research)", () => {
    test("detects feedback_required — an account-level flag, not a rate limit", async () => {
        // Instagram's "that looked automated" response. Backing off does not clear
        // it, so it must not be classified as rate-limited.
        mockResponse('{"message":"feedback_required","spam":true,"status":"fail"}', 400);

        const error = (await getJson("/x", { label: "test" }).catch((err) => err)) as InstagramError;

        expect(error.kind).toBe("feedback-required");
        expect(error.isTerminal).toBe(true);
    });

    test("classifies HTTP 400 enforcement, which a 401/403-only classifier misses", async () => {
        mockResponse(
            '{"message":"challenge_required","challenge":{"url":"https://i.instagram.com/challenge/123/abc/"}}',
            400
        );

        const error = (await getJson("/x", { label: "test", sessionId: "c" }).catch((err) => err)) as InstagramError;

        expect(error.kind).toBe("checkpoint");
        expect(error.challengeUrl).toContain("/challenge/");
    });

    test("separates a suspension from a clearable challenge via the URL", async () => {
        // "/suspended/" means an SMS code will not fix it — it needs an appeal.
        mockResponse(
            '{"message":"challenge_required","challenge":{"url":"https://www.instagram.com/challenge/suspended/?next=1"}}',
            400
        );

        const error = (await getJson("/x", { label: "test", sessionId: "c" }).catch((err) => err)) as InstagramError;

        expect(error.kind).toBe("suspended");
        expect(error.isTerminal).toBe(true);
    });

    test("treats sentry_block as IP-level rate limiting, which IS worth backing off from", async () => {
        mockResponse('{"message":"sentry_block","status":"fail"}', 403);

        const error = (await getJson("/x", { label: "test" }).catch((err) => err)) as InstagramError;

        expect(error.kind).toBe("rate-limited");
        expect(error.isTerminal).toBe(false);
    });

    test("sends x-csrftoken matching the cookie, and warns when it is missing", async () => {
        const seen: Array<Record<string, string>> = [];
        globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
            seen.push((init?.headers ?? {}) as Record<string, string>);
            return new Response('{"ok":true}', { status: 200 });
        }) as unknown as typeof fetch;

        await getJson("/x", { label: "test", sessionId: "abc", csrfToken: "tok123" });

        expect(seen[0]["x-csrftoken"]).toBe("tok123");
        expect(seen[0].cookie).toBe("sessionid=abc; csrftoken=tok123");
        expect(seen[0]["x-asbd-id"]).toBeDefined();
    });

    test("replays the server's x-ig-set-www-claim on subsequent requests", async () => {
        __clientTesting.resetWwwClaim();
        const seen: Array<Record<string, string>> = [];
        let call = 0;
        globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
            seen.push((init?.headers ?? {}) as Record<string, string>);
            call += 1;
            return new Response('{"ok":true}', {
                status: 200,
                headers: call === 1 ? { "x-ig-set-www-claim": "hmac.AR1234" } : {},
            });
        }) as unknown as typeof fetch;

        await getJson("/x", { label: "first" });
        await getJson("/x", { label: "second" });

        // Starts at "0", then echoes what the server handed back. Not replaying it
        // marks the client as not-a-browser for the rest of the session.
        expect(seen[0]["x-ig-www-claim"]).toBe("0");
        expect(seen[1]["x-ig-www-claim"]).toBe("hmac.AR1234");
        __clientTesting.resetWwwClaim();
    });
});

describe("marker scanning is gated on a failure envelope", () => {
    test("does not read the word `spam` in a profile bio as feedback_required", async () => {
        // `web_profile_info` answers 200 with the user's own text in it. Scanning
        // that for enforcement substrings invents a block on a working account —
        // and "no spam pls" is an extremely ordinary thing for a bio to say.
        mockResponse('{"data":{"user":{"username":"real","biography":"dm me, no spam pls"}},"status":"ok"}', 200);

        const response = await getJson<{ data: { user: { username: string } } }>("/x", { label: "test" });

        expect(response.data.data.user.username).toBe("real");
    });

    test("does not read a bio asking you to wait a few minutes as a throttle", async () => {
        mockResponse('{"data":{"user":{"biography":"live soon — please wait a few minutes"}},"status":"ok"}', 200);

        const response = await getJson<{ status: string }>("/x", { label: "test" });

        expect(response.data.status).toBe("ok");
    });

    test("only honours a TOP-LEVEL fail status, not one nested in the payload", async () => {
        // The gate reads the parsed document's own verdict. A `status` belonging to
        // some nested object must not open the marker scan while the real one says
        // "ok", or a payload that happens to carry both is a fabricated block.
        mockResponse('{"data":{"user":{"friendship":{"status":"fail"},"biography":"no spam"}},"status":"ok"}', 200);

        const response = await getJson<{ status: string }>("/x", { label: "test" });

        expect(response.data.status).toBe("ok");
    });

    test("still classifies enforcement that arrives as HTTP 200 plus a fail envelope", async () => {
        // The gate must not be `!response.ok` alone: Instagram does answer 200 with
        // `status: fail`, and dropping that would trade a false positive for a
        // false negative.
        mockResponse('{"message":"feedback_required","spam":true,"status":"fail"}', 200);

        const error = (await getJson("/x", { label: "test" }).catch((err) => err)) as InstagramError;

        expect(error.kind).toBe("feedback-required");
    });
});

describe("malformed JSON", () => {
    test("wraps an unparseable body in an InstagramError instead of a raw SyntaxError", async () => {
        // `startsWith("{")` only rules out the HTML shell. A truncated body still
        // reaches the parser, and a raw SyntaxError escapes explainError's
        // InstagramError branch to print a parser message at the user.
        mockResponse('{"reels": {"123": {"items": [', 200);

        const error = (await getJson("/x", { label: "test" }).catch((err) => err)) as InstagramError;

        expect(error.name).toBe("InstagramError");
        expect(error.kind).toBe("network");
        expect(error.message).toContain("malformed JSON");
    });
});

describe("www-claim isolation between auth modes", () => {
    test("never replays the session's claim on a later anonymous request", async () => {
        // The claim is minted against the caller Instagram answered. Echoing the
        // logged-in one anonymously links the two, which is the whole leak the
        // anonymous endpoints refuse a sessionId parameter to prevent.
        __clientTesting.resetWwwClaim();
        const seen: Array<Record<string, string>> = [];
        globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
            seen.push((init?.headers ?? {}) as Record<string, string>);
            return new Response('{"ok":true}', { status: 200, headers: { "x-ig-set-www-claim": "hmac.SESSION" } });
        }) as unknown as typeof fetch;

        await getJson("/x", { label: "authed", sessionId: "abc" });
        await getJson("/x", { label: "anon" });

        expect(seen[1]["x-ig-www-claim"]).toBe("0");
        expect(__clientTesting.currentWwwClaim("abc")).toBe("hmac.SESSION");
        __clientTesting.resetWwwClaim();
    });

    test("never hands one session's claim to a different session", async () => {
        // Auth mode alone is too coarse: two accounts are both "session", and
        // account B echoing A's claim links the pair just as visibly.
        __clientTesting.resetWwwClaim();
        const seen: Array<Record<string, string>> = [];
        globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
            seen.push((init?.headers ?? {}) as Record<string, string>);
            return new Response('{"ok":true}', { status: 200, headers: { "x-ig-set-www-claim": "hmac.ACCOUNT_A" } });
        }) as unknown as typeof fetch;

        await getJson("/x", { label: "account-a", sessionId: "session-a" });
        await getJson("/x", { label: "account-a again", sessionId: "session-a" });
        await getJson("/x", { label: "account-b", sessionId: "session-b" });

        // Same credential keeps replaying it; a different one starts clean.
        expect(seen[1]["x-ig-www-claim"]).toBe("hmac.ACCOUNT_A");
        expect(seen[2]["x-ig-www-claim"]).toBe("0");
        __clientTesting.resetWwwClaim();
    });

    test("keeps claims apart when two credentials are in flight at the same time", async () => {
        // Sequential tests cannot catch this. With one shared slot plus an "whose
        // claim is this?" variable, the window between B taking ownership and B
        // building its headers is one await wide — long enough for A's response
        // to drop A's claim into the slot that B is about to read.
        __clientTesting.resetWwwClaim();
        const seen: Array<Record<string, string>> = [];
        let releaseA: () => void = () => undefined;
        const aIsHeld = new Promise<void>((resolve) => {
            releaseA = resolve;
        });

        globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            seen.push(headers);

            if (headers.cookie?.includes("session-a")) {
                await aIsHeld;
                return new Response('{"ok":true}', { status: 200, headers: { "x-ig-set-www-claim": "hmac.A" } });
            }

            return new Response('{"ok":true}', { status: 200, headers: { "x-ig-set-www-claim": "hmac.B" } });
        }) as unknown as typeof fetch;

        // A goes out and parks inside fetch; B overtakes it and completes.
        const a = getJson("/x", { label: "a", sessionId: "session-a" });
        await getJson("/x", { label: "b", sessionId: "session-b" });

        // Now A's response lands, writing A's claim while B was the last owner.
        releaseA();
        await a;

        await getJson("/x", { label: "b again", sessionId: "session-b" });

        // seen[0] = A (parked), seen[1] = B, seen[2] = B again.
        expect(seen[2].cookie).toContain("session-b");
        expect(seen[2]["x-ig-www-claim"]).toBe("hmac.B");
        expect(__clientTesting.currentWwwClaim("session-a")).toBe("hmac.A");
        __clientTesting.resetWwwClaim();
    });
});

describe("request origin", () => {
    test("refuses to send credentials to a host that is not Instagram", async () => {
        // getJson attaches sessionid, csrftoken and the www-claim to whatever it
        // is pointed at, so an absolute URL from a caller is an exfiltration path.
        let requested = 0;
        globalThis.fetch = mock(async () => {
            requested += 1;
            return new Response('{"ok":true}', { status: 200 });
        }) as unknown as typeof fetch;

        const error = (await getJson("https://evil.example/steal", {
            label: "test",
            sessionId: "abc",
            csrfToken: "tok",
        }).catch((err) => err)) as InstagramError;

        expect(requested).toBe(0);
        expect(error.name).toBe("InstagramError");
        expect(error.message).toContain("not the Instagram web origin");
    });

    test("refuses plaintext http even on the right host", async () => {
        let requested = 0;
        globalThis.fetch = mock(async () => {
            requested += 1;
            return new Response('{"ok":true}', { status: 200 });
        }) as unknown as typeof fetch;

        const error = (await getJson("http://www.instagram.com/api/v1/x", { label: "test", sessionId: "abc" }).catch(
            (err) => err
        )) as InstagramError;

        expect(requested).toBe(0);
        expect(error.name).toBe("InstagramError");
    });

    test("still resolves ordinary relative paths against the web origin", async () => {
        let capturedUrl = "";
        globalThis.fetch = mock(async (url: string | URL) => {
            capturedUrl = String(url);
            return new Response('{"ok":true}', { status: 200 });
        }) as unknown as typeof fetch;

        await getJson("/api/v1/users/web_profile_info/?username=x", { label: "test" });

        expect(capturedUrl).toBe("https://www.instagram.com/api/v1/users/web_profile_info/?username=x");
    });
});

describe("strict JSON parsing", () => {
    test("rejects a body with comments rather than leniently accepting it", async () => {
        // Instagram cannot emit JSONC. A lenient parser accepting it would hide a
        // body that is not actually from the API behind a successful parse.
        mockResponse('{"ok": true /* not something Instagram sends */}', 200);

        const error = (await getJson("/x", { label: "test" }).catch((err) => err)) as InstagramError;

        expect(error.name).toBe("InstagramError");
        expect(error.message).toContain("malformed JSON");
    });
});

describe("please-wait throttle", () => {
    test("does not mistake the 401 + require_login throttle for an auth failure", async () => {
        // Encountered live on 2026-07-27 while developing this tool: Instagram
        // answers the soft throttle with HTTP 401 and `require_login: true`, which
        // a naive classifier reads as "your cookie is bad" and sends the user
        // chasing a credential problem that does not exist.
        mockResponse(
            '{"message":"Please wait a few minutes before you try again.","require_login":true,"igweb_rollout":true,"status":"fail"}',
            401
        );

        const error = (await getJson("/x", { label: "test" }).catch((err) => err)) as InstagramError;

        expect(error.kind).toBe("please-wait");
        expect(error.isTerminal).toBe(true);
    });
});

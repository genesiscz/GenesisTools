import { afterEach, describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { isTimelyAuthFailure, TimelyHttpError } from "./errors";
import { fetchTimelyWebJson, parseRetryAfterMs } from "./web-fetch";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
    globalThis.fetch = impl as typeof fetch;
}

function options(overrides: Partial<Parameters<typeof fetchTimelyWebJson>[0]> = {}) {
    return {
        url: "https://app.timelyapp.com/558481/entries.json?id=7",
        accessToken: "tok",
        scope: "memories" as const,
        label: "Entry request for 7",
        ...overrides,
    };
}

function delayedBodyResponse(init: RequestInit | undefined, body: string, delayMs: number): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const timer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode(body));
                controller.close();
            }, delayMs);
            init?.signal?.addEventListener(
                "abort",
                () => {
                    clearTimeout(timer);
                    controller.error(init.signal?.reason);
                },
                { once: true }
            );
        },
    });

    return new Response(stream, { status: 200 });
}

describe("fetchTimelyWebJson", () => {
    test("sends the stored cookie alongside the bearer and returns parsed JSON", async () => {
        let sent: Headers | undefined;
        stubFetch(async (_input, init) => {
            sent = new Headers(init?.headers);
            return new Response(SafeJSON.stringify([{ id: 7 }]), { status: 200 });
        });

        const data = await fetchTimelyWebJson(options({ cookie: "_memory_session=abc" }));

        expect(data).toEqual([{ id: 7 }]);
        expect(sent?.get("Cookie")).toBe("_memory_session=abc");
        expect(sent?.get("Authorization")).toBe("Bearer tok");
    });

    test("a non-OK response throws TimelyHttpError carrying the status, scope and label", async () => {
        stubFetch(async () => new Response("boom", { status: 500 }));

        const promise = fetchTimelyWebJson(options());

        await expect(promise).rejects.toThrow(TimelyHttpError);
        await expect(promise).rejects.toMatchObject({ status: 500, scope: "memories", usedCookie: false });
        await expect(promise).rejects.toThrow("Entry request for 7 failed (500)");
    });

    test("a 401 with a cookie is flagged usedCookie, so the caller can blame the cookie not the login", async () => {
        stubFetch(async () => new Response("nope", { status: 401 }));

        try {
            await fetchTimelyWebJson(options({ cookie: "_memory_session=stale" }));
            throw new Error("expected a rejection");
        } catch (err) {
            expect(isTimelyAuthFailure(err)).toBe(true);
            expect(err).toMatchObject({ usedCookie: true });
        }
    });

    test("a 200 carrying HTML rather than JSON becomes a TimelyHttpError, not a bare SyntaxError", async () => {
        stubFetch(async () => new Response("<!DOCTYPE html><title>Sign in to Timely</title>", { status: 200 }));

        const promise = fetchTimelyWebJson(options({ cookie: "_memory_session=stale" }));

        await expect(promise).rejects.toThrow(TimelyHttpError);
        await expect(promise).rejects.toMatchObject({ status: 200, scope: "memories", usedCookie: true });
        await expect(promise).rejects.toThrow("returned a non-JSON body (200)");
    });

    test("a sign-in redirect is an auth failure carrying the real 3xx, not a followed 200", async () => {
        const redirectModes: (RequestRedirect | undefined)[] = [];
        stubFetch(async (_input, init) => {
            redirectModes.push(init?.redirect);
            return new Response(null, { status: 302, headers: { location: "/login" } });
        });

        const promise = fetchTimelyWebJson(options({ cookie: "_memory_session=stale" }));

        await expect(promise).rejects.toThrow(TimelyHttpError);
        await expect(promise).rejects.toMatchObject({ status: 302, scope: "memories", usedCookie: true });
        await expect(promise).rejects.toThrow("was redirected to a sign-in page (302)");
        // Same no-follow policy as the login probe, from the one helper both call.
        expect(redirectModes).toEqual(["manual"]);
    });

    test("a redirect is classified as an auth failure, so callers abort the run", async () => {
        stubFetch(async () => new Response(null, { status: 302, headers: { location: "/login" } }));

        try {
            await fetchTimelyWebJson(options({ cookie: "_memory_session=stale" }));
            throw new Error("expected a rejection");
        } catch (err) {
            expect(isTimelyAuthFailure(err)).toBe(true);
        }
    });

    test("the request carries an abort signal, so a stalled host cannot hang the CLI", async () => {
        let signal: AbortSignal | null | undefined;
        stubFetch(async (_input, init) => {
            signal = init?.signal;
            return new Response("[]", { status: 200 });
        });

        await fetchTimelyWebJson(options({ timeoutMs: 5_000 }));

        expect(signal).toBeInstanceOf(AbortSignal);
    });

    test("keeps the timeout active while consuming a body received after headers", async () => {
        stubFetch(async (_input, init) => delayedBodyResponse(init, "[]", 50));

        await expect(fetchTimelyWebJson(options({ timeoutMs: 10 }))).rejects.toThrow("timed out");
    });

    test("keeps the caller abort active while consuming a body received after headers", async () => {
        const controller = new AbortController();
        stubFetch(async (_input, init) => delayedBodyResponse(init, "[]", 50));

        const promise = fetchTimelyWebJson(options({ signal: controller.signal, timeoutMs: 1_000 }));
        setTimeout(() => controller.abort(new Error("pool auth abort")), 10);

        await expect(promise).rejects.toThrow("pool auth abort");
    });

    test("still consumes an ordinary delayed body before the deadline", async () => {
        stubFetch(async (_input, init) => delayedBodyResponse(init, '[{"id":7}]', 5));

        await expect(fetchTimelyWebJson(options({ timeoutMs: 100 }))).resolves.toEqual([{ id: 7 }]);
    });

    test("retries one safe GET after a server Retry-After response", async () => {
        let calls = 0;
        stubFetch(async () => {
            calls++;

            if (calls === 1) {
                return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
            }

            return new Response('[{"id":7}]', { status: 200 });
        });

        await expect(fetchTimelyWebJson(options())).resolves.toEqual([{ id: 7 }]);
        expect(calls).toBe(2);
    });

    test("honors caller cancellation while waiting for Retry-After", async () => {
        stubFetch(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "2" } }));

        const promise = fetchTimelyWebJson(options({ signal: AbortSignal.timeout(20) }));

        await expect(promise).rejects.toBeDefined();
    });
});

describe("parseRetryAfterMs", () => {
    test("parses seconds and HTTP dates", () => {
        expect(parseRetryAfterMs("2", 1_000)).toBe(2_000);
        expect(parseRetryAfterMs(new Date(4_000).toUTCString(), 1_000)).toBe(3_000);
    });

    test("rejects malformed values", () => {
        expect(parseRetryAfterMs("later")).toBeUndefined();
        expect(parseRetryAfterMs(null)).toBeUndefined();
    });
});

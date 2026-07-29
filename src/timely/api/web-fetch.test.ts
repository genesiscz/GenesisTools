import { afterEach, describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { isTimelyAuthFailure, TimelyHttpError } from "./errors";
import { fetchTimelyWebJson } from "./web-fetch";

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
});

import { afterEach, describe, expect, test } from "bun:test";
import { readStoredCookie } from "@app/timely/utils/cookie";
import { Storage } from "@genesiscz/utils/storage";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { type CookieRejection, probeAndSaveCookie } from "./cookie-probe";

setupStorageSandbox();

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
    globalThis.fetch = impl as typeof fetch;
}

async function freshStorage(name: string): Promise<Storage> {
    const storage = new Storage(name);
    await storage.ensureDirs();
    return storage;
}

describe("probeAndSaveCookie", () => {
    test("a rejected cookie never reaches disk", async () => {
        const storage = await freshStorage("timely-probe-rejected");
        stubFetch(async () => new Response("nope", { status: 401 }));

        const outcome = await probeAndSaveCookie({ storage, accountId: 558481, cookie: "_memory_session=stale" });

        expect(outcome).toEqual({ status: "rejected", httpStatus: 401, reason: "http-status" });
        expect(await readStoredCookie(storage)).toBeUndefined();
    });

    // A web host answers a signed-out request with a bounce to sign-in, or with the
    // sign-in page under a 200. Both read as success to `response.ok`, so each one is
    // its own way of persisting a cookie that authenticates nothing.
    const bypasses: [string, () => Response, { httpStatus: number; reason: CookieRejection }][] = [
        [
            "a redirect to the sign-in page",
            () => new Response(null, { status: 302, headers: { location: "/login" } }),
            { httpStatus: 302, reason: "redirected" },
        ],
        [
            "a 200 carrying the sign-in page instead of JSON",
            () => new Response("<!DOCTYPE html><title>Sign in to Timely</title>", { status: 200 }),
            { httpStatus: 200, reason: "not-suggested-entries" },
        ],
        [
            "a 200 carrying a JSON error object instead of the entries array",
            () => new Response('{"error":"Unauthorized"}', { status: 200 }),
            { httpStatus: 200, reason: "not-suggested-entries" },
        ],
        [
            "a non-200 success status",
            () => new Response("[]", { status: 201 }),
            { httpStatus: 201, reason: "http-status" },
        ],
    ];

    test.each(bypasses)("%s is refused and never reaches disk", async (name, makeResponse, expected) => {
        const storage = await freshStorage(`timely-probe-${name.replace(/\W+/g, "-")}`);
        stubFetch(async () => makeResponse());

        const outcome = await probeAndSaveCookie({ storage, accountId: 558481, cookie: "_memory_session=stale" });

        expect(outcome).toEqual({ status: "rejected", ...expected });
        expect(await readStoredCookie(storage)).toBeUndefined();
    });

    test("redirects are never followed, so a bounce cannot be laundered into a 200", async () => {
        const storage = await freshStorage("timely-probe-redirect-mode");
        const redirectModes: (RequestRedirect | undefined)[] = [];
        stubFetch(async (_input, init) => {
            redirectModes.push(init?.redirect);
            return new Response("[]", { status: 200 });
        });

        await probeAndSaveCookie({ storage, accountId: 558481, cookie: "_memory_session=live" });

        expect(redirectModes).toEqual(["manual"]);
    });

    test("an unreachable Timely never reaches disk either", async () => {
        const storage = await freshStorage("timely-probe-unreachable");
        stubFetch(async () => {
            throw new Error("socket hang up");
        });

        const outcome = await probeAndSaveCookie({ storage, accountId: 558481, cookie: "_memory_session=abc" });

        expect(outcome.status).toBe("unreachable");
        expect(await readStoredCookie(storage)).toBeUndefined();
    });

    test("only a 200 persists the cookie", async () => {
        const storage = await freshStorage("timely-probe-accepted");
        stubFetch(async () => new Response("[]", { status: 200 }));

        const outcome = await probeAndSaveCookie({ storage, accountId: 558481, cookie: "_memory_session=live" });

        expect(outcome.status).toBe("saved");
        expect(await readStoredCookie(storage)).toBe("_memory_session=live");
    });

    test("the probe is made with the candidate cookie itself, against the selected account", async () => {
        const storage = await freshStorage("timely-probe-request");
        const seenUrls: string[] = [];
        const seenCookies: (string | null)[] = [];
        stubFetch(async (input, init) => {
            seenUrls.push(String(input));
            seenCookies.push(new Headers(init?.headers).get("Cookie"));
            return new Response("[]", { status: 200 });
        });

        await probeAndSaveCookie({ storage, accountId: 558481, cookie: "_memory_session=live" });

        expect(seenUrls).toHaveLength(1);
        expect(seenUrls[0]).toContain("https://app.timelyapp.com/558481/suggested_entries.json");
        expect(seenCookies).toEqual(["_memory_session=live"]);
    });
});

import { afterEach, describe, expect, test } from "bun:test";
import { TimelyHttpError } from "@app/timely/api/errors";
import { SafeJSON } from "@genesiscz/utils/json";
import { Storage } from "@genesiscz/utils/storage";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { saveCookie } from "./cookie";
import { fetchMemoriesForDates } from "./memories";

setupStorageSandbox();

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
    globalThis.fetch = impl as typeof fetch;
}

function fetchOptions(dates: string[], storage = new Storage("timely-memories-test")) {
    return {
        accountId: 558481,
        accessToken: "test-token",
        dates,
        storage,
        force: true,
    };
}

async function storageWithCookie(cookie: string): Promise<Storage> {
    const storage = new Storage("timely-memories-cookie-test");
    await storage.ensureDirs();
    await saveCookie(storage, cookie);
    return storage;
}

describe("fetchMemoriesForDates", () => {
    test("a 401 throws instead of reporting an empty day", async () => {
        stubFetch(async () => new Response('{"error":"Unauthorized"}', { status: 401 }));

        const promise = fetchMemoriesForDates(fetchOptions(["2026-07-24"]));

        await expect(promise).rejects.toThrow(TimelyHttpError);
        await expect(promise).rejects.toMatchObject({ status: 401, scope: "memories" });
    });

    test("the first 401 aborts the run instead of retrying every date", async () => {
        let calls = 0;
        stubFetch(async () => {
            calls++;
            return new Response('{"error":"Unauthorized"}', { status: 401 });
        });

        await expect(fetchMemoriesForDates(fetchOptions(["2026-07-22", "2026-07-23", "2026-07-24"]))).rejects.toThrow(
            TimelyHttpError
        );
        expect(calls).toBe(1);
    });

    test("a non-auth failure is counted and the remaining dates still return", async () => {
        stubFetch(async (input) => {
            if (String(input).includes("2026-07-22")) {
                return new Response("boom", { status: 500 });
            }

            return new Response(SafeJSON.stringify([{ id: 1 }]), { status: 200 });
        });

        const result = await fetchMemoriesForDates(fetchOptions(["2026-07-22", "2026-07-23"]));

        expect(result.stats.failed).toBe(1);
        expect(result.entries).toHaveLength(1);
        expect(result.byDate.get("2026-07-23")).toHaveLength(1);
    });

    // The failure this whole change exists to remove: a stale cookie is answered with a
    // bounce to sign-in, and following it produced a 200 page that read as "this day has
    // no memories". It has to surface as a refused session, on the first date.
    test("a sign-in redirect aborts the run as an auth failure instead of reporting empty days", async () => {
        let calls = 0;
        stubFetch(async () => {
            calls++;
            return new Response(null, { status: 302, headers: { location: "/login" } });
        });

        const promise = fetchMemoriesForDates(
            fetchOptions(["2026-07-22", "2026-07-23", "2026-07-24"], await storageWithCookie("_memory_session=stale"))
        );

        await expect(promise).rejects.toThrow(TimelyHttpError);
        await expect(promise).rejects.toMatchObject({ status: 302, scope: "memories", usedCookie: true });
        expect(calls).toBe(1);
    });

    test("a genuinely empty day stays empty and does not fail", async () => {
        stubFetch(async () => new Response("[]", { status: 200 }));

        const result = await fetchMemoriesForDates(fetchOptions(["2026-07-24"]));

        expect(result.entries).toEqual([]);
        expect(result.stats.failed).toBe(0);
    });

    test("a stored cookie is sent as the Cookie header", async () => {
        const sent: (string | null)[] = [];
        stubFetch(async (_input, init) => {
            sent.push(new Headers(init?.headers).get("Cookie"));
            return new Response("[]", { status: 200 });
        });

        await fetchMemoriesForDates(fetchOptions(["2026-07-24"], await storageWithCookie("_memory_session=abc")));

        expect(sent).toEqual(["_memory_session=abc"]);
    });

    test("a 401 with a stored cookie is flagged as a cookie failure", async () => {
        stubFetch(async () => new Response('{"error":"Unauthorized"}', { status: 401 }));

        const promise = fetchMemoriesForDates(
            fetchOptions(["2026-07-24"], await storageWithCookie("_memory_session=stale"))
        );

        await expect(promise).rejects.toMatchObject({ status: 401, scope: "memories", usedCookie: true });
    });

    test("a 401 without a stored cookie is not flagged as a cookie failure", async () => {
        stubFetch(async () => new Response('{"error":"Unauthorized"}', { status: 401 }));

        const promise = fetchMemoriesForDates(fetchOptions(["2026-07-24"]));

        await expect(promise).rejects.toMatchObject({ usedCookie: false });
    });
});

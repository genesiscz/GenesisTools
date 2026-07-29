import { afterEach, describe, expect, test } from "bun:test";
import { readStoredCookie } from "@app/timely/utils/cookie";
import { Storage } from "@genesiscz/utils/storage";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { probeAndSaveCookie } from "./cookie-probe";

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

        expect(outcome).toEqual({ status: "rejected", httpStatus: 401 });
        expect(await readStoredCookie(storage)).toBeUndefined();
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

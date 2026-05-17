import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { KosikAuthClient } from "@app/shops/api/shops/KosikAuthClient";

let originalFetch: typeof fetch;

beforeEach(() => {
    originalFetch = globalThis.fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("KosikAuthClient", () => {
    it("constructor requires sessionCookie", () => {
        expect(() => new KosikAuthClient({ sessionCookie: "" })).toThrow(/sessionCookie/);
    });

    it("getProfile returns the parsed client envelope", async () => {
        const captured: { cookie: string | null } = { cookie: null };
        globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
            const headers = new Headers(init?.headers as HeadersInit);
            captured.cookie = headers.get("Cookie");
            return new Response('{"client":{"id":1,"name":"M","surname":"F","email":"a@b"},"ordersCount":2}', {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as unknown as typeof fetch;

        const client = new KosikAuthClient({ sessionCookie: "sid=ABC" });
        const profile = await client.getProfile();
        expect(profile.client.email).toBe("a@b");
        expect(captured.cookie).toBe("sid=ABC");
    });

    it("listOrders fetches the order-list with limit/offset", async () => {
        const captured: { url: string } = { url: "" };
        globalThis.fetch = mock(async (url: string | URL | Request) => {
            captured.url = String(url);
            return new Response(
                '{"orders":[{"id":42,"orderedAt":"2026-05-01T00:00:00Z","total":100}],"totalNumberOfOrders":1}',
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }
            );
        }) as unknown as typeof fetch;

        const client = new KosikAuthClient({ sessionCookie: "sid=X" });
        const list = await client.listOrders({ limit: 5, offset: 0 });
        expect(captured.url).toContain("/api/front/profile/order-list?limit=5&showArchived=true&offset=0");
        expect(list.orders[0].id).toBe(42);
    });

    it("getProfile throws on 401", async () => {
        globalThis.fetch = mock(
            async () =>
                new Response('{"status":401}', {
                    status: 401,
                    headers: { "content-type": "application/json" },
                })
        ) as unknown as typeof fetch;
        const client = new KosikAuthClient({ sessionCookie: "sid=BAD" });
        await expect(client.getProfile()).rejects.toThrow();
    });
});

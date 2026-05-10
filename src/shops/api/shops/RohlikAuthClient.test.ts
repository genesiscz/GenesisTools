import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { RohlikAuthClient } from "@app/shops/api/shops/RohlikAuthClient";

let originalFetch: typeof fetch;

beforeEach(() => {
    originalFetch = globalThis.fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("RohlikAuthClient", () => {
    it("login posts {email,password} and stores returned cookie", async () => {
        const seenCalls: { url: string; init?: RequestInit }[] = [];
        globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
            seenCalls.push({ url: String(url), init });
            return new Response('{"data":{"user":{"email":"a@b"}}}', {
                status: 200,
                headers: {
                    "set-cookie": "JSESSIONID=ABC; Path=/; HttpOnly",
                    "content-type": "application/json",
                },
            });
        }) as unknown as typeof fetch;

        const client = new RohlikAuthClient();
        await client.login("a@b", "secret");
        expect(seenCalls[0].url).toContain("/services/frontend-service/login");
        const body = String(seenCalls[0].init?.body ?? "");
        expect(body).toContain('"email":"a@b"');
        expect(body).toContain('"password":"secret"');
        expect(client.getSessionCookie()).toContain("JSESSIONID=ABC");
    });

    it("constructor accepts a saved sessionCookie and sends it as Cookie header", async () => {
        const captured: { cookie: string | null } = { cookie: null };
        globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
            const headers = new Headers(init?.headers as HeadersInit);
            captured.cookie = headers.get("Cookie");
            return new Response('{"id":1,"email":"a@b"}', {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as unknown as typeof fetch;

        const client = new RohlikAuthClient({ sessionCookie: "JSESSIONID=XYZ" });
        await client.getProfile();
        expect(captured.cookie).toBe("JSESSIONID=XYZ");
    });

    it("listOrders returns parsed array; getOrderDetail returns items[]", async () => {
        const calls: string[] = [];
        globalThis.fetch = mock(async (url: string | URL | Request) => {
            calls.push(String(url));
            if (String(url).includes("/api/v3/orders/delivered")) {
                return new Response(
                    '[{"id":111,"itemsCount":2,"orderTime":"2026-05-08T15:31:04+0200","priceComposition":{"total":{"amount":12,"currency":"CZK"}}}]',
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }
                );
            }

            if (String(url).includes("/api/v3/orders/111")) {
                return new Response(
                    '{"id":111,"items":[{"id":717957,"name":"Kaiserka","unit":"g","textualAmount":"55 g","amount":5,"priceComposition":{"total":{"amount":24.5,"currency":"CZK"},"unit":{"amount":4.9,"currency":"CZK"}}}]}',
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }
                );
            }

            return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch;

        const client = new RohlikAuthClient({ sessionCookie: "JSESSIONID=X" });
        const list = await client.listOrders({ limit: 1, offset: 0 });
        expect(list[0].id).toBe(111);
        const detail = await client.getOrderDetail(111);
        expect(detail.items.length).toBe(1);
        expect(detail.items[0].id).toBe(717957);
    });

    it("getProfile throws on 401", async () => {
        globalThis.fetch = mock(
            async () =>
                new Response('{"error":"unauthorized"}', {
                    status: 401,
                    headers: { "content-type": "application/json" },
                })
        ) as unknown as typeof fetch;
        const client = new RohlikAuthClient({ sessionCookie: "JSESSIONID=BAD" });
        await expect(client.getProfile()).rejects.toThrow();
    });
});

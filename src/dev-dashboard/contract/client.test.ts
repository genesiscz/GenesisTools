import { describe, expect, it } from "bun:test";
import { createDashboardClient, type EventSourceLike } from "@app/dev-dashboard/contract/client";

describe("createDashboardClient", () => {
    it("GETs pulse with the auth header and parses JSON", async () => {
        let sentAuth: string | undefined;
        const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            sentAuth = headers.Authorization;

            return new Response('{"cpuPct":12,"capturedAt":"t"}', {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as unknown as typeof fetch;

        const client = createDashboardClient({ baseUrl: "http://h", fetch: fetchImpl, authHeader: () => "Basic xyz" });
        const pulse = await client.system.pulse();

        expect(pulse.cpuPct).toBe(12);
        expect(sentAuth).toBe("Basic xyz");
    });

    it("throws on a non-ok response with the status + body", async () => {
        const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
        const client = createDashboardClient({ baseUrl: "http://h", fetch: fetchImpl });

        await expect(client.system.pulse()).rejects.toThrow(/500/);
    });

    it("presets.* hit the right paths/methods and parse JSON", async () => {
        const calls: Array<{ url: string; method: string; body: string }> = [];
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({
                url: String(url),
                method: init?.method ?? "GET",
                body: typeof init?.body === "string" ? init.body : "",
            });

            return new Response('{"presets":[],"preset":null,"result":null,"removed":true}', {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as unknown as typeof fetch;

        const client = createDashboardClient({ baseUrl: "http://h", fetch: fetchImpl });

        await client.presets.list();
        await client.presets.save({ name: "x", note: "n" });
        await client.presets.restore("x");
        await client.presets.remove("x");

        expect(calls[0]).toMatchObject({ url: "http://h/api/tmux/presets", method: "GET" });
        expect(calls[1]).toMatchObject({ url: "http://h/api/tmux/presets/save", method: "POST" });
        expect(calls[1]?.body).toContain('"name":"x"');
        expect(calls[2]).toMatchObject({ url: "http://h/api/tmux/presets/restore", method: "POST" });
        expect(calls[2]?.body).toContain('"name":"x"');
        expect(calls[3]).toMatchObject({ url: "http://h/api/tmux/presets", method: "DELETE" });
        expect(calls[3]?.body).toContain('"name":"x"');
    });

    it("qa.subscribe uses the injected EventSource factory and parses entries", () => {
        const urls: string[] = [];
        const source: EventSourceLike = { close: () => {}, onmessage: null, onerror: null };
        const factory = (url: string): EventSourceLike => {
            urls.push(url);

            return source;
        };
        const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
        const client = createDashboardClient({ baseUrl: "http://h", fetch: fetchImpl, eventSourceFactory: factory });

        const received: string[] = [];
        const sub = client.qa.subscribe((entry) => received.push((entry as unknown as { id: string }).id));

        expect(urls[0]).toContain("/api/qa/stream");
        source.onmessage?.({ data: '{"id":"e1"}' });
        expect(received).toEqual(["e1"]);
        sub.close();
    });

    it("buildLog.subscribe builds the tail URL with the logFile and parses classified entries", () => {
        const urls: string[] = [];
        const source: EventSourceLike = { close: () => {}, onmessage: null, onerror: null };
        const factory = (url: string): EventSourceLike => {
            urls.push(url);

            return source;
        };
        const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
        const client = createDashboardClient({ baseUrl: "http://h", fetch: fetchImpl, eventSourceFactory: factory });

        const received: string[] = [];
        const sub = client.buildLog.subscribe("sync/2026-06-02.jsonl", (e) => received.push(e.cls));

        expect(urls[0]).toContain("/api/daemon/runs/tail");
        expect(urls[0]).toContain("logFile=sync");
        source.onmessage?.({ data: '{"type":"stderr","ts":"t","data":"boom","cls":"error"}' });
        expect(received).toEqual(["error"]);
        sub.close();
    });
});

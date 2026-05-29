import { afterEach, describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("dashboard api fetch (eval2 bug #9)", () => {
    it("passes AbortSignal.timeout to fetch", async () => {
        let capturedSignal: AbortSignal | null | undefined;

        globalThis.fetch = ((_url: string, init?: RequestInit) => {
            capturedSignal = init?.signal ?? null;
            return Promise.resolve(
                new Response(SafeJSON.stringify({ sessions: [] }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                })
            );
        }) as typeof fetch;

        const { api } = await import("@app/debugging-master/dashboard/lib/api");
        await api.listSessions();

        expect(capturedSignal).toBeDefined();
        expect(capturedSignal?.aborted).toBe(false);
    });
});

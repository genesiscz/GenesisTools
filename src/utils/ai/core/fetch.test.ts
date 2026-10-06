import { describe, expect, test } from "bun:test";
import { composeAuthFetch } from "./fetch";

interface Attempt {
    authorization: string | null;
    accept: string | null;
}

/** A transport that replays a programmed list of statuses and records every call. */
function fakeFetch(statuses: Array<number | { status: number; retryAfter: string }>) {
    const attempts: Attempt[] = [];

    const transport = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        attempts.push({ authorization: headers.get("authorization"), accept: headers.get("accept") });

        const next = statuses[attempts.length - 1] ?? statuses.at(-1) ?? 200;
        const status = typeof next === "number" ? next : next.status;
        const responseHeaders = typeof next === "number" ? undefined : { "retry-after": next.retryAfter };

        return new Response(`body-${attempts.length}`, { status, headers: responseHeaders });
    }) as typeof fetch;

    return { transport, attempts };
}

const FAST = { baseDelayMs: 1, maxDelayMs: 5 };

describe("composeAuthFetch — bearer injection", () => {
    test("injects the token from getToken on every attempt", async () => {
        const { transport, attempts } = fakeFetch([200]);
        const authed = composeAuthFetch({ getToken: async () => "tok-1", fetch: transport });

        const response = await authed("https://example.invalid/v1/messages");

        expect(response.status).toBe(200);
        expect(attempts).toEqual([{ authorization: "Bearer tok-1", accept: null }]);
    });

    test("preserves the caller's other headers", async () => {
        const { transport, attempts } = fakeFetch([200]);
        const authed = composeAuthFetch({ getToken: async () => "tok-1", fetch: transport });

        await authed("https://example.invalid/v1/messages", { headers: { accept: "text/event-stream" } });

        expect(attempts[0].accept).toBe("text/event-stream");
    });

    test("re-resolves the token per request, so a rotation is picked up", async () => {
        const tokens = ["tok-1", "tok-2"];
        const { transport, attempts } = fakeFetch([200]);
        const authed = composeAuthFetch({ getToken: async () => tokens.shift() ?? "spent", fetch: transport });

        await authed("https://example.invalid/v1/messages");
        await authed("https://example.invalid/v1/messages");

        expect(attempts.map((a) => a.authorization)).toEqual(["Bearer tok-1", "Bearer tok-2"]);
    });
});

describe("composeAuthFetch — 401 refresh", () => {
    test("a 401 triggers exactly one refresh and one retry", async () => {
        const { transport, attempts } = fakeFetch([401, 200]);
        let refreshes = 0;

        const authed = composeAuthFetch({
            getToken: async () => "stale",
            refresh: async () => {
                refreshes++;
                return "fresh";
            },
            fetch: transport,
        });

        const response = await authed("https://example.invalid/v1/messages");

        expect(response.status).toBe(200);
        expect(refreshes).toBe(1);
        expect(attempts.map((a) => a.authorization)).toEqual(["Bearer stale", "Bearer fresh"]);
    });

    test("a second 401 is returned rather than looped on", async () => {
        const { transport, attempts } = fakeFetch([401, 401]);
        const authed = composeAuthFetch({
            getToken: async () => "stale",
            refresh: async () => "also-stale",
            fetch: transport,
        });

        const response = await authed("https://example.invalid/v1/messages");

        expect(response.status).toBe(401);
        expect(attempts).toHaveLength(2);
    });

    test("without a refresh callback a 401 is returned untouched", async () => {
        const { transport, attempts } = fakeFetch([401]);
        const authed = composeAuthFetch({ getToken: async () => "stale", fetch: transport });

        const response = await authed("https://example.invalid/v1/messages");

        expect(response.status).toBe(401);
        expect(attempts).toHaveLength(1);
    });
});

describe("composeAuthFetch — retry policy", () => {
    test("does NOT retry by default, because the ai-sdk already retries the call", async () => {
        const { transport, attempts } = fakeFetch([429, 200]);
        const authed = composeAuthFetch({ getToken: async () => "tok", fetch: transport });

        const response = await authed("https://example.invalid/v1/messages");

        expect(response.status).toBe(429);
        expect(attempts).toHaveLength(1);
    });

    test("retries a 429 when asked, then returns the success", async () => {
        const { transport, attempts } = fakeFetch([429, 429, 200]);
        const authed = composeAuthFetch({ getToken: async () => "tok", fetch: transport, maxRetries: 3, ...FAST });

        const response = await authed("https://example.invalid/v1/messages");

        expect(response.status).toBe(200);
        expect(attempts).toHaveLength(3);
    });

    test("retries a 500", async () => {
        const { transport, attempts } = fakeFetch([503, 200]);
        const authed = composeAuthFetch({ getToken: async () => "tok", fetch: transport, maxRetries: 2, ...FAST });

        expect((await authed("https://example.invalid/v1/messages")).status).toBe(200);
        expect(attempts).toHaveLength(2);
    });

    test("gives up after maxRetries and returns the last response", async () => {
        const { transport, attempts } = fakeFetch([429]);
        const authed = composeAuthFetch({ getToken: async () => "tok", fetch: transport, maxRetries: 2, ...FAST });

        const response = await authed("https://example.invalid/v1/messages");

        expect(response.status).toBe(429);
        expect(attempts).toHaveLength(3);
    });

    test("does NOT retry a 400 — a bad request stays bad", async () => {
        const { transport, attempts } = fakeFetch([400, 200]);
        const authed = composeAuthFetch({ getToken: async () => "tok", fetch: transport, maxRetries: 3, ...FAST });

        const response = await authed("https://example.invalid/v1/messages");

        expect(response.status).toBe(400);
        expect(attempts).toHaveLength(1);
    });

    test("honors Retry-After over the exponential schedule", async () => {
        const { transport, attempts } = fakeFetch([{ status: 429, retryAfter: "0" }, 200]);
        const authed = composeAuthFetch({
            getToken: async () => "tok",
            fetch: transport,
            maxRetries: 2,
            baseDelayMs: 10_000,
            maxDelayMs: 20_000,
        });

        const started = performance.now();
        const response = await authed("https://example.invalid/v1/messages");

        expect(response.status).toBe(200);
        expect(attempts).toHaveLength(2);
        // Retry-After: 0 must beat the 10s base delay, or this test would hang.
        expect(performance.now() - started).toBeLessThan(1000);
    });

    test("an aborted caller stops the backoff instead of sleeping it out", async () => {
        const { transport } = fakeFetch([429]);
        const authed = composeAuthFetch({
            getToken: async () => "tok",
            fetch: transport,
            maxRetries: 5,
            baseDelayMs: 50_000,
            maxDelayMs: 50_000,
        });

        const controller = new AbortController();
        const pending = authed("https://example.invalid/v1/messages", { signal: controller.signal });
        controller.abort();

        expect(pending).rejects.toThrow();
    });
});

describe("composeAuthFetch — refresh and retry together", () => {
    /**
     * The two policies used to be tested only in isolation, and they interact:
     * the refresh branch lives inside the retry loop, so a retryable status
     * between two 401s produced a SECOND refresh. A subscription refresh token is
     * single-use, so that second call spends the grant the first one replaced.
     */
    test("refreshes at most once even when a retry brings back another 401", async () => {
        const { transport, attempts } = fakeFetch([401, 500, 401, 200]);
        const issued: string[] = [];

        const authed = composeAuthFetch({
            getToken: async () => "stale",
            refresh: async () => {
                const token = `fresh-${issued.length + 1}`;
                issued.push(token);
                return token;
            },
            fetch: transport,
            maxRetries: 3,
            ...FAST,
        });

        const response = await authed("https://example.invalid/v1/messages");

        expect(issued).toEqual(["fresh-1"]);
        // Attempt 3 is the retry after the 500. It carries the stale token again
        // because getToken is the source of truth, it comes back 401, and 401 is
        // not retryable, so the caller is handed that 401 rather than having a
        // second grant spent behind its back.
        expect(attempts.map((a) => a.authorization)).toEqual(["Bearer stale", "Bearer fresh-1", "Bearer stale"]);
        expect(response.status).toBe(401);
    });
});

describe("composeAuthFetch — cancellation boundaries", () => {
    test("a pre-aborted request never resolves a token or refreshes a credential", async () => {
        const controller = new AbortController();
        const touched: string[] = [];
        controller.abort(new Error("cancelled"));
        const authed = composeAuthFetch({
            getToken: async () => {
                touched.push("token");
                throw new Error("must not resolve a token");
            },
            refresh: async () => {
                touched.push("refresh");
                throw new Error("must not rotate");
            },
            fetch: (async () => {
                touched.push("transport");
                throw new Error("must not send");
            }) as unknown as typeof fetch,
        });

        await expect(
            authed(
                new Request("https://example.invalid", {
                    signal: controller.signal,
                })
            )
        ).rejects.toThrow("cancelled");
        expect(touched).toEqual([]);
    });

    test("cancellation while resolving a token prevents the send", async () => {
        const controller = new AbortController();
        const { transport, attempts } = fakeFetch([200]);
        const authed = composeAuthFetch({
            getToken: async () => {
                controller.abort(new Error("token cancelled"));
                return "token";
            },
            fetch: transport,
        });

        await expect(
            authed("https://example.invalid", {
                signal: controller.signal,
            })
        ).rejects.toThrow("token cancelled");
        expect(attempts).toHaveLength(0);
    });

    test("an aborted 401 response cannot start a refresh", async () => {
        const controller = new AbortController();
        let refreshes = 0;
        const response = new Response("rejected", { status: 401 });
        const authed = composeAuthFetch({
            getToken: async () => "stale",
            refresh: async () => {
                refreshes++;
                throw new Error("must not rotate");
            },
            fetch: (async () => {
                controller.abort(new Error("request cancelled"));
                return response;
            }) as unknown as typeof fetch,
        });

        await expect(
            authed("https://example.invalid", {
                signal: controller.signal,
            })
        ).rejects.toThrow("request cancelled");
        expect(refreshes).toBe(0);
        expect(response.bodyUsed).toBe(true);
    });

    test("cancellation during an already-started refresh prevents a resend", async () => {
        const controller = new AbortController();
        const { transport, attempts } = fakeFetch([401, 200]);
        let refreshes = 0;
        const authed = composeAuthFetch({
            getToken: async () => "stale",
            refresh: async () => {
                refreshes++;
                controller.abort(new Error("refresh cancelled"));
                return "fresh";
            },
            fetch: transport,
        });

        await expect(
            authed("https://example.invalid", {
                signal: controller.signal,
            })
        ).rejects.toThrow("refresh cancelled");
        expect(refreshes).toBe(1);
        expect(attempts).toHaveLength(1);
    });

    test("uses a Request signal to stop retry backoff", async () => {
        const controller = new AbortController();
        let sends = 0;
        const authed = composeAuthFetch({
            getToken: async () => "token",
            fetch: (async () => {
                sends++;

                return new Response(
                    new ReadableStream({
                        cancel() {
                            controller.abort(new Error("backoff cancelled"));
                        },
                    }),
                    { status: 429 }
                );
            }) as unknown as typeof fetch,
            maxRetries: 3,
            baseDelayMs: 50_000,
        });

        await expect(
            authed(
                new Request("https://example.invalid", {
                    signal: controller.signal,
                })
            )
        ).rejects.toThrow("backoff cancelled");
        expect(sends).toBe(1);
    });

    test("discards a late refresh response after cancellation", async () => {
        const controller = new AbortController();
        let sends = 0;
        const late = new Response("late", { status: 200 });
        const authed = composeAuthFetch({
            getToken: async () => "stale",
            refresh: async () => "fresh",
            fetch: (async () => {
                sends++;

                if (sends === 1) {
                    return new Response("expired", { status: 401 });
                }

                controller.abort(new Error("late response"));
                return late;
            }) as unknown as typeof fetch,
        });

        await expect(
            authed("https://example.invalid", {
                signal: controller.signal,
            })
        ).rejects.toThrow("late response");
        expect(sends).toBe(2);
        expect(late.bodyUsed).toBe(true);
    });

    test("preserves headers on Request inputs when injecting authorization", async () => {
        const { transport, attempts } = fakeFetch([200]);
        const authed = composeAuthFetch({ getToken: async () => "token", fetch: transport });

        await authed(
            new Request("https://example.invalid", {
                headers: { accept: "application/json" },
            })
        );

        expect(attempts).toEqual([{ authorization: "Bearer token", accept: "application/json" }]);
    });
});

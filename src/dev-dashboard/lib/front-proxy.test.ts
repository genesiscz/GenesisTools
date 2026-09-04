import { describe, expect, test } from "bun:test";
import type { DashboardAuthProvision } from "@app/dev-dashboard/config";
import {
    createBasicAuthCredentials,
    issueSessionToken,
    LOCAL_ORIGIN_HEADER,
    makeBasicAuthHeader,
} from "@app/dev-dashboard/lib/auth";
import {
    classifyUpstreamFailure,
    decideProxyAuth,
    fetchProxiedUpstream,
    isLongLivedProxiedStream,
    isLoopbackOnlyOrigin,
    isResponseRetryableMethod,
    proxyFailureLogLevel,
    SCAN_UPSTREAM_TIMEOUT_MS,
    SLOW_UPSTREAM_TIMEOUT_MS,
    UPSTREAM_TIMEOUT_MS,
    UpstreamRetriesExhausted,
    upstreamTimeoutMs,
} from "@app/dev-dashboard/lib/front-proxy";
import { createDashboardRouter } from "@app/dev-dashboard/server/registry";
import { RELOAD_PATH } from "@genesiscz/utils/DashboardApp/preview/reload";

// Security regression net for the ttyd/WS auth gate. The front-proxy serves
// /ttyd/* and every WS upgrade BEFORE the Vite auth middleware, so this gate is
// the only thing between LAN/tunnel and a writable shell. If any of this code
// changes, these tests must still hold or the bypass is back.

function reqWith(headers: Record<string, string>): Request {
    return new Request("http://dev-dashboard.test/ttyd/x/", { headers });
}

const { auth, password } = createBasicAuthCredentials({ username: "martin", password: "s3cret" });
const provision: DashboardAuthProvision = { auth, generatedPassword: null };

describe("isLoopbackOnlyOrigin — locality comes from socket + Host only", () => {
    test("genuine loopback hits are local", () => {
        expect(isLoopbackOnlyOrigin(reqWith({ host: "localhost:3042" }), "127.0.0.1")).toBe(true);
        expect(isLoopbackOnlyOrigin(reqWith({ host: "[::1]:3042" }), "::1")).toBe(true);
        expect(isLoopbackOnlyOrigin(reqWith({ host: "127.0.0.1" }), "::ffff:127.0.0.1")).toBe(true);
    });

    test("non-loopback socket is never local, whatever the Host says", () => {
        expect(isLoopbackOnlyOrigin(reqWith({ host: "localhost:3042" }), "192.168.0.15")).toBe(false);
        expect(isLoopbackOnlyOrigin(reqWith({ host: "127.0.0.1" }), "10.0.0.2")).toBe(false);
        expect(isLoopbackOnlyOrigin(reqWith({ host: "localhost" }), undefined)).toBe(false);
    });

    test("Cloudflare/forwarded edge headers exclude the tunnel even from loopback", () => {
        for (const h of ["cf-ray", "cf-connecting-ip", "cf-visitor", "cdn-loop", "x-forwarded-for"]) {
            expect(isLoopbackOnlyOrigin(reqWith({ host: "localhost", [h]: "v" }), "127.0.0.1")).toBe(false);
        }
    });

    test("non-localhost Host from loopback (tunnel/LAN names) is not local", () => {
        expect(isLoopbackOnlyOrigin(reqWith({ host: "myhost.example.com" }), "127.0.0.1")).toBe(false);
        expect(isLoopbackOnlyOrigin(reqWith({ host: "192.168.0.15:3042" }), "127.0.0.1")).toBe(false);
        expect(isLoopbackOnlyOrigin(reqWith({ host: "evil.example" }), "127.0.0.1")).toBe(false);
    });

    test("an inbound x-dd-local-origin header NEVER confers locality (anti-spoof)", () => {
        expect(
            isLoopbackOnlyOrigin(reqWith({ host: "192.168.0.15", [LOCAL_ORIGIN_HEADER]: "1" }), "192.168.0.15")
        ).toBe(false);
    });
});

describe("decideProxyAuth — the ttyd/WS gate matrix", () => {
    test("loopback origin is allowed with no credentials", () => {
        expect(decideProxyAuth({ req: reqWith({}), isLocal: true, provision })).toBe("allow");
    });

    test("remote (LAN/tunnel) with no credentials is denied", () => {
        expect(decideProxyAuth({ req: reqWith({}), isLocal: false, provision })).toBe("deny");
    });

    test("a forged x-dd-local-origin header does NOT bypass the proxy gate", () => {
        expect(decideProxyAuth({ req: reqWith({ [LOCAL_ORIGIN_HEADER]: "1" }), isLocal: false, provision })).toBe(
            "deny"
        );
    });

    test("valid Basic auth is allowed remotely", () => {
        const req = reqWith({ authorization: makeBasicAuthHeader({ username: "martin", password }) });
        expect(decideProxyAuth({ req, isLocal: false, provision })).toBe("allow");
    });

    test("wrong Basic auth is denied", () => {
        const req = reqWith({ authorization: makeBasicAuthHeader({ username: "martin", password: "nope" }) });
        expect(decideProxyAuth({ req, isLocal: false, provision })).toBe("deny");
    });

    test("a valid session cookie is allowed remotely", () => {
        const req = reqWith({ cookie: `dd_session=${issueSessionToken(auth)}` });
        expect(decideProxyAuth({ req, isLocal: false, provision })).toBe("allow");
    });

    test("a tampered session cookie is denied", () => {
        const req = reqWith({ cookie: `dd_session=${issueSessionToken(auth)}TAMPER` });
        expect(decideProxyAuth({ req, isLocal: false, provision })).toBe("deny");
    });

    test("a future-dated session cookie is denied", () => {
        const realNow = Date.now;
        Date.now = () => realNow() + 60_000;
        const futureToken = issueSessionToken(auth);
        Date.now = realNow;

        const req = reqWith({ cookie: `dd_session=${futureToken}` });
        expect(decideProxyAuth({ req, isLocal: false, provision })).toBe("deny");
    });

    test("auth disabled by config allows everything", () => {
        const disabled: DashboardAuthProvision = {
            auth: { enabled: false, username: "martin" },
            generatedPassword: null,
        };
        expect(decideProxyAuth({ req: reqWith({}), isLocal: false, provision: disabled })).toBe("allow");
    });

    test("incomplete auth config reports unconfigured (deny-equivalent → 503)", () => {
        const incomplete: DashboardAuthProvision = {
            auth: { enabled: true, username: "martin" },
            generatedPassword: null,
        };
        expect(decideProxyAuth({ req: reqWith({}), isLocal: false, provision: incomplete })).toBe("unconfigured");
    });
});

describe("LOCAL_ORIGIN_HEADER invariant", () => {
    test("is the exact lowercased name both proxy and middleware rely on", () => {
        // A careless rename here is exactly the desync that turns the loopback
        // trust into a fail-open auth bypass — pin the value.
        expect(LOCAL_ORIGIN_HEADER).toBe("x-dd-local-origin");
        expect(LOCAL_ORIGIN_HEADER).toBe(LOCAL_ORIGIN_HEADER.toLowerCase());
    });
});

describe("isLongLivedProxiedStream", () => {
    test("matches QA SSE, boards work/wait, and any board's SSE stream", () => {
        expect(isLongLivedProxiedStream("/api/qa/stream")).toBe(true);
        expect(isLongLivedProxiedStream("/api/qa/log")).toBe(false);
        expect(isLongLivedProxiedStream("/api/boards/work/wait")).toBe(true);
        expect(isLongLivedProxiedStream("/api/boards/my-board/events")).toBe(true);
        expect(isLongLivedProxiedStream("/api/boards/my-board")).toBe(false);
        expect(isLongLivedProxiedStream("/api/ports/classify")).toBe(true);
        expect(isLongLivedProxiedStream("/api/live")).toBe(true);
        expect(isLongLivedProxiedStream("/api/ports")).toBe(false);
    });

    test("every longLived route in the router is exempt, and so is the preview reload stream", () => {
        // The list used to be restated by hand and had drifted: the daemon run
        // tail and the preview reload EventSource were killed every 15 s by
        // AbortSignal.timeout, mid-stream.
        const longLived = createDashboardRouter()
            .list()
            .filter((def) => def.longLived);

        expect(longLived.length).toBeGreaterThanOrEqual(6);

        const missing = longLived
            .map((def) => def.pattern.replace(/:[^/]+/g, "sample"))
            .filter((probe) => !isLongLivedProxiedStream(probe));

        expect(missing).toEqual([]);
        expect(isLongLivedProxiedStream(RELOAD_PATH)).toBe(true);
    });
});

// Every path named here timed out against the 15s deadline in
// ~/.genesis-tools/logs/dev-dashboard.bg.log and became a public 502.
describe("upstreamTimeoutMs — four tiers, not two", () => {
    test("a stream has no deadline at all", () => {
        expect(upstreamTimeoutMs("/api/qa/stream")).toBeUndefined();
        expect(upstreamTimeoutMs("/api/live")).toBeUndefined();
        expect(upstreamTimeoutMs("/api/ports/classify")).toBeUndefined();
    });

    test("known-slow APIs keep a deadline, just a reachable one", () => {
        expect(upstreamTimeoutMs("/api/ports")).toBe(SLOW_UPSTREAM_TIMEOUT_MS);
        expect(upstreamTimeoutMs("/api/system/pulse")).toBe(SLOW_UPSTREAM_TIMEOUT_MS);
        expect(upstreamTimeoutMs("/api/system/pulse/history")).toBe(SLOW_UPSTREAM_TIMEOUT_MS);
        expect(upstreamTimeoutMs("/api/tmux/sessions")).toBe(SLOW_UPSTREAM_TIMEOUT_MS);
    });

    test("the transcript-scan routes get the longest deadline of the bounded tiers", () => {
        expect(upstreamTimeoutMs("/api/ai/spend/totals")).toBe(SCAN_UPSTREAM_TIMEOUT_MS);
        expect(upstreamTimeoutMs("/api/ai/spend/series")).toBe(SCAN_UPSTREAM_TIMEOUT_MS);
        expect(upstreamTimeoutMs("/api/claude/usage/totals")).toBe(SCAN_UPSTREAM_TIMEOUT_MS);
    });

    test("the neighbouring ai routes are fast and stay on the short default", () => {
        expect(upstreamTimeoutMs("/api/ai/usage")).toBe(UPSTREAM_TIMEOUT_MS);
        expect(upstreamTimeoutMs("/api/ai/usage/series")).toBe(UPSTREAM_TIMEOUT_MS);
        expect(upstreamTimeoutMs("/api/ai/daemon")).toBe(UPSTREAM_TIMEOUT_MS);
        expect(upstreamTimeoutMs("/api/ai/accounts")).toBe(UPSTREAM_TIMEOUT_MS);
    });

    test("everything else keeps the short default", () => {
        expect(upstreamTimeoutMs("/")).toBe(UPSTREAM_TIMEOUT_MS);
        expect(upstreamTimeoutMs("/share/KSW_CSKpwggf5mLz")).toBe(UPSTREAM_TIMEOUT_MS);
        expect(upstreamTimeoutMs("/api/qa/log")).toBe(UPSTREAM_TIMEOUT_MS);
    });

    test("a slow API stays bounded — it must never become an unbounded stream", () => {
        expect(SLOW_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(UPSTREAM_TIMEOUT_MS);
        expect(Number.isFinite(SLOW_UPSTREAM_TIMEOUT_MS)).toBe(true);
    });

    test("a scan stays bounded too, and outlives the worker's own 60s budget", () => {
        expect(SCAN_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(SLOW_UPSTREAM_TIMEOUT_MS);
        expect(Number.isFinite(SCAN_UPSTREAM_TIMEOUT_MS)).toBe(true);
    });
});

describe("classifyUpstreamFailure — a 502 must name its cause", () => {
    test("an upstream that blew the deadline is a timeout, not a client abort", () => {
        // Both are DOMExceptions; only the name separates them, and 23k log lines
        // conflated the two before this split existed.
        const timeout = new DOMException("The operation timed out.", "TimeoutError");
        expect(classifyUpstreamFailure(timeout)).toBe("upstream-timeout");
    });

    test("a closed client connection is a client abort", () => {
        const abort = new DOMException("The connection was closed.", "AbortError");
        expect(classifyUpstreamFailure(abort)).toBe("client-abort");
    });

    test("both spellings of a refused connection are recognised", () => {
        expect(classifyUpstreamFailure(Object.assign(new Error("x"), { code: "ConnectionRefused" }))).toBe(
            "upstream-refused"
        );
        expect(classifyUpstreamFailure(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(
            "upstream-refused"
        );
    });

    test("an exhausted retry budget reports its own reason and count", () => {
        const err = new UpstreamRetriesExhausted(10);
        expect(classifyUpstreamFailure(err)).toBe("retries-exhausted");
        expect(err.attempts).toBe(10);
    });

    test("anything else is an unclassified upstream error", () => {
        expect(classifyUpstreamFailure(new Error("boom"))).toBe("upstream-error");
        expect(classifyUpstreamFailure(undefined)).toBe("upstream-error");
    });

    test("only the two benign causes are demoted below warn", () => {
        expect(proxyFailureLogLevel("client-abort")).toBe("debug");
        expect(proxyFailureLogLevel("upstream-refused")).toBe("debug");
        expect(proxyFailureLogLevel("upstream-timeout")).toBe("warn");
        expect(proxyFailureLogLevel("retries-exhausted")).toBe("warn");
        expect(proxyFailureLogLevel("upstream-error")).toBe("warn");
        expect(proxyFailureLogLevel("ttyd-missing")).toBe("warn");
    });
});

describe("fetchProxiedUpstream — retry accounting", () => {
    test("a first-try success reports one attempt", async () => {
        const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });

        try {
            const stats = { attempts: 0 };
            const res = await fetchProxiedUpstream(new Request(server.url), UPSTREAM_TIMEOUT_MS, stats);
            expect(res.status).toBe(200);
            expect(stats.attempts).toBe(1);
        } finally {
            server.stop(true);
        }
    });

    test("only side-effect-free methods may replay a 5xx response", () => {
        expect(isResponseRetryableMethod("GET")).toBe(true);
        expect(isResponseRetryableMethod("head")).toBe(true);
        expect(isResponseRetryableMethod("OPTIONS")).toBe(true);
        expect(isResponseRetryableMethod("POST")).toBe(false);
        expect(isResponseRetryableMethod("PUT")).toBe(false);
        expect(isResponseRetryableMethod("PATCH")).toBe(false);
        expect(isResponseRetryableMethod("DELETE")).toBe(false);
    });

    test("a GET body survives a 503 replay instead of failing with ERR_BODY_ALREADY_USED", async () => {
        // Attempt 2 used to re-fetch the SAME Request, so every request with a
        // body got one attempt and a 502 blaming `upstream-error`.
        let seen = 0;
        const server = Bun.serve({
            port: 0,
            fetch: () => {
                seen += 1;

                return seen === 1 ? new Response("retry me", { status: 503 }) : new Response("ok");
            },
        });

        try {
            const stats = { attempts: 0 };
            const res = await fetchProxiedUpstream(new Request(server.url), UPSTREAM_TIMEOUT_MS, stats);

            expect(res.status).toBe(200);
            expect(stats.attempts).toBe(2);
            expect(seen).toBe(2);
        } finally {
            server.stop(true);
        }
    });

    test("a POST is NOT replayed after a 503, because the handler already ran", async () => {
        // The handler answering 503 may have mutated state first, so replaying
        // the POST executed the mutation up to ten times.
        let seen = 0;
        const server = Bun.serve({
            port: 0,
            fetch: () => {
                seen += 1;

                return new Response("retry me", { status: 503 });
            },
        });

        try {
            const stats = { attempts: 0 };
            const forwarded = new Request(server.url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: '{"pid":123}',
            });
            const res = await fetchProxiedUpstream(forwarded, UPSTREAM_TIMEOUT_MS, stats);

            expect(res.status).toBe(503);
            expect(stats.attempts).toBe(1);
            expect(seen).toBe(1);
        } finally {
            server.stop(true);
        }
    });

    test("a POST body survives a connection-refused retry", async () => {
        // Nothing reached a handler, so this retry stays on for every method —
        // it is the make-before-break preview swap. The body must be replayable.
        const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
        const port = probe.port;
        probe.stop(true);

        const bodies: string[] = [];
        let late: ReturnType<typeof Bun.serve> | undefined;
        const timer = setTimeout(() => {
            late = Bun.serve({
                port,
                fetch: async (req) => {
                    bodies.push(await req.text());

                    return new Response("ok");
                },
            });
        }, 400);

        try {
            const stats = { attempts: 0 };
            const forwarded = new Request(`http://127.0.0.1:${port}/`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: '{"pid":123}',
            });
            const res = await fetchProxiedUpstream(forwarded, UPSTREAM_TIMEOUT_MS, stats);

            expect(res.status).toBe(200);
            expect(stats.attempts).toBeGreaterThan(1);
            expect(bodies).toEqual(['{"pid":123}']);
        } finally {
            clearTimeout(timer);
            late?.stop(true);
        }
    });

    test("a client abort cancels the upstream instead of running out the deadline", async () => {
        // AbortSignal.timeout replaced the client's own signal, so a closed tab
        // left a 60 s /api/ports rescan running to completion.
        let markAborted: () => void = () => {};
        const upstreamAborted = new Promise<void>((resolve) => {
            markAborted = resolve;
        });
        const server = Bun.serve({
            port: 0,
            fetch: (req) =>
                new Promise<Response>((resolve) => {
                    req.signal.addEventListener("abort", markAborted);
                    setTimeout(() => resolve(new Response("late")), 5_000);
                }),
        });

        try {
            const controller = new AbortController();
            const forwarded = new Request(server.url, { signal: controller.signal });
            const pending = fetchProxiedUpstream(forwarded, SLOW_UPSTREAM_TIMEOUT_MS).catch((e: unknown) => e);
            setTimeout(() => controller.abort(), 100);

            const started = Date.now();
            const err = await pending;

            expect(classifyUpstreamFailure(err)).toBe("client-abort");
            expect(Date.now() - started).toBeLessThan(2_000);
            // The upstream sees the abort a tick after the client rejects.
            const sawAbort = await Promise.race([upstreamAborted.then(() => true), Bun.sleep(1_000).then(() => false)]);
            expect(sawAbort).toBe(true);
        } finally {
            server.stop(true);
        }
    });

    test("a persistently refused upstream exhausts the budget and reports the count", async () => {
        const dead = await Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
        const port = dead.port;
        dead.stop(true);

        const stats = { attempts: 0 };
        const err = await fetchProxiedUpstream(new Request(`http://127.0.0.1:${port}/`), 2_000, stats).catch(
            (e: unknown) => e
        );

        expect(classifyUpstreamFailure(err)).toBe("upstream-refused");
        expect(stats.attempts).toBe(10);
    });
});

describe("fetchProxiedUpstream — body handling and discarded responses", () => {
    test("a 5xx replay cancels the response it throws away", async () => {
        // Nine unread responses per request during a preview restart storm kept
        // nine sockets checked out of the pool until GC.
        const served: Response[] = [];
        const original = globalThis.fetch;
        globalThis.fetch = (async (): Promise<Response> => {
            const response =
                served.length < 2 ? new Response("restarting", { status: 503 }) : new Response("ok", { status: 200 });
            served.push(response);

            return response;
        }) as unknown as typeof fetch;

        try {
            const res = await fetchProxiedUpstream(new Request("http://127.0.0.1:1/"), UPSTREAM_TIMEOUT_MS);

            expect(res.status).toBe(200);
            expect(served).toHaveLength(3);

            for (const discarded of served.slice(0, 2)) {
                expect(discarded.bodyUsed || discarded.body === null || discarded.body.locked).toBe(true);
            }
        } finally {
            globalThis.fetch = original;
        }
    });

    test("a body over the buffer cap streams through instead of being copied", async () => {
        // 9 MB, one byte over MAX_REPLAYABLE_BODY_BYTES: the upstream must see
        // every byte, and the proxy must not have held them all at once.
        const chunk = new Uint8Array(1024 * 1024).fill(65);
        let received = 0;
        const server = Bun.serve({
            port: 0,
            fetch: async (req) => {
                received = (await req.arrayBuffer()).byteLength;

                return new Response("ok");
            },
        });

        try {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    for (let i = 0; i < 9; i++) {
                        controller.enqueue(chunk);
                    }

                    controller.close();
                },
            });
            const forwarded = new Request(`http://127.0.0.1:${server.port}/`, {
                method: "POST",
                body,
                // @ts-expect-error duplex is required for a stream body and the DOM lib types omit it
                duplex: "half",
            });
            const res = await fetchProxiedUpstream(forwarded, UPSTREAM_TIMEOUT_MS);

            expect(res.status).toBe(200);
            expect(received).toBe(9 * 1024 * 1024);
        } finally {
            server.stop(true);
        }
    });
});

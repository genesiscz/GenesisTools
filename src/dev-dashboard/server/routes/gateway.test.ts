import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardClient } from "@app/dev-dashboard/contract/client";
import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import { createBasicAuthCredentials } from "@app/dev-dashboard/lib/auth";
import { routerToResponse } from "@app/dev-dashboard/server/adapters/bun-serve";
import { decideApiAuth, isActScopedRequest } from "@app/dev-dashboard/server/auth-guard";
import { Router } from "@app/dev-dashboard/server/router";
import type { RouteContext, RouteDef, RouteResult, RouteServices } from "@app/dev-dashboard/server/types";
import { CapabilityRefusedError, HUB_CAPABILITIES } from "@app/hub/lib/capabilities/index";
import { realProcsSources } from "@app/hub/lib/procs/sources";
import { realSignalOps } from "@app/hub/lib/procs/stop";
import { issueActTokens, memoryActTokenStore } from "@app/question/lib/act/tokens";
import type { DecisionRecord } from "@app/question/lib/decisions/store";
import { GATEWAY_ROWS, gatewayRoutes } from "./gateway";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

function ctx({
    method,
    pathname,
    query = {},
    headers = {},
    body,
    raw,
}: {
    method: "GET" | "POST";
    pathname: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: unknown;
    raw?: Uint8Array;
}): RouteContext {
    return {
        method,
        pathname,
        query: new URLSearchParams(query),
        params: {},
        headers,
        readJson: async <T>() => (body ?? {}) as T,
        readRawBody: async () => raw ?? new Uint8Array(),
        services: {} as RouteContext["services"],
    };
}

function route(defs: RouteDef[], method: string, pattern: string): RouteDef {
    const found = defs.find((def) => def.method === method && def.pattern === pattern);

    if (!found) {
        throw new Error(`no route ${method} ${pattern}`);
    }

    return found;
}

async function json(result: RouteResult | Promise<RouteResult>): Promise<{ status: number; body: unknown }> {
    const settled = await result;

    if (settled.kind !== "json") {
        throw new Error(`expected json, got ${settled.kind}`);
    }

    return { status: settled.status, body: settled.body };
}

describe("the Mac gateway", () => {
    it("serves every hub capability on its own row, and nothing else", () => {
        expect(Object.keys(GATEWAY_ROWS).sort()).toEqual(Object.keys(HUB_CAPABILITIES).sort());
        expect(Object.values(GATEWAY_ROWS).every((row) => row.method === "GET" && row.policy === "read")).toBe(true);
    });

    it("passes the query to the capability and maps its refusals to 400 and 404", async () => {
        const seen: { name: string; input: Readonly<Record<string, unknown>> }[] = [];
        const routes = gatewayRoutes({
            run: async (name, input) => {
                seen.push({ name, input });

                if (input.agent === "missing") {
                    throw new CapabilityRefusedError("not-found", "No agent missing in the window");
                }

                if (input.since === "soon") {
                    throw new CapabilityRefusedError("bad-input", "since: a duration");
                }

                return { ok: name };
            },
        });
        const agents = route(routes, "GET", "/api/gateway/agents");

        expect(
            await json(agents.handler(ctx({ method: "GET", pathname: "/api/gateway/agents", query: { since: "24h" } })))
        ).toEqual({ status: 200, body: { ok: "agents" } });
        expect(seen[0]).toEqual({ name: "agents", input: { since: "24h" } });
        expect(
            (
                await json(
                    agents.handler(ctx({ method: "GET", pathname: "/api/gateway/agents", query: { agent: "missing" } }))
                )
            ).status
        ).toBe(404);
        expect(
            (
                await json(
                    agents.handler(ctx({ method: "GET", pathname: "/api/gateway/agents", query: { since: "soon" } }))
                )
            ).status
        ).toBe(400);
    });

    it("answers an act from its token header, once per Idempotency-Key", async () => {
        const store = memoryActTokenStore();
        const row: DecisionRecord = {
            id: "d_2_s-gw",
            sessionId: "s-gw",
            number: 2,
            prompt: "Which?",
            options: ["one", "two"],
            state: "open",
            updatedTs: "2026-11-03T09:00:00Z",
        };
        const [, b] = await issueActTokens({ row, surface: "phone", store });
        let answers = 0;
        const routes = gatewayRoutes({
            act: async () => ({
                store,
                rows: () => [row],
                answer: async () => {
                    answers++;
                    return { session: "s-gw", text: "2b", channel: "queued", delivered: false };
                },
            }),
        });
        const actRoute = route(routes, "POST", "/api/act");
        const call = (headers: Record<string, string>) =>
            json(actRoute.handler(ctx({ method: "POST", pathname: "/api/act", headers })));

        expect((await call({ "idempotency-key": "r1" })).status).toBe(401);
        expect((await call({ "x-gt-act-token": b.token })).status).toBe(400);

        const first = await call({ "x-gt-act-token": b.token, "idempotency-key": "r1" });
        const retry = await call({ "x-gt-act-token": b.token, "idempotency-key": "r1" });

        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ key: "http:r1", outcome: { kind: "queued" }, decision: { option: "b" } });
        expect(retry).toEqual(first);
        expect(answers).toBe(1);
    });

    it("stores an upload by content under the upload folder, and refuses an unknown type", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-gateway-upload-"));
        const upload = route(gatewayRoutes({ uploadDir: () => dir }), "POST", ENDPOINTS.gatewayUpload.path);
        const bytes = new TextEncoder().encode("a note from the phone");

        const refused = await json(
            upload.handler(
                ctx({
                    method: "POST",
                    pathname: "/api/gateway/upload",
                    headers: { "content-type": "image/gif" },
                    raw: bytes,
                })
            )
        );
        const stored = await json(
            upload.handler(
                ctx({
                    method: "POST",
                    pathname: "/api/gateway/upload",
                    headers: { "content-type": "text/plain; charset=utf-8" },
                    raw: bytes,
                })
            )
        );
        const receipt = stored.body as { path: string; bytes: number; sha256: string };

        expect(refused.status).toBe(415);
        expect(stored.status).toBe(200);
        expect(receipt.path.startsWith(dir)).toBe(true);
        expect(receipt.path.endsWith(".txt")).toBe(true);
        expect(receipt.bytes).toBe(bytes.byteLength);
        expect(existsSync(receipt.path) && readFileSync(receipt.path, "utf8")).toBe("a note from the phone");
    });
});

describe("the upload row through the generic client", () => {
    // The upload route never reads the pulse; the collector refuses if anything does.
    const services: RouteServices = {
        collector: { platform: "macos", collect: () => Promise.reject(new Error("no pulse in this test")) },
    };

    it("sends raw bytes with their own content type and gets the stored receipt", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-gateway-client-"));
        const router = new Router().add(
            route(gatewayRoutes({ uploadDir: () => dir }), "POST", ENDPOINTS.gatewayUpload.path)
        );
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) =>
            (await routerToResponse(router, new Request(String(url), init), { services })) ??
            new Response("no route", { status: 404 })) as unknown as typeof fetch;
        const client = createDashboardClient({ baseUrl: "http://agent.test", fetch: fetchImpl });

        const receipt = await client.call(
            ENDPOINTS.gatewayUpload,
            {},
            { idempotencyKey: "u1", rawBody: { data: "a note from the phone", contentType: "text/plain" } }
        );

        expect(receipt.bytes).toBe("a note from the phone".length);
        expect(readFileSync(receipt.path, "utf8")).toBe("a note from the phone");
    });
});

describe("the act scope", () => {
    const { auth } = createBasicAuthCredentials({ username: "u", password: "p" });
    const provision = { auth, generatedPassword: null };

    it("stops a session behind the full login only, once per Idempotency-Key", async () => {
        let reads = 0;
        const routes = gatewayRoutes({
            stop: {
                fleet: async () => {
                    reads++;
                    return [];
                },
                // Never reached: a session that is not live is refused before any process is read or signalled.
                sources: realProcsSources,
                ops: realSignalOps,
                graceMs: 0,
            },
        });
        const stop = route(routes, "POST", "/api/agents/stop");
        const call = (body: unknown, headers: Record<string, string> = { "idempotency-key": "s1" }) =>
            json(stop.handler(ctx({ method: "POST", pathname: "/api/agents/stop", headers, body })));

        expect((await call({ key: "claude:s" })).status).toBe(400);
        const first = await call({ key: "claude:s", pid: 4100 });
        const retry = await call({ key: "claude:s", pid: 4100 });

        expect(first).toEqual({
            status: 200,
            body: {
                key: "claude:s",
                pid: 4100,
                stopped: false,
                signal: null,
                survivors: [],
                reason: "the session is no longer live",
            },
        });
        expect(retry).toEqual(first);
        expect(reads).toBe(1);
        expect(
            decideApiAuth({
                method: "POST",
                pathname: "/api/agents/stop",
                headers: { "x-gt-act-token": TOKEN },
                provision,
            }).decision
        ).toBe("deny");
    });

    it("raises a waiting gate behind the full login, once per Idempotency-Key, and never answers it", async () => {
        const opened: string[] = [];
        const activated: number[] = [];
        const wait = { title: "t", who: null, askedAt: "2026-11-04T11:00:00.000Z" };
        const routes = gatewayRoutes({
            gates: {
                ledger: () => ({
                    recent: [],
                    pending: [
                        {
                            ...wait,
                            id: "rm:abc",
                            gate: "rm",
                            window: null,
                            request: { id: "abc", reason: null, paths: [], expiresAt: "2026-11-05T11:00:00.000Z" },
                        },
                        {
                            ...wait,
                            id: "vault:77",
                            gate: "vault",
                            window: { pid: 77, openedAt: wait.askedAt, deadline: "2026-11-04T11:02:50.000Z" },
                            request: null,
                        },
                    ],
                }),
                openRmWindow: (id) => opened.push(id),
                activate: async (pid) => {
                    activated.push(pid);
                    return "refused";
                },
            },
        });
        const raise = route(routes, "POST", "/api/gates/raise");
        const call = (body: unknown, key: string) =>
            json(
                raise.handler(
                    ctx({ method: "POST", pathname: "/api/gates/raise", headers: { "idempotency-key": key }, body })
                )
            );

        expect((await call({ id: "rm:abc" }, "r1")).body).toMatchObject({ outcome: "opened" });
        expect((await call({ id: "rm:abc" }, "r1")).body).toMatchObject({ outcome: "opened" });
        expect((await call({ id: "vault:77" }, "r2")).body).toMatchObject({ outcome: "asked" });
        expect((await call({ id: "vault:1" }, "r3")).body).toMatchObject({ outcome: "gone" });
        expect(opened).toEqual(["abc"]);
        expect(activated).toEqual([77]);
        expect(
            decideApiAuth({
                method: "POST",
                pathname: "/api/gates/raise",
                headers: { "x-gt-act-token": TOKEN },
                provision,
            }).decision
        ).toBe("deny");
    });

    it("lets an act token reach the act row only, without the dashboard login", () => {
        expect(isActScopedRequest("POST", "/api/act", TOKEN)).toBe(true);
        expect(isActScopedRequest("POST", "/api/act", "short")).toBe(false);
        expect(isActScopedRequest("GET", "/api/act", TOKEN)).toBe(false);
        expect(isActScopedRequest("POST", "/api/qa/decisions/answer", TOKEN)).toBe(false);

        expect(
            decideApiAuth({ method: "POST", pathname: "/api/act", headers: { "x-gt-act-token": TOKEN }, provision })
        ).toEqual({ decision: "allow", scope: "act" });
        expect(
            decideApiAuth({
                method: "POST",
                pathname: "/api/qa/decisions/answer",
                headers: { "x-gt-act-token": TOKEN },
                provision,
            }).decision
        ).toBe("deny");
    });
});

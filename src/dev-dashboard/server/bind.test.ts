import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ENDPOINTS,
    endpointTier,
    fillPath,
    findEndpoint,
    TIMEOUT_TIER_MS,
} from "@app/dev-dashboard/contract/endpoint-table";
import { upstreamTimeoutMs } from "@app/dev-dashboard/lib/front-proxy";
import { qaDecisionRoutes } from "@app/dev-dashboard/server/routes/qa-decisions";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { postDecisions } from "@app/question/lib/decisions/store";
import { z } from "zod";
import { bindEndpoint, ReceiptCache } from "./bind";

function ctx({
    method = "POST",
    pathname,
    body,
    query = {},
    params = {},
    headers = {},
}: {
    method?: "GET" | "POST";
    pathname: string;
    body?: unknown;
    query?: Record<string, string>;
    params?: Record<string, string>;
    headers?: Record<string, string>;
}): RouteContext {
    return {
        method,
        pathname,
        query: new URLSearchParams(query),
        params,
        headers,
        readJson: async <T>() => body as T,
        readRawBody: async () => new Uint8Array(),
        services: {} as RouteContext["services"],
    };
}

function json(result: RouteResult): { status: number; body: unknown } {
    if (result.kind !== "json") {
        throw new Error(`expected json, got ${result.kind}`);
    }

    return { status: result.status, body: result.body };
}

function route(defs: RouteDef[], pattern: string): RouteDef {
    const found = defs.find((def) => def.pattern === pattern);

    if (!found) {
        throw new Error(`no route ${pattern}`);
    }

    return found;
}

describe("endpoint table", () => {
    it("fills path params and leaves the rest for the query or the body", () => {
        expect(fillPath("/api/qa/pending/:id/answer", { id: "ask 1", answers: [] })).toEqual({
            path: "/api/qa/pending/ask%201/answer",
            rest: { answers: [] },
        });
        expect(() => fillPath("/api/qa/pending/:id", {})).toThrow("missing path parameter id");
    });

    it("finds a row by method and pattern, and the proxy deadline comes from its tier", () => {
        expect(findEndpoint("POST", "/api/qa/decisions/dismiss")).toBe(ENDPOINTS.qaDecisionsDismiss);
        expect(findEndpoint("GET", "/api/qa/decisions/dismiss")).toBeUndefined();
        expect(endpointTier("/api/qa/pending/ask_1/wait")).toBe("stream");

        for (const entry of Object.values(ENDPOINTS)) {
            const probe = entry.path.replace(/:[^/]+/g, "sample");
            expect(upstreamTimeoutMs(probe)).toBe(TIMEOUT_TIER_MS[entry.timeout]);
        }
    });
});

describe("bindEndpoint", () => {
    const row = ENDPOINTS.qaDecisionsDismiss;

    it("refuses an input its zod check refuses, with the row's message", async () => {
        const def = bindEndpoint(row, {
            input: z.object({ session: z.string(), number: z.number() }),
            invalid: "expected { session, number }",
            run: async () => ({}) as never,
        });

        expect(def).toMatchObject({ method: "POST", pattern: "/api/qa/decisions/dismiss" });
        expect(json(await def.handler(ctx({ pathname: row.path, body: { session: "s" } })))).toEqual({
            status: 400,
            body: { error: "expected { session, number }" },
        });
    });

    it("runs a keyed write once per Idempotency-Key and answers a retry with the first answer", async () => {
        let runs = 0;
        const def = bindEndpoint(
            row,
            {
                input: z.object({ session: z.string(), number: z.number() }),
                invalid: "bad",
                run: async () => ({ run: ++runs }) as never,
            },
            new ReceiptCache()
        );
        const keyed = (key: string) =>
            ctx({ pathname: row.path, body: { session: "s", number: 1 }, headers: { "idempotency-key": key } });

        const first = json(await def.handler(keyed("k1")));
        const retry = json(await def.handler(keyed("k1")));
        const other = json(await def.handler(keyed("k2")));
        const unkeyed = json(await def.handler(ctx({ pathname: row.path, body: { session: "s", number: 1 } })));

        expect(first).toEqual({ status: 200, body: { run: 1 } });
        expect(retry).toEqual(first);
        expect(other.body).toEqual({ run: 2 });
        expect(unkeyed.body).toEqual({ run: 3 });
    });
});

describe("qa decision routes from the table", () => {
    function scratch() {
        const dir = mkdtempSync(join(tmpdir(), "gt-bind-"));
        return { file: join(dir, "decisions.jsonl"), events: join(dir, "events.jsonl") };
    }

    it("passes the shown revision through dismiss and draft, so a newer post refuses the write", async () => {
        const files = scratch();
        await postDecisions(files.file, files.events, {
            sessionId: "s-rev",
            decisions: [{ prompt: "Port?", options: ["3000", "4000"] }],
        });
        const routes = qaDecisionRoutes({ files: () => files, block: async () => null });

        const stale = json(
            await route(routes, "/api/qa/decisions/dismiss").handler(
                ctx({
                    pathname: "/api/qa/decisions/dismiss",
                    body: { session: "s-rev", number: 1, expectedRevision: 2 },
                })
            )
        );
        const draftStale = json(
            await route(routes, "/api/qa/decisions/draft").handler(
                ctx({
                    pathname: "/api/qa/decisions/draft",
                    body: { session: "s-rev", number: 1, option: "a", expectedRevision: 2 },
                })
            )
        );
        const current = json(
            await route(routes, "/api/qa/decisions/dismiss").handler(
                ctx({
                    pathname: "/api/qa/decisions/dismiss",
                    body: { session: "s-rev", number: 1, expectedRevision: 1 },
                })
            )
        );

        expect(stale.status).toBe(400);
        expect(String((stale.body as { error: string }).error)).toContain("changed");
        expect(draftStale.status).toBe(400);
        expect(current.status).toBe(200);
        expect((current.body as { state: string }).state).toBe("dismissed");
    });

    it("keeps the old 400 bodies for a malformed request", async () => {
        const routes = qaDecisionRoutes({ files: () => scratch() });

        expect(
            json(
                await route(routes, "/api/qa/decisions/answer").handler(
                    ctx({ pathname: "/api/qa/decisions/answer", body: { session: "s" } })
                )
            )
        ).toEqual({
            status: 400,
            body: { error: "expected { session, answers: [{ number, option?, text? }], dryRun? }" },
        });
        expect(
            json(
                await route(routes, "/api/qa/decisions/send").handler(
                    ctx({ pathname: "/api/qa/decisions/send", body: {} })
                )
            )
        ).toEqual({ status: 400, body: { error: "session required" } });
    });
});

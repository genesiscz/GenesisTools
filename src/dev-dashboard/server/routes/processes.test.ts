import { describe, expect, it } from "bun:test";
import { processesRoutes } from "@app/dev-dashboard/server/routes/processes";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@app/utils/json";

function findRoute(method: string, pattern: string): RouteDef {
    const def = processesRoutes().find((d) => d.method === method && d.pattern === pattern);

    if (!def) {
        throw new Error(`route not found: ${method} ${pattern}`);
    }

    return def;
}

function makeCtx(opts: { query?: Record<string, string>; body?: unknown }): RouteContext {
    return {
        method: "GET",
        pathname: "/api/processes",
        query: new URLSearchParams(opts.query ?? {}),
        params: {},
        headers: {},
        readJson: async <T>() => opts.body as T,
        readRawBody: async () => new TextEncoder().encode(SafeJSON.stringify(opts.body ?? {})),
        // The processes routes never touch services; an empty cast keeps the test focused.
        services: {} as RouteContext["services"],
    };
}

function asJson(result: RouteResult): { status: number; body: Record<string, unknown> } {
    if (result.kind !== "json") {
        throw new Error(`expected json result, got ${result.kind}`);
    }

    return { status: result.status, body: result.body as Record<string, unknown> };
}

interface MinimalProcess {
    pid: number;
    name: string;
    rssBytes: number;
}

describe("processesRoutes", () => {
    it("registers the GET list + POST kill routes", () => {
        const paths = processesRoutes().map((d) => `${d.method} ${d.pattern}`);
        expect(paths).toContain("GET /api/processes");
        expect(paths).toContain("POST /api/processes/kill");
    });

    it("GET defaults to rss sort and returns a descending-by-rss list", async () => {
        const def = findRoute("GET", "/api/processes");
        const { status, body } = asJson(await def.handler(makeCtx({})));

        expect(status).toBe(200);
        expect(body.sort).toBe("rss");

        const processes = body.processes as MinimalProcess[];
        expect(Array.isArray(processes)).toBe(true);

        for (let i = 1; i < processes.length; i++) {
            expect(processes[i - 1].rssBytes >= processes[i].rssBytes).toBe(true);
        }
    });

    it("GET sort=name returns an ascending-by-name list, limit caps the array", async () => {
        const def = findRoute("GET", "/api/processes");
        const { body } = asJson(await def.handler(makeCtx({ query: { sort: "name", limit: "3" } })));

        expect(body.sort).toBe("name");

        const processes = body.processes as MinimalProcess[];
        expect(processes.length).toBeLessThanOrEqual(3);

        for (let i = 1; i < processes.length; i++) {
            expect(processes[i - 1].name.toLowerCase() <= processes[i].name.toLowerCase()).toBe(true);
        }
    });

    it("POST kill with a non-numeric pid returns 400 { ok:false }", async () => {
        const def = findRoute("POST", "/api/processes/kill");
        const { status, body } = asJson(await def.handler(makeCtx({ body: { pid: "x" } })));

        expect(status).toBe(400);
        expect(body.ok).toBe(false);
    });

    it("POST kill with a guarded pid (1) returns 200 { ok:false } (never throws)", async () => {
        const def = findRoute("POST", "/api/processes/kill");
        const { status, body } = asJson(await def.handler(makeCtx({ body: { pid: 1 } })));

        expect(status).toBe(200);
        expect(body.ok).toBe(false);
    });
});

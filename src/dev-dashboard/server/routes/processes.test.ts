import { describe, expect, it } from "bun:test";
import { processesRoutes } from "@app/dev-dashboard/server/routes/processes";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { skip } from "@genesiscz/utils/test/skip";

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

    it("POST kill without a command returns 400 — the command guard refuses before any signal", async () => {
        const def = findRoute("POST", "/api/processes/kill");
        const { status, body } = asJson(await def.handler(makeCtx({ body: { pid: 1 } })));

        // `command` is REQUIRED, not optional: it is the only thing standing between this
        // route and "SIGTERM whatever number you post at me", because a pid can be reissued
        // between the table render and the click. This test used to assert 200 here, which
        // pinned the contract from BEFORE that guard existed.
        expect(status).toBe(400);
        expect(body.ok).toBe(false);
        expect(String(body.error)).toContain("command");
    });

    it("POST kill with a guarded pid (1) returns 200 { ok:false } at the pid guard, never throwing", async () => {
        const def = findRoute("POST", "/api/processes/kill");
        const { status, body } = asJson(
            await def.handler(makeCtx({ body: { pid: 1, command: "definitely-not-this-process" } }))
        );

        // 🛑 pid 1 is launchd, and `killProcess` returns at its `pid <= 1` guard — BEFORE it
        // reads the live command. So this case says nothing about the command comparison;
        // it pins only "a guarded pid answers ok:false rather than throwing". The two tests
        // below are what cover the comparison, and they need a pid greater than 1 to do it.
        expect(status).toBe(200);
        expect(body.ok).toBe(false);
    });

    /**
     * The command comparison needs a pid the guard lets through, so these spawn a child of
     * our own. That is deliberate containment: if a regression removes the comparison, the
     * SIGTERM lands on this child and the assertion fails, rather than landing on the test
     * runner. Verified by mutation 2026-09-15 — disabling the comparison leaves every
     * pid-1 case green and turns the mismatch case below red.
     */
    it.skipIf(skip.onWindows)("POST kill refuses a live pid whose command does not match", async () => {
        const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });

        try {
            const def = findRoute("POST", "/api/processes/kill");
            const { status, body } = asJson(
                await def.handler(makeCtx({ body: { pid: child.pid, command: "definitely-not-sleep-xyzzy" } }))
            );

            expect(status).toBe(200);
            expect(body.ok).toBe(false);

            // The real assertion: a refused kill sends no signal, so the child is still alive.
            await Bun.sleep(100);
            expect(child.exitCode).toBeNull();
        } finally {
            child.kill("SIGKILL");
            await child.exited;
        }
    });

    /**
     * The negative control. A guard that also blocks the legitimate path is worse than the
     * bug it fixed, so prove a MATCHING command still reaches `process.kill`.
     */
    it.skipIf(skip.onWindows)("POST kill signals a live pid whose command matches", async () => {
        const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });

        try {
            const def = findRoute("POST", "/api/processes/kill");
            const { status, body } = asJson(await def.handler(makeCtx({ body: { pid: child.pid, command: "sleep" } })));

            expect(status).toBe(200);
            expect(body.ok).toBe(true);

            // A signalled process reports `signalCode`, not `exitCode` — `exitCode` stays
            // null, so asserting on it would pass for a child that was never touched.
            await child.exited;
            expect(child.signalCode).toBe("SIGTERM");
        } finally {
            child.kill("SIGKILL");
        }
    });
});

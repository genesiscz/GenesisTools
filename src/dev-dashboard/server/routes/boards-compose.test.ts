import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard } from "@app/dev-dashboard/lib/boards/boards-store";
import { getBoardsDb, resetBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import { resetEventHub } from "@app/dev-dashboard/lib/boards/events";
import { resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { env } from "@app/utils/env";
import { boardsComposeRoutes } from "./boards-compose";

function findRoute(method: string, pattern: string): RouteDef {
    const def = boardsComposeRoutes().find((d) => d.method === method && d.pattern === pattern);
    if (!def) {
        throw new Error(`route not found: ${method} ${pattern}`);
    }
    return def;
}

function makeCtx(opts: { params?: Record<string, string>; body?: unknown }): RouteContext {
    return {
        method: "POST",
        pathname: "/",
        query: new URLSearchParams(),
        params: opts.params ?? {},
        headers: {},
        readJson: async <T>() => opts.body as T,
        readRawBody: async () => new Uint8Array(),
        services: {} as RouteContext["services"],
    };
}

function asJson(result: RouteResult): { status: number; body: Record<string, unknown> } {
    if (result.kind !== "json") {
        throw new Error(`expected json result, got ${result.kind}`);
    }
    return { status: result.status, body: result.body as Record<string, unknown> };
}

describe("POST /api/boards/:slug/compose", () => {
    beforeEach(() => {
        const dir = mkdtempSync(join(tmpdir(), "boards-compose-route-"));
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        env.testing.set("BOARDS_DB_PATH", ":memory:");
        resetDevDashboardStorage();
        resetBoardsDb();
        resetEventHub();
    });
    afterEach(() => {
        resetEventHub();
        resetBoardsDb();
        resetDevDashboardStorage();
        env.testing.unset("GENESIS_TOOLS_HOME");
        env.testing.unset("BOARDS_DB_PATH");
    });

    async function compose(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
        const route = findRoute("POST", "/api/boards/:slug/compose");
        return asJson(await route.handler(makeCtx({ params: { slug: "b1" }, body })));
    }

    it("201 with cards/edges/questions/region on the happy path", async () => {
        await createBoard(getBoardsDb(), { slug: "b1" });
        const res = await compose({
            cards: [
                { ref: "a", kind: "text", payload: { md: "A" } },
                { ref: "b", kind: "note", payload: { text: "B" } },
            ],
            edges: [{ from: "a", to: "b" }],
        });
        expect(res.status).toBe(201);
        expect((res.body.cards as unknown[]).length).toBe(2);
        expect((res.body.edges as unknown[]).length).toBe(1);
        expect(res.body.region).toMatchObject({ x: expect.any(Number), w: expect.any(Number) });
    });

    it("400 {error,code,index} on an empty batch", async () => {
        await createBoard(getBoardsDb(), { slug: "b1" });
        const res = await compose({ cards: [] });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: "empty", index: -1 });
    });

    it("413 on a limit breach", async () => {
        await createBoard(getBoardsDb(), { slug: "b1" });
        const cards = Array.from({ length: 61 }, (_, i) => ({ ref: `c${i}`, kind: "text", payload: { md: "x" } }));
        expect((await compose({ cards })).status).toBe(413);
    });

    it("404 on a compare referencing a card not on the board", async () => {
        await createBoard(getBoardsDb(), { slug: "b1" });
        const res = await compose({ cards: [{ kind: "compare", payload: { a: { cardId: 9 }, b: { cardId: 8 } } }] });
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ code: "not_found" });
    });
});

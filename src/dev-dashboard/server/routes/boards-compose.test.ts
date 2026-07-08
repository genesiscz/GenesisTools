import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard, createCard, getBoardDoc } from "@app/dev-dashboard/lib/boards/boards-store";
import { getBoardsDb, resetBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import { resetEventHub } from "@app/dev-dashboard/lib/boards/events";
import { __resetLayoutDebounce } from "@app/dev-dashboard/lib/boards/layout-engine";
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
        __resetLayoutDebounce();
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

describe("POST /api/boards/:slug/arrange", () => {
    beforeEach(() => {
        const dir = mkdtempSync(join(tmpdir(), "boards-arrange-route-"));
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        env.testing.set("BOARDS_DB_PATH", ":memory:");
        resetDevDashboardStorage();
        resetBoardsDb();
        resetEventHub();
    });
    afterEach(() => {
        __resetLayoutDebounce();
        resetEventHub();
        resetBoardsDb();
        resetDevDashboardStorage();
        env.testing.unset("GENESIS_TOOLS_HOME");
        env.testing.unset("BOARDS_DB_PATH");
    });

    function findArrange(): RouteDef {
        const def = boardsComposeRoutes().find((d) => d.method === "POST" && d.pattern === "/api/boards/:slug/arrange");
        if (!def) {
            throw new Error("arrange route not found");
        }
        return def;
    }
    async function arrange(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
        return asJson(await findArrange().handler(makeCtx({ params: { slug: "b1" }, body })));
    }

    it("arranges an explicit id selection", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        const c1 = await createCard(db, "b1", { kind: "text", x: 0, y: 0, w: 100, h: 100, payload: { md: "a" } });
        const c2 = await createCard(db, "b1", { kind: "text", x: 300, y: 300, w: 100, h: 100, payload: { md: "b" } });
        const res = await arrange({ mode: "row", ids: [c1.id, c2.id] });
        expect(res.status).toBe(200);
        expect(res.body.moved).toBe(2);
    });

    it("400s a scope with fewer than 2 cards", async () => {
        await createBoard(getBoardsDb(), { slug: "b1" });
        expect((await arrange({ mode: "grid", scope: "all" })).status).toBe(400);
    });

    it("save persists the layout onto the scoped section", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        await createCard(db, "b1", { kind: "section", x: 0, y: 0, w: 600, h: 400, payload: { title: "Checkout" } });
        await createCard(db, "b1", { kind: "text", x: 50, y: 80, w: 100, h: 100, payload: { md: "a", layer: "ai" } });
        await createCard(db, "b1", { kind: "text", x: 200, y: 80, w: 100, h: 100, payload: { md: "b", layer: "ai" } });
        const res = await arrange({ mode: "grid", scope: "section:Checkout", cols: 2, save: true });
        expect(res.status).toBe(200);
        expect(res.body.saved).toBe(true);
        const doc = await getBoardDoc(db, "b1");
        const sec = doc.cards.find((c) => c.kind === "section");
        expect((sec?.payload.layout as { mode?: string })?.mode).toBe("grid");
    });
});

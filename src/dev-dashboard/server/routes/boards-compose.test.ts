import { describe, expect, it } from "bun:test";
import {
    createBoard,
    createCard,
    getBoardDoc,
    listTrash,
    softDeleteCard,
} from "@app/dev-dashboard/lib/boards/boards-store";
import { getBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { boardsComposeRoutes } from "./boards-compose";
import { setupBoardsTestEnv } from "./boards-route-test-utils";

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
    setupBoardsTestEnv("boards-compose-route-");

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
    setupBoardsTestEnv("boards-arrange-route-");

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

describe("POST /api/boards/:slug/update-cards", () => {
    setupBoardsTestEnv("boards-update-route-");

    function findUpdate(): RouteDef {
        const def = boardsComposeRoutes().find(
            (d) => d.method === "POST" && d.pattern === "/api/boards/:slug/update-cards"
        );
        if (!def) {
            throw new Error("update-cards route not found");
        }
        return def;
    }
    async function update(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
        return asJson(await findUpdate().handler(makeCtx({ params: { slug: "b1" }, body })));
    }
    const aiText = async (db: ReturnType<typeof getBoardsDb>) =>
        createCard(db, "b1", { kind: "text", x: 0, y: 0, w: 100, h: 100, payload: { md: "x", layer: "ai" } });

    it("400 empty on zero ops, 413 on >100", async () => {
        await createBoard(getBoardsDb(), { slug: "b1" });
        expect((await update({})).status).toBe(400);
        expect((await update({ remove: Array.from({ length: 101 }, (_, i) => i + 1) })).status).toBe(413);
    });

    it("403 not_ai_layer when patching a card that isn't on the AI layer", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        const shot = await createCard(db, "b1", { kind: "shot", x: 0, y: 0, w: 100, h: 100, payload: {} });
        const res = await update({ patch: [{ id: shot.id, x: 50 }] });
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: "not_ai_layer", index: 0 });
    });

    it("allows patching a section card and re-stamps layer:ai on a non-section patch", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        const section = await createCard(db, "b1", {
            kind: "section",
            x: 0,
            y: 0,
            w: 300,
            h: 200,
            payload: { title: "S" },
        });
        const text = await aiText(db);
        const res = await update({
            patch: [
                { id: section.id, w: 400 },
                { id: text.id, payload: { md: "edited" } }, // omits layer → must be re-stamped
            ],
        });
        expect(res.status).toBe(200);
        expect(res.body.patched).toBe(2);

        const doc = await getBoardDoc(db, "b1");
        const sec = doc.cards.find((c) => c.id === section.id);
        expect(sec?.w).toBe(400);
        expect("layer" in (sec?.payload ?? {})).toBe(false); // section stays layer-neutral
        const txt = doc.cards.find((c) => c.id === text.id);
        expect(txt?.payload.layer).toBe("ai"); // re-stamped
        expect(txt?.payload.md).toBe("edited");
    });

    it("remove soft-deletes into the trash", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        const text = await aiText(db);
        expect((await update({ remove: [text.id] })).body.removed).toBe(1);
        const trash = await listTrash(db, "b1");
        expect(trash.map((c) => c.id)).toContain(text.id);
    });

    it("restore 403s a live (non-trashed) card, and restores a trashed AI card", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        const live = await aiText(db);
        expect((await update({ restore: [live.id] })).status).toBe(403); // not in trash

        const doomed = await aiText(db);
        await softDeleteCard(db, doomed.id);
        const res = await update({ restore: [doomed.id] });
        expect(res.status).toBe(200);
        expect(res.body.restored).toBe(1);
        const doc = await getBoardDoc(db, "b1");
        expect(doc.cards.map((c) => c.id)).toContain(doomed.id);
    });
});

describe("GET /api/boards/:slug/scrape", () => {
    setupBoardsTestEnv("boards-scrape-route-");

    it("returns the board digest, 404s an unknown section", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1", title: "T" });
        await createCard(db, "b1", { kind: "text", x: 0, y: 0, w: 50, h: 50, payload: { md: "hi", layer: "ai" } });
        const route = boardsComposeRoutes().find((d) => d.method === "GET" && d.pattern === "/api/boards/:slug/scrape");
        if (!route) {
            throw new Error("scrape route not found");
        }
        const ctx = (query: Record<string, string>): RouteContext => ({
            method: "GET",
            pathname: "/",
            query: new URLSearchParams(query),
            params: { slug: "b1" },
            headers: {},
            readJson: async <T>() => ({}) as T,
            readRawBody: async () => new Uint8Array(),
            services: {} as RouteContext["services"],
        });
        const ok = asJson(await route.handler(ctx({})));
        expect(ok.status).toBe(200);
        expect((ok.body.cards as unknown[]).length).toBe(1);
        expect(asJson(await route.handler(ctx({ section: "nope" }))).status).toBe(404);
    });
});

describe("GET /api/boards/templates.md", () => {
    it("serves the template library as markdown", async () => {
        const route = boardsComposeRoutes().find((d) => d.method === "GET" && d.pattern === "/api/boards/templates.md");
        if (!route) {
            throw new Error("templates route not found");
        }
        const result = await route.handler(makeCtx({}));
        if (result.kind !== "text") {
            throw new Error(`expected text result, got ${result.kind}`);
        }
        expect(result.status).toBe(200);
        expect(result.contentType).toBe("text/markdown");
        expect(result.body).toContain("# Board templates");
        expect(result.body).toContain("boards_compose_board");
    });
});

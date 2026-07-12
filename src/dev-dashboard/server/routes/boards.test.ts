import { describe, expect, it } from "bun:test";
import { subscribeBoard } from "@app/dev-dashboard/lib/boards/events";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@app/utils/json";
import { boardsRoutes } from "./boards";
import { setupBoardsTestEnv } from "./boards-route-test-utils";

function findRoute(method: string, pattern: string): RouteDef {
    const def = boardsRoutes().find((d) => d.method === method && d.pattern === pattern);
    if (!def) {
        throw new Error(`route not found: ${method} ${pattern}`);
    }
    return def;
}

function makeCtx(opts: {
    method?: RouteContext["method"];
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    rawBody?: Uint8Array;
}): RouteContext {
    return {
        method: opts.method ?? "GET",
        pathname: "/",
        query: new URLSearchParams(opts.query ?? {}),
        params: opts.params ?? {},
        headers: {},
        readJson: async <T>() => opts.body as T,
        readRawBody: async () => opts.rawBody ?? new TextEncoder().encode(SafeJSON.stringify(opts.body ?? {})),
        services: {} as RouteContext["services"],
    };
}

function asJson(result: RouteResult): { status: number; body: Record<string, unknown> } {
    if (result.kind !== "json") {
        throw new Error(`expected json result, got ${result.kind}`);
    }
    return { status: result.status, body: result.body as Record<string, unknown> };
}

function u32be(n: number): number[] {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function buildPng(width: number, height: number): Uint8Array {
    return new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0x00,
        0x00,
        0x00,
        0x0d,
        0x49,
        0x48,
        0x44,
        0x52,
        ...u32be(width),
        ...u32be(height),
        0x08,
        0x06,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
    ]);
}

async function createBoard(slug: string): Promise<Record<string, unknown>> {
    const post = findRoute("POST", "/api/boards");
    return asJson(await post.handler(makeCtx({ method: "POST", body: { slug } }))).body;
}

async function createCard(slug: string, kind = "note"): Promise<Record<string, unknown>> {
    const post = findRoute("POST", "/api/boards/:slug/cards");
    return asJson(
        await post.handler(makeCtx({ method: "POST", params: { slug }, body: { kind, x: 0, y: 0, w: 10, h: 10 } }))
    ).body;
}

describe("boardsRoutes", () => {
    setupBoardsTestEnv("boards-routes-");

    it("GET /api/boards/:slug/sections returns spatial sections with member counts and journeys", async () => {
        const { getBoardsDb } = await import("@app/dev-dashboard/lib/boards/db");
        const { createCard: storeCreateCard } = await import("@app/dev-dashboard/lib/boards/boards-store");
        await createBoard("b1");
        const db = getBoardsDb();
        await storeCreateCard(db, "b1", {
            kind: "section",
            x: 0,
            y: 0,
            w: 400,
            h: 400,
            payload: { title: "Checkout", journey: "checkout", pass: 1 },
        });
        await storeCreateCard(db, "b1", { kind: "note", x: 100, y: 100, w: 50, h: 50, payload: { text: "hi" } });

        const route = findRoute("GET", "/api/boards/:slug/sections");
        const res = asJson(await route.handler(makeCtx({ params: { slug: "b1" } })));
        expect(res.status).toBe(200);
        const sections = res.body.sections as Array<{ name: string; cards: number; journey?: string }>;
        expect(sections).toHaveLength(1);
        expect(sections[0]).toMatchObject({ name: "Checkout", cards: 1, journey: "checkout", pass: 1 });
        expect(res.body.journeys).toEqual([{ journey: "checkout", title: "Checkout", passes: 1, latest: "Checkout" }]);
    });

    it("creates a board (201) and rejects a duplicate slug (409)", async () => {
        const post = findRoute("POST", "/api/boards");
        const first = await post.handler(makeCtx({ method: "POST", body: { slug: "b1" } }));
        expect(asJson(first).status).toBe(201);
        const dup = await post.handler(makeCtx({ method: "POST", body: { slug: "b1" } }));
        expect(asJson(dup).status).toBe(409);
    });

    it("card CRUD + trash/restore emits card/card_deleted SSE events in order", async () => {
        await createBoard("b1");
        const events: string[] = [];
        subscribeBoard("b1", (frame) =>
            events.push((SafeJSON.parse(frame, { strict: true }) as { type: string }).type)
        );

        const created = await createCard("b1");
        const cardId = created.id as number;

        const patch = findRoute("PATCH", "/api/boards/cards/:id");
        await patch.handler(makeCtx({ method: "PATCH", params: { id: String(cardId) }, body: { x: 99 } }));

        const del = findRoute("DELETE", "/api/boards/cards/:id");
        await del.handler(makeCtx({ method: "DELETE", params: { id: String(cardId) } }));

        const trashRoute = findRoute("GET", "/api/boards/:slug/trash");
        const trash = asJson(await trashRoute.handler(makeCtx({ params: { slug: "b1" } })));
        expect((trash.body.cards as unknown[]).length).toBe(1);

        const restore = findRoute("POST", "/api/boards/cards/:id/restore");
        await restore.handler(makeCtx({ method: "POST", params: { id: String(cardId) } }));

        const trashAfter = asJson(await trashRoute.handler(makeCtx({ params: { slug: "b1" } })));
        expect((trashAfter.body.cards as unknown[]).length).toBe(0);

        expect(events).toEqual(["card", "card", "card_deleted", "card"]);
    });

    it("bulk layout moves cards in one call and publishes ONE layout event", async () => {
        await createBoard("b1");
        const c1 = await createCard("b1");
        const c2 = await createCard("b1");

        const events: unknown[] = [];
        subscribeBoard("b1", (frame) => events.push(SafeJSON.parse(frame, { strict: true })));

        const layout = findRoute("POST", "/api/boards/:slug/layout");
        const moves = [
            { id: c1.id, x: 10, y: 20 },
            { id: c2.id, x: 30, y: 40 },
        ];
        const res = asJson(await layout.handler(makeCtx({ method: "POST", params: { slug: "b1" }, body: { moves } })));
        expect(res.status).toBe(200);

        const layoutEvents = events.filter((e) => (e as { type: string }).type === "layout");
        expect(layoutEvents.length).toBe(1);

        const doc = asJson(await findRoute("GET", "/api/boards/:slug").handler(makeCtx({ params: { slug: "b1" } })));
        const cards = doc.body.cards as Array<{ id: number; x: number; y: number }>;
        expect(cards.find((c) => c.id === c1.id)?.x).toBe(10);
        expect(cards.find((c) => c.id === c2.id)?.y).toBe(40);
    });

    it("dispatch flips staged annotations to open and the store's own status events reach subscribers", async () => {
        await createBoard("b1");
        const card = await createCard("b1", "shot");

        const { createAnnotation } = await import("@app/dev-dashboard/lib/boards/annotations-store");
        const { getBoardsDb } = await import("@app/dev-dashboard/lib/boards/db");
        const ann = await createAnnotation(getBoardsDb(), {
            boardSlug: "b1",
            cardId: card.id as number,
            region: { x: 0, y: 0, w: 1, h: 1 },
            intent: "fix",
            prompt: "p",
            status: "staged",
        });

        const events: unknown[] = [];
        subscribeBoard("b1", (frame) => events.push(SafeJSON.parse(frame, { strict: true })));

        const dispatch = findRoute("POST", "/api/boards/:slug/dispatch");
        const res = asJson(await dispatch.handler(makeCtx({ method: "POST", params: { slug: "b1" } })));
        expect(res.body.opened).toEqual([ann.id]);

        const statusEvents = events.filter((e) => (e as { type: string }).type === "status");
        expect(statusEvents.length).toBe(1);
    });

    it("upload creates a media card from raw image bytes, capping natural width to 480", async () => {
        await createBoard("b1");
        const upload = findRoute("POST", "/api/boards/:slug/upload");
        const bytes = buildPng(960, 480);
        const res = asJson(
            await upload.handler(
                makeCtx({
                    method: "POST",
                    params: { slug: "b1" },
                    query: { name: "shot.png", mime: "image/png" },
                    rawBody: bytes,
                })
            )
        );
        expect(res.status).toBe(201);
        expect(res.body.kind).toBe("media");
        expect(res.body.w).toBe(480);
        expect(res.body.h).toBe(240);
        expect(res.body.x).toBe(40);
        expect(res.body.y).toBe(40);
        // Source dims (pre-downscale) persist in payload for the UI's region/stroke scaling.
        const payload = res.body.payload as { naturalWidth: number; naturalHeight: number };
        expect(payload.naturalWidth).toBe(960);
        expect(payload.naturalHeight).toBe(480);
    });

    it("board messages post as board-level and emit board_message", async () => {
        await createBoard("b1");
        const events: string[] = [];
        subscribeBoard("b1", (frame) =>
            events.push((SafeJSON.parse(frame, { strict: true }) as { type: string }).type)
        );

        const messages = findRoute("POST", "/api/boards/:slug/messages");
        const res = asJson(
            await messages.handler(
                makeCtx({ method: "POST", params: { slug: "b1" }, body: { body: "hello", author: "martin" } })
            )
        );
        expect(res.status).toBe(201);
        expect(res.body.author).toBe("martin");
        expect(res.body.boardId).not.toBeNull();
        expect(events).toEqual(["board_message"]);
    });

    it("PATCH stroke moves/restyles a stroke and emits a `stroke` SSE event", async () => {
        await createBoard("b1");
        const strokesRoute = findRoute("POST", "/api/boards/:slug/strokes");
        const created = asJson(
            await strokesRoute.handler(
                makeCtx({ method: "POST", params: { slug: "b1" }, body: { strokes: [{ path: [[1, 2, 0.5]] }] } })
            )
        );
        const stroke = (created.body.strokes as Array<{ id: number }>)[0];

        const events: unknown[] = [];
        subscribeBoard("b1", (frame) => events.push(SafeJSON.parse(frame, { strict: true })));

        const patch = findRoute("PATCH", "/api/boards/strokes/:id");
        const res = asJson(
            await patch.handler(
                makeCtx({
                    method: "PATCH",
                    params: { id: String(stroke.id) },
                    body: {
                        path: [
                            [5, 6, 0.5],
                            [7, 8, 0.5],
                        ],
                        color: "#08f",
                    },
                })
            )
        );
        expect(res.status).toBe(200);
        expect(res.body.path).toEqual([
            [5, 6, 0.5],
            [7, 8, 0.5],
        ]);
        expect(res.body.color).toBe("#08f");
        expect(events).toEqual([{ type: "stroke", payload: res.body }]);
    });

    it("msg-uploads stores a raw image blob and returns its descriptor without creating a card", async () => {
        await createBoard("b1");
        const upload = findRoute("POST", "/api/boards/:slug/msg-uploads");
        const res = asJson(
            await upload.handler(
                makeCtx({
                    method: "POST",
                    params: { slug: "b1" },
                    query: { name: "paste.png", mime: "image/png" },
                    rawBody: buildPng(10, 10),
                })
            )
        );
        expect(res.status).toBe(201);
        expect(res.body.name).toBe("paste.png");
        expect(res.body.mime).toBe("image/png");
        expect(res.body.blobKey).toMatch(/^[0-9a-f]{64}\.png$/);

        // The board has no cards — the upload did not create one.
        const doc = asJson(await findRoute("GET", "/api/boards/:slug").handler(makeCtx({ params: { slug: "b1" } })));
        expect((doc.body.cards as unknown[]).length).toBe(0);
    });

    it("board messages carry attachments end to end", async () => {
        await createBoard("b1");
        const messages = findRoute("POST", "/api/boards/:slug/messages");
        const attachments = [{ blobKey: "abc.png", name: "shot.png", mime: "image/png" }];
        const res = asJson(
            await messages.handler(
                makeCtx({ method: "POST", params: { slug: "b1" }, body: { body: "look", attachments } })
            )
        );
        expect(res.status).toBe(201);
        expect(res.body.attachments).toEqual(attachments);
    });
});

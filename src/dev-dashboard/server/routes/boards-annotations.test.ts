import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobUrl } from "@app/dev-dashboard/lib/boards/blobs";
import { createBoard, createCard, softDeleteCard } from "@app/dev-dashboard/lib/boards/boards-store";
import { getBoardsDb, resetBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import { resetEventHub, subscribeBoard } from "@app/dev-dashboard/lib/boards/events";
import { getSet, syncSet } from "@app/dev-dashboard/lib/boards/sets-store";
import { dispatchBoard } from "@app/dev-dashboard/lib/boards/work-store";
import { resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { boardsAnnotationsRoutes } from "./boards-annotations";
import { boardsSetsRoutes } from "./boards-sets";

function findRoute(method: string, pattern: string): RouteDef {
    const def = boardsAnnotationsRoutes().find((d) => d.method === method && d.pattern === pattern);
    if (!def) {
        throw new Error(`route not found: ${method} ${pattern}`);
    }
    return def;
}

function findSetsRoute(method: string, pattern: string): RouteDef {
    const def = boardsSetsRoutes().find((d) => d.method === method && d.pattern === pattern);
    if (!def) {
        throw new Error(`route not found: ${method} ${pattern}`);
    }
    return def;
}

function makeCtx(opts: {
    method?: RouteContext["method"];
    params?: Record<string, string>;
    body?: unknown;
    headers?: Record<string, string>;
}): RouteContext {
    return {
        method: opts.method ?? "GET",
        pathname: "/",
        query: new URLSearchParams(),
        params: opts.params ?? {},
        headers: opts.headers ?? {},
        readJson: async <T>() => opts.body as T,
        readRawBody: async () => new TextEncoder().encode(SafeJSON.stringify(opts.body ?? {})),
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

describe("boardsAnnotationsRoutes", () => {
    beforeEach(() => {
        const dir = mkdtempSync(join(tmpdir(), "boards-ann-routes-"));
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        env.testing.set("BOARDS_DB_PATH", ":memory:");
        resetDevDashboardStorage();
        resetBoardsDb();
        resetEventHub();
    });

    afterEach(() => {
        resetBoardsDb();
        resetDevDashboardStorage();
        resetEventHub();
        env.testing.unset("GENESIS_TOOLS_HOME");
        env.testing.unset("BOARDS_DB_PATH");
    });

    it("full lifecycle: staged create -> dispatch -> claim -> attempt swaps the face -> user reply re-queues -> accept resolves", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s1",
            entries: [{ path: "a.png", data: buildPng(10, 10) }],
        });
        const set1 = await getSet(db, "proj", "main", "s1");
        const card = await createCard(db, "b1", {
            kind: "shot",
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            setRef: "proj/main/s1",
            setVersion: 1,
            filePath: "a.png",
            blobKey: set1.files[0].blobKey,
        });

        const events: unknown[] = [];
        subscribeBoard("b1", (frame) => events.push(SafeJSON.parse(frame, { strict: true })));

        const create = findRoute("POST", "/api/boards/annotations");
        const created = asJson(
            await create.handler(
                makeCtx({
                    method: "POST",
                    body: {
                        board: "b1",
                        cardId: card.id,
                        region: { x: 0, y: 0, w: 1, h: 1 },
                        intent: "fix",
                        prompt: "fix it",
                        status: "staged",
                    },
                })
            )
        );
        expect(created.status).toBe(201);
        const annotationId = created.body.id as number;

        await dispatchBoard(db, "b1");

        const patch = findRoute("PATCH", "/api/boards/annotations/:id");
        const claimed = asJson(
            await patch.handler(
                makeCtx({
                    method: "PATCH",
                    params: { id: String(annotationId) },
                    body: { status: "working", actor: "claude" },
                })
            )
        );
        expect(claimed.body.status).toBe("working");

        // Push a second version of the same set so the attempt has something to swap to.
        await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s2",
            entries: [{ path: "a.png", data: buildPng(20, 20) }],
        });

        const attemptRoute = findRoute("POST", "/api/boards/annotations/:id/attempts");
        const attemptRes = asJson(
            await attemptRoute.handler(
                makeCtx({
                    method: "POST",
                    params: { id: String(annotationId) },
                    body: { project: "proj", branch: "main", selector: "s2", file: "a.png" },
                })
            )
        );
        expect(attemptRes.status).toBe(201);
        const card2 = attemptRes.body.card as { blobKey: string; currentVersion: number };
        expect(card2.currentVersion).toBe(2);

        const inReview = findRoute("PATCH", "/api/boards/annotations/:id");
        await inReview.handler(
            makeCtx({ method: "PATCH", params: { id: String(annotationId) }, body: { status: "in_review" } })
        );

        const messages = findRoute("POST", "/api/boards/annotations/:id/messages");
        const reply = asJson(
            await messages.handler(
                makeCtx({
                    method: "POST",
                    params: { id: String(annotationId) },
                    body: { body: "not quite", author: "martin" },
                })
            )
        );
        expect(reply.status).toBe(201);

        const getRoute = findRoute("GET", "/api/boards/annotations/:id");
        const afterReply = asJson(await getRoute.handler(makeCtx({ params: { id: String(annotationId) } })));
        expect(afterReply.body.status).toBe("staged"); // reply re-stages the thread (decision §0.1.1)

        // Dispatch releases the re-staged thread back onto the wire, then reclaim → in_review → accept.
        await dispatchBoard(db, "b1");
        await patch.handler(
            makeCtx({ method: "PATCH", params: { id: String(annotationId) }, body: { status: "working" } })
        );
        await patch.handler(
            makeCtx({ method: "PATCH", params: { id: String(annotationId) }, body: { status: "in_review" } })
        );

        const verdictRoute = findRoute("POST", "/api/boards/attempts/:id/verdict");
        const attemptId = (attemptRes.body.attempt as { id: number }).id;
        const accepted = asJson(
            await verdictRoute.handler(
                makeCtx({ method: "POST", params: { id: String(attemptId) }, body: { verdict: "accept" } })
            )
        );
        expect((accepted.body.annotation as { status: string }).status).toBe("resolved");

        const eventTypes = events.map((e) => (e as { type: string }).type);
        expect(eventTypes).toContain("annotation");
        expect(eventTypes).toContain("status");
        expect(eventTypes).toContain("card");
        expect(eventTypes).toContain("attempt");
        expect(eventTypes).toContain("message");
    });

    it("cancel path: any write after cancel returns 409", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        const card = await createCard(db, "b1", { kind: "note", x: 0, y: 0, w: 10, h: 10 });

        const create = findRoute("POST", "/api/boards/annotations");
        const created = asJson(
            await create.handler(
                makeCtx({
                    method: "POST",
                    body: {
                        board: "b1",
                        cardId: card.id,
                        region: { x: 0, y: 0, w: 1, h: 1 },
                        intent: "fix",
                        prompt: "p",
                        status: "open",
                    },
                })
            )
        );
        const id = created.body.id as number;

        const cancel = findRoute("POST", "/api/boards/annotations/:id/cancel");
        const cancelled = asJson(await cancel.handler(makeCtx({ method: "POST", params: { id: String(id) } })));
        expect(cancelled.body.status).toBe("cancelled");

        const messages = findRoute("POST", "/api/boards/annotations/:id/messages");
        const reply = asJson(
            await messages.handler(makeCtx({ method: "POST", params: { id: String(id) }, body: { body: "hi" } }))
        );
        expect(reply.status).toBe(409);
    });

    it("capsule route renders real markdown from the annotation+card, with optional ?base= absolutizing the image URL", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s1",
            entries: [{ path: "a.png", data: buildPng(10, 10) }],
        });
        const set1 = await getSet(db, "proj", "main", "s1");
        const card = await createCard(db, "b1", {
            kind: "shot",
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            setRef: "proj/main/s1",
            setVersion: 1,
            filePath: "a.png",
            blobKey: set1.files[0].blobKey,
        });

        const create = findRoute("POST", "/api/boards/annotations");
        const created = asJson(
            await create.handler(
                makeCtx({
                    method: "POST",
                    body: {
                        board: "b1",
                        cardId: card.id,
                        region: { x: 1, y: 2, w: 3, h: 4 },
                        intent: "fix",
                        prompt: "make it blue",
                        status: "open",
                    },
                })
            )
        );
        const id = created.body.id as number;

        const capsule = findRoute("GET", "/api/boards/annotations/:id/capsule");
        const result = await capsule.handler(makeCtx({ params: { id: String(id) } }));
        expect(result.kind).toBe("text");
        if (result.kind !== "text") {
            throw new Error("expected text result");
        }
        expect(result.contentType).toBe("text/markdown");
        expect(result.body).toContain(`# boards work №${id}`);
        expect(result.body).toContain("board b1");
        expect(result.body).toContain("**Region:** 1,2 3×4 px on `a.png`");
        expect(result.body).toContain(`image: ${blobUrl(set1.files[0].blobKey)}`);
        expect(result.body).toContain("**Protocol:**");

        const ctxWithBase: RouteContext = {
            ...makeCtx({ params: { id: String(id) } }),
            query: new URLSearchParams({ base: "http://localhost:9999" }),
        };
        const withBase = await capsule.handler(ctxWithBase);
        if (withBase.kind !== "text") {
            throw new Error("expected text result");
        }
        expect(withBase.body).toContain(`image: http://localhost:9999${blobUrl(set1.files[0].blobKey)}`);

        // Soft-deleting a card doesn't cascade to its annotations — the capsule must still
        // render (matches listOpenWorkDetailed's unfiltered card lookup for the wait queue).
        await softDeleteCard(db, card.id);
        const afterDelete = await capsule.handler(makeCtx({ params: { id: String(id) } }));
        expect(afterDelete.kind).toBe("text");
    });

    it("capsule route 404s for an unknown annotation id", async () => {
        const capsule = findRoute("GET", "/api/boards/annotations/:id/capsule");
        const result = await capsule.handler(makeCtx({ params: { id: "999999" } }));
        expect(result.kind).toBe("json");
        if (result.kind === "json") {
            expect(result.status).toBe(404);
        }
    });

    it('actor fallback chain: body override > x-board-actor header > operator setting > "operator" literal', async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        const card = await createCard(db, "b1", { kind: "note", x: 0, y: 0, w: 10, h: 10 });
        const create = findRoute("POST", "/api/boards/annotations");
        const annotationBody = {
            board: "b1",
            cardId: card.id,
            region: { x: 0, y: 0, w: 1, h: 1 },
            intent: "fix",
            prompt: "p",
        };

        // No header, no operator set yet -> falls back to the literal "operator".
        const noFallback = asJson(await create.handler(makeCtx({ method: "POST", body: annotationBody })));
        expect(noFallback.body.createdBy).toBe("operator");

        // Operator setting present, no header -> uses the operator setting.
        const putOperator = findSetsRoute("PUT", "/api/boards/operator");
        await putOperator.handler(makeCtx({ method: "PUT", body: { operator: "alice" } }));
        const viaOperator = asJson(await create.handler(makeCtx({ method: "POST", body: annotationBody })));
        expect(viaOperator.body.createdBy).toBe("alice");

        // x-board-actor header present -> wins over the operator setting.
        const viaHeader = asJson(
            await create.handler(makeCtx({ method: "POST", body: annotationBody, headers: { "x-board-actor": "bob" } }))
        );
        expect(viaHeader.body.createdBy).toBe("bob");

        // Explicit body.createdBy -> wins over everything.
        const viaBody = asJson(
            await create.handler(
                makeCtx({
                    method: "POST",
                    body: { ...annotationBody, createdBy: "carol" },
                    headers: { "x-board-actor": "bob" },
                })
            )
        );
        expect(viaBody.body.createdBy).toBe("carol");
    });
});

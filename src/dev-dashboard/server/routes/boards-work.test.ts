import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnnotation } from "@app/dev-dashboard/lib/boards/annotations-store";
import { createBoard, createCard } from "@app/dev-dashboard/lib/boards/boards-store";
import { getBoardsDb, resetBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import { resetEventHub } from "@app/dev-dashboard/lib/boards/events";
import { claimOrRenewLease, dispatchBoard } from "@app/dev-dashboard/lib/boards/work-store";
import { resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { boardsWorkRoutes } from "./boards-work";

function findRoute(method: string, pattern: string): RouteDef {
    const def = boardsWorkRoutes().find((d) => d.method === method && d.pattern === pattern);
    if (!def) {
        throw new Error(`route not found: ${method} ${pattern}`);
    }
    return def;
}

function makeCtx(opts: { params?: Record<string, string>; query?: Record<string, string> }): RouteContext {
    return {
        method: "GET",
        pathname: "/",
        query: new URLSearchParams(opts.query ?? {}),
        params: opts.params ?? {},
        headers: {},
        readJson: async <T>() => ({}) as T,
        readRawBody: async () => new TextEncoder().encode("{}"),
        services: {} as RouteContext["services"],
    };
}

function asJson(result: RouteResult): { status: number; body: Record<string, unknown> } {
    if (result.kind !== "json") {
        throw new Error(`expected json result, got ${result.kind}`);
    }
    return { status: result.status, body: result.body as Record<string, unknown> };
}

const REGION = { x: 0, y: 0, w: 1, h: 1 };

describe("boardsWorkRoutes", () => {
    beforeEach(() => {
        const dir = mkdtempSync(join(tmpdir(), "boards-work-routes-"));
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

    it("(a) wait returns immediately when open work exists, capped at 3 capsules, with the right pending count", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        const card = await createCard(db, "b1", {
            kind: "shot",
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            blobKey: "h.png",
            filePath: "a.png",
        });
        for (let i = 0; i < 4; i += 1) {
            await createAnnotation(db, {
                boardSlug: "b1",
                cardId: card.id,
                region: REGION,
                intent: "fix",
                prompt: `p${i}`,
                status: "open",
            });
        }

        const wait = findRoute("GET", "/api/boards/work/wait");
        const res = asJson(await wait.handler(makeCtx({ query: { board: "b1", timeout: "5" } })));
        expect(res.status).toBe(200);
        expect((res.body.work as unknown[]).length).toBe(3);
        expect(res.body.pending).toBe(4);
    }, 10000);

    it("(b) wait with timeout=1 returns idle when there is no work", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });

        const wait = findRoute("GET", "/api/boards/work/wait");
        const res = asJson(await wait.handler(makeCtx({ query: { board: "b1", timeout: "1" } })));
        expect(res.status).toBe(200);
        expect(res.body.idle).toBe(true);
    }, 10000);

    it("(c) a staged item dispatched mid-wait wakes the wait and resolves with work", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        const card = await createCard(db, "b1", {
            kind: "shot",
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            blobKey: "h.png",
            filePath: "a.png",
        });
        await createAnnotation(db, {
            boardSlug: "b1",
            cardId: card.id,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "staged",
        });

        setTimeout(() => {
            dispatchBoard(db, "b1");
        }, 50);

        const wait = findRoute("GET", "/api/boards/work/wait");
        const res = asJson(await wait.handler(makeCtx({ query: { board: "b1", timeout: "5" } })));
        expect(res.status).toBe(200);
        expect((res.body.work as unknown[]).length).toBe(1);
    }, 10000);

    it("(d) a lease conflict returns 409 carrying the live holder", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        await claimOrRenewLease(db, { kind: "board", board: "b1" }, "session-a", "alice");

        const wait = findRoute("GET", "/api/boards/work/wait");
        const res = asJson(
            await wait.handler(makeCtx({ query: { board: "b1", timeout: "1", session: "session-b", actor: "bob" } }))
        );
        expect(res.status).toBe(409);
        expect((res.body.holder as { session: string }).session).toBe("session-a");
    }, 10000);

    it("(e) an answered question drains as a choice exactly once", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        const board = await db.kysely
            .selectFrom("boards")
            .selectAll()
            .where("slug", "=", "b1")
            .executeTakeFirstOrThrow();
        const now = new Date().toISOString();
        await db.kysely
            .insertInto("board_questions")
            .values({
                board_id: board.id,
                card_id: 0,
                prompt: "pick one",
                options: "[]",
                answer: SafeJSON.stringify(["a"]),
                answered_by: "user",
                delivered: 0,
                staged: 0,
                multi: 0,
                created_at: now,
                answered_at: now,
            })
            .execute();

        const wait = findRoute("GET", "/api/boards/work/wait");
        const first = asJson(await wait.handler(makeCtx({ query: { board: "b1", timeout: "5" } })));
        expect((first.body.choices as unknown[]).length).toBe(1);

        const second = asJson(await wait.handler(makeCtx({ query: { board: "b1", timeout: "1" } })));
        expect((second.body.choices as unknown[] | undefined)?.length ?? 0).toBe(0);
    }, 10000);

    it("GET /api/boards/work lists open items; DELETE listener releases claims", async () => {
        const db = getBoardsDb();
        await createBoard(db, { slug: "b1" });
        const card = await createCard(db, "b1", {
            kind: "shot",
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            blobKey: "h.png",
            filePath: "a.png",
        });
        await createAnnotation(db, {
            boardSlug: "b1",
            cardId: card.id,
            region: REGION,
            intent: "fix",
            prompt: "p",
            status: "open",
        });

        const list = findRoute("GET", "/api/boards/work");
        const res = asJson(await list.handler(makeCtx({ query: { board: "b1" } })));
        expect((res.body.work as unknown[]).length).toBe(1);

        const lease = await claimOrRenewLease(db, { kind: "board", board: "b1" }, "session-a", "alice");
        const del = findRoute("DELETE", "/api/boards/work/listeners/:id");
        const delRes = asJson(await del.handler(makeCtx({ params: { id: String((lease as { id: number }).id) } })));
        expect(delRes.body.reverted).toEqual([]);
    });
});

import { describe, expect, it } from "bun:test";
import { createCard, createBoard as storeCreateBoard } from "@app/dev-dashboard/lib/boards/boards-store";
import { getBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import { subscribeBoard } from "@app/dev-dashboard/lib/boards/events";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@app/utils/json";
import { boardsQuestionsRoutes } from "./boards-questions";
import { setupBoardsTestEnv } from "./boards-route-test-utils";

function findRoute(method: string, pattern: string): RouteDef {
    const def = boardsQuestionsRoutes().find((d) => d.method === method && d.pattern === pattern);
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

async function createBoard(slug: string): Promise<void> {
    await storeCreateBoard(getBoardsDb(), { slug });
}

async function create(body: unknown, slug = "b1"): Promise<{ status: number; body: Record<string, unknown> }> {
    const route = findRoute("POST", "/api/boards/:slug/questions");
    return asJson(await route.handler(makeCtx({ params: { slug }, body })));
}

describe("boardsQuestionsRoutes", () => {
    setupBoardsTestEnv("boards-questions-route-");

    it("201 questionJSON on the happy path, with otherLabel added at render time", async () => {
        await createBoard("b1");
        const res = await create({ prompt: "pick one", options: ["a", "b"] });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            prompt: "pick one",
            options: [{ label: "a" }, { label: "b" }],
            otherLabel: "Other / Něco jiného",
            staged: true,
        });
        expect(res.body.id).toEqual(expect.any(Number));
        expect(res.body.multi).toBe(false);
    });

    it("400 when the prompt is missing or over 1000 chars", async () => {
        await createBoard("b1");
        expect((await create({ prompt: "", options: ["a"] })).status).toBe(400);
        expect((await create({ prompt: "x".repeat(1001), options: ["a"] })).status).toBe(400);
    });

    it("422 when options is empty or over 12 entries", async () => {
        await createBoard("b1");
        expect((await create({ prompt: "pick one", options: [] })).status).toBe(422);
        const many = Array.from({ length: 13 }, (_, i) => `opt${i}`);
        expect((await create({ prompt: "pick one", options: many })).status).toBe(422);
    });

    it("404 when cardId is not a live card on this board", async () => {
        await createBoard("b1");
        const res = await create({ prompt: "pick one", options: ["a"], cardId: 999 });
        expect(res.status).toBe(404);
    });

    it("anchors to a live card when cardId is given", async () => {
        await createBoard("b1");
        const card = await createCard(getBoardsDb(), "b1", { kind: "note", x: 0, y: 0, w: 10, h: 10 });
        const res = await create({ prompt: "pick one", options: ["a"], cardId: card.id });
        expect(res.status).toBe(201);
        expect(res.body.cardId).toBe(card.id);
    });

    it("GET lists a board's questions oldest-first", async () => {
        await createBoard("b1");
        const first = await create({ prompt: "first", options: ["a"] });
        const second = await create({ prompt: "second", options: ["a"] });
        const route = findRoute("GET", "/api/boards/:slug/questions");
        const res = asJson(await route.handler(makeCtx({ params: { slug: "b1" } })));
        expect(res.status).toBe(200);
        const ids = (res.body.questions as Array<{ id: number }>).map((q) => q.id);
        expect(ids).toEqual([first.body.id as number, second.body.id as number]);
    });

    it("answer: 200, staged remains true (dispatch releases it, not the answer), wraps a single string", async () => {
        await createBoard("b1");
        const created = await create({ prompt: "pick one", options: ["picked", "other"] });
        const answerRoute = findRoute("POST", "/api/boards/questions/:id/answer");
        const res = asJson(
            await answerRoute.handler(makeCtx({ params: { id: String(created.body.id) }, body: { answer: "picked" } }))
        );
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ answer: ["picked"], staged: true, answeredBy: "operator" });
    });

    it("answer: 400 when empty or over 500 chars; any string is otherwise accepted (off-vocabulary 'Other' text)", async () => {
        await createBoard("b1");
        const created = await create({ prompt: "pick one", options: ["picked"] });
        const answerRoute = findRoute("POST", "/api/boards/questions/:id/answer");
        expect(
            asJson(
                await answerRoute.handler(makeCtx({ params: { id: String(created.body.id) }, body: { answer: "" } }))
            ).status
        ).toBe(400);
        expect(
            asJson(
                await answerRoute.handler(
                    makeCtx({ params: { id: String(created.body.id) }, body: { answer: "x".repeat(501) } })
                )
            ).status
        ).toBe(400);
        const offVocab = asJson(
            await answerRoute.handler(
                makeCtx({ params: { id: String(created.body.id) }, body: { answer: "totally different text" } })
            )
        );
        expect(offVocab.status).toBe(200);
    });

    it("answer: 400 on a malformed multi-select answer; a subsequent read stays clean", async () => {
        await createBoard("b1");
        const created = await create({ prompt: "pick some", options: ["a", "b"], multiSelect: true });
        const answerRoute = findRoute("POST", "/api/boards/questions/:id/answer");
        const res = asJson(
            await answerRoute.handler(
                makeCtx({ params: { id: String(created.body.id) }, body: { answer: "not a json array" } })
            )
        );
        expect(res.status).toBe(400);

        const listRoute = findRoute("GET", "/api/boards/:slug/questions");
        const listRes = asJson(await listRoute.handler(makeCtx({ params: { slug: "b1" } })));
        expect(listRes.status).toBe(200);
        expect((listRes.body.questions as Array<{ answer: unknown }>)[0].answer).toBeNull();
    });

    it("answer: 404 on an unknown question id", async () => {
        const answerRoute = findRoute("POST", "/api/boards/questions/:id/answer");
        const res = asJson(await answerRoute.handler(makeCtx({ params: { id: "999" }, body: { answer: "picked" } })));
        expect(res.status).toBe(404);
    });

    it("emits a `question` SSE event on create and on answer", async () => {
        await createBoard("b1");
        const events: string[] = [];
        subscribeBoard("b1", (frame) =>
            events.push((SafeJSON.parse(frame, { strict: true }) as { type: string }).type)
        );
        const created = await create({ prompt: "pick one", options: ["picked"] });
        const answerRoute = findRoute("POST", "/api/boards/questions/:id/answer");
        await answerRoute.handler(makeCtx({ params: { id: String(created.body.id) }, body: { answer: "picked" } }));
        expect(events.filter((t) => t === "question").length).toBe(2);
    });
});

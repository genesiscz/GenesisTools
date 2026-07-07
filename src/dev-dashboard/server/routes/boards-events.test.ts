import { describe, expect, it } from "bun:test";
import { publishBoardEvent, resetEventHub } from "@app/dev-dashboard/lib/boards/events";
import type { RouteContext, RouteDef, SseEmitter } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@app/utils/json";
import { boardsRoutes } from "./boards";

function findRoute(method: string, pattern: string): RouteDef {
    const def = boardsRoutes().find((d) => d.method === method && d.pattern === pattern);
    if (!def) {
        throw new Error(`route not found: ${method} ${pattern}`);
    }
    return def;
}

function makeCtx(params: Record<string, string>): RouteContext {
    return {
        method: "GET",
        pathname: "/",
        query: new URLSearchParams(),
        params,
        headers: {},
        readJson: async <T>() => ({}) as T,
        readRawBody: async () => new TextEncoder().encode("{}"),
        services: {} as RouteContext["services"],
    };
}

describe("board SSE events route", () => {
    it("relays publishBoardEvent frames to the stream and unsubscribes on close", async () => {
        resetEventHub();
        const route = findRoute("GET", "/api/boards/:slug/events");
        const result = await route.handler(makeCtx({ slug: "b1" }));
        if (result.kind !== "sse") {
            throw new Error(`expected sse result, got ${result.kind}`);
        }

        const dataFrames: string[] = [];
        const comments: string[] = [];
        const emit: SseEmitter = {
            data: (payload) => dataFrames.push(payload),
            comment: (text) => comments.push(text),
        };
        const handle = result.start(emit);

        expect(comments).toEqual([" board b1 stream open"]);

        publishBoardEvent("b1", { type: "card", payload: { id: 1 } });
        expect(dataFrames.length).toBe(1);
        expect(SafeJSON.parse(dataFrames[0], { strict: true })).toEqual({ type: "card", payload: { id: 1 } });

        handle.close();
        publishBoardEvent("b1", { type: "card", payload: { id: 2 } });
        expect(dataFrames.length).toBe(1); // no further delivery after close/unsubscribe

        resetEventHub();
    });

    it("does not relay events published to a different board", async () => {
        resetEventHub();
        const route = findRoute("GET", "/api/boards/:slug/events");
        const result = await route.handler(makeCtx({ slug: "b1" }));
        if (result.kind !== "sse") {
            throw new Error(`expected sse result, got ${result.kind}`);
        }

        const dataFrames: string[] = [];
        const handle = result.start({ data: (p) => dataFrames.push(p), comment: () => {} });

        publishBoardEvent("other-board", { type: "card", payload: {} });
        expect(dataFrames.length).toBe(0);

        handle.close();
        resetEventHub();
    });
});

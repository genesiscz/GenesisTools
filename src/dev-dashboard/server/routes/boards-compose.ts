import { type ComposeBody, composeBoard } from "@app/dev-dashboard/lib/boards/compose-store";
import { getBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import { publishBoardEvent } from "@app/dev-dashboard/lib/boards/events";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { boardsError } from "./boards-errors";
import { getOperator } from "./boards-sets";

/** Compose error code → HTTP status (handlers_compose.go); everything else is a 400. */
const STATUS_BY_CODE: Record<string, number> = { limit: 413, not_found: 404, not_ai_layer: 403 };

async function actorOf(header: string | undefined): Promise<string> {
    if (header) {
        return header;
    }
    return (await getOperator()) || "claude";
}

export function boardsComposeRoutes(): RouteDef[] {
    return [
        {
            method: "POST",
            pattern: "/api/boards/:slug/compose",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<ComposeBody>();
                    const actor = await actorOf(ctx.headers["x-board-actor"]);
                    const result = await composeBoard(getBoardsDb(), ctx.params.slug, body, actor);
                    if (!result.ok) {
                        const status = STATUS_BY_CODE[result.code] ?? 400;
                        return {
                            kind: "json",
                            status,
                            body: { error: result.message, code: result.code, index: result.index },
                        };
                    }
                    // SSE publishes AFTER the transaction commits.
                    if (result.events.cards.length > 0) {
                        publishBoardEvent(ctx.params.slug, { type: "cards", payload: result.events.cards });
                    }
                    for (const edge of result.events.edges) {
                        publishBoardEvent(ctx.params.slug, { type: "edge", payload: edge });
                    }
                    for (const question of result.events.questions) {
                        publishBoardEvent(ctx.params.slug, { type: "question", payload: question });
                    }
                    return {
                        kind: "json",
                        status: 201,
                        body: {
                            cards: result.cards,
                            edges: result.edges,
                            questions: result.questions,
                            region: result.region,
                        },
                    };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
    ];
}

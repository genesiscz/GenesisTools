import { resolve } from "node:path";
import { getBoardDoc } from "@app/dev-dashboard/lib/boards/boards-store";
import {
    type ComposeBody,
    composeBoard,
    type UpdateCardsBody,
    updateCards,
} from "@app/dev-dashboard/lib/boards/compose-store";
import { getBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import { publishBoardEvent } from "@app/dev-dashboard/lib/boards/events";
import { type ArrangeBody, runArrange } from "@app/dev-dashboard/lib/boards/layout-engine";
import { scrapeBoard } from "@app/dev-dashboard/lib/boards/scrape";
import { boardPageUrl } from "@app/dev-dashboard/lib/public-base";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { logger } from "@app/logger";
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

const TEMPLATES_PATH = resolve(import.meta.dirname, "../static/boards-templates.md");

export function boardsComposeRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/boards/templates.md",
            handler: async () => {
                try {
                    const body = await Bun.file(TEMPLATES_PATH).text();
                    return { kind: "text", status: 200, contentType: "text/markdown", body };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/:slug/compose",
            handler: async (ctx) => {
                try {
                    const body = (await ctx.readJson<ComposeBody>()) ?? ({} as ComposeBody);
                    const actor = await actorOf(ctx.headers["x-board-actor"]);
                    const result = await composeBoard(getBoardsDb(), ctx.params.slug, body, actor);
                    if (!result.ok) {
                        const status = STATUS_BY_CODE[result.code] ?? 400;
                        logger.warn(
                            {
                                slug: ctx.params.slug,
                                actor,
                                code: result.code,
                                index: result.index,
                                message: result.message,
                            },
                            "boards compose: rejected"
                        );
                        return {
                            kind: "json",
                            status,
                            body: { error: result.message, code: result.code, index: result.index },
                        };
                    }
                    logger.info(
                        {
                            slug: ctx.params.slug,
                            actor,
                            section: body.section,
                            layout: body.layout,
                            cards: result.cards.length,
                            edges: result.edges.length,
                            questions: result.questions.length,
                        },
                        "boards compose: placed"
                    );
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
                            url: await boardPageUrl(ctx.params.slug),
                        },
                    };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/:slug/update-cards",
            handler: async (ctx) => {
                try {
                    const body = (await ctx.readJson<UpdateCardsBody>()) ?? ({} as UpdateCardsBody);
                    const result = await updateCards(getBoardsDb(), ctx.params.slug, body);
                    if (!result.ok) {
                        const status = STATUS_BY_CODE[result.code] ?? 400;
                        logger.warn(
                            { slug: ctx.params.slug, code: result.code, message: result.message },
                            "boards update-cards: rejected"
                        );
                        return {
                            kind: "json",
                            status,
                            body: { error: result.message, code: result.code, index: result.index },
                        };
                    }
                    logger.info(
                        {
                            slug: ctx.params.slug,
                            patched: result.patched,
                            removed: result.removed,
                            restored: result.restored,
                        },
                        "boards update-cards: applied"
                    );
                    for (const card of result.events.cards) {
                        publishBoardEvent(ctx.params.slug, { type: "card", payload: card });
                    }
                    for (const id of result.events.deleted) {
                        publishBoardEvent(ctx.params.slug, { type: "card_deleted", payload: { id } });
                    }
                    return {
                        kind: "json",
                        status: 200,
                        body: { ok: true, patched: result.patched, removed: result.removed, restored: result.restored },
                    };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/:slug/scrape",
            handler: async (ctx) => {
                try {
                    const doc = await getBoardDoc(getBoardsDb(), ctx.params.slug);
                    const result = scrapeBoard({
                        doc,
                        base: ctx.query.get("base") ?? "",
                        section: ctx.query.get("section") ?? undefined,
                        diff: ctx.query.get("diff") ?? undefined,
                    });
                    if (!result.ok) {
                        return { kind: "json", status: result.status, body: { error: result.message } };
                    }
                    return { kind: "json", status: 200, body: result.body };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/:slug/arrange",
            handler: async (ctx) => {
                try {
                    const body = (await ctx.readJson<ArrangeBody>()) ?? ({} as ArrangeBody);
                    const outcome = await runArrange(getBoardsDb(), ctx.params.slug, body);
                    if (!outcome.ok) {
                        logger.warn(
                            { slug: ctx.params.slug, mode: body.mode, scope: body.scope, message: outcome.message },
                            "boards arrange: rejected"
                        );
                        return { kind: "json", status: outcome.status, body: { error: outcome.message } };
                    }
                    logger.info(
                        {
                            slug: ctx.params.slug,
                            mode: body.mode,
                            scope: body.scope,
                            moved: outcome.moved,
                            saved: outcome.saved,
                        },
                        "boards arrange: applied"
                    );
                    // runArrange publishes the layout/card SSE events itself (after its writes commit).
                    return {
                        kind: "json",
                        status: 200,
                        body: { ok: true, moved: outcome.moved, cards: outcome.cards, saved: outcome.saved },
                    };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
    ];
}

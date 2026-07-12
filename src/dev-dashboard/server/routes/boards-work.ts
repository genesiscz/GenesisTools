import { getBoardDoc } from "@app/dev-dashboard/lib/boards/boards-store";
import { buildCapsule } from "@app/dev-dashboard/lib/boards/capsule";
import { getBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import { waitForWorkSignal } from "@app/dev-dashboard/lib/boards/events";
import type { WorkScope } from "@app/dev-dashboard/lib/boards/types";
import {
    claimOrRenewLease,
    drainChoices,
    listListeners,
    listOpenWorkDetailed,
    listWork,
    reapExpiredListeners,
    releaseLease,
} from "@app/dev-dashboard/lib/boards/work-store";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { logger } from "@app/logger";
import { boardsError } from "./boards-errors";

function parseScope(q: URLSearchParams): WorkScope | null {
    if (q.get("all") === "1") {
        return { kind: "all" };
    }
    const board = q.get("board");
    if (board) {
        return { kind: "board", board };
    }
    const project = q.get("project");
    if (project) {
        return { kind: "project", project, branch: q.get("branch") ?? "" };
    }
    return null;
}

export function boardsWorkRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/boards/work",
            handler: async (ctx) => {
                const filter = {
                    status: ctx.query.get("status") ?? undefined,
                    board: ctx.query.get("board") ?? undefined,
                    project: ctx.query.get("project") ?? undefined,
                    branch: ctx.query.get("branch") ?? undefined,
                };
                const work = await listWork(getBoardsDb(), filter);
                logger.debug({ ...filter, count: work.length }, "boards work: list");
                return { kind: "json", status: 200, body: { work } };
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/work/wait",
            longLived: true,
            handler: async (ctx) => {
                try {
                    const db = getBoardsDb();
                    const rawTimeout = Number(ctx.query.get("timeout") ?? "25");
                    const timeoutSec = Math.min(55, Math.max(1, Number.isNaN(rawTimeout) ? 25 : rawTimeout));
                    const scope = parseScope(ctx.query);
                    const session = ctx.query.get("session") ?? "";
                    const actor = ctx.query.get("actor") ?? "";
                    const takeover = ctx.query.get("takeover") === "1";

                    logger.debug({ scope, session, actor, timeoutSec, takeover }, "boards wait: armed");

                    if (session && !scope) {
                        logger.warn({ session, actor }, "boards wait: leased wait without a scope rejected");
                        return {
                            kind: "json",
                            status: 400,
                            body: { error: "leased waits require a scope (board | project | all=1)" },
                        };
                    }

                    const startedAt = Date.now();
                    const deadline = startedAt + timeoutSec * 1000;
                    let leaseId: number | undefined;
                    for (;;) {
                        await reapExpiredListeners(db);
                        if (session && scope) {
                            const lease = await claimOrRenewLease(db, scope, session, actor, takeover);
                            if (lease.conflict) {
                                logger.warn(
                                    {
                                        scope,
                                        session,
                                        actor,
                                        takeover,
                                        holderId: lease.holder.id,
                                        holderSession: lease.holder.session,
                                        holderLastSeen: lease.holder.lastSeen,
                                        live: lease.live,
                                    },
                                    "boards wait: lease conflict"
                                );
                                return {
                                    kind: "json",
                                    status: 409,
                                    body: {
                                        error: lease.live
                                            ? "scope held by a live listener"
                                            : "scope held by an expired listener — retry with takeover=1 to steal it",
                                        live: lease.live,
                                        holder: lease.holder,
                                    },
                                };
                            }
                            leaseId = lease.id;
                        }
                        const effectiveScope = scope ?? ({ kind: "all" } as const);
                        const { items, total } = await listOpenWorkDetailed(db, effectiveScope, 3);
                        const choices = await drainChoices(db, effectiveScope);
                        if (items.length > 0 || choices.length > 0) {
                            const docCache = new Map<string, ReturnType<typeof getBoardDoc>>();
                            const docFor = (slug: string) => {
                                let doc = docCache.get(slug);
                                if (!doc) {
                                    doc = getBoardDoc(db, slug);
                                    docCache.set(slug, doc);
                                }
                                return doc;
                            };
                            const work = await Promise.all(
                                items.map(async (it) => {
                                    const doc = await docFor(it.boardSlug);
                                    return {
                                        id: it.annotation.id,
                                        board: it.boardSlug,
                                        capsule: buildCapsule(it.annotation, it.card, it.boardSlug, {
                                            boardCards: doc.cards,
                                        }),
                                    };
                                })
                            );
                            logger.info(
                                {
                                    scope,
                                    session,
                                    listener: leaseId,
                                    workIds: work.map((w) => w.id),
                                    choiceIds: choices.map((c) => c.id),
                                    pending: total,
                                    waitedMs: Date.now() - startedAt,
                                },
                                "boards wait: returning work"
                            );
                            return {
                                kind: "json",
                                status: 200,
                                body: {
                                    work,
                                    choices,
                                    pending: total,
                                    ...(leaseId ? { listener: leaseId } : {}),
                                },
                            };
                        }
                        const remaining = deadline - Date.now();
                        if (remaining <= 0) {
                            logger.debug(
                                { scope, session, listener: leaseId, waitedMs: Date.now() - startedAt },
                                "boards wait: idle timeout"
                            );
                            return {
                                kind: "json",
                                status: 200,
                                body: { idle: true, ...(leaseId ? { listener: leaseId } : {}) },
                            };
                        }
                        await waitForWorkSignal(Math.min(remaining, 10_000));
                    }
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/work/listeners",
            handler: async () => {
                const listeners = await listListeners(getBoardsDb());
                return { kind: "json", status: 200, body: { listeners } };
            },
        },
        {
            method: "DELETE",
            pattern: "/api/boards/work/listeners/:id",
            handler: async (ctx) => {
                const id = Number(ctx.params.id);
                if (!Number.isInteger(id)) {
                    logger.warn({ raw: ctx.params.id }, "boards listeners: delete with invalid id");
                    return { kind: "json", status: 400, body: { error: "invalid listener id" } };
                }

                const reverted = await releaseLease(getBoardsDb(), id);
                logger.info({ id, reverted }, "boards listeners: lease released via DELETE");
                return { kind: "json", status: 200, body: { reverted } };
            },
        },
    ];
}

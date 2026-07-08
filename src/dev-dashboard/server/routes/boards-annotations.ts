import {
    addAttempt,
    addMessage,
    addRevision,
    cancelAnnotation,
    createAnnotation,
    deleteAnnotation,
    getAnnotation,
    patchAnnotation,
    reactivateAnnotation,
    setVerdict,
} from "@app/dev-dashboard/lib/boards/annotations-store";
import { getCard } from "@app/dev-dashboard/lib/boards/boards-store";
import { buildCapsule } from "@app/dev-dashboard/lib/boards/capsule";
import { getBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import { publishBoardEvent, wakeWorkWaiters } from "@app/dev-dashboard/lib/boards/events";
import { getSet, getSetFile, setRefOf } from "@app/dev-dashboard/lib/boards/sets-store";
import type { Region } from "@app/dev-dashboard/lib/boards/types";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { boardsError } from "./boards-errors";
import { actorFrom } from "./boards-sets";

async function listenerIdForSession(session: string | undefined): Promise<number | undefined> {
    if (!session) {
        return undefined;
    }

    const row = await getBoardsDb()
        .kysely.selectFrom("listeners")
        .select("id")
        .where("session", "=", session)
        .orderBy("id", "desc")
        .executeTakeFirst();
    return row?.id;
}

export function boardsAnnotationsRoutes(): RouteDef[] {
    return [
        {
            method: "POST",
            pattern: "/api/boards/annotations",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{
                        board: string;
                        cardId: number;
                        region: Region;
                        intent: string;
                        intentOther?: string;
                        prompt: string;
                        createdBy?: string;
                        status?: "staged" | "open";
                    }>();
                    const annotation = await createAnnotation(getBoardsDb(), {
                        boardSlug: body.board,
                        cardId: body.cardId,
                        region: body.region,
                        intent: body.intent,
                        intentOther: body.intentOther,
                        prompt: body.prompt,
                        createdBy: body.createdBy ?? (await actorFrom(ctx)),
                        status: body.status,
                    });
                    publishBoardEvent(annotation.boardSlug, { type: "annotation", payload: annotation });
                    if (annotation.status === "open") {
                        wakeWorkWaiters();
                    }
                    return { kind: "json", status: 201, body: annotation };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/annotations/:id",
            handler: async (ctx) => {
                try {
                    const annotation = await getAnnotation(getBoardsDb(), Number(ctx.params.id));
                    return { kind: "json", status: 200, body: annotation };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "PATCH",
            pattern: "/api/boards/annotations/:id",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const body = await ctx.readJson<{
                        status?: string;
                        region?: Region;
                        session?: string;
                        actor?: string;
                    }>();
                    const claimedListener =
                        body.status === "working" ? await listenerIdForSession(body.session) : undefined;
                    const annotation = await patchAnnotation(getBoardsDb(), id, {
                        status: body.status,
                        region: body.region,
                        claimedBy: body.actor ?? "claude",
                        claimedListener,
                    });
                    if (body.status !== undefined) {
                        publishBoardEvent(annotation.boardSlug, {
                            type: "status",
                            payload: { id, status: annotation.status },
                        });
                    }
                    if (body.region !== undefined) {
                        publishBoardEvent(annotation.boardSlug, { type: "annotation", payload: annotation });
                    }
                    return { kind: "json", status: 200, body: annotation };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/annotations/:id/cancel",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const annotation = await cancelAnnotation(getBoardsDb(), id);
                    publishBoardEvent(annotation.boardSlug, {
                        type: "status",
                        payload: { id, status: annotation.status },
                    });
                    return { kind: "json", status: 200, body: annotation };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/annotations/:id/reactivate",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const annotation = await reactivateAnnotation(getBoardsDb(), id);
                    publishBoardEvent(annotation.boardSlug, {
                        type: "status",
                        payload: { id, status: annotation.status },
                    });
                    return { kind: "json", status: 200, body: annotation };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "DELETE",
            pattern: "/api/boards/annotations/:id",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const annotation = await getAnnotation(getBoardsDb(), id);
                    await deleteAnnotation(getBoardsDb(), id);
                    publishBoardEvent(annotation.boardSlug, { type: "annotation_deleted", payload: { id } });
                    return { kind: "json", status: 200, body: { ok: true } };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/annotations/:id/capsule",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const annotation = await getAnnotation(getBoardsDb(), id);
                    const card = await getCard(getBoardsDb(), annotation.cardId);
                    const capsule = buildCapsule(annotation, card, annotation.boardSlug);
                    const base = ctx.query.get("base");
                    const body = base ? capsule.replace("image: /api/", `image: ${base}/api/`) : capsule;
                    return { kind: "text", status: 200, contentType: "text/markdown", body };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/annotations/:id/revisions",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const body = await ctx.readJson<{ prompt: string }>();
                    const annotation = await addRevision(getBoardsDb(), id, {
                        prompt: body.prompt,
                        createdBy: await actorFrom(ctx),
                    });
                    publishBoardEvent(annotation.boardSlug, { type: "annotation", payload: annotation });
                    return { kind: "json", status: 200, body: annotation };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/annotations/:id/messages",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const body = await ctx.readJson<{ body: string; author?: string }>();
                    const before = await getAnnotation(getBoardsDb(), id);
                    const author = body.author ?? (await actorFrom(ctx));
                    const message = await addMessage(getBoardsDb(), { annotationId: id, author, body: body.body });
                    publishBoardEvent(before.boardSlug, { type: "message", payload: message });

                    const after = await getAnnotation(getBoardsDb(), id);
                    if (after.status !== before.status) {
                        publishBoardEvent(before.boardSlug, { type: "status", payload: { id, status: after.status } });
                        wakeWorkWaiters();
                    }
                    return { kind: "json", status: 201, body: message };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/annotations/:id/attempts",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const body = await ctx.readJson<{
                        project: string;
                        branch: string;
                        selector: string;
                        file: string;
                        agent?: string;
                        commit?: string;
                    }>();
                    const set = await getSet(getBoardsDb(), body.project, body.branch, body.selector);
                    const file = await getSetFile(getBoardsDb(), set.id, body.file);
                    if (!file) {
                        return { kind: "json", status: 404, body: { error: `file not found in set: ${body.file}` } };
                    }

                    const result = await addAttempt(getBoardsDb(), {
                        annotationId: id,
                        afterSetRef: setRefOf(set),
                        afterVersion: set.version,
                        afterFile: body.file,
                        afterBlobKey: file.blobKey,
                        afterWidth: file.width,
                        afterHeight: file.height,
                        agent: body.agent,
                        commitRef: body.commit,
                    });
                    const annotation = await getAnnotation(getBoardsDb(), id);
                    publishBoardEvent(annotation.boardSlug, { type: "attempt", payload: result.attempt });
                    publishBoardEvent(annotation.boardSlug, { type: "card", payload: result.card });
                    return { kind: "json", status: 201, body: result };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/attempts/:id/verdict",
            handler: async (ctx) => {
                try {
                    const attemptId = Number(ctx.params.id);
                    const body = await ctx.readJson<{ verdict: "accept" | "reject" }>();
                    const result = await setVerdict(getBoardsDb(), attemptId, body.verdict);
                    publishBoardEvent(result.annotation.boardSlug, { type: "attempt", payload: result.attempt });
                    if (body.verdict === "accept") {
                        publishBoardEvent(result.annotation.boardSlug, {
                            type: "status",
                            payload: { id: result.annotation.id, status: result.annotation.status },
                        });
                    } else {
                        // reject may roll the face back (card event) and re-stages the thread (status event).
                        publishBoardEvent(result.annotation.boardSlug, { type: "card", payload: result.card });
                        publishBoardEvent(result.annotation.boardSlug, {
                            type: "status",
                            payload: { id: result.annotation.id, status: result.annotation.status },
                        });
                    }
                    return { kind: "json", status: 200, body: result };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
    ];
}

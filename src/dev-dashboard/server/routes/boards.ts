import { addMessage } from "@app/dev-dashboard/lib/boards/annotations-store";
import { mimeForPath, putBlob } from "@app/dev-dashboard/lib/boards/blobs";
import {
    addEdge,
    addStrokes,
    bulkLayout,
    createBoard,
    createCard,
    deleteEdge,
    deleteStroke,
    getBoardDoc,
    importSet,
    listBoards,
    listCardVersions,
    listTrash,
    patchBoard,
    patchCard,
    patchStroke,
    RESERVED_SLUGS,
    restoreCard,
    softDeleteCard,
    syncSetCards,
} from "@app/dev-dashboard/lib/boards/boards-store";
import { getBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import { publishBoardEvent, subscribeBoard } from "@app/dev-dashboard/lib/boards/events";
import { readImageDims } from "@app/dev-dashboard/lib/boards/image-size";
import { notifyLayoutChanged } from "@app/dev-dashboard/lib/boards/layout-engine";
import { sectionsToJSON } from "@app/dev-dashboard/lib/boards/sections";
import { getSet } from "@app/dev-dashboard/lib/boards/sets-store";
import type { MessageAttachmentDto } from "@app/dev-dashboard/lib/boards/types";
import { dispatchBoard } from "@app/dev-dashboard/lib/boards/work-store";
import { publicBaseUrl } from "@app/dev-dashboard/lib/public-base";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { boardsError } from "./boards-errors";
import { actorFrom } from "./boards-sets";

const UPLOAD_MAX_WIDTH = 480;

async function boardSlugForCardId(cardId: number): Promise<string | null> {
    const row = await getBoardsDb()
        .kysely.selectFrom("board_cards")
        .innerJoin("boards", "boards.id", "board_cards.board_id")
        .select("boards.slug")
        .where("board_cards.id", "=", cardId)
        .executeTakeFirst();
    return row?.slug ?? null;
}

async function boardSlugForStrokeId(strokeId: number): Promise<string | null> {
    const row = await getBoardsDb()
        .kysely.selectFrom("board_strokes")
        .innerJoin("boards", "boards.id", "board_strokes.board_id")
        .select("boards.slug")
        .where("board_strokes.id", "=", strokeId)
        .executeTakeFirst();
    return row?.slug ?? null;
}

async function boardSlugForEdgeId(edgeId: number): Promise<string | null> {
    const row = await getBoardsDb()
        .kysely.selectFrom("board_edges")
        .innerJoin("boards", "boards.id", "board_edges.board_id")
        .select("boards.slug")
        .where("board_edges.id", "=", edgeId)
        .executeTakeFirst();
    return row?.slug ?? null;
}

export function boardsRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/boards",
            handler: async (ctx) => {
                const project = ctx.query.get("project") ?? undefined;
                const boards = await listBoards(getBoardsDb(), project);
                // Each row carries its user-facing page url (public host when configured) so
                // clients relay the authoritative link instead of assembling one from the
                // loopback base they called in on.
                const base = await publicBaseUrl();
                return {
                    kind: "json",
                    status: 200,
                    body: { boards: boards.map((b) => ({ ...b, url: `${base}/boards/${b.slug}` })) },
                };
            },
        },
        {
            method: "POST",
            pattern: "/api/boards",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{
                        slug: string;
                        title?: string;
                        boardType?: string;
                        project?: string;
                    }>();
                    const board = await createBoard(getBoardsDb(), body);
                    const url = `${await publicBaseUrl()}/boards/${board.slug}`;
                    return { kind: "json", status: 201, body: { ...board, url } };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/:slug",
            handler: async (ctx) => {
                // Belt-and-braces: static-prefix boards routes (sets/work/annotations/...) are
                // registered before this catch-all, so this never fires in practice — but it's
                // cheap insurance against a router that scores/sorts instead of first-matching.
                if (RESERVED_SLUGS.has(ctx.params.slug)) {
                    return { kind: "json", status: 404, body: { error: "not found" } };
                }
                try {
                    const doc = await getBoardDoc(getBoardsDb(), ctx.params.slug);
                    return { kind: "json", status: 200, body: doc };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/:slug/sections",
            handler: async (ctx) => {
                try {
                    const doc = await getBoardDoc(getBoardsDb(), ctx.params.slug);
                    return { kind: "json", status: 200, body: sectionsToJSON(doc.cards) };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "PATCH",
            pattern: "/api/boards/:slug",
            handler: async (ctx) => {
                if (RESERVED_SLUGS.has(ctx.params.slug)) {
                    return { kind: "json", status: 404, body: { error: "not found" } };
                }
                try {
                    const body = await ctx.readJson<{ title?: string; project?: string; archived?: boolean }>();
                    const board = await patchBoard(getBoardsDb(), ctx.params.slug, body);
                    return { kind: "json", status: 200, body: board };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/:slug/trash",
            handler: async (ctx) => {
                try {
                    const cards = await listTrash(getBoardsDb(), ctx.params.slug);
                    return { kind: "json", status: 200, body: { cards } };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/:slug/cards",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{
                        kind: string;
                        x: number;
                        y: number;
                        w: number;
                        h: number;
                        z?: number;
                        setRef?: string;
                        setVersion?: number;
                        filePath?: string;
                        blobKey?: string;
                        payload?: Record<string, unknown>;
                        createdBy?: string;
                    }>();
                    const card = await createCard(getBoardsDb(), ctx.params.slug, {
                        ...body,
                        createdBy: body.createdBy ?? (await actorFrom(ctx)),
                    });
                    publishBoardEvent(ctx.params.slug, { type: "card", payload: card });
                    notifyLayoutChanged(getBoardsDb(), ctx.params.slug);
                    return { kind: "json", status: 201, body: card };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "PATCH",
            pattern: "/api/boards/cards/:id",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const body =
                        await ctx.readJson<
                            Partial<{
                                x: number;
                                y: number;
                                w: number;
                                h: number;
                                z: number;
                                payload: Record<string, unknown>;
                            }>
                        >();
                    const card = await patchCard(getBoardsDb(), id, body);
                    const slug = await boardSlugForCardId(id);
                    if (slug) {
                        publishBoardEvent(slug, { type: "card", payload: card });
                        notifyLayoutChanged(getBoardsDb(), slug);
                    }
                    return { kind: "json", status: 200, body: card };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "DELETE",
            pattern: "/api/boards/cards/:id",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const slug = await boardSlugForCardId(id);
                    await softDeleteCard(getBoardsDb(), id);
                    if (slug) {
                        publishBoardEvent(slug, { type: "card_deleted", payload: { id } });
                        notifyLayoutChanged(getBoardsDb(), slug);
                    }
                    return { kind: "json", status: 200, body: { ok: true } };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/cards/:id/restore",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const card = await restoreCard(getBoardsDb(), id);
                    const slug = await boardSlugForCardId(id);
                    if (slug) {
                        publishBoardEvent(slug, { type: "card", payload: card });
                        notifyLayoutChanged(getBoardsDb(), slug);
                    }
                    return { kind: "json", status: 200, body: card };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/cards/:id/versions",
            handler: async (ctx) => {
                try {
                    const versions = await listCardVersions(getBoardsDb(), Number(ctx.params.id));
                    return { kind: "json", status: 200, body: { versions } };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/:slug/strokes",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{
                        strokes: Array<{
                            cardId?: number;
                            path: number[][];
                            color?: string;
                            width?: number;
                            createdBy?: string;
                        }>;
                    }>();
                    const actor = await actorFrom(ctx);
                    const strokes = await addStrokes(
                        getBoardsDb(),
                        ctx.params.slug,
                        body.strokes.map((s) => ({ ...s, createdBy: s.createdBy ?? actor }))
                    );
                    publishBoardEvent(ctx.params.slug, { type: "strokes", payload: strokes });
                    return { kind: "json", status: 201, body: { strokes } };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "PATCH",
            pattern: "/api/boards/strokes/:id",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const body = await ctx.readJson<Partial<{ path: number[][]; color: string; width: number }>>();
                    const stroke = await patchStroke(getBoardsDb(), id, body);
                    const slug = await boardSlugForStrokeId(id);
                    if (slug) {
                        publishBoardEvent(slug, { type: "stroke", payload: stroke });
                    }
                    return { kind: "json", status: 200, body: stroke };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "DELETE",
            pattern: "/api/boards/strokes/:id",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const slug = await boardSlugForStrokeId(id);
                    await deleteStroke(getBoardsDb(), id);
                    if (slug) {
                        publishBoardEvent(slug, { type: "stroke_deleted", payload: { id } });
                    }
                    return { kind: "json", status: 200, body: { ok: true } };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/:slug/edges",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{
                        fromCard: number;
                        toCard?: number;
                        toX?: number;
                        toY?: number;
                        label?: string;
                        createdBy?: string;
                    }>();
                    const edge = await addEdge(getBoardsDb(), ctx.params.slug, {
                        ...body,
                        createdBy: body.createdBy ?? (await actorFrom(ctx)),
                    });
                    publishBoardEvent(ctx.params.slug, { type: "edge", payload: edge });
                    return { kind: "json", status: 201, body: edge };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "DELETE",
            pattern: "/api/boards/edges/:id",
            handler: async (ctx) => {
                try {
                    const id = Number(ctx.params.id);
                    const slug = await boardSlugForEdgeId(id);
                    await deleteEdge(getBoardsDb(), id);
                    if (slug) {
                        publishBoardEvent(slug, { type: "edge_deleted", payload: { id } });
                    }
                    return { kind: "json", status: 200, body: { ok: true } };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/:slug/layout",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ moves: Array<{ id: number; x: number; y: number }> }>();
                    await bulkLayout(getBoardsDb(), ctx.params.slug, body.moves);
                    publishBoardEvent(ctx.params.slug, { type: "layout", payload: { moves: body.moves } });
                    return { kind: "json", status: 200, body: { ok: true } };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/:slug/import-set",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ project: string; branch: string; selector: string }>();
                    const set = await getSet(getBoardsDb(), body.project, body.branch, body.selector);
                    const result = await importSet(getBoardsDb(), ctx.params.slug, set);
                    publishBoardEvent(ctx.params.slug, { type: "cards", payload: result.cards });
                    for (const edge of result.edges) {
                        publishBoardEvent(ctx.params.slug, { type: "edge", payload: edge });
                    }
                    notifyLayoutChanged(getBoardsDb(), ctx.params.slug);
                    return { kind: "json", status: 200, body: result };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/:slug/sync-set",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ project: string; branch: string; selector: string }>();
                    const set = await getSet(getBoardsDb(), body.project, body.branch, body.selector);
                    const result = await syncSetCards(getBoardsDb(), ctx.params.slug, set);
                    const doc = await getBoardDoc(getBoardsDb(), ctx.params.slug);
                    publishBoardEvent(ctx.params.slug, { type: "cards", payload: doc.cards });
                    return { kind: "json", status: 200, body: result };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/:slug/upload",
            handler: async (ctx) => {
                try {
                    const bytes = await ctx.readRawBody();
                    const name = ctx.query.get("name") ?? "";
                    const mime = ctx.query.get("mime") || mimeForPath(name);
                    const dims = readImageDims(bytes);
                    const naturalWidth = dims?.width ?? UPLOAD_MAX_WIDTH;
                    const naturalHeight = dims?.height ?? UPLOAD_MAX_WIDTH;
                    const w = Math.min(UPLOAD_MAX_WIDTH, naturalWidth);
                    const h =
                        naturalWidth > UPLOAD_MAX_WIDTH
                            ? Math.round((naturalHeight * UPLOAD_MAX_WIDTH) / naturalWidth)
                            : naturalHeight;
                    const blobKey = await putBlob(bytes, mime);
                    const card = await createCard(getBoardsDb(), ctx.params.slug, {
                        kind: "media",
                        x: 40,
                        y: 40,
                        w,
                        h,
                        filePath: name,
                        blobKey,
                        payload: { naturalWidth, naturalHeight },
                        createdBy: await actorFrom(ctx),
                    });
                    publishBoardEvent(ctx.params.slug, { type: "card", payload: card });
                    notifyLayoutChanged(getBoardsDb(), ctx.params.slug);
                    return { kind: "json", status: 201, body: card };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            // Raw-body upload for a message attachment (image paste/drop or the ＋ button). Stores the
            // blob and returns its descriptor; the caller then references `blobKey` when sending the
            // message. Mirrors /upload but does NOT create a card.
            method: "POST",
            pattern: "/api/boards/:slug/msg-uploads",
            handler: async (ctx) => {
                try {
                    const bytes = await ctx.readRawBody();
                    const name = ctx.query.get("name") ?? "";
                    const mime = ctx.query.get("mime") || mimeForPath(name);
                    const blobKey = await putBlob(bytes, mime);
                    return { kind: "json", status: 201, body: { blobKey, name, mime } };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/:slug/messages",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{
                        body: string;
                        author?: string;
                        attachments?: MessageAttachmentDto[];
                    }>();
                    const message = await addMessage(getBoardsDb(), {
                        boardSlug: ctx.params.slug,
                        author: body.author ?? (await actorFrom(ctx)),
                        body: body.body,
                        attachments: body.attachments,
                    });
                    publishBoardEvent(ctx.params.slug, { type: "board_message", payload: message });
                    return { kind: "json", status: 201, body: message };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/boards/:slug/dispatch",
            handler: async (ctx) => {
                try {
                    // dispatchBoard publishes its own `status`/`question` SSE events and wakes
                    // work-queue waiters internally — the route must not duplicate either.
                    const result = await dispatchBoard(getBoardsDb(), ctx.params.slug);
                    return { kind: "json", status: 200, body: result };
                } catch (err) {
                    return boardsError(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/boards/:slug/events",
            longLived: true,
            handler: (ctx) => ({
                kind: "sse",
                start: (emit) => {
                    emit.comment(` board ${ctx.params.slug} stream open`);
                    const unsubscribe = subscribeBoard(ctx.params.slug, (frame) => emit.data(frame));
                    const keepAlive = setInterval(() => emit.comment(" ping"), 12_000);
                    return {
                        close: () => {
                            clearInterval(keepAlive);
                            unsubscribe();
                        },
                    };
                },
            }),
        },
    ];
}

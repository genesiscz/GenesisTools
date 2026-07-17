import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { parseCollectionRule, resolveCollectionVideoIds } from "@app/youtube/lib/collection-rules";
import type { CollectionKind } from "@app/youtube/lib/db.types";
import { requireUser } from "@app/youtube/lib/server/auth";
import { safeJsonBody } from "@app/youtube/lib/server/body";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import { matchRoute } from "@app/youtube/lib/server/match-route";
import type { Youtube } from "@app/youtube/lib/youtube";

export async function handleCollectionsRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    try {
        // "threads" must never parse as a collection id — register first.
        const threadDetail = matchRoute(req, "GET", "/api/v1/collections/threads/:threadId", url.pathname);

        if (threadDetail) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const threadId = parseId(threadDetail.threadId);
            const thread = threadId !== null ? yt.db.getAskThread(user.id, threadId) : null;

            if (!thread) {
                return jsonError("thread not found", 404);
            }

            return Response.json({ thread, messages: yt.db.listAskMessages(thread.id) }, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "GET", "/api/v1/collections", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const collections = yt.db.listCollections(user.id).map((collection) => ({
                ...collection,
                videoCount: resolveCollectionVideoIds(yt.db, collection).length,
            }));

            return Response.json({ collections }, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "POST", "/api/v1/collections", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const body = (await safeJsonBody(req)) ?? {};
            const name = typeof body.name === "string" ? body.name.trim() : "";
            const kind: CollectionKind | null = body.kind === "manual" || body.kind === "dynamic" ? body.kind : null;

            if (!name || !kind) {
                return jsonError("body must include {name, kind: 'manual'|'dynamic'}", 400);
            }

            let ruleJson: string | null = null;

            if (kind === "dynamic") {
                const rule = parseCollectionRule(body.rule);

                if (!rule) {
                    return jsonError("dynamic collections need a valid rule, e.g. {type:'watched', sinceDays:30}", 400);
                }

                ruleJson = SafeJSON.stringify(rule, { strict: true });
            }

            const collection = yt.db.createCollection({ userId: user.id, name, kind, ruleJson });
            logger.info({ userId: user.id, collectionId: collection.id, kind }, "youtube collections: created");

            return Response.json({ collection }, { headers: CORS_HEADERS });
        }

        const threadsList = matchRoute(req, "GET", "/api/v1/collections/:id/threads", url.pathname);

        if (threadsList) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const collection = ownedCollection(yt, user.id, threadsList.id);

            if (!collection) {
                return jsonError("collection not found", 404);
            }

            return Response.json({ threads: yt.db.listAskThreads(user.id, collection.id) }, { headers: CORS_HEADERS });
        }

        const addVideo = matchRoute(req, "POST", "/api/v1/collections/:id/videos", url.pathname);

        if (addVideo) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const collection = ownedCollection(yt, user.id, addVideo.id);

            if (!collection) {
                return jsonError("collection not found", 404);
            }

            if (collection.kind !== "manual") {
                return jsonError("dynamic collections resolve automatically — cannot add videos", 400);
            }

            const body = (await safeJsonBody(req)) ?? {};
            const videoId = typeof body.videoId === "string" ? body.videoId : null;

            if (!videoId) {
                return jsonError("body must include {videoId}", 400);
            }

            yt.db.addCollectionVideo(collection.id, videoId);

            return Response.json({ added: true }, { headers: CORS_HEADERS });
        }

        const removeVideo = matchRoute(req, "DELETE", "/api/v1/collections/:id/videos/:videoId", url.pathname);

        if (removeVideo) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const collection = ownedCollection(yt, user.id, removeVideo.id);

            if (!collection) {
                return jsonError("collection not found", 404);
            }

            return Response.json(
                { removed: yt.db.removeCollectionVideo(collection.id, removeVideo.videoId) },
                { headers: CORS_HEADERS }
            );
        }

        const detail = matchRoute(req, "GET", "/api/v1/collections/:id", url.pathname);

        if (detail) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const collection = ownedCollection(yt, user.id, detail.id);

            if (!collection) {
                return jsonError("collection not found", 404);
            }

            const videos = yt.db.getVideosByIds(resolveCollectionVideoIds(yt.db, collection));

            return Response.json({ collection, videos }, { headers: CORS_HEADERS });
        }

        const patch = matchRoute(req, "PATCH", "/api/v1/collections/:id", url.pathname);

        if (patch) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const body = (await safeJsonBody(req)) ?? {};
            const name = typeof body.name === "string" ? body.name.trim() : "";

            if (!name) {
                return jsonError("body must include {name}", 400);
            }

            const id = parseId(patch.id);
            const updated = id !== null ? yt.db.updateCollectionName(user.id, id, name) : null;

            if (!updated) {
                return jsonError("collection not found", 404);
            }

            return Response.json({ collection: updated }, { headers: CORS_HEADERS });
        }

        const remove = matchRoute(req, "DELETE", "/api/v1/collections/:id", url.pathname);

        if (remove) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const id = parseId(remove.id);
            const deleted = id !== null ? yt.db.deleteCollection(user.id, id) : false;

            if (!deleted) {
                return jsonError("collection not found", 404);
            }

            return Response.json({ deleted: true }, { headers: CORS_HEADERS });
        }

        return jsonError("not found", 404);
    } catch (err) {
        return toErrorResponse(err);
    }
}

function ownedCollection(yt: Youtube, userId: number, rawId: string) {
    const id = parseId(rawId);

    return id !== null ? yt.db.getCollection(userId, id) : null;
}

/** Full-segment positive integer — `parseInt` would accept `"1junk"` as 1. */
function parseId(value: string): number | null {
    if (!/^[1-9]\d*$/.test(value)) {
        return null;
    }

    const id = Number(value);

    return Number.isSafeInteger(id) ? id : null;
}

function jsonError(error: string, status: number): Response {
    return new Response(SafeJSON.stringify({ error }, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

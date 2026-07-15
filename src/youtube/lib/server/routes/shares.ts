import { SafeJSON } from "@app/utils/json";
import { requireUser } from "@app/youtube/lib/server/auth";
import { safeJsonBody } from "@app/youtube/lib/server/body";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import { matchRoute } from "@app/youtube/lib/server/match-route";
import { createShare, listShares, revokeShare } from "@app/youtube/lib/shares";
import type { Youtube } from "@app/youtube/lib/youtube";

export async function handleSharesRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    try {
        if (matchRoute(req, "POST", "/api/v1/shares", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const body = (await safeJsonBody(req)) ?? {};
            const kind = body.kind === "summary" || body.kind === "qa" ? body.kind : null;
            const videoId = typeof body.videoId === "string" ? body.videoId : null;

            if (!kind || !videoId) {
                return jsonError("body must include {kind, videoId}", 400);
            }

            const mode =
                body.mode === "short" || body.mode === "timestamped" || body.mode === "long" ? body.mode : undefined;
            const qaHistoryId = typeof body.qaHistoryId === "number" ? body.qaHistoryId : undefined;

            try {
                const result = await createShare({
                    db: yt.db,
                    user,
                    kind,
                    videoId,
                    mode,
                    qaHistoryId,
                    baseUrl: url.origin,
                });
                return Response.json(result, { headers: CORS_HEADERS });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const status = message.includes("not found") ? 404 : message.includes("rate limit") ? 429 : 400;
                return jsonError(message, status);
            }
        }

        if (matchRoute(req, "GET", "/api/v1/shares", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const shares = listShares(yt.db, user.id, url.origin);
            return Response.json({ shares }, { headers: CORS_HEADERS });
        }

        const revokeParams = matchRoute(req, "DELETE", "/api/v1/shares/:slug", url.pathname);

        if (revokeParams) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const revoked = revokeShare(yt.db, user.id, revokeParams.slug);

            if (!revoked) {
                return jsonError("not found", 404);
            }

            return Response.json({ revoked: true }, { headers: CORS_HEADERS });
        }

        return jsonError("not found", 404);
    } catch (err) {
        return toErrorResponse(err);
    }
}

function jsonError(error: string, status: number): Response {
    return new Response(SafeJSON.stringify({ error }, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

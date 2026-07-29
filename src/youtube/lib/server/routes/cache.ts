import { buildCacheStatsBase, clearVideoBinaries, listCacheVideos, ttlDays } from "@app/youtube/lib/cache-ops";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import { requireOperator } from "@app/youtube/lib/server/require-operator";
import type { Youtube } from "@app/youtube/lib/youtube";
import { SafeJSON } from "@genesiscz/utils/json";

interface ClearCacheBody {
    audio?: boolean;
    video?: boolean;
    thumbs?: boolean;
    all?: boolean;
}

export async function handleCacheRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    try {
        if (url.pathname === "/api/v1/cache/stats" && req.method === "GET") {
            return Response.json(buildCacheStats(yt), { headers: CORS_HEADERS });
        }

        if (url.pathname === "/api/v1/cache/prune" && req.method === "POST") {
            const denied = await requireOperator(req, url, yt);

            if (denied) {
                return denied;
            }

            const body = await safeJson<{ dryRun?: boolean }>(req);

            if (body?.dryRun) {
                return Response.json({ audio: 0, video: 0, thumb: 0, dryRun: true }, { headers: CORS_HEADERS });
            }

            const config = await yt.config.getAll();
            const result = await yt.db.pruneExpiredBinaries({
                audioOlderThanDays: ttlDays(config.ttls.audio),
                videoOlderThanDays: ttlDays(config.ttls.video),
                thumbOlderThanDays: ttlDays(config.ttls.thumb),
            });

            return Response.json(result, { headers: CORS_HEADERS });
        }

        if (url.pathname === "/api/v1/cache/clear" && req.method === "POST") {
            const denied = await requireOperator(req, url, yt);

            if (denied) {
                return denied;
            }

            const body = (await req.json()) as ClearCacheBody;
            return Response.json(
                clearVideoBinaries({
                    yt,
                    audio: Boolean(body.all || body.audio),
                    video: Boolean(body.all || body.video),
                    thumbs: Boolean(body.all || body.thumbs),
                }),
                { headers: CORS_HEADERS }
            );
        }

        return jsonError("not found", 404);
    } catch (err) {
        return toErrorResponse(err);
    }
}

function buildCacheStats(yt: Youtube) {
    const channels = yt.channels.list();
    const videos = listCacheVideos(yt);
    const jobs = yt.pipeline.listJobs({ limit: 100 });
    const stats = buildCacheStatsBase({ yt, channels: channels.length, videos });

    return {
        channels: stats.channels,
        videos: stats.videos,
        transcripts: stats.transcripts,
        jobs,
        audioBytes: stats.audioBytes,
        videoBytes: stats.videoBytes,
        thumbBytes: 0,
    };
}

async function safeJson<T>(req: Request): Promise<T | undefined> {
    try {
        return (await req.json()) as T;
    } catch {
        return undefined;
    }
}

function jsonError(error: string, status: number): Response {
    return new Response(SafeJSON.stringify({ error }, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

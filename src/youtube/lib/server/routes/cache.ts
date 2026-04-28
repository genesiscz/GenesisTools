import { existsSync, statSync, unlinkSync } from "node:fs";
import { SafeJSON } from "@app/utils/json";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import type { Youtube } from "@app/youtube/lib/youtube";

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
            const body = (await req.json()) as ClearCacheBody;
            return Response.json(clearCachedBinaries(yt, body), { headers: CORS_HEADERS });
        }

        return jsonError("not found", 404);
    } catch (err) {
        return toErrorResponse(err);
    }
}

function buildCacheStats(yt: Youtube) {
    const channels = yt.channels.list();
    const videos = yt.videos.list({ includeShorts: true, includeLive: true, limit: 1_000_000 });
    const jobs = yt.pipeline.listJobs({ limit: 100 });
    const transcriptCount = videos.reduce((count, video) => count + yt.db.listTranscripts(video.id).length, 0);

    return {
        channels: channels.length,
        videos: videos.length,
        transcripts: transcriptCount,
        jobs,
        audioBytes: sumBytes(videos.map((video) => video.audioSizeBytes)),
        videoBytes: sumBytes(videos.map((video) => video.videoSizeBytes)),
        thumbBytes: 0,
    };
}

function clearCachedBinaries(yt: Youtube, body: ClearCacheBody): { deletedCount: number; freedBytes: number } {
    const videos = yt.videos.list({ includeShorts: true, includeLive: true, limit: 1_000_000 });
    let deletedCount = 0;
    let freedBytes = 0;

    for (const video of videos) {
        if ((body.all || body.audio) && video.audioPath) {
            freedBytes += deletePath(video.audioPath, video.audioSizeBytes);
            yt.db.setVideoBinaryPath(video.id, "audio", null);
            deletedCount++;
        }

        if ((body.all || body.video) && video.videoPath) {
            freedBytes += deletePath(video.videoPath, video.videoSizeBytes);
            yt.db.setVideoBinaryPath(video.id, "video", null);
            deletedCount++;
        }

        if ((body.all || body.thumbs) && video.thumbPath) {
            freedBytes += deletePath(video.thumbPath, null);
            yt.db.setVideoBinaryPath(video.id, "thumb", null);
            deletedCount++;
        }
    }

    return { deletedCount, freedBytes };
}

function deletePath(path: string, knownBytes: number | null): number {
    const bytes = knownBytes ?? (existsSync(path) ? statSync(path).size : 0);

    if (existsSync(path)) {
        unlinkSync(path);
    }

    return bytes;
}

function sumBytes(values: Array<number | null>): number {
    return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function ttlDays(raw: string): number | undefined {
    const match = raw.match(/^(\d+)\s+days?$/);

    if (!match?.[1]) {
        return undefined;
    }

    return parseInt(match[1], 10);
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

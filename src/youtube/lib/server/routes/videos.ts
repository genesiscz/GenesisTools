import { SafeJSON } from "@app/utils/json";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import type { ChannelHandle, Transcript, VideoId } from "@app/youtube/lib/types";
import type { Youtube } from "@app/youtube/lib/youtube";

export async function handleVideosRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    const segments = url.pathname.split("/").filter(Boolean);
    const id = segments[3];
    const action = segments[4];

    try {
        if (url.pathname === "/api/v1/videos" && req.method === "GET") {
            const channel = url.searchParams.get("channel") as ChannelHandle | null;
            const since = url.searchParams.get("since") ?? undefined;
            const limit = parseInt(url.searchParams.get("limit") ?? "30", 10);
            const includeShorts = url.searchParams.get("includeShorts") === "true";
            const videos = yt.videos.list({ channel: channel ?? undefined, since, limit, includeShorts });

            return Response.json({ videos }, { headers: CORS_HEADERS });
        }

        if (id === "search" && req.method === "GET") {
            const query = url.searchParams.get("q") ?? "";
            const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
            const hits = yt.videos.search(query, { limit });

            return Response.json({ hits }, { headers: CORS_HEADERS });
        }

        if (id && !action && req.method === "GET") {
            const video = yt.videos.show(id as VideoId);

            if (!video) {
                return jsonError("video not found", 404);
            }

            return Response.json({ video, transcripts: yt.db.listTranscripts(id as VideoId) }, { headers: CORS_HEADERS });
        }

        if (id && action === "transcript" && req.method === "GET") {
            return handleTranscriptRoute(url, yt, id as VideoId);
        }

        if (id && action === "summary" && req.method === "GET") {
            const video = yt.videos.show(id as VideoId);

            if (!video) {
                return jsonError("video not found", 404);
            }

            const mode = url.searchParams.get("mode") ?? "short";

            if (mode === "timestamped") {
                return Response.json({ summary: video.summaryTimestamped ?? [] }, { headers: CORS_HEADERS });
            }

            return Response.json({ summary: video.summaryShort ?? "" }, { headers: CORS_HEADERS });
        }

        if (id && action === "qa" && req.method === "POST") {
            return jsonError("qa route requires CLI provider wiring from Plan 2", 501);
        }

        return jsonError("not found", 404);
    } catch (err) {
        return toErrorResponse(err);
    }
}

function handleTranscriptRoute(url: URL, yt: Youtube, id: VideoId): Response {
    const lang = url.searchParams.get("lang") ?? undefined;
    const source = url.searchParams.get("source") ?? undefined;
    const format = url.searchParams.get("format") ?? "json";
    const transcript = yt.db.getTranscript(id, {
        lang,
        source: source === "captions" || source === "ai" ? source : undefined,
    });

    if (!transcript) {
        return jsonError("no transcript", 404);
    }

    if (format === "text") {
        return new Response(transcript.text, { headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (format === "srt") {
        return new Response(toSrt(transcript), { headers: { ...CORS_HEADERS, "Content-Type": "application/x-subrip; charset=utf-8" } });
    }

    if (format === "vtt") {
        return new Response(toVtt(transcript), { headers: { ...CORS_HEADERS, "Content-Type": "text/vtt; charset=utf-8" } });
    }

    return Response.json({ transcript }, { headers: CORS_HEADERS });
}

function toSrt(transcript: Transcript): string {
    return transcript.segments
        .map((segment, index) => `${index + 1}\n${formatTimestamp(segment.start, ",")} --> ${formatTimestamp(segment.end, ",")}\n${segment.text}`)
        .join("\n\n");
}

function toVtt(transcript: Transcript): string {
    const cues = transcript.segments.map((segment) => `${formatTimestamp(segment.start, ".")} --> ${formatTimestamp(segment.end, ".")}\n${segment.text}`).join("\n\n");
    return `WEBVTT\n\n${cues}`;
}

function formatTimestamp(seconds: number, separator: "," | "."): string {
    const totalMs = Math.round(seconds * 1000);
    const hours = Math.floor(totalMs / 3_600_000);
    const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
    const secs = Math.floor((totalMs % 60_000) / 1000);
    const ms = totalMs % 1000;

    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}${separator}${ms.toString().padStart(3, "0")}`;
}

function jsonError(error: string, status: number): Response {
    return new Response(SafeJSON.stringify({ error }, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

import { SafeJSON } from "@app/utils/json";
import { resolveProviderChoice } from "@app/youtube/lib/provider-choice";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import { matchRoute } from "@app/youtube/lib/server/match-route";
import type { ChannelHandle, Transcript, VideoId } from "@app/youtube/lib/types";
import type { Youtube } from "@app/youtube/lib/youtube";

export async function handleVideosRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    try {
        if (matchRoute(req, "GET", "/api/v1/videos", url.pathname)) {
            const channel = url.searchParams.get("channel") as ChannelHandle | null;
            const since = url.searchParams.get("since") ?? undefined;
            const limit = parseInt(url.searchParams.get("limit") ?? "30", 10);
            const includeShorts = url.searchParams.get("includeShorts") === "true";
            const videos = yt.videos.list({ channel: channel ?? undefined, since, limit, includeShorts });

            return Response.json({ videos }, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "GET", "/api/v1/videos/search", url.pathname)) {
            const query = url.searchParams.get("q") ?? "";
            const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
            const hits = yt.videos.search(query, { limit });

            return Response.json({ hits }, { headers: CORS_HEADERS });
        }

        const showVideo = matchRoute(req, "GET", "/api/v1/videos/:id", url.pathname);

        if (showVideo) {
            const id = showVideo.id as VideoId;
            const video = yt.videos.show(id);

            if (!video) {
                return jsonError("video not found", 404);
            }

            return Response.json({ video, transcripts: yt.db.listTranscripts(id) }, { headers: CORS_HEADERS });
        }

        const transcriptRoute = matchRoute(req, "GET", "/api/v1/videos/:id/transcript", url.pathname);

        if (transcriptRoute) {
            return handleTranscriptRoute(url, yt, transcriptRoute.id as VideoId);
        }

        const summaryGet = matchRoute(req, "GET", "/api/v1/videos/:id/summary", url.pathname);

        if (summaryGet) {
            const id = summaryGet.id as VideoId;
            const video = yt.videos.show(id);

            if (!video) {
                return jsonError("video not found", 404);
            }

            const mode = url.searchParams.get("mode") === "timestamped" ? "timestamped" : "short";
            const cached = mode === "timestamped" ? video.summaryTimestamped : video.summaryShort;

            return Response.json({ summary: cached ?? (mode === "timestamped" ? [] : ""), mode, cached: cached !== null && cached !== undefined }, { headers: CORS_HEADERS });
        }

        const summaryPost = matchRoute(req, "POST", "/api/v1/videos/:id/summary", url.pathname);

        if (summaryPost) {
            const id = summaryPost.id as VideoId;
            const video = yt.videos.show(id);

            if (!video) {
                return jsonError("video not found", 404);
            }

            const body = (await safeJsonBody(req)) ?? {};
            const mode = body.mode === "timestamped" ? "timestamped" : "short";
            const force = body.force === true;
            const provider = typeof body.provider === "string" ? body.provider : undefined;
            const model = typeof body.model === "string" ? body.model : undefined;
            const targetBins = typeof body.targetBins === "number" ? body.targetBins : undefined;

            const transcript = yt.db.getTranscript(id);

            if (!transcript) {
                return jsonError("no transcript yet for this video — run pipeline / transcribe first", 409);
            }

            const providerChoice = (provider || model) ? await resolveProviderChoice({ provider, model }) : undefined;
            const result = await yt.summary.summarize({
                videoId: id,
                mode,
                provider,
                providerChoice,
                targetBins,
                forceRecompute: force,
            });

            return Response.json({ summary: mode === "timestamped" ? result.timestamped ?? [] : result.short ?? "", mode, cached: false }, { headers: CORS_HEADERS });
        }

        const qa = matchRoute(req, "POST", "/api/v1/videos/:id/qa", url.pathname);

        if (qa) {
            const id = qa.id as VideoId;
            const video = yt.videos.show(id);

            if (!video) {
                return jsonError("video not found", 404);
            }

            const body = await safeJsonBody(req);

            if (!body || typeof body.question !== "string" || body.question.trim() === "") {
                return jsonError("body must include {question: string}", 400);
            }

            const transcript = yt.db.getTranscript(id);

            if (!transcript) {
                return jsonError("no transcript yet for this video — run pipeline / transcribe first", 409);
            }

            await yt.qa.index({ videoId: id });
            const providerChoice = await resolveProviderChoice({
                provider: typeof body.provider === "string" ? body.provider : undefined,
                model: typeof body.model === "string" ? body.model : undefined,
            });
            const result = await yt.qa.ask({
                videoIds: [id],
                question: body.question,
                topK: typeof body.topK === "number" ? body.topK : undefined,
                providerChoice,
            });

            return Response.json(result, { headers: CORS_HEADERS });
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

async function safeJsonBody(req: Request): Promise<Record<string, unknown> | null> {
    if (!req.headers.get("content-type")?.includes("application/json")) {
        return null;
    }

    try {
        const parsed = await req.json();

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // ignore — caller treats null as "no body"
    }

    return null;
}

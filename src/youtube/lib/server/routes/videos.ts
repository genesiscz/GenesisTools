import { SafeJSON } from "@app/utils/json";
import { withJobActivity } from "@app/youtube/lib/job-activity";
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
            const inFields = (url.searchParams.get("in") ?? "transcript")
                .split(",")
                .map((part) => part.trim())
                .filter(Boolean);
            const channel = url.searchParams.get("channel") as ChannelHandle | null;
            const hits: Array<{ kind: string; videoId: string; snippet: string; rank?: number; lang?: string }> = [];

            if (inFields.includes("transcript")) {
                for (const hit of yt.videos.search(query, { limit })) {
                    hits.push({ kind: "transcript", ...hit });
                }
            }

            const metadataFields = inFields
                .map((value) => (value === "desc" ? "description" : value))
                .filter(
                    (value): value is "title" | "description" | "tags" =>
                        value === "title" || value === "description" || value === "tags"
                );

            if (metadataFields.length > 0) {
                for (const hit of yt.videos.searchMetadata(query, {
                    fields: metadataFields,
                    channel: channel ?? undefined,
                    limit,
                    includeShorts: true,
                    includeLive: true,
                })) {
                    hits.push({ kind: hit.field, videoId: hit.videoId, snippet: hit.snippet });
                }
            }

            return Response.json({ hits: hits.slice(0, limit) }, { headers: CORS_HEADERS });
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

            const mode = parseMode(url.searchParams.get("mode"));
            const cached =
                mode === "timestamped"
                    ? video.summaryTimestamped
                    : mode === "long"
                      ? video.summaryLong
                      : video.summaryShort;
            const fallback = mode === "timestamped" ? [] : mode === "long" ? null : "";

            return Response.json(
                { summary: cached ?? fallback, mode, cached: cached !== null && cached !== undefined },
                { headers: CORS_HEADERS }
            );
        }

        const summaryPost = matchRoute(req, "POST", "/api/v1/videos/:id/summary", url.pathname);

        if (summaryPost) {
            const id = summaryPost.id as VideoId;
            const video = yt.videos.show(id);

            if (!video) {
                return jsonError("video not found", 404);
            }

            const body = (await safeJsonBody(req)) ?? {};
            const mode = parseMode(body.mode);
            const force = body.force === true;
            const provider = typeof body.provider === "string" ? body.provider : undefined;
            const model = typeof body.model === "string" ? body.model : undefined;
            const tone = parseTone(body.tone);
            const format = parseFormat(body.format);
            const length = parseLength(body.length);
            const targetBins = typeof body.targetBins === "number" ? body.targetBins : undefined;

            const hasTranscript = yt.db.getTranscript(id) !== null;
            const needsProvider = mode !== "short" || !!provider || !!model;
            const providerChoice = needsProvider ? await resolveProviderChoice({ provider, model }) : undefined;
            const stages = hasTranscript ? (["summarize"] as const) : (["captions", "summarize"] as const);
            const job = yt.db.enqueueJob({ targetKind: "video", target: id, stages: [...stages] });
            yt.pipeline.emitExternal({ type: "job:created", job });
            const startedAt = new Date().toISOString();
            yt.db.updateJob(job.id, {
                status: "running",
                currentStage: hasTranscript ? "summarize" : "captions",
                progress: 0,
                progressMessage: hasTranscript ? "Compacting transcript" : "Fetching captions / transcribing",
            });
            const startedJob = yt.db.getJob(job.id) ?? job;
            yt.pipeline.emitExternal({ type: "job:started", job: startedJob });

            try {
                if (!hasTranscript) {
                    yt.pipeline.emitExternal({ type: "stage:started", jobId: job.id, stage: "captions" });
                    yt.pipeline.emitExternal({
                        type: "stage:progress",
                        jobId: job.id,
                        stage: "captions",
                        progress: 0.05,
                        message: "Fetching captions",
                    });
                    await withJobActivity({ jobId: job.id, stage: "captions", db: yt.db }, () =>
                        yt.transcripts.transcribe({
                            videoId: id,
                            onProgress: (info) => {
                                const stagePct = (info.percent ?? 0) / 100;
                                const overall = Math.min(0.25, 0.05 + stagePct * 0.2);
                                yt.db.updateJob(job.id, { progress: overall, progressMessage: info.message });
                                yt.pipeline.emitExternal({
                                    type: "stage:progress",
                                    jobId: job.id,
                                    stage: "captions",
                                    progress: overall,
                                    message: info.message,
                                });
                            },
                        })
                    );
                    yt.pipeline.emitExternal({ type: "stage:completed", jobId: job.id, stage: "captions" });
                }

                yt.db.updateJob(job.id, {
                    currentStage: "summarize",
                    progress: 0.25,
                    progressMessage: "Compacting transcript",
                });
                yt.pipeline.emitExternal({ type: "stage:started", jobId: job.id, stage: "summarize" });
                yt.pipeline.emitExternal({
                    type: "stage:progress",
                    jobId: job.id,
                    stage: "summarize",
                    progress: 0.25,
                    message: "Compacting transcript",
                });

                const result = await withJobActivity({ jobId: job.id, stage: "summarize", db: yt.db }, () =>
                    yt.summary.summarize({
                        videoId: id,
                        mode,
                        provider,
                        providerChoice,
                        targetBins,
                        forceRecompute: force,
                        tone,
                        format,
                        length,
                        onProgress: (info) => {
                            const progress = (info.percent ?? 50) / 100;
                            yt.db.updateJob(job.id, { progress, progressMessage: info.message });
                            yt.pipeline.emitExternal({
                                type: "stage:progress",
                                jobId: job.id,
                                stage: "summarize",
                                progress,
                                message: info.message,
                            });
                        },
                    })
                );
                yt.db.updateJob(job.id, {
                    status: "completed",
                    progress: 1,
                    progressMessage: null,
                    currentStage: null,
                    completedAt: new Date().toISOString(),
                });
                const completedJob = yt.db.getJob(job.id) ?? job;
                yt.pipeline.emitExternal({ type: "stage:completed", jobId: job.id, stage: "summarize" });
                yt.pipeline.emitExternal({ type: "job:completed", job: completedJob });

                return Response.json(
                    {
                        summary:
                            mode === "timestamped"
                                ? (result.timestamped ?? [])
                                : mode === "long"
                                  ? (result.long ?? null)
                                  : (result.short ?? ""),
                        mode,
                        cached: false,
                        jobId: job.id,
                        startedAt,
                    },
                    { headers: CORS_HEADERS }
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                yt.db.updateJob(job.id, { status: "failed", error: message, completedAt: new Date().toISOString() });
                const failedJob = yt.db.getJob(job.id) ?? job;
                yt.pipeline.emitExternal({ type: "job:failed", job: failedJob, error: message });
                throw error;
            }
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

            const question = body.question;
            const topK = typeof body.topK === "number" ? body.topK : undefined;
            const providerChoice = await resolveProviderChoice({
                provider: typeof body.provider === "string" ? body.provider : undefined,
                model: typeof body.model === "string" ? body.model : undefined,
            });
            const job = yt.db.enqueueJob({ targetKind: "video", target: id, stages: ["summarize"] });
            yt.pipeline.emitExternal({ type: "job:created", job });
            yt.db.updateJob(job.id, { status: "running", currentStage: "summarize" });
            const startedJob = yt.db.getJob(job.id) ?? job;
            yt.pipeline.emitExternal({ type: "job:started", job: startedJob });
            yt.pipeline.emitExternal({ type: "stage:started", jobId: job.id, stage: "summarize" });
            yt.pipeline.emitExternal({
                type: "stage:progress",
                jobId: job.id,
                stage: "summarize",
                progress: 0.05,
                message: "Indexing transcript",
            });

            try {
                const result = await withJobActivity({ jobId: job.id, stage: "summarize", db: yt.db }, async () => {
                    await yt.qa.index({ videoId: id });
                    yt.pipeline.emitExternal({
                        type: "stage:progress",
                        jobId: job.id,
                        stage: "summarize",
                        progress: 0.5,
                        message: "Answering question",
                    });
                    return yt.qa.ask({
                        videoIds: [id],
                        question,
                        topK,
                        providerChoice,
                    });
                });
                yt.db.updateJob(job.id, {
                    status: "completed",
                    progress: 1,
                    currentStage: null,
                    completedAt: new Date().toISOString(),
                });
                const completedJob = yt.db.getJob(job.id) ?? job;
                yt.pipeline.emitExternal({ type: "stage:completed", jobId: job.id, stage: "summarize" });
                yt.pipeline.emitExternal({ type: "job:completed", job: completedJob });

                return Response.json({ ...result, jobId: job.id }, { headers: CORS_HEADERS });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                yt.db.updateJob(job.id, { status: "failed", error: message, completedAt: new Date().toISOString() });
                const failedJob = yt.db.getJob(job.id) ?? job;
                yt.pipeline.emitExternal({ type: "job:failed", job: failedJob, error: message });
                throw error;
            }
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
        return new Response(transcript.text, {
            headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
        });
    }

    if (format === "srt") {
        return new Response(toSrt(transcript), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/x-subrip; charset=utf-8" },
        });
    }

    if (format === "vtt") {
        return new Response(toVtt(transcript), {
            headers: { ...CORS_HEADERS, "Content-Type": "text/vtt; charset=utf-8" },
        });
    }

    return Response.json({ transcript }, { headers: CORS_HEADERS });
}

function toSrt(transcript: Transcript): string {
    return transcript.segments
        .map(
            (segment, index) =>
                `${index + 1}\n${formatTimestamp(segment.start, ",")} --> ${formatTimestamp(segment.end, ",")}\n${segment.text}`
        )
        .join("\n\n");
}

function toVtt(transcript: Transcript): string {
    const cues = transcript.segments
        .map(
            (segment) =>
                `${formatTimestamp(segment.start, ".")} --> ${formatTimestamp(segment.end, ".")}\n${segment.text}`
        )
        .join("\n\n");
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

function parseMode(value: unknown): "short" | "timestamped" | "long" {
    if (value === "timestamped" || value === "long") {
        return value;
    }

    return "short";
}

function parseTone(value: unknown): "insightful" | "funny" | "actionable" | "controversial" | undefined {
    if (value === "insightful" || value === "funny" || value === "actionable" || value === "controversial") {
        return value;
    }

    return undefined;
}

function parseFormat(value: unknown): "list" | "qa" | undefined {
    if (value === "list" || value === "qa") {
        return value;
    }

    return undefined;
}

function parseLength(value: unknown): "short" | "auto" | "detailed" | undefined {
    if (value === "short" || value === "auto" || value === "detailed") {
        return value;
    }

    return undefined;
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

import { logger } from "@app/logger";
import { estimateLlmCallCostUsd, estimateSpeechTokens } from "@app/utils/ai/llm-cost";
import { SafeJSON } from "@app/utils/json";
import { estimateTokens } from "@app/utils/tokens";
import { grantArtifactAccess, resolveArtifactPrice } from "@app/youtube/lib/artifact-access";
import { withJobActivity } from "@app/youtube/lib/job-activity";
import { isOutputLang } from "@app/youtube/lib/languages";
import { getPresetForUse } from "@app/youtube/lib/presets";
import { resolveProviderChoice } from "@app/youtube/lib/provider-choice";
import { selectCandidateVideos } from "@app/youtube/lib/qa";
import { requireUser, resolveUser } from "@app/youtube/lib/server/auth";
import { safeJsonBody } from "@app/youtube/lib/server/body";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import { matchRoute } from "@app/youtube/lib/server/match-route";
import { serveFileWithRange } from "@app/youtube/lib/server/range";
import {
    getOrSynthesizeSummaryAudio,
    NoSummaryError,
    NoTtsProviderError,
    resolveSummaryAudioTarget,
    summaryAudioCacheHit,
} from "@app/youtube/lib/summary-audio";
import { compactTranscript } from "@app/youtube/lib/transcript-compact";
import { translateTranscript } from "@app/youtube/lib/transcripts";
import type { ChannelHandle, QaSource, Transcript, Video, VideoId } from "@app/youtube/lib/types";
import { CREDIT_COSTS, InsufficientCreditsError, REUSE_COST } from "@app/youtube/lib/types";
import type { Youtube } from "@app/youtube/lib/youtube";
import { dynamicPricingManager } from "@ask/providers/DynamicPricing";

/** System prompt + instructions sent alongside the transcript. */
const PROMPT_OVERHEAD_TOKENS = 700;

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

        const transcriptTranslate = matchRoute(req, "POST", "/api/v1/videos/:id/transcript/translate", url.pathname);

        if (transcriptTranslate) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const id = transcriptTranslate.id as VideoId;
            const body = (await safeJsonBody(req)) ?? {};
            const lang = typeof body.lang === "string" ? body.lang : undefined;

            if (!lang || !isOutputLang(lang)) {
                return jsonError("body must include a known {lang}", 400);
            }

            if (!yt.db.getTranscript(id)) {
                return jsonError("no transcript yet for this video — run pipeline / transcribe first", 409);
            }

            // Reuse-aware: an existing translated row is served for free —
            // the cache is checked BEFORE any credit charge.
            const existing = yt.db.getTranscript(id, { lang });

            if (existing) {
                return Response.json(
                    { transcript: existing, creditsSpent: 0, credits: user.credits },
                    { headers: CORS_HEADERS }
                );
            }

            const creditCost = CREDIT_COSTS["transcript:translate"];
            // Reserve BEFORE the LLM call so concurrent requests cannot pass a
            // stale balance check and burn provider cost; released on failure.
            const hold = yt.db.reserveCredits({
                userId: user.id,
                amount: creditCost,
                reason: "transcript:translate",
                context: id,
            });

            try {
                const providerChoice = await resolveProviderChoice({
                    provider: typeof body.provider === "string" ? body.provider : undefined,
                    model: typeof body.model === "string" ? body.model : undefined,
                });
                const transcript = await translateTranscript({ db: yt.db, videoId: id, lang, providerChoice });
                yt.db.commitHold(hold.holdId);

                return Response.json(
                    { transcript, creditsSpent: creditCost, credits: hold.credits },
                    { headers: CORS_HEADERS }
                );
            } catch (error) {
                yt.db.releaseHold(hold.holdId);
                throw error;
            }
        }

        const audioPost = matchRoute(req, "POST", "/api/v1/videos/:id/summary/audio", url.pathname);

        if (audioPost) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const id = audioPost.id as VideoId;

            // TTS narrates the long summary — it must not bypass the artifact
            // lock. A missing summary still falls through to the 409 below.
            if (yt.db.hasArtifact("summary:long", id) && !yt.db.hasArtifactAccess(user.id, "summary:long", id)) {
                return jsonError("unlock the long summary first", 403);
            }

            const body = (await safeJsonBody(req)) ?? {};
            const voice = typeof body.voice === "string" ? body.voice : (user.ttsVoice ?? undefined);

            let target: Awaited<ReturnType<typeof resolveSummaryAudioTarget>>;

            try {
                target = await resolveSummaryAudioTarget({ db: yt.db, videoId: id, mode: "long", voice });
            } catch (error) {
                if (error instanceof NoTtsProviderError) {
                    return jsonError("no TTS provider configured", 503);
                }

                if (error instanceof NoSummaryError) {
                    return jsonError("no long summary yet — generate one first", 409);
                }

                throw error;
            }

            // Cache is checked BEFORE the credit charge — a hit never spends.
            const cached = await summaryAudioCacheHit(target);
            const creditCost = CREDIT_COSTS["tts:summary"];
            let credits = user.credits;
            let charged = 0;
            let hold: { holdId: number; credits: number } | undefined;

            if (!cached) {
                // Reserve BEFORE synthesis so concurrent requests cannot pass a
                // stale balance check and burn provider cost; released on failure.
                hold = yt.db.reserveCredits({ userId: user.id, amount: creditCost, reason: `tts:${id}` });
                credits = hold.credits;
                charged = creditCost;
            }

            let result: Awaited<ReturnType<typeof getOrSynthesizeSummaryAudio>>;

            try {
                result = await getOrSynthesizeSummaryAudio({
                    db: yt.db,
                    videoId: id,
                    mode: "long",
                    voice,
                    userId: user.id,
                });
            } catch (error) {
                if (hold) {
                    yt.db.releaseHold(hold.holdId);
                }

                throw error;
            }

            if (hold && result.cached) {
                // Lost a synthesis race — another request already produced the file.
                credits = yt.db.releaseHold(hold.holdId);
                charged = 0;
            } else if (hold) {
                yt.db.commitHold(hold.holdId);
            }

            return Response.json(
                {
                    // Voice is part of the cache key — the URL must carry it or
                    // a GET falls back to the user's default voice and 404s.
                    url: `/api/v1/videos/${id}/summary/audio${voice ? `?voice=${encodeURIComponent(voice)}` : ""}`,
                    cached: result.cached,
                    creditsSpent: charged,
                    credits,
                },
                { headers: CORS_HEADERS }
            );
        }

        const audioGet = matchRoute(req, "GET", "/api/v1/videos/:id/summary/audio", url.pathname);

        if (audioGet) {
            // `<audio>` elements can't set an Authorization header — the token
            // travels as a query param instead, mirrored onto `access_token` so
            // it goes through the same requireUser path as every other route.
            const authUrl = new URL(url);
            const token = url.searchParams.get("token");

            if (token) {
                authUrl.searchParams.set("access_token", token);
            }

            const user = requireUser(req, authUrl, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const id = audioGet.id as VideoId;

            if (yt.db.hasArtifact("summary:long", id) && !yt.db.hasArtifactAccess(user.id, "summary:long", id)) {
                return jsonError("unlock the long summary first", 403);
            }

            const voice = url.searchParams.get("voice") ?? user.ttsVoice ?? undefined;

            let target: Awaited<ReturnType<typeof resolveSummaryAudioTarget>>;

            try {
                target = await resolveSummaryAudioTarget({ db: yt.db, videoId: id, mode: "long", voice });
            } catch (error) {
                if (error instanceof NoTtsProviderError) {
                    return jsonError("no TTS provider configured", 503);
                }

                if (error instanceof NoSummaryError) {
                    return jsonError("no long summary yet — generate one first", 404);
                }

                throw error;
            }

            if (!(await summaryAudioCacheHit(target))) {
                return jsonError("audio not synthesized yet — POST first", 404);
            }

            return serveFileWithRange(req, target.path, "audio/mpeg");
        }

        const speakersPut = matchRoute(req, "PUT", "/api/v1/videos/:id/speakers", url.pathname);

        if (speakersPut) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const id = speakersPut.id as VideoId;
            const video = yt.videos.show(id);

            if (!video) {
                return jsonError("video not found", 404);
            }

            const body = await safeJsonBody(req);
            const speakers = parseSpeakers(body?.speakers);

            if (!speakers) {
                return jsonError("body must include {speakers: {idx: number; label: string}[]}", 400);
            }

            yt.db.upsertVideoSpeakers(id, speakers);

            return Response.json({ speakerLabels: yt.db.getVideoSpeakers(id) }, { headers: CORS_HEADERS });
        }

        const commentsRoute = matchRoute(req, "GET", "/api/v1/videos/:id/comments", url.pathname);

        if (commentsRoute) {
            const id = commentsRoute.id as VideoId;
            const video = yt.videos.show(id);

            if (!video) {
                return jsonError("video not found", 404);
            }

            return Response.json({ comments: yt.db.getComments(id) }, { headers: CORS_HEADERS });
        }

        const summaryGet = matchRoute(req, "GET", "/api/v1/videos/:id/summary", url.pathname);

        if (summaryGet) {
            const id = summaryGet.id as VideoId;
            const video = yt.videos.show(id);

            if (!video) {
                return jsonError("video not found", 404);
            }

            const mode = parseMode(url.searchParams.get("mode"));

            // Existing artifact + authenticated user without an access row →
            // locked teaser envelope (never a 402 on GET — the UI needs the
            // price to render the unlock). Anonymous requests keep the open
            // behavior: the local web UI has no login surface.
            if (yt.db.hasArtifact(`summary:${mode}`, id)) {
                const viewer = resolveUser(req, url, yt.db);

                if (viewer && !yt.db.hasArtifactAccess(viewer.id, `summary:${mode}`, id)) {
                    return Response.json(
                        { locked: true, price: REUSE_COST, preview: { tldr: summaryPreview(video, mode) }, mode },
                        { headers: CORS_HEADERS }
                    );
                }
            }

            const cached =
                mode === "timestamped"
                    ? video.summaryTimestamped
                    : mode === "long"
                      ? video.summaryLong
                      : video.summaryShort;
            const fallback = mode === "timestamped" ? [] : mode === "long" ? null : "";

            return Response.json(
                {
                    summary: cached ?? fallback,
                    mode,
                    lang: summaryLangFor(video, mode),
                    cached: cached !== null && cached !== undefined,
                },
                { headers: CORS_HEADERS }
            );
        }

        const summaryPost = matchRoute(req, "POST", "/api/v1/videos/:id/summary", url.pathname);

        if (summaryPost) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const id = summaryPost.id as VideoId;
            // Extension can request a summary for a video the DB has never
            // seen (user just opened the watch page) — ingest metadata on
            // demand instead of 404ing.
            await yt.videos.ensureMetadata(id);

            const body = (await safeJsonBody(req)) ?? {};
            const mode = parseMode(body.mode);
            const creditCost = CREDIT_COSTS[`summary:${mode}`];
            const force = body.force === true;
            const requestedLang = typeof body.lang === "string" ? body.lang : undefined;
            const lang = requestedLang && isOutputLang(requestedLang) ? requestedLang : (user.outputLang ?? "en");
            // Switching to a language the stored artifact wasn't generated in
            // always regenerates — v1 keeps one summary per mode, so a lang
            // switch replaces it (never served from the reuse/cache path).
            const existingVideo = yt.videos.show(id);
            const langMismatch =
                existingVideo !== null &&
                yt.db.hasArtifact(`summary:${mode}`, id) &&
                summaryLangFor(existingVideo, mode) !== lang;

            // Reuse/owned short-circuit: the artifact already exists — charge
            // the flat unlock price (or nothing when already unlocked) and
            // return the stored content immediately. No LLM call, no job.
            // `force` (or a language switch) opts into a fresh regeneration
            // at full price instead.
            if (!force && !langMismatch && yt.db.hasArtifact(`summary:${mode}`, id)) {
                const pricing = resolveArtifactPrice(yt.db, { userId: user.id, kind: `summary:${mode}`, videoId: id });

                if (user.credits < pricing.price) {
                    return insufficientDiamonds(user.credits, pricing.price);
                }

                let credits = user.credits;

                if (pricing.reused) {
                    credits = yt.db.spendCredits(user.id, pricing.price, `reuse:summary:${mode}:${id}`);
                    grantArtifactAccess(yt.db, {
                        userId: user.id,
                        kind: `summary:${mode}`,
                        videoId: id,
                        creditsSpent: pricing.price,
                    });
                }

                return Response.json(
                    {
                        summary: storedSummary(yt.videos.show(id), mode),
                        mode,
                        lang,
                        cached: true,
                        reused: pricing.reused,
                        creditsSpent: pricing.reused ? pricing.price : 0,
                        credits,
                    },
                    { headers: CORS_HEADERS }
                );
            }

            // Courtesy pre-check → early 402 before body/provider work. The
            // authoritative debit is the atomic reserveCredits below, taken
            // BEFORE the LLM call and released on failure.
            if (user.credits < creditCost) {
                return insufficientDiamonds(user.credits, creditCost);
            }

            const provider = typeof body.provider === "string" ? body.provider : undefined;
            const model = typeof body.model === "string" ? body.model : undefined;
            const tone = parseTone(body.tone);
            const format = parseFormat(body.format);
            const length = parseLength(body.length);
            const targetBins = typeof body.targetBins === "number" ? body.targetBins : undefined;
            const presetId = typeof body.presetId === "number" ? body.presetId : undefined;
            let presetInstructions: string | undefined;

            if (presetId !== undefined) {
                const preset = getPresetForUse(yt.db, user.id, presetId, "summary");

                if (!preset) {
                    return jsonError("preset not found", 404);
                }

                presetInstructions = preset.instructions;
            }

            const hasTranscript = yt.db.getTranscript(id) !== null;
            const needsProvider = mode !== "short" || !!provider || !!model;
            const providerChoice = needsProvider
                ? await resolveProviderChoice({
                      provider,
                      model,
                      fallbackSpec: (await yt.config.get("provider")).summarize,
                  })
                : undefined;
            // Reserve BEFORE the pipeline work so concurrent requests cannot pass
            // a stale balance check and burn provider cost; released on failure.
            const hold = yt.db.reserveCredits({
                userId: user.id,
                amount: creditCost,
                reason: `summary:${mode}`,
                context: id,
            });
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
                        lang,
                        presetInstructions,
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
                        onPartial: (partial) => {
                            if (partial === null || typeof partial !== "object") {
                                logger.debug({ jobId: job.id, videoId: id }, "skipping malformed summary partial");
                                return;
                            }

                            yt.pipeline.emitExternal({
                                type: "summary:partial",
                                jobId: job.id,
                                videoId: id,
                                mode,
                                partial,
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
                // Full-price generation also records access — the generator
                // never pays again, and later users can unlock this artifact.
                grantArtifactAccess(yt.db, {
                    userId: user.id,
                    kind: `summary:${mode}`,
                    videoId: id,
                    creditsSpent: creditCost,
                });
                // Last DB action before the response: anything throwing above
                // still finds the hold "held" and releasable in the catch.
                yt.db.commitHold(hold.holdId);

                return Response.json(
                    {
                        summary:
                            mode === "timestamped"
                                ? (result.timestamped ?? [])
                                : mode === "long"
                                  ? (result.long ?? null)
                                  : (result.short ?? ""),
                        mode,
                        lang,
                        cached: false,
                        jobId: job.id,
                        startedAt,
                        creditsSpent: creditCost,
                        credits: hold.credits,
                    },
                    { headers: CORS_HEADERS }
                );
            } catch (error) {
                yt.db.releaseHold(hold.holdId);
                const message = error instanceof Error ? error.message : String(error);
                yt.db.updateJob(job.id, { status: "failed", error: message, completedAt: new Date().toISOString() });
                const failedJob = yt.db.getJob(job.id) ?? job;
                yt.pipeline.emitExternal({ type: "job:failed", job: failedJob, error: message });
                throw error;
            }
        }

        const estimateRoute = matchRoute(req, "GET", "/api/v1/videos/:id/estimate", url.pathname);

        if (estimateRoute) {
            const id = estimateRoute.id as VideoId;
            const mode = parseMode(url.searchParams.get("mode"));
            const choice = await resolveProviderChoice({
                provider: url.searchParams.get("provider") ?? undefined,
                model: url.searchParams.get("model") ?? undefined,
                // Estimates front the summary dialog, so quote the summarize default.
                fallbackSpec: (await yt.config.get("provider")).summarize,
            });
            const transcript = yt.db.getTranscript(id);
            const video = yt.videos.show(id);
            const outputTokens = mode === "long" ? 1200 : mode === "timestamped" ? 700 : 350;

            let inputTokens: number | null = null;
            let basis: "transcript" | "duration" | null = null;

            if (transcript) {
                const compacted = compactTranscript(transcript, { mergeSentences: true });
                inputTokens = PROMPT_OVERHEAD_TOKENS + estimateTokens(compacted.text);
                basis = "transcript";
            } else if (video?.durationSec) {
                inputTokens = PROMPT_OVERHEAD_TOKENS + estimateSpeechTokens(video.durationSec);
                basis = "duration";
            }

            const subscription = choice.provider.subscription === true;
            let estUsd: number | null = null;

            if (inputTokens !== null && !subscription) {
                const pricing =
                    choice.model.pricing ??
                    (await dynamicPricingManager.getPricing(choice.provider.name, choice.model.id)) ??
                    undefined;
                estUsd = estimateLlmCallCostUsd({ pricing, inputTokens, outputTokens });
            }

            // Reuse pricing: an existing artifact the viewer has no access to
            // costs the flat unlock price; already-unlocked costs nothing.
            // Mirrors the POST route: a stored artifact in another language is
            // regenerated at full price — never quoted as a reuse/unlock.
            const viewer = resolveUser(req, url, yt.db);
            const artifactExists = yt.db.hasArtifact(`summary:${mode}`, id);
            const requestedLang = url.searchParams.get("lang") ?? undefined;
            const lang = requestedLang && isOutputLang(requestedLang) ? requestedLang : (viewer?.outputLang ?? "en");
            const langMismatch = artifactExists && video !== null && summaryLangFor(video, mode) !== lang;
            const reusable = artifactExists && !langMismatch;
            const hasAccess = viewer !== null && reusable && yt.db.hasArtifactAccess(viewer.id, `summary:${mode}`, id);
            const reused = reusable && !hasAccess;

            return Response.json(
                {
                    provider: choice.provider.name,
                    model: choice.model.id,
                    subscription,
                    mode,
                    inputTokens,
                    outputTokens,
                    estUsd,
                    basis,
                    creditCost: reusable ? (hasAccess ? 0 : REUSE_COST) : CREDIT_COSTS[`summary:${mode}`],
                    reused,
                },
                { headers: CORS_HEADERS }
            );
        }

        const qa = matchRoute(req, "POST", "/api/v1/videos/:id/qa", url.pathname);

        if (qa) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const id = qa.id as VideoId;
            await yt.videos.ensureMetadata(id);

            const body = await safeJsonBody(req);

            if (!body || typeof body.question !== "string" || body.question.trim() === "") {
                return jsonError("body must include {question: string}", 400);
            }

            const scope = body.scope === "channel" ? ("channel" as const) : ("video" as const);
            const askCost = scope === "channel" ? CREDIT_COSTS["qa:channel"] : CREDIT_COSTS.ask;
            // No per-question language override (spec: "no per-question
            // selector — noise") — ask always follows the user's saved
            // output-language preference.
            const lang = user.outputLang && isOutputLang(user.outputLang) ? user.outputLang : "en";

            if (user.credits < askCost) {
                return insufficientDiamonds(user.credits, askCost);
            }

            // Channel scope searches transcripts only — the comment corpus is a
            // single-video feature.
            const sources = scope === "channel" ? (["transcript"] as QaSource[]) : parseSources(body.sources);
            const question = body.question;

            let videoIds: VideoId[] = [id];
            let crossVideo: NonNullable<Parameters<typeof yt.qa.ask>[0]["crossVideo"]> | undefined;

            if (scope === "channel") {
                const video = yt.videos.show(id);

                if (!video) {
                    return jsonError("video not found", 404);
                }

                const selection = selectCandidateVideos(yt.db, { channel: video.channelHandle, question });
                videoIds = selection.videoIds.length > 0 ? selection.videoIds : [id];
                crossVideo = {
                    videos: Object.fromEntries(
                        videoIds.map((videoId) => {
                            const member = yt.db.getVideo(videoId);

                            return [
                                videoId,
                                { title: member?.title ?? videoId, uploadDate: member?.uploadDate ?? null },
                            ];
                        })
                    ),
                    skippedUnindexed: selection.skippedUnindexed,
                };
            } else {
                if (sources.includes("transcript") && !yt.db.getTranscript(id)) {
                    return jsonError("no transcript yet for this video — run pipeline / transcribe first", 409);
                }

                if (sources.includes("comments") && yt.db.getComments(id).length === 0) {
                    return jsonError("comments not fetched yet", 409);
                }
            }

            const topK = typeof body.topK === "number" ? body.topK : undefined;
            const providerChoice = await resolveProviderChoice({
                provider: typeof body.provider === "string" ? body.provider : undefined,
                model: typeof body.model === "string" ? body.model : undefined,
                fallbackSpec: (await yt.config.get("provider")).qa,
            });
            const presetId = typeof body.presetId === "number" ? body.presetId : undefined;
            let presetInstructions: string | undefined;

            if (presetId !== undefined) {
                const preset = getPresetForUse(yt.db, user.id, presetId, "ask");

                if (!preset) {
                    return jsonError("preset not found", 404);
                }

                presetInstructions = preset.instructions;
            }

            // Reserve BEFORE the retrieval/LLM work so concurrent requests cannot
            // pass a stale balance check and burn provider cost; released on failure.
            const hold = yt.db.reserveCredits({
                userId: user.id,
                amount: askCost,
                reason: scope === "channel" ? "qa:channel" : "ask",
                context: id,
            });
            const job = yt.db.enqueueJob({ targetKind: "video", target: id, stages: ["qa"] });
            yt.pipeline.emitExternal({ type: "job:created", job });
            yt.db.updateJob(job.id, { status: "running", currentStage: "qa" });
            const startedJob = yt.db.getJob(job.id) ?? job;
            yt.pipeline.emitExternal({ type: "job:started", job: startedJob });
            yt.pipeline.emitExternal({ type: "stage:started", jobId: job.id, stage: "qa" });
            yt.pipeline.emitExternal({
                type: "stage:progress",
                jobId: job.id,
                stage: "qa",
                progress: 0.05,
                message: "Indexing transcript",
            });

            try {
                const result = await withJobActivity({ jobId: job.id, stage: "qa", db: yt.db }, async () => {
                    for (const videoId of videoIds) {
                        await yt.qa.index({ videoId, sources });
                    }

                    yt.pipeline.emitExternal({
                        type: "stage:progress",
                        jobId: job.id,
                        stage: "qa",
                        progress: 0.5,
                        message: "Answering question",
                    });
                    return yt.qa.ask({
                        videoIds,
                        question,
                        topK,
                        providerChoice,
                        presetInstructions,
                        sources,
                        crossVideo,
                        lang,
                    });
                });
                yt.db.updateJob(job.id, {
                    status: "completed",
                    progress: 1,
                    currentStage: null,
                    completedAt: new Date().toISOString(),
                });
                const completedJob = yt.db.getJob(job.id) ?? job;
                yt.pipeline.emitExternal({ type: "stage:completed", jobId: job.id, stage: "qa" });
                yt.pipeline.emitExternal({ type: "job:completed", job: completedJob });
                const historyItem = yt.db.insertQaHistory({
                    userId: user.id,
                    videoId: id,
                    question,
                    answer: result.answer,
                    citations: result.citations,
                    creditsSpent: askCost,
                    sources,
                    scope,
                    candidateVideoIds: scope === "channel" ? videoIds : undefined,
                    lang,
                });

                // Metadata for every distinct cited video — the UI renders
                // grouped citation headers (title, date, thumbnail) from it.
                const citedVideos = Object.fromEntries(
                    [...new Set(result.citations.map((citation) => citation.videoId))].map((videoId) => {
                        const member = yt.db.getVideo(videoId);

                        return [
                            videoId,
                            {
                                title: member?.title ?? videoId,
                                uploadDate: member?.uploadDate ?? null,
                                thumbUrl: member?.thumbUrl ?? null,
                            },
                        ];
                    })
                );
                // Last DB action before the response: anything throwing above
                // still finds the hold "held" and releasable in the catch.
                yt.db.commitHold(hold.holdId);

                return Response.json(
                    {
                        ...result,
                        jobId: job.id,
                        lang,
                        creditsSpent: askCost,
                        credits: hold.credits,
                        historyId: historyItem.id,
                        citedVideos,
                    },
                    { headers: CORS_HEADERS }
                );
            } catch (error) {
                yt.db.releaseHold(hold.holdId);
                const message = error instanceof Error ? error.message : String(error);
                yt.db.updateJob(job.id, { status: "failed", error: message, completedAt: new Date().toISOString() });
                const failedJob = yt.db.getJob(job.id) ?? job;
                yt.pipeline.emitExternal({ type: "job:failed", job: failedJob, error: message });
                throw error;
            }
        }

        return jsonError("not found", 404);
    } catch (err) {
        if (err instanceof InsufficientCreditsError) {
            // Lost the two-tab race: the courtesy pre-check passed but the
            // atomic upfront debit found the balance already drained.
            return insufficientDiamonds(err.balance, err.required);
        }

        return toErrorResponse(err);
    }
}

function summaryLangFor(video: Video, mode: "short" | "timestamped" | "long"): string {
    return mode === "timestamped"
        ? video.summaryTimestampedLang
        : mode === "long"
          ? video.summaryLongLang
          : video.summaryShortLang;
}

function storedSummary(video: Video | null, mode: "short" | "timestamped" | "long") {
    if (!video) {
        return mode === "timestamped" ? [] : mode === "long" ? null : "";
    }

    return mode === "timestamped"
        ? (video.summaryTimestamped ?? [])
        : mode === "long"
          ? (video.summaryLong ?? null)
          : (video.summaryShort ?? "");
}

/** First 140 chars of the artifact's text — the locked envelope's teaser. */
function summaryPreview(video: Video, mode: "short" | "timestamped" | "long"): string {
    const source =
        mode === "long"
            ? video.summaryLong?.tldr
            : mode === "timestamped"
              ? video.summaryTimestamped?.map((entry) => entry.text).join(" ")
              : video.summaryShort;

    return (source ?? "").slice(0, 140);
}

function insufficientDiamonds(balance: number, required: number): Response {
    return new Response(SafeJSON.stringify({ error: "Not enough diamonds", balance, required }, { strict: true }), {
        status: 402,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
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

    return Response.json({ transcript, speakerLabels: yt.db.getVideoSpeakers(id) }, { headers: CORS_HEADERS });
}

function parseSpeakers(value: unknown): Array<{ idx: number; label: string }> | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const speakers: Array<{ idx: number; label: string }> = [];

    for (const entry of value) {
        const raw = entry as { idx?: unknown; label?: unknown } | null;

        if (
            !raw ||
            typeof raw.idx !== "number" ||
            !Number.isInteger(raw.idx) ||
            raw.idx < 0 ||
            typeof raw.label !== "string" ||
            raw.label.trim().length === 0
        ) {
            return null;
        }

        speakers.push({ idx: raw.idx, label: raw.label.trim() });
    }

    return speakers;
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

function parseSources(value: unknown): QaSource[] {
    if (!Array.isArray(value)) {
        return ["transcript"];
    }

    const valid = value.filter((entry): entry is QaSource => entry === "transcript" || entry === "comments");

    return valid.length > 0 ? [...new Set(valid)] : ["transcript"];
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

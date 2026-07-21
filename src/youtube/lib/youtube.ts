import { join } from "node:path";
import { resolveAiSpecForTask } from "@app/youtube/lib/ai-mapping";
import { grantArtifactAccess } from "@app/youtube/lib/artifact-access";
import { audioPath, ensureBinaryDir, videoFilePath } from "@app/youtube/lib/cache";
import type { ChannelEnsureResult, ChannelHandle, ChannelSyncStatus } from "@app/youtube/lib/channel.types";
import type { VideoComment } from "@app/youtube/lib/comments.types";
import { DEFAULT_BASE_DIR, YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import type { UpsertVideoInput } from "@app/youtube/lib/db.types";
import { buildJobFingerprint } from "@app/youtube/lib/job-fingerprint";
import type { JobStage } from "@app/youtube/lib/jobs.types";
import { Pipeline } from "@app/youtube/lib/pipeline";
import type { PipelineHandlerMap, StageHandlerCtx } from "@app/youtube/lib/pipeline.types";
import { resolveProviderChoice } from "@app/youtube/lib/provider-choice";
import { QaService } from "@app/youtube/lib/qa";
import { type ReportMember, SummaryService } from "@app/youtube/lib/summarize";
import { TranscriptService } from "@app/youtube/lib/transcripts";
import { CREDIT_COSTS } from "@app/youtube/lib/users.types";
import type { VideoId } from "@app/youtube/lib/video.types";
import type { YoutubeDeps, YoutubeOptions } from "@app/youtube/lib/youtube.types";
import {
    downloadAudio,
    downloadVideo,
    dumpVideoMetadata,
    fetchComments,
    listChannelVideos,
} from "@app/youtube/lib/yt-dlp";
import type { ListedVideo } from "@app/youtube/lib/yt-dlp.types";
import { concurrentMap } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";

const DEFAULT_YOUTUBE_DEPS: YoutubeDeps = {
    listChannelVideos,
    dumpVideoMetadata,
    fetchComments,
};

const DEFAULT_MAX_COMMENTS = 100;

export interface SyncDatesOpts {
    channel?: ChannelHandle;
    limit?: number;
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (info: { videoId: VideoId; index: number; total: number; uploadDate: string | null }) => void;
}

export interface SyncDatesResult {
    scanned: number;
    updated: number;
    failed: Array<{ videoId: VideoId; error: string }>;
}

export class Youtube {
    private readonly baseDir: string;
    private readonly deps: YoutubeDeps;
    private _db?: YoutubeDatabase;
    private _config?: YoutubeConfig;
    private _transcripts?: TranscriptService;
    private _summary?: SummaryService;
    private _qa?: QaService;
    private _pipeline?: Pipeline;
    readonly channels: {
        add: (handle: ChannelHandle) => Promise<void>;
        list: () => ReturnType<YoutubeDatabase["listChannels"]>;
        remove: (handle: ChannelHandle) => void;
        sync: (
            handle: ChannelHandle,
            opts?: { limit?: number; includeShorts?: boolean; signal?: AbortSignal }
        ) => Promise<number>;
        /** Upsert + enqueue discover/metadata when not yet synced (deduped). */
        ensure: (handle: ChannelHandle, opts?: { userId?: number | null }) => ChannelEnsureResult;
    };
    readonly videos: {
        list: YoutubeDatabase["listVideos"];
        show: (id: VideoId) => ReturnType<YoutubeDatabase["getVideo"]>;
        search: (
            query: string,
            opts?: { videoIds?: VideoId[]; limit?: number }
        ) => ReturnType<YoutubeDatabase["searchTranscripts"]>;
        searchMetadata: YoutubeDatabase["searchVideos"];
        ensureMetadata: (
            id: VideoId,
            opts?: { signal?: AbortSignal }
        ) => Promise<NonNullable<ReturnType<YoutubeDatabase["getVideo"]>>>;
        syncDates: (opts?: SyncDatesOpts) => Promise<SyncDatesResult>;
    };
    readonly comments: {
        fetch: (id: VideoId, opts?: { max?: number; signal?: AbortSignal }) => Promise<VideoComment[]>;
        list: (id: VideoId) => VideoComment[];
    };

    constructor(options: YoutubeOptions = {}) {
        this.baseDir = options.baseDir ?? DEFAULT_BASE_DIR;
        this.deps = { ...DEFAULT_YOUTUBE_DEPS, ...options.deps };
        this._db = options.db;
        this._config = options.config;
        this.channels = {
            add: async (handle: ChannelHandle): Promise<void> => {
                logger.info({ handle }, "youtube channel add");
                this.db.upsertChannel({ handle });
            },
            list: () => this.db.listChannels(),
            remove: (handle: ChannelHandle): void => {
                logger.info({ handle }, "youtube channel remove");
                this.db.removeChannel(handle);
            },
            ensure: (handle: ChannelHandle, opts: { userId?: number | null } = {}): ChannelEnsureResult => {
                this.db.upsertChannel({ handle });
                const channel = this.db.getChannel(handle);

                if (!channel) {
                    throw new Error(`ensure: channel ${handle} missing after upsert`);
                }

                const stages: JobStage[] = ["discover", "metadata"];
                const fingerprint = buildJobFingerprint({
                    targetKind: "channel",
                    target: handle,
                    stages,
                });
                const active = this.db.findActiveJobByFingerprint(fingerprint);

                if (channel.lastSyncedAt && !active) {
                    logger.info({ handle }, "youtube channel ensure: already synced");

                    return {
                        channel,
                        tracked: true,
                        syncStatus: "synced",
                        job: null,
                        queuePosition: null,
                        reused: false,
                    };
                }

                const result = this.pipeline.enqueue({
                    targetKind: "channel",
                    target: handle,
                    stages,
                    userId: opts.userId ?? null,
                });

                if (!result.job) {
                    throw new Error(`ensure: enqueue returned no job for ${handle}`);
                }

                const syncStatus: ChannelSyncStatus =
                    result.job.status === "running" ? "running" : result.job.status === "failed" ? "failed" : "queued";

                logger.info(
                    {
                        handle,
                        jobId: result.job.id,
                        reused: result.reused,
                        queuePosition: result.queuePosition,
                        syncStatus,
                    },
                    "youtube channel ensure"
                );

                return {
                    channel: this.db.getChannel(handle) ?? channel,
                    tracked: true,
                    syncStatus,
                    job: result.job,
                    queuePosition: result.queuePosition,
                    reused: result.reused,
                };
            },
            sync: async (
                handle: ChannelHandle,
                opts: { limit?: number; includeShorts?: boolean; signal?: AbortSignal } = {}
            ): Promise<number> => {
                logger.info(
                    { handle, limit: opts.limit, includeShorts: opts.includeShorts },
                    "youtube channel sync started"
                );
                this.db.upsertChannel({ handle });
                const videos = await this.deps.listChannelVideos({
                    handle,
                    limit: opts.limit,
                    includeShorts: opts.includeShorts,
                    signal: opts.signal,
                });

                for (const video of videos) {
                    this.db.upsertVideo(listedVideoToInput(handle, video));
                }

                this.db.setChannelSynced(handle);
                logger.info({ handle, videos: videos.length }, "youtube channel sync completed");

                return videos.length;
            },
        };
        this.videos = {
            list: this.db.listVideos.bind(this.db),
            show: (id: VideoId) => this.db.getVideo(id),
            search: (query: string, opts?: { videoIds?: VideoId[]; limit?: number }) =>
                this.db.searchTranscripts(query, opts),
            searchMetadata: this.db.searchVideos.bind(this.db),
            syncDates: async (opts: SyncDatesOpts = {}): Promise<SyncDatesResult> => {
                const candidates = this.db.listVideosMissingUploadDate({
                    channel: opts.channel,
                    limit: opts.limit ?? 500,
                });
                const failed: Array<{ videoId: VideoId; error: string }> = [];
                let updated = 0;

                logger.info({ channel: opts.channel, candidates: candidates.length }, "youtube videos.syncDates start");

                if (candidates.length === 0) {
                    return { scanned: 0, updated: 0, failed: [] };
                }

                let index = 0;
                await concurrentMap({
                    items: candidates,
                    concurrency: opts.concurrency ?? 4,
                    fn: async (video) => {
                        opts.signal?.throwIfAborted();

                        try {
                            const meta = await this.deps.dumpVideoMetadata(video.id, { signal: opts.signal });

                            if (meta.uploadDate) {
                                this.db.upsertVideo({
                                    id: video.id,
                                    channelHandle: video.channelHandle,
                                    title: meta.title ?? video.title,
                                    description: meta.description ?? video.description,
                                    uploadDate: meta.uploadDate,
                                    durationSec: meta.durationSec ?? video.durationSec,
                                    viewCount: meta.viewCount ?? video.viewCount,
                                    likeCount: meta.likeCount ?? video.likeCount,
                                    language: meta.language ?? video.language,
                                    availableCaptionLangs:
                                        meta.availableCaptionLangs ?? video.availableCaptionLangs ?? undefined,
                                    tags: meta.tags ?? video.tags ?? undefined,
                                    isShort: meta.isShort ?? video.isShort,
                                    isLive: meta.isLive ?? video.isLive,
                                    thumbUrl: meta.thumbUrl ?? video.thumbUrl,
                                });
                                updated++;
                            }

                            const current = ++index;
                            opts.onProgress?.({
                                videoId: video.id,
                                index: current,
                                total: candidates.length,
                                uploadDate: meta.uploadDate ?? null,
                            });
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            failed.push({ videoId: video.id, error: message });
                            const current = ++index;
                            opts.onProgress?.({
                                videoId: video.id,
                                index: current,
                                total: candidates.length,
                                uploadDate: null,
                            });
                        }
                    },
                    onError: (video, reason) => {
                        const message = reason instanceof Error ? reason.message : String(reason);
                        failed.push({ videoId: video.id, error: message });
                    },
                });

                logger.info(
                    { scanned: candidates.length, updated, failed: failed.length },
                    "youtube videos.syncDates done"
                );
                return { scanned: candidates.length, updated, failed };
            },
            ensureMetadata: async (id: VideoId, opts: { signal?: AbortSignal } = {}) => {
                logger.info({ videoId: id }, "youtube metadata ensure requested");
                const existing = this.db.getVideo(id);

                if (existing) {
                    logger.debug({ videoId: id }, "youtube metadata already cached");
                    return existing;
                }

                const metadata = await this.deps.dumpVideoMetadata(id, { signal: opts.signal });
                const handle = metadata.channelHandle ?? (`@${metadata.channelId ?? "unknown"}` as ChannelHandle);
                this.db.upsertChannel({ handle, channelId: metadata.channelId, title: metadata.channelTitle });
                this.db.upsertVideo({
                    id: metadata.id,
                    channelHandle: handle,
                    title: metadata.title,
                    description: metadata.description,
                    uploadDate: metadata.uploadDate,
                    durationSec: metadata.durationSec,
                    viewCount: metadata.viewCount,
                    likeCount: metadata.likeCount,
                    language: metadata.language,
                    availableCaptionLangs: metadata.availableCaptionLangs,
                    tags: metadata.tags,
                    isShort: metadata.isShort,
                    isLive: metadata.isLive,
                    thumbUrl: metadata.thumbUrl,
                });

                const saved = this.db.getVideo(id);

                if (!saved) {
                    throw new Error(`ensureMetadata failed to persist video ${id}`);
                }

                logger.info({ videoId: id, channelHandle: handle }, "youtube metadata persisted");
                return saved;
            },
        };
        this.comments = {
            fetch: async (id: VideoId, opts: { max?: number; signal?: AbortSignal } = {}): Promise<VideoComment[]> => {
                logger.info({ videoId: id, max: opts.max }, "youtube comments fetch started");
                await this.videos.ensureMetadata(id, { signal: opts.signal });
                const fetched = await this.deps.fetchComments(id, {
                    max: opts.max ?? DEFAULT_MAX_COMMENTS,
                    signal: opts.signal,
                });
                this.db.upsertComments(id, fetched);
                logger.info({ videoId: id, comments: fetched.length }, "youtube comments fetch completed");

                return this.db.getComments(id);
            },
            list: (id: VideoId): VideoComment[] => this.db.getComments(id),
        };
    }

    get db(): YoutubeDatabase {
        if (!this._db) {
            this._db = new YoutubeDatabase(join(this.baseDir, "youtube.db"));
        }

        return this._db;
    }

    get config(): YoutubeConfig {
        if (!this._config) {
            this._config = new YoutubeConfig({ baseDir: this.baseDir });
        }

        return this._config;
    }

    get transcripts(): TranscriptService {
        if (!this._transcripts) {
            this._transcripts = new TranscriptService(this.db, this.config);
        }

        return this._transcripts;
    }

    get summary(): SummaryService {
        if (!this._summary) {
            this._summary = new SummaryService(this.db, this.config);
        }

        return this._summary;
    }

    get qa(): QaService {
        if (!this._qa) {
            this._qa = new QaService(this.db, this.config);
        }

        return this._qa;
    }

    get pipeline(): Pipeline {
        if (!this._pipeline) {
            this._pipeline = new Pipeline(this.db, this.config, { handlers: this.createPipelineHandlers() });
        }

        return this._pipeline;
    }

    async dispose(): Promise<void> {
        await this._pipeline?.stop();
        this._db?.close();
    }

    private createPipelineHandlers(): PipelineHandlerMap {
        return {
            discover: async (ctx) => {
                if (ctx.job.targetKind !== "channel") {
                    return;
                }

                await this.channels.sync(ctx.job.target as ChannelHandle, { signal: ctx.signal });

                const remainingStages = stagesAfter(ctx.job.stages, "discover");

                if (remainingStages.length === 0) {
                    return;
                }

                const videos = this.db.listVideos({ channel: ctx.job.target as ChannelHandle, includeShorts: true });
                logger.info(
                    {
                        parentJobId: ctx.job.id,
                        channel: ctx.job.target,
                        videos: videos.length,
                        stages: remainingStages,
                    },
                    "youtube enqueueing discovered video jobs"
                );

                for (const video of videos) {
                    this.pipeline.enqueue({
                        targetKind: "video",
                        target: video.id,
                        stages: remainingStages,
                        parentJobId: ctx.job.id,
                    });
                }
            },
            metadata: async (ctx) => {
                if (ctx.job.targetKind !== "video" && ctx.job.targetKind !== "url") {
                    logger.warn(
                        { jobId: ctx.job.id, targetKind: ctx.job.targetKind, target: ctx.job.target },
                        "youtube metadata stage skipped for non-video target"
                    );
                    return;
                }

                await this.videos.ensureMetadata(ctx.job.target as VideoId, { signal: ctx.signal });
            },
            comments: async (ctx) => {
                await this.comments.fetch(ctx.job.target as VideoId, { signal: ctx.signal });
            },
            captions: async (ctx) => {
                await this.runGatedTranscribe(ctx, { forceTranscribe: false });
            },
            audio: async (ctx) => {
                const video = await this.videos.ensureMetadata(ctx.job.target as VideoId, { signal: ctx.signal });
                const nextAudio = audioPath(
                    { cacheDir: join(this.baseDir, "cache") },
                    video.channelHandle,
                    video.id,
                    "opus"
                );
                ensureBinaryDir(nextAudio);
                const result = await downloadAudio({
                    idOrUrl: video.id,
                    outPath: nextAudio,
                    format: "opus",
                    signal: ctx.signal,
                    onProgress: (info) => ctx.onProgress(info.percent ?? 0, info.message),
                });
                this.db.setVideoBinaryPath(video.id, "audio", result.path, result.sizeBytes);
            },
            video: async (ctx) => {
                await this.downloadVideo(ctx.job.target as VideoId, { signal: ctx.signal });
            },
            transcribe: async (ctx) => {
                await this.runGatedTranscribe(ctx, { forceTranscribe: true });
            },
            summarize: async (ctx) => {
                const params = ctx.job.params ?? {};
                const mode =
                    params.mode === "long" || params.mode === "timestamped" || params.mode === "short"
                        ? params.mode
                        : "short";
                const holdId = typeof params.holdId === "number" ? params.holdId : null;
                const creditCost = typeof params.creditCost === "number" ? params.creditCost : 0;
                const videoId = ctx.job.target as VideoId;

                try {
                    const providerChoice = await resolveProviderChoice({
                        provider: typeof params.provider === "string" ? params.provider : undefined,
                        model: typeof params.model === "string" ? params.model : undefined,
                        fallbackSpec: resolveAiSpecForTask(await this.config.getAll(), "summary"),
                    });

                    await this.summary.summarize({
                        videoId,
                        mode,
                        provider: typeof params.provider === "string" ? params.provider : undefined,
                        providerChoice,
                        targetBins: typeof params.targetBins === "number" ? params.targetBins : undefined,
                        forceRecompute: params.force === true,
                        tone:
                            params.tone === "insightful" ||
                            params.tone === "funny" ||
                            params.tone === "actionable" ||
                            params.tone === "controversial"
                                ? params.tone
                                : undefined,
                        format: params.format === "list" || params.format === "qa" ? params.format : undefined,
                        length:
                            params.length === "short" || params.length === "auto" || params.length === "detailed"
                                ? params.length
                                : undefined,
                        lang: typeof params.language === "string" ? params.language : undefined,
                        presetInstructions:
                            typeof params.presetInstructions === "string" ? params.presetInstructions : undefined,
                        signal: ctx.signal,
                        onProgress: (info) => ctx.onProgress((info.percent ?? 50) / 100, info.message),
                        onPartial: (partial) => {
                            if (partial === null || typeof partial !== "object") {
                                return;
                            }

                            this.pipeline.emitExternal({
                                type: "summary:partial",
                                jobId: ctx.job.id,
                                videoId,
                                mode,
                                partial,
                            });
                        },
                    });

                    if (holdId !== null && ctx.job.userId !== null) {
                        this.db.transaction(() => {
                            grantArtifactAccess(this.db, {
                                userId: ctx.job.userId as number,
                                kind: `summary:${mode}`,
                                videoId,
                                creditsSpent: creditCost,
                            });
                            this.db.commitHold(holdId);
                        });
                    }
                } catch (error) {
                    if (holdId !== null) {
                        this.db.releaseHold(holdId);
                    }

                    throw error;
                }
            },
            qa: async (ctx) => {
                const params = ctx.job.params ?? {};
                const holdId = typeof params.holdId === "number" ? params.holdId : null;
                const question = typeof params.question === "string" ? params.question : "";
                const videoId = ctx.job.target as VideoId;
                const scope = params.scope === "channel" ? ("channel" as const) : ("video" as const);
                const sources = Array.isArray(params.sources)
                    ? (params.sources.filter((s) => s === "transcript" || s === "comments") as Array<
                          "transcript" | "comments"
                      >)
                    : (["transcript"] as Array<"transcript" | "comments">);
                const lang = typeof params.language === "string" ? params.language : "en";
                const askCost = typeof params.creditCost === "number" ? params.creditCost : 0;
                const topK = typeof params.topK === "number" ? params.topK : undefined;
                const presetInstructions =
                    typeof params.presetInstructions === "string" ? params.presetInstructions : undefined;
                const videoIds = Array.isArray(params.videoIds)
                    ? (params.videoIds.filter((id): id is string => typeof id === "string") as VideoId[])
                    : [videoId];

                if (!question.trim()) {
                    throw new Error(`qa job ${ctx.job.id}: missing question in params`);
                }

                try {
                    ctx.onProgress(0.05, "Indexing transcript");
                    const providerChoice = await resolveProviderChoice({
                        provider: typeof params.provider === "string" ? params.provider : undefined,
                        model: typeof params.model === "string" ? params.model : undefined,
                        fallbackSpec: resolveAiSpecForTask(await this.config.getAll(), "qa"),
                    });

                    for (const memberId of videoIds) {
                        await this.qa.index({ videoId: memberId, sources });
                    }

                    ctx.onProgress(0.5, "Answering question");
                    const result = await this.qa.ask({
                        videoIds,
                        question,
                        topK,
                        providerChoice,
                        presetInstructions,
                        sources,
                        lang,
                    });

                    if (ctx.job.userId !== null) {
                        this.db.insertQaHistory({
                            userId: ctx.job.userId,
                            videoId,
                            question,
                            answer: result.answer,
                            citations: result.citations,
                            creditsSpent: askCost,
                            sources,
                            scope,
                            candidateVideoIds: scope === "channel" ? videoIds : undefined,
                            lang,
                        });
                    }

                    if (holdId !== null) {
                        this.db.commitHold(holdId);
                    }
                } catch (error) {
                    if (holdId !== null) {
                        this.db.releaseHold(holdId);
                    }

                    throw error;
                }
            },
            reportSynthesize: async (ctx) => {
                if (ctx.job.targetKind !== "report") {
                    logger.warn(
                        { jobId: ctx.job.id, targetKind: ctx.job.targetKind },
                        "youtube reportSynthesize stage skipped for non-report target"
                    );
                    return;
                }

                const reportId = Number(ctx.job.target);
                const report = this.db.getReport(reportId);

                if (!report) {
                    throw new Error(`unknown report ${reportId}`);
                }

                const params = report.params ?? {};
                const providerChoice = await resolveProviderChoice({
                    provider: typeof params.provider === "string" ? params.provider : undefined,
                    model: typeof params.model === "string" ? params.model : undefined,
                });
                const members: ReportMember[] = [];

                for (let i = 0; i < report.memberIds.length; i++) {
                    const videoId = report.memberIds[i] as VideoId;
                    ctx.onProgress(
                        (i / (report.memberIds.length + 1)) * 0.8,
                        `video ${i + 1}/${report.memberIds.length} summarized`
                    );

                    try {
                        const video = await this.videos.ensureMetadata(videoId, { signal: ctx.signal });

                        if (!this.db.getTranscript(videoId)) {
                            await this.transcripts.transcribe({ videoId, signal: ctx.signal });
                        }

                        const summary = await this.summary.summarize({
                            videoId,
                            mode: "long",
                            providerChoice,
                            signal: ctx.signal,
                        });
                        members.push({
                            videoId,
                            title: video.title,
                            uploadDate: video.uploadDate,
                            summary: summary.long ?? null,
                            skipped: summary.long ? null : "no long summary produced",
                        });
                    } catch (error) {
                        ctx.signal.throwIfAborted();
                        // A failed member NEVER fails the whole report — it lands
                        // as a skipped entry with its reason.
                        const reason = error instanceof Error ? error.message : String(error);
                        logger.warn({ videoId, reportId, reason }, "youtube report member skipped");
                        const video = this.db.getVideo(videoId);
                        members.push({
                            videoId,
                            title: video?.title ?? videoId,
                            uploadDate: video?.uploadDate ?? null,
                            summary: null,
                            skipped: reason,
                        });
                    }
                }

                ctx.onProgress(0.85, "Synthesizing report");
                const result = await this.summary.synthesizeReport({ members, providerChoice });
                // A cancel that landed during synthesis is only observed by the
                // pipeline after this handler returns — don't persist a result
                // for a job the user already aborted.
                ctx.signal.throwIfAborted();
                this.db.setReportResult(reportId, result);
                logger.info({ reportId, members: members.length }, "youtube report synthesized");
            },
        };
    }

    /** Shared captions/transcribe stage body: metadata ensure → free captions
     *  tier → diamond-gated ASR fallback, with progress + hold semantics. */
    private async runGatedTranscribe(ctx: StageHandlerCtx, opts: { forceTranscribe: boolean }): Promise<void> {
        const videoId = ctx.job.target as VideoId;
        // Queue path previously skipped metadata → "unknown video" job failures
        // on fresh videos (POST /pipeline does not ingest, unlike POST /summary).
        await this.videos.ensureMetadata(videoId, { signal: ctx.signal });
        const userId = ctx.job.userId;
        // Ref object (not a bare `let`): TS never invalidates `let` narrowing from
        // assignments inside a closure, so a `let hold` read after the await would
        // narrow to `never`; property access on a ref resets narrowing per-read.
        const holdRef: { current: { holdId: number; credits: number } | null } = { current: null };

        try {
            await this.transcripts.transcribe({
                videoId,
                signal: ctx.signal,
                forceTranscribe: opts.forceTranscribe,
                beforeAiTranscription: () => {
                    if (userId === null) {
                        return;
                    }

                    // Reserve before the provider spend; committed on success,
                    // released on failure. Throws InsufficientCreditsError →
                    // job fails with an explicit balance message.
                    holdRef.current = this.db.reserveCredits({
                        userId,
                        amount: CREDIT_COSTS["transcribe:ai"],
                        reason: "transcribe:ai",
                        context: videoId,
                    });
                },
                onProgress: (info) => ctx.onProgress(transcribeStageFraction(info), info.message),
            });

            if (holdRef.current) {
                this.db.commitHold(holdRef.current.holdId);
            }
        } catch (error) {
            if (holdRef.current) {
                this.db.releaseHold(holdRef.current.holdId);
            }

            throw error;
        }
    }

    async downloadVideo(id: VideoId, opts: { quality?: "720p" | "1080p" | "best"; signal?: AbortSignal } = {}) {
        logger.info({ videoId: id, quality: opts.quality }, "youtube video download requested");
        const video = await this.videos.ensureMetadata(id, { signal: opts.signal });
        const quality = opts.quality ?? (await this.config.get("defaultQuality"));
        const nextVideo = videoFilePath(
            { cacheDir: join(this.baseDir, "cache") },
            video.channelHandle,
            video.id,
            "mp4"
        );
        ensureBinaryDir(nextVideo);
        const result = await downloadVideo({ idOrUrl: video.id, outPath: nextVideo, quality, signal: opts.signal });
        this.db.setVideoBinaryPath(video.id, "video", result.path, result.sizeBytes);
        logger.info(
            { videoId: id, path: result.path, sizeBytes: result.sizeBytes },
            "youtube video download completed"
        );

        return result;
    }
}

function stagesAfter(stages: JobStage[], stage: JobStage): JobStage[] {
    const index = stages.indexOf(stage);

    if (index === -1) {
        return [];
    }

    return stages.slice(index + 1);
}

function listedVideoToInput(handle: ChannelHandle, video: ListedVideo): UpsertVideoInput {
    return {
        id: video.id,
        channelHandle: handle,
        title: video.title,
        uploadDate: video.uploadDate,
        durationSec: video.durationSec,
        isShort: video.isShort,
        isLive: video.isLive,
    };
}

/** Maps transcript progress onto the stage's 0..1 bar: audio download fills the first half, ASR the second. */
function transcribeStageFraction(info: { phase: string; percent?: number }): number {
    const within = Math.max(0, Math.min(1, (info.percent ?? 0) / 100));

    return info.phase === "audio" ? within * 0.5 : 0.5 + within * 0.5;
}

import { join } from "node:path";
import logger from "@app/logger";
import { concurrentMap } from "@app/utils/async";
import { audioPath, ensureBinaryDir, videoFilePath } from "@app/youtube/lib/cache";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import { DEFAULT_BASE_DIR, YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import type { UpsertVideoInput } from "@app/youtube/lib/db.types";
import type { JobStage } from "@app/youtube/lib/jobs.types";
import { Pipeline } from "@app/youtube/lib/pipeline";
import type { PipelineHandlerMap } from "@app/youtube/lib/pipeline.types";
import { QaService } from "@app/youtube/lib/qa";
import { SummaryService } from "@app/youtube/lib/summarize";
import { TranscriptService } from "@app/youtube/lib/transcripts";
import type { VideoId } from "@app/youtube/lib/video.types";
import type { YoutubeDeps, YoutubeOptions } from "@app/youtube/lib/youtube.types";
import { downloadAudio, downloadVideo, dumpVideoMetadata, listChannelVideos } from "@app/youtube/lib/yt-dlp";
import type { ListedVideo } from "@app/youtube/lib/yt-dlp.types";

const DEFAULT_YOUTUBE_DEPS: YoutubeDeps = {
    listChannelVideos,
    dumpVideoMetadata,
};

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
            captions: async (ctx) => {
                await this.transcripts.transcribe({ videoId: ctx.job.target as VideoId, signal: ctx.signal });
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
                await this.transcripts.transcribe({
                    videoId: ctx.job.target as VideoId,
                    forceTranscribe: true,
                    signal: ctx.signal,
                });
            },
            summarize: async (ctx) => {
                await this.summary.summarize({ videoId: ctx.job.target as VideoId, mode: "short", signal: ctx.signal });
            },
        };
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

import { join } from "node:path";
import { audioPath, ensureBinaryDir, videoFilePath } from "@app/youtube/lib/cache";
import { DEFAULT_BASE_DIR, YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import type { UpsertVideoInput } from "@app/youtube/lib/db.types";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import type { JobStage } from "@app/youtube/lib/jobs.types";
import { Pipeline } from "@app/youtube/lib/pipeline";
import type { PipelineHandlerMap } from "@app/youtube/lib/pipeline.types";
import { QaService } from "@app/youtube/lib/qa";
import { SummaryService } from "@app/youtube/lib/summarize";
import { TranscriptService } from "@app/youtube/lib/transcripts";
import type { VideoId } from "@app/youtube/lib/video.types";
import { downloadAudio, downloadVideo, dumpVideoMetadata, listChannelVideos } from "@app/youtube/lib/yt-dlp";
import type { ListedVideo } from "@app/youtube/lib/yt-dlp.types";
import type { YoutubeDeps, YoutubeOptions } from "@app/youtube/lib/youtube.types";

const DEFAULT_YOUTUBE_DEPS: YoutubeDeps = {
    listChannelVideos,
    dumpVideoMetadata,
};

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
        sync: (handle: ChannelHandle, opts?: { limit?: number; includeShorts?: boolean; signal?: AbortSignal }) => Promise<number>;
    };
    readonly videos: {
        list: YoutubeDatabase["listVideos"];
        show: (id: VideoId) => ReturnType<YoutubeDatabase["getVideo"]>;
        search: (query: string, opts?: { videoIds?: VideoId[]; limit?: number }) => ReturnType<YoutubeDatabase["searchTranscripts"]>;
        ensureMetadata: (id: VideoId, opts?: { signal?: AbortSignal }) => Promise<NonNullable<ReturnType<YoutubeDatabase["getVideo"]>>>;
    };

    constructor(options: YoutubeOptions = {}) {
        this.baseDir = options.baseDir ?? DEFAULT_BASE_DIR;
        this.deps = { ...DEFAULT_YOUTUBE_DEPS, ...options.deps };
        this._db = options.db;
        this._config = options.config;
        this.channels = {
            add: async (handle: ChannelHandle): Promise<void> => {
                this.db.upsertChannel({ handle });
            },
            list: () => this.db.listChannels(),
            remove: (handle: ChannelHandle): void => {
                this.db.removeChannel(handle);
            },
            sync: async (handle: ChannelHandle, opts: { limit?: number; includeShorts?: boolean; signal?: AbortSignal } = {}): Promise<number> => {
                this.db.upsertChannel({ handle });
                const videos = await this.deps.listChannelVideos({ handle, limit: opts.limit, includeShorts: opts.includeShorts, signal: opts.signal });

                for (const video of videos) {
                    this.db.upsertVideo(listedVideoToInput(handle, video));
                }

                this.db.setChannelSynced(handle);

                return videos.length;
            },
        };
        this.videos = {
            list: this.db.listVideos.bind(this.db),
            show: (id: VideoId) => this.db.getVideo(id),
            search: (query: string, opts?: { videoIds?: VideoId[]; limit?: number }) => this.db.searchTranscripts(query, opts),
            ensureMetadata: async (id: VideoId, opts: { signal?: AbortSignal } = {}) => {
                const existing = this.db.getVideo(id);

                if (existing) {
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

                return saved;
            },
        };
    }

    get db(): YoutubeDatabase {
        return (this._db ??= new YoutubeDatabase(join(this.baseDir, "youtube.db")));
    }

    get config(): YoutubeConfig {
        return (this._config ??= new YoutubeConfig({ baseDir: this.baseDir }));
    }

    get transcripts(): TranscriptService {
        return (this._transcripts ??= new TranscriptService(this.db, this.config));
    }

    get summary(): SummaryService {
        return (this._summary ??= new SummaryService(this.db, this.config));
    }

    get qa(): QaService {
        return (this._qa ??= new QaService(this.db, this.config));
    }

    get pipeline(): Pipeline {
        return (this._pipeline ??= new Pipeline(this.db, this.config, { handlers: this.createPipelineHandlers() }));
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
            },
            metadata: async (ctx) => {
                await this.videos.ensureMetadata(ctx.job.target as VideoId, { signal: ctx.signal });
            },
            captions: async (ctx) => {
                await this.transcripts.transcribe({ videoId: ctx.job.target as VideoId, signal: ctx.signal });
            },
            audio: async (ctx) => {
                const video = await this.videos.ensureMetadata(ctx.job.target as VideoId, { signal: ctx.signal });
                const nextAudio = audioPath({ cacheDir: join(this.baseDir, "cache") }, video.channelHandle, video.id, "opus");
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
                await this.transcripts.transcribe({ videoId: ctx.job.target as VideoId, forceTranscribe: true, signal: ctx.signal });
            },
            summarize: async (ctx) => {
                await this.summary.summarize({ videoId: ctx.job.target as VideoId, mode: "short", signal: ctx.signal });
            },
        };
    }

    async downloadVideo(id: VideoId, opts: { quality?: "720p" | "1080p" | "best"; signal?: AbortSignal } = {}) {
        const video = await this.videos.ensureMetadata(id, { signal: opts.signal });
        const quality = opts.quality ?? (await this.config.get("defaultQuality"));
        const nextVideo = videoFilePath({ cacheDir: join(this.baseDir, "cache") }, video.channelHandle, video.id, "mp4");
        ensureBinaryDir(nextVideo);
        const result = await downloadVideo({ idOrUrl: video.id, outPath: nextVideo, quality, signal: opts.signal });
        this.db.setVideoBinaryPath(video.id, "video", result.path, result.sizeBytes);

        return result;
    }
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

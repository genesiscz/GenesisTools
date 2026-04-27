export type ChannelHandle = `@${string}`;
export type VideoId = string;
export type Language = string;

export type JobStage = "discover" | "metadata" | "captions" | "audio" | "transcribe" | "summarize";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type JobTargetKind = "video" | "channel" | "url";

export interface Channel {
    handle: ChannelHandle;
    channelId: string | null;
    title: string | null;
    description: string | null;
    subscriberCount: number | null;
    thumbUrl: string | null;
    lastSyncedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface VideoMetadata {
    id: VideoId;
    channelHandle: ChannelHandle;
    title: string;
    description: string | null;
    uploadDate: string | null;
    durationSec: number | null;
    viewCount: number | null;
    likeCount: number | null;
    language: Language | null;
    availableCaptionLangs: Language[];
    tags: string[];
    isShort: boolean;
    isLive: boolean;
    thumbUrl: string | null;
}

export interface Video extends VideoMetadata {
    summaryShort: string | null;
    summaryTimestamped: TimestampedSummaryEntry[] | null;
    audioPath: string | null;
    audioSizeBytes: number | null;
    audioCachedAt: string | null;
    videoPath: string | null;
    videoSizeBytes: number | null;
    videoCachedAt: string | null;
    thumbPath: string | null;
    thumbCachedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface TranscriptSegment {
    text: string;
    start: number;
    end: number;
}

export interface Transcript {
    id: number;
    videoId: VideoId;
    lang: Language;
    source: "captions" | "ai";
    text: string;
    segments: TranscriptSegment[];
    durationSec: number | null;
    createdAt: string;
}

export interface TimestampedSummaryEntry {
    startSec: number;
    endSec: number;
    text: string;
}

export interface QaChunk {
    id: number;
    videoId: VideoId;
    chunkIdx: number;
    text: string;
    startSec: number | null;
    endSec: number | null;
    embedding: Float32Array | null;
    embeddingDims: number | null;
    embedderModel: string | null;
    createdAt: string;
}

export interface PipelineJob {
    id: number;
    targetKind: JobTargetKind;
    target: string;
    stages: JobStage[];
    currentStage: JobStage | null;
    status: JobStatus;
    error: string | null;
    progress: number;
    progressMessage: string | null;
    parentJobId: number | null;
    workerId: string | null;
    claimedAt: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
}

export type JobEvent =
    | { type: "job:created"; job: PipelineJob }
    | { type: "job:started"; job: PipelineJob }
    | { type: "stage:started"; jobId: number; stage: JobStage }
    | { type: "stage:progress"; jobId: number; stage: JobStage; progress: number; message?: string }
    | { type: "stage:completed"; jobId: number; stage: JobStage }
    | { type: "job:completed"; job: PipelineJob }
    | { type: "job:failed"; job: PipelineJob; error: string }
    | { type: "job:cancelled"; jobId: number };

export interface YoutubeConfigShape {
    apiPort: number;
    apiBaseUrl: string;
    provider: {
        transcribe?: string;
        summarize?: string;
        qa?: string;
        embed?: string;
    };
    defaultQuality: "720p" | "1080p" | "best";
    concurrency: {
        download: number;
        localTranscribe: number;
        cloudTranscribe: number;
        summarize: number;
    };
    ttls: {
        audio: string;
        video: string;
        thumb: string;
        channelListing: string;
    };
    keepVideo: boolean;
    firstRunComplete: boolean;
    lastPruneAt: string | null;
    preferredLangs: Language[];
}

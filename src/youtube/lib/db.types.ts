import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import type { JobActivityKind, JobStage, JobStatus, JobTargetKind } from "@app/youtube/lib/jobs.types";
import type { Language, TranscriptSegment } from "@app/youtube/lib/transcript.types";
import type { TimestampedSummaryEntry, VideoId, VideoLongSummary } from "@app/youtube/lib/video.types";

export interface UpsertChannelInput {
    handle: ChannelHandle;
    channelId?: string | null;
    title?: string | null;
    description?: string | null;
    subscriberCount?: number | null;
    thumbUrl?: string | null;
}

export interface UpsertVideoInput {
    id: VideoId;
    channelHandle: ChannelHandle;
    title: string;
    description?: string | null;
    uploadDate?: string | null;
    durationSec?: number | null;
    viewCount?: number | null;
    likeCount?: number | null;
    language?: string | null;
    availableCaptionLangs?: string[];
    tags?: string[];
    isShort?: boolean;
    isLive?: boolean;
    thumbUrl?: string | null;
}

export interface ListVideosOpts {
    channel?: ChannelHandle;
    since?: string;
    includeShorts?: boolean;
    includeLive?: boolean;
    limit?: number;
    offset?: number;
}

export interface SetVideoBinaryPathInput {
    id: VideoId;
    kind: "audio" | "video" | "thumb";
    path: string | null;
    sizeBytes?: number;
}

export interface SetVideoSummaryInput {
    id: VideoId;
    kind: "short" | "timestamped" | "long";
    value: string | TimestampedSummaryEntry[] | VideoLongSummary;
}

export interface SaveTranscriptInput {
    videoId: VideoId;
    lang: Language;
    source: "captions" | "ai";
    text: string;
    segments: TranscriptSegment[];
    durationSec?: number | null;
}

export interface GetTranscriptOpts {
    lang?: Language;
    source?: "captions" | "ai";
    preferLang?: Language[];
}

export interface SearchTranscriptsOpts {
    videoIds?: VideoId[];
    limit?: number;
    snippetChars?: number;
}

export type VideoSearchField = "title" | "description" | "tags";

export interface SearchVideosOpts {
    fields?: VideoSearchField[];
    channel?: ChannelHandle;
    limit?: number;
    includeShorts?: boolean;
    includeLive?: boolean;
}

export interface VideoSearchHit {
    videoId: VideoId;
    field: VideoSearchField;
    snippet: string;
    title: string;
    channelHandle: ChannelHandle;
}

export interface TranscriptSearchHit {
    videoId: VideoId;
    lang: Language;
    snippet: string;
    rank: number;
}

export interface UpsertQaChunkInput {
    videoId: VideoId;
    chunkIdx: number;
    text: string;
    startSec?: number | null;
    endSec?: number | null;
    embedding?: Float32Array | null;
    embedderModel?: string | null;
}

export interface EnqueueJobInput {
    targetKind: JobTargetKind;
    target: string;
    stages: JobStage[];
    parentJobId?: number | null;
}

export interface ClaimJobOpts {
    stage?: JobStage;
}

export interface UpdateJobPartial {
    status?: JobStatus;
    currentStage?: JobStage | null;
    error?: string | null;
    progress?: number;
    progressMessage?: string | null;
    completedAt?: string | null;
}

export interface ListJobsOpts {
    status?: JobStatus;
    targetKind?: JobTargetKind;
    target?: string;
    parentJobId?: number;
    limit?: number;
    offset?: number;
}

export interface PruneExpiredBinariesOpts {
    audioOlderThanDays?: number;
    videoOlderThanDays?: number;
    thumbOlderThanDays?: number;
}

export interface PruneExpiredBinariesResult {
    audio: number;
    video: number;
    thumb: number;
}

export interface RecordJobActivityInput {
    jobId: number;
    stage?: JobStage | null;
    kind: JobActivityKind;
    action?: string | null;
    provider?: string | null;
    model?: string | null;
    prompt?: string | null;
    response?: string | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    tokensTotal?: number | null;
    costUsd?: number | null;
    durationMs?: number | null;
    startedAt?: string | null;
    completedAt?: string | null;
    error?: string | null;
}

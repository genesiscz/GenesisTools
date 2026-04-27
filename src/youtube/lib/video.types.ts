import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import type { Language } from "@app/youtube/lib/transcript.types";

export type VideoId = string;

export interface TimestampedSummaryEntry {
    startSec: number;
    endSec: number;
    text: string;
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

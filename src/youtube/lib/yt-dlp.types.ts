import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import type { VideoId } from "@app/youtube/lib/video.types";

export interface YtDlpProgressInfo {
    phase: "download" | "postprocess" | "merge";
    percent?: number;
    message: string;
}

export type YtDlpProgress = (info: YtDlpProgressInfo) => void;

export interface YtDlpAvailability {
    available: boolean;
    version: string | null;
}

export interface ListChannelVideosOpts {
    handle: ChannelHandle;
    limit?: number;
    includeShorts?: boolean;
    sinceUploadDate?: string;
    signal?: AbortSignal;
}

export interface ListedVideo {
    id: VideoId;
    title: string;
    durationSec: number | null;
    uploadDate: string | null;
    isShort: boolean;
    isLive: boolean;
}

export interface DumpedVideoMetadata {
    id: VideoId;
    title: string;
    description: string | null;
    uploadDate: string | null;
    durationSec: number | null;
    viewCount: number | null;
    likeCount: number | null;
    language: string | null;
    availableCaptionLangs: string[];
    tags: string[];
    isShort: boolean;
    isLive: boolean;
    thumbUrl: string | null;
    channelHandle: ChannelHandle | null;
    channelId: string | null;
    channelTitle: string | null;
}

export interface DownloadAudioOpts {
    idOrUrl: string;
    outPath: string;
    format: "wav" | "opus";
    sampleRate?: number;
    bitrate?: number;
    onProgress?: YtDlpProgress;
    signal?: AbortSignal;
}

export interface DownloadAudioResult {
    path: string;
    sizeBytes: number;
    durationSec: number | null;
}

export interface DownloadVideoOpts {
    idOrUrl: string;
    outPath: string;
    quality: "720p" | "1080p" | "best";
    onProgress?: YtDlpProgress;
    signal?: AbortSignal;
}

export interface DownloadVideoResult {
    path: string;
    sizeBytes: number;
}

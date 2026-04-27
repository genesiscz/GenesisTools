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

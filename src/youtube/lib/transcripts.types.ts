import type { Language } from "@app/youtube/lib/transcript.types";
import type { VideoId } from "@app/youtube/lib/video.types";
import type { YtDlpProgressInfo } from "@app/youtube/lib/yt-dlp.types";

export interface TranscribeProgressInfo {
    phase: "audio" | "transcribe";
    percent?: number;
    message: string;
}

export interface TranscribeOpts {
    videoId: VideoId;
    forceTranscribe?: boolean;
    lang?: Language;
    provider?: string;
    persistProvider?: boolean;
    onProgress?: (info: TranscribeProgressInfo) => void;
    signal?: AbortSignal;
}

export interface TranscriberProgressInfo {
    percent?: number;
    message: string;
}

export interface TranscriberSegment {
    text: string;
    start: number;
    end: number;
}

export interface TranscriberResult {
    text: string;
    language?: Language;
    duration?: number;
    segments?: TranscriberSegment[];
}

export type AudioDownloadProgress = (info: YtDlpProgressInfo) => void;

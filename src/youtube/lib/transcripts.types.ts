import type { Language } from "@app/youtube/lib/transcript.types";
import type { VideoId } from "@app/youtube/lib/video.types";
import type { DownloadAudioOpts, DownloadAudioResult, YtDlpProgressInfo } from "@app/youtube/lib/yt-dlp.types";

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

export interface TranscriptServiceTranscriber {
    transcribe(
        audioPath: string,
        opts: { language?: Language; onProgress?: (info: TranscriberProgressInfo) => void }
    ): Promise<TranscriberResult>;
    dispose(): void;
}

export interface TranscriptServiceDeps {
    fetchCaptions: (opts: {
        videoId: VideoId;
        preferredLangs?: Language[];
    }) => Promise<{ text: string; segments: TranscriberSegment[]; lang: Language } | null>;
    downloadAudio: (opts: DownloadAudioOpts) => Promise<DownloadAudioResult>;
    createTranscriber: (opts: { provider?: string; persist?: boolean }) => Promise<TranscriptServiceTranscriber>;
}

export type AudioDownloadProgress = (info: YtDlpProgressInfo) => void;

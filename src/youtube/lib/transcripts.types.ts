import type { CallLLMOptions, CallLLMResult } from "@app/utils/ai/call-llm";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { Language, TranscriptSegment } from "@app/youtube/lib/transcript.types";
import type { VideoId } from "@app/youtube/lib/video.types";
import type { DownloadAudioOpts, DownloadAudioResult, YtDlpProgressInfo } from "@app/youtube/lib/yt-dlp.types";
import type { ProviderChoice } from "@ask/types";

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
    /** Normalized `SPEAKER_NN` label from diarization, when requested. */
    speaker?: string;
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
        opts: { language?: Language; diarize?: boolean; onProgress?: (info: TranscriberProgressInfo) => void }
    ): Promise<TranscriberResult>;
    dispose(): void;
}

export interface TranscriptServiceDeps {
    fetchCaptions: (opts: {
        videoId: VideoId;
        preferredLangs?: Language[];
    }) => Promise<{ text: string; segments: TranscriptSegment[]; lang: Language } | null>;
    downloadAudio: (opts: DownloadAudioOpts) => Promise<DownloadAudioResult>;
    createTranscriber: (opts: { provider?: string; persist?: boolean }) => Promise<TranscriptServiceTranscriber>;
}

export type AudioDownloadProgress = (info: YtDlpProgressInfo) => void;

export interface TranslateProgressInfo {
    percent?: number;
    message: string;
}

export interface TranslateTranscriptOpts {
    db: YoutubeDatabase;
    videoId: VideoId;
    lang: Language;
    providerChoice: ProviderChoice;
    onProgress?: (info: TranslateProgressInfo) => void;
    /** Test seam — defaults to the real `callLLM`. */
    callLLM?: (opts: CallLLMOptions) => Promise<CallLLMResult>;
}

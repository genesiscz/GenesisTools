import type { Language } from "@app/youtube/lib/transcript.types";

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

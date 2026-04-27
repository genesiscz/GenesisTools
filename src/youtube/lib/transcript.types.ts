import type { VideoId } from "@app/youtube/lib/video.types";

export type Language = string;

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

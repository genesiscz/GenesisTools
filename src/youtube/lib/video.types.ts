import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import type { Language } from "@app/youtube/lib/transcript.types";

export type VideoId = string;

export interface TimestampedSummaryEntry {
    /** Section start in whole seconds, in [0, totalSec]. */
    startSec: number;
    /** Section end in whole seconds, ≥ startSec, in [startSec, totalSec]. */
    endSec: number;
    /** A single emoji the LLM picked as a contextual icon. Optional for back-compat with old rows. */
    icon?: string;
    /** 3-6 word headline for the section. Optional for back-compat. */
    title?: string;
    /** When format = "qa", the question this section answers. Otherwise omitted. */
    question?: string;
    /** 1-2 sentence body of the section (the answer when format = "qa"). */
    text: string;
}

export interface VideoLongSummaryChapter {
    title: string;
    summary: string;
}

export interface VideoLongSummary {
    /** 2-3 sentences capturing the essence of the video. */
    tldr: string;
    /** 3-10 bullet points of the most important points the speaker makes. */
    keyPoints: string[];
    /** 2-8 takeaways viewers should walk away with. */
    learnings: string[];
    /** Topical chapter breakdown. NOT necessarily aligned with timestamps. */
    chapters: VideoLongSummaryChapter[];
    /** Optional 1-line closing thought / verdict. */
    conclusion: string | null;
}

export type SummaryTone = "insightful" | "funny" | "actionable" | "controversial";
export type SummaryFormat = "list" | "qa";
export type SummaryLength = "short" | "auto" | "detailed";

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
    summaryLong: VideoLongSummary | null;
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

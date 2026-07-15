import type { CallLLMOptions, CallLLMResult } from "@app/utils/ai/call-llm";
import type { EmbeddingResult } from "@app/utils/ai/types";
import type { Transcript } from "@app/youtube/lib/transcript.types";
import type { VideoId } from "@app/youtube/lib/video.types";
import type { ProviderChoice } from "@ask/types";

export type QaSource = "transcript" | "comments";

export interface IndexOpts {
    videoId: VideoId;
    forceReindex?: boolean;
    provider?: string;
    model?: string;
    signal?: AbortSignal;
    /** Which corpora to embed. Default `["transcript"]`. */
    sources?: QaSource[];
}

export interface IndexResult {
    indexed: number;
    modelId: string;
}

export interface AskOpts {
    videoIds: VideoId[];
    question: string;
    topK?: number;
    streaming?: boolean;
    providerChoice: ProviderChoice;
    streamTarget?: NodeJS.WritableStream;
    /** Resolved, ownership-checked preset instructions (Feature 11) — wrapped
     *  via `buildPresetBlock` and appended AFTER the system prompt is built. */
    presetInstructions?: string;
    /** 2-letter ISO output language. Default "en" (no prompt suffix). */
    lang?: string;
    /** Which corpora to retrieve from. Default `["transcript"]`. */
    sources?: QaSource[];
    /** Channel-scope asks: per-video metadata for prompt tags + attribution,
     *  and the count of candidates skipped by the lazy-index cap. */
    crossVideo?: {
        videos: Record<string, { title: string; uploadDate: string | null }>;
        skippedUnindexed: number;
    };
}

export interface AskCitation {
    videoId: VideoId;
    chunkIdx: number;
    startSec: number | null;
    endSec: number | null;
    source: QaSource;
    author: string | null;
    commentId: string | null;
}

export interface AskResult {
    answer: string;
    citations: AskCitation[];
}

export interface ChunkedTranscript {
    text: string;
    startSec: number | null;
    endSec: number | null;
}

/** One embeddable slice of a comment thread. */
export interface CommentChunk {
    text: string;
    rootCommentId: string;
}

export interface QaChunk {
    id: number;
    videoId: VideoId;
    chunkIdx: number;
    text: string;
    startSec: number | null;
    endSec: number | null;
    embedding: Float32Array | null;
    embeddingDims: number | null;
    embedderModel: string | null;
    createdAt: string;
    source: QaSource;
    /** Comment thread root id for `source: "comments"`; null for transcript chunks. */
    sourceRef: string | null;
}

export interface QaServiceEmbedder {
    embed(text: string): Promise<EmbeddingResult>;
    embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
    dispose(): void;
}

export interface QaServiceDeps {
    createEmbedder: (opts?: { provider?: string; model?: string; persist?: boolean }) => Promise<QaServiceEmbedder>;
    callLLM: (opts: CallLLMOptions) => Promise<CallLLMResult>;
}

export type TranscriptChunkSource = Pick<Transcript, "text" | "segments" | "durationSec">;

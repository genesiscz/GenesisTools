import type { CallLLMOptions, CallLLMResult } from "@app/utils/ai/call-llm";
import type { EmbeddingResult } from "@app/utils/ai/types";
import type { Transcript } from "@app/youtube/lib/transcript.types";
import type { VideoId } from "@app/youtube/lib/video.types";
import type { ProviderChoice } from "@ask/types";

export interface IndexOpts {
    videoId: VideoId;
    forceReindex?: boolean;
    provider?: string;
    model?: string;
    signal?: AbortSignal;
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
}

export interface AskCitation {
    videoId: VideoId;
    chunkIdx: number;
    startSec: number | null;
    endSec: number | null;
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

import type { CallLLMOptions, CallLLMResult } from "@app/utils/ai/call-llm";
import type { SummarizationResult } from "@app/utils/ai/types";
import type { ProviderChoice } from "@ask/types";
import type { TimestampedSummaryEntry, VideoId } from "@app/youtube/lib/video.types";

export interface SummaryProgressInfo {
    phase: "summarize";
    percent?: number;
    message: string;
}

export interface SummarizeOpts {
    videoId: VideoId;
    mode: "short" | "timestamped";
    binSizeSec?: number;
    targetBins?: number;
    forceRecompute?: boolean;
    provider?: string;
    providerChoice?: ProviderChoice;
    onProgress?: (info: SummaryProgressInfo) => void;
    signal?: AbortSignal;
}

export interface SummarizeResult {
    short?: string;
    timestamped?: TimestampedSummaryEntry[];
}

export interface SummaryBin {
    startSec: number;
    endSec: number;
    text: string;
}

export interface SummaryServiceSummarizer {
    summarize(text: string): Promise<SummarizationResult>;
    dispose(): void;
}

export interface SummaryServiceDeps {
    createSummarizer: (opts: { provider?: string }) => Promise<SummaryServiceSummarizer>;
    callLLM: (opts: CallLLMOptions) => Promise<CallLLMResult>;
}

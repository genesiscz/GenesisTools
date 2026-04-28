import type {
    CallLLMOptions,
    CallLLMResult,
    CallLLMStructuredOptions,
    CallLLMStructuredResult,
} from "@app/utils/ai/call-llm";
import type { SummarizationResult } from "@app/utils/ai/types";
import type {
    SummaryFormat,
    SummaryLength,
    SummaryTone,
    TimestampedSummaryEntry,
    VideoId,
    VideoLongSummary,
} from "@app/youtube/lib/video.types";
import type { ProviderChoice } from "@ask/types";

export interface SummaryProgressInfo {
    phase: "summarize";
    percent?: number;
    message: string;
}

export interface SummarizeOpts {
    videoId: VideoId;
    mode: "short" | "timestamped" | "long";
    /** Override the auto section count for `mode = "timestamped"`. */
    targetBins?: number;
    /** Default false. When true, ignores any cached summary for this mode. */
    forceRecompute?: boolean;
    /** Free-form provider hint passed to the legacy Summarizer wrapper for `mode = "short"` only. */
    provider?: string;
    /**
     * Required for `timestamped` and `long` modes. When omitted for `short`, falls back to the
     * Summarizer wrapper using `config.provider.summarize`.
     */
    providerChoice?: ProviderChoice;
    /** Free-form tone steering. Default "insightful". */
    tone?: SummaryTone;
    /** Output style. Default "list". Only respected by `mode = "timestamped"`. */
    format?: SummaryFormat;
    /** Length budget. Default "auto". Affects section count for timestamped, depth for long. */
    length?: SummaryLength;
    /**
     * Optional knob for the transcript-compaction pre-pass. Defaults are sensible — pass
     * `{ stripNoise: false }` only for tests or rare debugging.
     */
    compactOpts?: import("@app/youtube/lib/transcript-compact").CompactOptions;
    onProgress?: (info: SummaryProgressInfo) => void;
    signal?: AbortSignal;
}

export interface SummarizeResult {
    short?: string;
    timestamped?: TimestampedSummaryEntry[];
    long?: VideoLongSummary;
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
    callLLMStructured: <T>(opts: CallLLMStructuredOptions<T>) => Promise<CallLLMStructuredResult<T>>;
}

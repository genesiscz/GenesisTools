import type {
    SummaryFormat,
    SummaryLength,
    SummaryTone,
    TimestampedSummaryEntry,
    VideoId,
    VideoLongSummary,
} from "@app/youtube/lib/video.types";
import type {
    CallLLMOptions,
    CallLLMResult,
    CallLLMStructuredOptions,
    CallLLMStructuredResult,
} from "@genesiscz/utils/ai/call-llm";
import type { ProviderChoice } from "@genesiscz/utils/ask/types";

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
    /** A ModelRef for `mode = "short"` when no `providerChoice` is passed. */
    provider?: string;
    /**
     * Required for `timestamped` and `long` modes. When omitted for `short`, the
     * model comes from `config.provider.summarize` (or the AI config's summarize
     * default) through the same prompt.
     */
    providerChoice?: ProviderChoice;
    /** Free-form tone steering. Default "insightful". */
    tone?: SummaryTone;
    /** 2-letter ISO output language. Default "en" (no prompt suffix). */
    lang?: string;
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
    /**
     * Streaming partial objects from the structured call (`timestamped` / `long` modes only),
     * throttled to ≥250 ms between emissions with a guaranteed final flush before return.
     */
    onPartial?: (partial: unknown) => void;
    signal?: AbortSignal;
    /** Resolved, ownership-checked preset instructions (Feature 11) — wrapped
     *  via `buildPresetBlock` and appended AFTER all other system prompt
     *  construction (base + tone + length). */
    presetInstructions?: string;
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

export interface SummaryServiceDeps {
    callLLM: (opts: CallLLMOptions) => Promise<CallLLMResult>;
    callLLMStructured: <T>(opts: CallLLMStructuredOptions<T>) => Promise<CallLLMStructuredResult<T>>;
}

/** Pre-flight cost estimate for an LLM summarize/QA call (GET /videos/:id/estimate). */
export interface LlmEstimate {
    provider: string;
    model: string;
    subscription: boolean;
    mode: "short" | "timestamped" | "long";
    /** null = nothing to estimate from (no transcript, no metadata yet) */
    inputTokens: number | null;
    outputTokens: number;
    /** null = subscription model or unknown pricing */
    estUsd: number | null;
    basis: "transcript" | "duration" | null;
    /** Diamond price of the run (`CREDIT_COSTS`), shown next to the $ estimate. */
    creditCost: number;
    /** True when the artifact already exists and the user would pay the flat reuse price instead of generating. */
    reused?: boolean;
}

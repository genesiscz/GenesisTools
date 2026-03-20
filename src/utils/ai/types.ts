export type AIProviderType = "cloud" | "local-hf" | "darwinkit" | "coreml";
export type AITask = "transcribe" | "translate" | "summarize" | "classify" | "embed" | "sentiment";

export interface AIProvider {
    readonly type: AIProviderType;
    isAvailable(): Promise<boolean>;
    supports(task: AITask): boolean;
    dispose?(): void;
}

export type ProgressPhase = "download" | "load" | "transcribe";

export interface ProgressInfo {
    phase: ProgressPhase;
    /** 0–100, or undefined if indeterminate */
    percent?: number;
    /** Human-readable status message */
    message: string;
}

export type OnProgress = (info: ProgressInfo) => void;

export interface TranscriptionSegment {
    text: string;
    start: number;
    end: number;
}

export type OnSegment = (segment: TranscriptionSegment) => void;

export interface TranscribeOptions {
    language?: string;
    format?: "text" | "json" | "srt" | "vtt";
    model?: string;
    onProgress?: OnProgress;
    /** Called per chunk as transcription progresses. Text may differ slightly from final result at chunk boundaries. */
    onSegment?: OnSegment;
    /** Language detection config. Only used when `language` is not set. */
    languageDetection?: import("./LanguageDetector").LanguageDetectorOptions;
    /**
     * Whisper generation thresholds. Tune these for different audio types:
     * - Multi-speaker / background speech: lower noSpeechThreshold (e.g. 0.3), raise logprobThreshold (e.g. -0.5)
     * - Noisy recordings: raise compressionRatioThreshold (e.g. 2.0)
     * - Clean single-speaker: defaults work well
     */
    thresholds?: WhisperThresholds;
}

export interface WhisperThresholds {
    /** Skip segments where P(no_speech) exceeds this. Lower = more sensitive to quiet speech. Default: 0.45 */
    noSpeechThreshold?: number;
    /** Discard chunks below this log-probability. Higher (less negative) = stricter. Default: -1.0 */
    logprobThreshold?: number;
    /** Discard chunks with compression ratio above this. Catches repetitive hallucinations. Default: 1.8 */
    compressionRatioThreshold?: number;
    /** Block repeating N-grams of this size. 0 = disabled. Default: 3 */
    noRepeatNgramSize?: number;
    /** Use previous chunk text as conditioning context. false = prevents hallucination cascades. Default: false */
    conditionOnPrevTokens?: boolean;
}

export interface TranscriptionResult {
    text: string;
    segments?: TranscriptionSegment[];
    language?: string;
    duration?: number;
}

/** Chunk emitted by transformers.js chunk_callback during ASR pipeline processing */
export interface TranscriptionChunk {
    text: string;
    timestamp: [number, number | null];
}

/** Progress info from HuggingFace transformers.js model download */
export interface HfDownloadProgress {
    status: string;
    file?: string;
    loaded?: number;
    total?: number;
}

export interface TranslateOptions {
    from?: string;
    to: string;
    model?: string;
}

export interface TranslationResult {
    text: string;
    from: string;
    to: string;
}

export interface SummarizeOptions {
    maxLength?: number;
    model?: string;
}

export interface SummarizationResult {
    summary: string;
    originalLength: number;
}

export interface AITranscriptionProvider extends AIProvider {
    transcribe(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult>;
}

export interface AITranslationProvider extends AIProvider {
    translate(text: string, options: TranslateOptions): Promise<TranslationResult>;
}

export interface AISummarizationProvider extends AIProvider {
    summarize(text: string, options?: SummarizeOptions): Promise<SummarizationResult>;
}

export interface EmbeddingResult {
    vector: Float32Array;
    dimensions: number;
}

export interface EmbedOptions {
    language?: string;
    model?: string;
}

export interface AIEmbeddingProvider extends AIProvider {
    embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult>;
    readonly dimensions: number;
}

export interface TaskConfig {
    provider: AIProviderType;
    model?: string;
}

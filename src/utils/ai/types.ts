import type { AIProviderType, AITask, TaskConfig } from "@app/utils/config/ai.types";

// Re-export canonical types from unified config
export type { AIProviderType, AITask, TaskConfig };

export interface AIProvider {
    readonly type: AIProviderType;
    isAvailable(): Promise<boolean>;
    supports(task: AITask): boolean;
    dispose?(): void;
}

/** Unified model metadata — single source of truth for all AI tasks. */
export interface ModelEntry {
    id: string;
    name: string;
    task: AITask;
    provider: "ollama" | "local-hf" | "darwinkit" | "coreml" | "cloud" | "google" | "openai" | "groq" | "openrouter";
    params?: string;
    dimensions?: number;
    contextLength?: number;
    charsPerToken?: number;
    speed: "fast" | "medium" | "slow";
    ramGB: number;
    license: string;
    bestFor?: string[];
    description: string;
    installCmd?: string;
    taskPrefix?: { document: string; query: string };
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
     * Called after language auto-detection. Return a language code to override,
     * or undefined to accept the detected language. Used for interactive confirmation.
     */
    confirmLanguage?: (detected: import("./LanguageDetector").LanguageDetectionResult) => Promise<string | undefined>;
    /**
     * Whisper generation thresholds. Tune these for different audio types:
     * - Multi-speaker / background speech: lower noSpeechThreshold (e.g. 0.3), raise logprobThreshold (e.g. -0.5)
     * - Noisy recordings: raise compressionRatioThreshold (e.g. 2.0)
     * - Clean single-speaker: defaults work well
     */
    thresholds?: WhisperThresholds;
    /** Enable speaker diarization (AssemblyAI, Deepgram). */
    diarize?: boolean;
    /** Request word-level timestamps (Whisper, Deepgram). */
    wordTimestamps?: boolean;
    /** Enable smart formatting/punctuation (Deepgram). */
    smartFormat?: boolean;
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
    /** Streaming variant — paces audio frames over WebSocket and emits onSegment per finalized chunk. */
    transcribeStream?(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult>;
}

export interface TTSOptions {
    /** Provider-specific voice id (xai: "eve" | "ara" | "rex" | "sal" | "leo"). */
    voice?: string;
    /** BCP-47 language code, or "auto". */
    language?: string;
    /** Output container codec. v1 ships only formats afplay handles natively. */
    format?: "mp3" | "wav";
    /** Enable provider-side text normalization (numbers, abbreviations -> spoken form). */
    textNormalization?: boolean;
    /** Force WebSocket streaming path even if text fits in REST limit. */
    stream?: boolean;
}

export interface TTSResult {
    audio: Buffer;
    /** Response Content-Type — used to pick the temp-file extension for playback. */
    contentType: string;
}

export interface TTSVoice {
    id: string;
    name: string;
    description?: string;
    locale?: string;
}

export interface AITextToSpeechProvider extends AIProvider {
    synthesize(text: string, options?: TTSOptions): Promise<TTSResult>;
    /**
     * Streaming variant — yields audio chunks as they arrive (WebSocket or chunked HTTP).
     * Bypasses REST text-length limits and enables real-time piped playback.
     * Returns a named object so callers can get contentType without consuming the stream first.
     */
    synthesizeStream?(text: string, options?: TTSOptions): { audio: AsyncIterable<Uint8Array>; contentType: string };
    /**
     * Native speak short-circuit — plays audio directly to speakers without a buffer roundtrip.
     * Implemented by local providers (e.g. macOS) that can pipe straight to the audio subsystem.
     */
    speak?(text: string, options?: TTSOptions & { volume?: number; rate?: number; wait?: boolean }): Promise<void>;
    listVoices?(): Promise<TTSVoice[]>;
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
    /** Batch embed multiple texts in a single provider call. Optional -- falls back to sequential embed(). */
    embedBatch?(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]>;
    readonly dimensions: number;
}

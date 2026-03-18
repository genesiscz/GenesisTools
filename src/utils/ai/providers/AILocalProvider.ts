import { toFloat32Audio } from "@app/utils/audio/converter";
import { formatBytes } from "@app/utils/format";
import type { PipelineType } from "@huggingface/transformers";
import { createLanguageDetector, type LanguageDetector } from "../LanguageDetector";
import type {
    AISummarizationProvider,
    AITask,
    AITranscriptionProvider,
    AITranslationProvider,
    HfDownloadProgress,
    OnProgress,
    SummarizationResult,
    SummarizeOptions,
    TranscribeOptions,
    TranscriptionChunk,
    TranscriptionResult,
    TranslateOptions,
    TranslationResult,
} from "../types";

type PipelineInstance = {
    (input: unknown, options?: Record<string, unknown>): Promise<unknown>;
    dispose(): Promise<void>;
};

const SUPPORTED_TASKS: AITask[] = ["transcribe", "translate", "summarize"];

export class AILocalProvider implements AITranscriptionProvider, AITranslationProvider, AISummarizationProvider {
    readonly type = "local-hf" as const;
    private pipelines = new Map<string, PipelineInstance>();
    private pendingPipelines = new Map<string, Promise<PipelineInstance>>();
    private langDetector: LanguageDetector | null = null;

    async isAvailable(): Promise<boolean> {
        return true;
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.includes(task);
    }

    async transcribe(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult> {
        const onProgress = options?.onProgress;

        onProgress?.({ phase: "transcribe", message: "Converting audio..." });
        const audioData = await toFloat32Audio(audio);

        // Auto-detect language if not specified
        let language = options?.language;

        if (!language) {
            onProgress?.({ phase: "transcribe", message: "Detecting language..." });

            let detector: LanguageDetector;

            if (options?.languageDetection) {
                detector = createLanguageDetector(options.languageDetection);
            } else {
                if (!this.langDetector) {
                    this.langDetector = createLanguageDetector();
                }

                detector = this.langDetector;
            }

            let detected: Awaited<ReturnType<LanguageDetector["detectFromAudio"]>>;

            try {
                detected = await detector.detectFromAudio(audioData);
                language = detected.language;
            } finally {
                if (options?.languageDetection) {
                    detector.dispose();
                }
            }

            onProgress?.({
                phase: "transcribe",
                message: `Detected: ${language} (${Math.round(detected.confidence * 100)}% via ${detected.driver})`,
            });
        }

        // whisper-large-v3-turbo: full large-v3 encoder (128 mel bins, 5M+ hours training data)
        // with only 4 decoder layers — near-large-v3 quality at ~2x speed. ~1.5GB (fp16 enc + q4 dec).
        // whisper-small was producing garbage for non-English (Czech especially).
        const model = options?.model ?? "onnx-community/whisper-large-v3-turbo";
        const pipe = await this.getPipeline("automatic-speech-recognition", model, onProgress);

        const durationSec = audioData.length / 16000;
        // 29s instead of 30s: transformers.js bug #1358 causes timestamp collapse at exactly 30s
        const chunkLengthS = 29;
        const totalChunks = Math.ceil(durationSec / chunkLengthS);
        let processedChunks = 0;

        onProgress?.({
            phase: "transcribe",
            percent: 0,
            message: `Transcribing ${Math.round(durationSec)}s [${language}]...`,
        });

        const result = (await pipe(audioData, {
            return_timestamps: true,
            chunk_length_s: chunkLengthS,
            stride_length_s: 5,
            language,
            task: "transcribe",
            // Anti-hallucination params (from openai/whisper-large-v3 model card).
            // Without these, Whisper produces repetitive garbage for non-English languages
            // (e.g. "*vyskává výstře*" repeated 20+ times for Czech input).
            // Configurable via options.thresholds for different audio types (multi-speaker, noisy, etc.)
            condition_on_prev_tokens: options?.thresholds?.conditionOnPrevTokens ?? false,
            compression_ratio_threshold: options?.thresholds?.compressionRatioThreshold ?? 1.8,
            logprob_threshold: options?.thresholds?.logprobThreshold ?? -1.0,
            no_speech_threshold: options?.thresholds?.noSpeechThreshold ?? 0.45,
            no_repeat_ngram_size: options?.thresholds?.noRepeatNgramSize ?? 3,
            // chunk_callback fires when each audio chunk is fully decoded — gives us
            // the text + timestamps live, so the user sees progress as segments stream in.
            chunk_callback: (chunk: TranscriptionChunk) => {
                processedChunks++;
                const pct = Math.min(100, Math.round((processedChunks / totalChunks) * 100));
                const segText = chunk.text.trim();
                const start = chunk.timestamp[0];
                const end = chunk.timestamp[1] ?? start;

                // Fire onSegment live so callers (spinner, UI) see text as it's transcribed
                options?.onSegment?.({ text: segText, start, end });

                onProgress?.({
                    phase: "transcribe",
                    percent: pct,
                    message: `Transcribing [${language}]... ${pct}%`,
                });
            },
        })) as {
            text: string;
            chunks?: Array<{ text: string; timestamp: [number, number] }>;
        };

        onProgress?.({ phase: "transcribe", percent: 100, message: "Transcription complete" });

        return {
            text: result.text,
            language,
            duration: durationSec,
            segments: result.chunks?.map((c) => ({
                text: c.text,
                start: c.timestamp[0],
                end: c.timestamp[1],
            })),
        };
    }

    async translate(text: string, options: TranslateOptions): Promise<TranslationResult> {
        const from = options.from;
        const to = options.to;

        if (!from && !options.model) {
            throw new Error("Local translation requires --from unless an explicit --model is provided.");
        }

        const model = options.model ?? `Helsinki-NLP/opus-mt-${from}-${to}`;

        let pipe: PipelineInstance;

        try {
            pipe = await this.getPipeline("translation", model);
        } catch (err) {
            const cause = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Failed to load translation model "${model}" for ${from ?? "auto"} → ${to}. ` +
                    `Try an explicit --model option or pivot through English. Cause: ${cause}`
            );
        }

        const result = (await pipe(text)) as Array<{ translation_text: string }>;
        const translatedText = result[0]?.translation_text ?? "";

        return {
            text: translatedText,
            from: from ?? "auto",
            to,
        };
    }

    async summarize(text: string, options?: SummarizeOptions): Promise<SummarizationResult> {
        const model = options?.model ?? "Xenova/distilbart-cnn-6-6";
        const pipe = await this.getPipeline("summarization", model);

        const result = (await pipe(text, {
            ...(options?.maxLength ? { max_length: options.maxLength } : {}),
        })) as Array<{ summary_text: string }>;

        return {
            summary: result[0]?.summary_text ?? "",
            originalLength: text.length,
        };
    }

    private async getPipeline(task: PipelineType, model: string, onProgress?: OnProgress): Promise<PipelineInstance> {
        const key = `${task}:${model}`;
        const existing = this.pipelines.get(key);

        if (existing) {
            return existing;
        }

        const pending = this.pendingPipelines.get(key);

        if (pending) {
            return pending;
        }

        const load = (async () => {
            const { pipeline, env } = await import("@huggingface/transformers");

            try {
                const pipe = (await pipeline(task, model, {
                    // Whisper (encoder-decoder) is extremely sensitive to encoder quantization.
                    // HF docs: "encoder-decoder models like Whisper are extremely sensitive to
                    // quantization settings: especially of the encoder."
                    // Flat "q4" quantizes BOTH encoder and decoder to 4-bit, corrupting encoder
                    // hidden states → decoder hallucinates garbage (especially non-English).
                    // Per-module dtype: fp16 encoder (precise) + q4 decoder (compressed).
                    // For non-ASR tasks (translation, summarization), flat q4 is fine — those
                    // models are decoder-only and tolerate aggressive quantization.
                    dtype:
                        task === "automatic-speech-recognition"
                            ? { encoder_model: "fp16", decoder_model_merged: "q4" }
                            : "q4",
                    progress_callback: onProgress
                        ? (info: HfDownloadProgress) => {
                              if (info.status === "progress" && info.loaded != null && info.total) {
                                  const pct = Math.round((info.loaded / info.total) * 100);
                                  const file = info.file?.split("/").pop() ?? "";
                                  const size = `${formatBytes(info.loaded)}/${formatBytes(info.total)}`;

                                  onProgress({
                                      phase: "download",
                                      percent: pct,
                                      message: `Downloading ${file}... ${pct}% (${size})`,
                                  });
                              } else if (info.status === "ready") {
                                  onProgress({ phase: "load", percent: 100, message: "Model loaded" });
                              }
                          }
                        : undefined,
                })) as unknown as PipelineInstance;

                this.pipelines.set(key, pipe);
                return pipe;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);

                if (msg.includes("Protobuf parsing failed") || msg.includes("Load model")) {
                    const cacheDir = env.cacheDir;

                    if (cacheDir) {
                        const { rmSync } = await import("node:fs");
                        const modelCacheDir = `${cacheDir}/models--${model.replace(/\//g, "--")}`;

                        try {
                            rmSync(modelCacheDir, { recursive: true, force: true });
                        } catch {
                            // ignore cleanup errors
                        }
                    }

                    throw new Error(
                        `Model "${model}" cache is corrupted. Deleted cached files — retry to re-download.\n` +
                            `Original error: ${msg}`
                    );
                }

                throw err;
            }
        })();

        this.pendingPipelines.set(key, load);

        try {
            return await load;
        } finally {
            this.pendingPipelines.delete(key);
        }
    }

    dispose(): void {
        for (const pipe of this.pipelines.values()) {
            pipe.dispose().catch(() => {});
        }

        this.pipelines.clear();
        this.langDetector?.dispose();
    }
}

import logger from "@app/logger";
import { toFloat32Audio } from "@app/utils/audio/converter";
import { formatBytes } from "@app/utils/format";
import { ensureHuggingFaceTransformers } from "../ensure-hf";
import { createLanguageDetector, type LanguageDetector } from "../LanguageDetector";
import { getDefaultModel } from "../ModelManager";
import { suppressConsoleWarnings } from "../suppress-warnings";
import type {
    AIEmbeddingProvider,
    AISummarizationProvider,
    AITask,
    AITranscriptionProvider,
    AITranslationProvider,
    EmbeddingResult,
    EmbedOptions,
    HfDownloadProgress,
    OnProgress,
    SummarizationResult,
    SummarizeOptions,
    TranscribeOptions,
    TranscriptionResult,
    TranslateOptions,
    TranslationResult,
} from "../types";

type PipelineInstance = {
    (input: unknown, options?: Record<string, unknown>): Promise<unknown>;
    dispose(): Promise<void>;
    tokenizer: unknown;
};

const SUPPORTED_TASKS: AITask[] = ["transcribe", "translate", "summarize", "embed"];

// ONNX Runtime 1.24.x has a CPU graph optimization bug: the loop re-runs Level3 after
// InsertCast, exposing InsertedPrecisionFreeCast nodes to SimplifiedLayerNormFusion which
// crashes on fp16 models. Workaround: lower graphOptimizationLevel to 'extended' (skips
// the buggy Level3 re-run). Ref: microsoft/onnxruntime#26631, huggingface/transformers.js#1567
// Track this set at runtime so the error-recovery path can add models dynamically.
const FP16_INCOMPATIBLE_ENCODERS = new Set([
    "onnx-community/whisper-large-v3",
    "onnx-community/whisper-large-v3-turbo",
]);

export class AILocalProvider
    implements AITranscriptionProvider, AITranslationProvider, AISummarizationProvider, AIEmbeddingProvider
{
    readonly type = "local-hf" as const;
    readonly dimensions = 384;
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

            // Allow caller to confirm/override the detected language (interactive prompt)
            if (options?.confirmLanguage) {
                const confirmed = await options.confirmLanguage(detected);

                if (confirmed) {
                    language = confirmed;
                }
            }
        }

        // whisper-large-v3-turbo: full large-v3 encoder (128 mel bins, 5M+ hours training data)
        // with only 4 decoder layers — near-large-v3 quality at ~2x speed. ~1.5GB (fp16 enc + q4 dec).
        // whisper-small was producing garbage for non-English (Czech especially).
        const model =
            options?.model ?? getDefaultModel("transcribe", "local-hf") ?? "onnx-community/whisper-large-v3-turbo";
        const pipe = await this.getPipeline("automatic-speech-recognition", model, onProgress);

        const durationSec = audioData.length / 16000;
        // 29s instead of 30s: transformers.js bug #1358 causes timestamp collapse at exactly 30s
        const chunkLengthS = 29;

        logger.info(`[transcribe] start: ${Math.round(durationSec)}s audio, lang=${language}, model=${model}`);
        const transcribeStart = Date.now();

        onProgress?.({
            phase: "transcribe",
            percent: 0,
            message: `Transcribing ${Math.round(durationSec)}s [${language}]...`,
        });

        // WhisperTextStreamer (v3) fires on_chunk_start/on_chunk_end per timestamp
        // token pair (every few seconds of audio), NOT per audio chunk.
        // Use the timestamp time to calculate real progress against total duration.
        const { WhisperTextStreamer } = await import("@huggingface/transformers");
        let currentChunkText = "";
        let lastProgressUpdate = 0;
        let lastTimestamp = 0;
        const PROGRESS_THROTTLE_MS = 300;

        // biome-ignore lint/suspicious/noExplicitAny: pipeline tokenizer type not exposed by @huggingface/transformers
        const streamer = new WhisperTextStreamer(pipe.tokenizer as any, {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function: (text: string) => {
                currentChunkText += text;
                logger.debug(`[transcribe] token: "${text}" (accumulated ${currentChunkText.length} chars)`);

                const now = Date.now();

                if (now - lastProgressUpdate < PROGRESS_THROTTLE_MS) {
                    return;
                }

                const elapsed = now - lastProgressUpdate;
                lastProgressUpdate = now;
                const pct = Math.min(99, Math.round((lastTimestamp / durationSec) * 100));
                const truncated = currentChunkText.length > 60 ? `...${currentChunkText.slice(-57)}` : currentChunkText;

                logger.info(
                    `[transcribe] progress: ${pct}% ts=${lastTimestamp.toFixed(1)}s elapsed_since_last=${elapsed}ms`
                );

                onProgress?.({
                    phase: "transcribe",
                    percent: pct,
                    message: `[${language}] ${pct}% — ${truncated.trim()}`,
                });
            },
            on_chunk_start: (time: number) => {
                const elapsed = Date.now() - transcribeStart;
                logger.info(`[transcribe] chunk_start: time=${time.toFixed(2)}s total_elapsed=${elapsed}ms`);
                lastTimestamp = time;
                currentChunkText = "";
            },
            on_chunk_end: (time: number) => {
                const elapsed = Date.now() - transcribeStart;
                logger.info(
                    `[transcribe] chunk_end: time=${time.toFixed(2)}s text="${currentChunkText.slice(0, 80)}" total_elapsed=${elapsed}ms`
                );
                lastTimestamp = time;

                if (currentChunkText.trim()) {
                    options?.onSegment?.({
                        text: currentChunkText.trim(),
                        start: time - chunkLengthS,
                        end: time,
                    });
                }
            },
        });

        logger.info(
            `[transcribe] calling pipeline with ${audioData.length} samples, chunk_length=${chunkLengthS}s, stride=5s`
        );
        const pipeStart = Date.now();

        const result = (await pipe(audioData, {
            return_timestamps: true,
            chunk_length_s: chunkLengthS,
            stride_length_s: 5,
            language,
            task: "transcribe",
            streamer,
            // Anti-hallucination params (from openai/whisper-large-v3 model card).
            // Without these, Whisper produces repetitive garbage for non-English languages
            // (e.g. "*vyskává výstře*" repeated 20+ times for Czech input).
            // Configurable via options.thresholds for different audio types (multi-speaker, noisy, etc.)
            condition_on_prev_tokens: options?.thresholds?.conditionOnPrevTokens ?? false,
            compression_ratio_threshold: options?.thresholds?.compressionRatioThreshold ?? 1.8,
            logprob_threshold: options?.thresholds?.logprobThreshold ?? -1.0,
            no_speech_threshold: options?.thresholds?.noSpeechThreshold ?? 0.45,
            no_repeat_ngram_size: options?.thresholds?.noRepeatNgramSize ?? 3,
        })) as {
            text: string;
            chunks?: Array<{ text: string; timestamp: [number, number] }>;
        };

        const pipeDuration = Date.now() - pipeStart;
        const totalDuration = Date.now() - transcribeStart;
        logger.info(
            `[transcribe] pipeline done: ${pipeDuration}ms, total=${totalDuration}ms, chunks=${result.chunks?.length ?? 0}, text=${result.text.length} chars`
        );

        onProgress?.({ phase: "transcribe", percent: 100, message: "Transcription complete" });

        const segments = result.chunks?.map((c) => ({
            text: c.text,
            start: c.timestamp[0],
            end: c.timestamp[1],
        }));

        return { text: result.text, language, duration: durationSec, segments };
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

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        const model = options?.model ?? "Xenova/all-MiniLM-L6-v2";
        const pipe = await this.getPipeline("feature-extraction", model);
        const result = await pipe(text, { pooling: "mean", normalize: true });
        const data = (result as { data: Float32Array }).data;

        if (data.length === 0) {
            throw new Error("embed: model returned empty embedding");
        }

        return { vector: new Float32Array(data), dimensions: data.length };
    }

    async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
        if (texts.length === 0) {
            return [];
        }

        const model = options?.model ?? "Xenova/all-MiniLM-L6-v2";
        const pipe = await this.getPipeline("feature-extraction", model);

        // transformers.js feature-extraction pipeline accepts string[]
        const result = await pipe(texts, { pooling: "mean", normalize: true });

        // Result shape: { data: Float32Array, dims: [batchSize, hiddenSize] } (with pooling)
        const data = (result as { data: Float32Array; dims: number[] }).data;
        const dims = (result as { data: Float32Array; dims: number[] }).dims;
        const expectedBatch = texts.length;
        const actualBatch = dims.length >= 2 ? dims[0] : 0;

        if (actualBatch !== expectedBatch) {
            throw new Error(
                `embedBatch: expected ${expectedBatch} vectors, got batch dimension ${actualBatch} (dims: [${dims.join(",")}])`
            );
        }

        const hiddenSize = dims[dims.length - 1];
        const results: EmbeddingResult[] = [];

        for (let i = 0; i < texts.length; i++) {
            const offset = i * hiddenSize;
            const vector = new Float32Array(data.buffer, data.byteOffset + offset * 4, hiddenSize);
            results.push({ vector: new Float32Array(vector), dimensions: hiddenSize });
        }

        return results;
    }

    private async getPipeline(task: string, model: string, onProgress?: OnProgress): Promise<PipelineInstance> {
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
            const installed = await ensureHuggingFaceTransformers();

            if (!installed) {
                throw new Error("HuggingFace Transformers not available — install was declined or failed");
            }

            const { pipeline, env } = await import("@huggingface/transformers");

            // Set HF token for gated models (e.g. whisper-large-v3)
            await this.ensureHfToken(env);

            const restoreWarnings = suppressConsoleWarnings({
                patterns: ["Unable to determine content-length"],
            });

            try {
                const pipe = (await pipeline(task as Parameters<typeof pipeline>[0], model, {
                    // Whisper (encoder-decoder) is extremely sensitive to encoder quantization.
                    // Per-module dtype: fp16 encoder (precise) + q4 decoder (compressed).
                    // For non-ASR tasks, flat q4 is fine (decoder-only models).
                    dtype:
                        task === "automatic-speech-recognition"
                            ? { encoder_model: "fp16", decoder_model_merged: "q4" }
                            : "q4",
                    // ONNX Runtime 1.24.x bug: Level3 re-runs after InsertCast on fp16 models,
                    // crashing with InsertedPrecisionFreeCast/SimplifiedLayerNormFusion error.
                    // Lowering to 'extended' skips the buggy re-run. Only needed for known-bad
                    // models; turbo variants don't hit this code path.
                    ...(FP16_INCOMPATIBLE_ENCODERS.has(model)
                        ? { session_options: { graphOptimizationLevel: "extended" } }
                        : {}),
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

                restoreWarnings();
                this.pipelines.set(key, pipe);
                return pipe;
            } catch (err) {
                restoreWarnings();
                const msg = err instanceof Error ? err.message : String(err);

                // Gated model — prompt for HF token if not configured
                if (msg.includes("Unauthorized") || msg.includes("Access denied") || msg.includes("401")) {
                    const token = await this.promptForHfToken(model, env);

                    if (token) {
                        // Retry with the new token
                        const retryPipe = (await pipeline(task as Parameters<typeof pipeline>[0], model, {
                            dtype:
                                task === "automatic-speech-recognition"
                                    ? { encoder_model: "fp16", decoder_model_merged: "q4" }
                                    : "q4",
                            ...(FP16_INCOMPATIBLE_ENCODERS.has(model)
                                ? { session_options: { graphOptimizationLevel: "extended" } }
                                : {}),
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

                        this.pipelines.set(key, retryPipe);
                        return retryPipe;
                    }

                    throw new Error(
                        `Model "${model}" requires a HuggingFace token. Run: tools ai config → Hugging Face token`,
                    );
                }

                // ONNX Runtime CPU bug: fp16 models crash with InsertedPrecisionFreeCast
                // on certain architectures. Auto-retry with lowered graph optimization.
                if (msg.includes("InsertedPrecisionFreeCast") && !FP16_INCOMPATIBLE_ENCODERS.has(model)) {
                    logger.warn(
                        `[getPipeline] fp16 ONNX RT crash for "${model}". Retrying with graphOptimizationLevel=extended.`
                    );
                    FP16_INCOMPATIBLE_ENCODERS.add(model);

                    const retryPipe = (await pipeline(task as Parameters<typeof pipeline>[0], model, {
                        dtype:
                            task === "automatic-speech-recognition"
                                ? { encoder_model: "fp16", decoder_model_merged: "q4" }
                                : "q4",
                        session_options: { graphOptimizationLevel: "extended" },
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

                    this.pipelines.set(key, retryPipe);
                    return retryPipe;
                }

                if (msg.includes("Protobuf parsing failed") || msg.includes("Load model")) {
                    const cacheDir = env.cacheDir;

                    if (cacheDir) {
                        const { rmSync } = await import("node:fs");

                        // transformers.js uses <cacheDir>/<org>/<model>/ (direct path)
                        const directCacheDir = `${cacheDir}/${model}`;
                        // HF hub uses <cacheDir>/models--<org>--<model>/ (flattened)
                        const hubCacheDir = `${cacheDir}/models--${model.replace(/\//g, "--")}`;

                        for (const dir of [directCacheDir, hubCacheDir]) {
                            try {
                                rmSync(dir, { recursive: true, force: true });
                            } catch {
                                // ignore cleanup errors
                            }
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

    /**
     * Set env.token from AIConfig if available. Called once before first pipeline load.
     */
    private async ensureHfToken(env: { token?: string | null }): Promise<void> {
        if (env.token) {
            return;
        }

        const { AIConfig } = await import("../AIConfig");
        const config = await AIConfig.load();
        const token = config.getHfToken() ?? process.env.HUGGINGFACE_TOKEN ?? process.env.HF_TOKEN;

        if (token) {
            env.token = token;
        }
    }

    /**
     * Prompt the user for a HuggingFace token when a gated model returns Unauthorized.
     * Opens the token page in the browser, saves the token to AIConfig, and sets env.token.
     */
    private async promptForHfToken(
        model: string,
        env: { token?: string | null },
    ): Promise<string | null> {
        const { isInteractive } = await import("@app/utils/cli");

        if (!isInteractive()) {
            return null;
        }

        const p = await import("@clack/prompts");
        const pc = (await import("picocolors")).default;
        const HF_TOKEN_URL = "https://huggingface.co/settings/tokens";

        p.log.warn(
            `Model "${model}" is gated and requires a HuggingFace access token.\n` +
                `Create one at: ${pc.cyan(HF_TOKEN_URL)}\n` +
                `(select "Read" scope, "Fine-grained" type)`,
        );

        const openBrowser = await p.confirm({
            message: "Open HuggingFace token page in browser?",
            initialValue: true,
        });

        if (!p.isCancel(openBrowser) && openBrowser) {
            const { Browser } = await import("@app/utils/browser");
            await Browser.open(HF_TOKEN_URL);
        }

        const token = await p.text({
            message: "Paste your HuggingFace token:",
            placeholder: "hf_...",
            validate: (val) => {
                if (!val?.trim()) {
                    return "Token is required";
                }

                if (!val.startsWith("hf_")) {
                    return "HuggingFace tokens start with hf_";
                }
            },
        });

        if (p.isCancel(token)) {
            return null;
        }

        const tokenStr = (token as string).trim();

        // Save to AIConfig as a huggingface account
        const { AIConfig } = await import("../AIConfig");
        const config = await AIConfig.load();
        await config.setHfToken(tokenStr);

        // Set for current session
        env.token = tokenStr;

        p.log.success("HuggingFace token saved to AI config.");
        return tokenStr;
    }

    dispose(): void {
        for (const pipe of this.pipelines.values()) {
            pipe.dispose().catch(() => {});
        }

        this.pipelines.clear();
        this.langDetector?.dispose();
    }
}

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import type {
    AIEmbeddingProvider,
    AISummarizationProvider,
    AITask,
    AITranscriptionProvider,
    AITranslationProvider,
    EmbeddingResult,
    EmbedOptions,
    SummarizationResult,
    SummarizeOptions,
    TranscribeOptions,
    TranscriptionResult,
    TranslateOptions,
    TranslationResult,
} from "@app/utils/ai/types";
import type { AIProviderType } from "@app/utils/config/ai.types";
import { TranscriptionManager } from "@ask/audio/TranscriptionManager";

type LlmCloudType = "openai" | "groq" | "openrouter";
type TranscribeOnlyCloudType = "assemblyai" | "deepgram" | "gladia";
type CloudType = LlmCloudType | TranscribeOnlyCloudType | "auto";

const ENV_VAR_MAP: Record<Exclude<CloudType, "auto">, string> = {
    openai: "OPENAI_API_KEY",
    groq: "GROQ_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    assemblyai: "ASSEMBLYAI_API_KEY",
    deepgram: "DEEPGRAM_API_KEY",
    gladia: "GLADIA_API_KEY",
};

const AUTO_API_KEY_VARS = Object.values(ENV_VAR_MAP);

const TRANSCRIBE_ONLY: ReadonlySet<AITask> = new Set(["transcribe"]);

const CLOUD_TASKS: Record<CloudType, ReadonlySet<AITask>> = {
    openai: new Set(["transcribe", "translate", "summarize", "embed"]),
    groq: new Set(["transcribe", "translate", "summarize"]),
    openrouter: new Set(["transcribe", "translate", "summarize"]),
    assemblyai: TRANSCRIBE_ONLY,
    deepgram: TRANSCRIBE_ONLY,
    gladia: TRANSCRIBE_ONLY,
    auto: new Set(["transcribe", "translate", "summarize", "embed"]),
};

const DEFAULT_LLM_MODELS: Record<LlmCloudType, string> = {
    groq: "groq/llama-3.3-70b-versatile",
    openrouter: "openrouter/meta-llama/llama-3-70b-instruct",
    openai: "openai/gpt-4o-mini",
};

const FALLBACK_ORDER: ReadonlyArray<LlmCloudType> = ["groq", "openrouter", "openai"];

export class AICloudProvider
    implements AITranscriptionProvider, AITranslationProvider, AISummarizationProvider, AIEmbeddingProvider
{
    readonly type: AIProviderType;
    private readonly cloudType: CloudType;
    readonly dimensions = 1536;
    private _transcriptionManager?: TranscriptionManager;

    constructor(cloudType: CloudType = "auto") {
        this.cloudType = cloudType;
        this.type = cloudType === "auto" ? ("cloud" as AIProviderType) : cloudType;
    }

    private get transcriptionManager(): TranscriptionManager {
        this._transcriptionManager ??= new TranscriptionManager();
        return this._transcriptionManager;
    }

    async isAvailable(): Promise<boolean> {
        if (this.cloudType === "auto") {
            return AUTO_API_KEY_VARS.some((key) => !!process.env[key]);
        }

        return !!process.env[ENV_VAR_MAP[this.cloudType]];
    }

    supports(task: AITask): boolean {
        if (this.cloudType === "auto" && task === "embed") {
            return !!process.env.OPENAI_API_KEY;
        }

        return CLOUD_TASKS[this.cloudType].has(task);
    }

    async transcribe(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult> {
        const tempPath = join(tmpdir(), `ai-transcribe-${Date.now()}.wav`);
        await Bun.write(tempPath, audio);

        try {
            const result = await this.transcriptionManager.transcribeAudio(tempPath, {
                language: options?.language,
                model: options?.model,
                provider: this.cloudType === "auto" ? undefined : this.cloudType,
            });

            return {
                text: result.text,
                duration: result.duration,
            };
        } finally {
            try {
                unlinkSync(tempPath);
            } catch {
                logger.debug(`Failed to clean up temp file: ${tempPath}`);
            }
        }
    }

    async translate(text: string, options: TranslateOptions): Promise<TranslationResult> {
        const { generateText } = await import("ai");
        const model = await this.getLanguageModel(options.model);

        const from = options.from ?? "auto-detect";
        const prompt =
            `Translate the following text from ${from} to ${options.to}. ` +
            `Return ONLY the translated text, no explanations.\n\n${text}`;

        const result = await generateText({
            model,
            prompt,
        });

        return {
            text: result.text,
            from: options.from ?? "auto",
            to: options.to,
        };
    }

    async summarize(text: string, options?: SummarizeOptions): Promise<SummarizationResult> {
        const { generateText } = await import("ai");
        const model = await this.getLanguageModel(options?.model);

        const maxLengthInstruction = options?.maxLength
            ? ` Keep the summary under ${options.maxLength} characters.`
            : "";

        const result = await generateText({
            model,
            prompt:
                `Summarize the following text concisely.${maxLengthInstruction} ` +
                `Return ONLY the summary.\n\n${text}`,
        });

        return {
            summary: result.text,
            originalLength: text.length,
        };
    }

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        const results = await this.embedBatch([text], options);

        if (!results[0]) {
            throw new Error("Embedding API returned empty result");
        }

        return results[0];
    }

    async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
        if (texts.length === 0) {
            return [];
        }

        const model = options?.model ?? "text-embedding-3-small";
        const { createOpenAI } = await import("@ai-sdk/openai");
        const openai = createOpenAI();

        const MAX_BATCH = 2048;
        const results: EmbeddingResult[] = [];

        for (let i = 0; i < texts.length; i += MAX_BATCH) {
            const batch = texts.slice(i, i + MAX_BATCH);
            const result = await openai.embedding(model).doEmbed({ values: batch });

            for (const embedding of result.embeddings) {
                const vec = new Float32Array(embedding);
                results.push({ vector: vec, dimensions: vec.length });
            }
        }

        return results;
    }

    private async getLanguageModel(
        modelSpec?: string
    ): Promise<Parameters<typeof import("ai").generateText>[0]["model"]> {
        if (modelSpec) {
            return this.resolveModel(modelSpec);
        }

        if (this.cloudType !== "auto") {
            if (!(this.cloudType in DEFAULT_LLM_MODELS)) {
                throw new Error(
                    `Provider "${this.cloudType}" is transcribe-only and cannot run LLM tasks. ` +
                        "Use openai/groq/openrouter for summarize/translate."
                );
            }

            return this.resolveModel(DEFAULT_LLM_MODELS[this.cloudType as LlmCloudType]);
        }

        for (const ct of FALLBACK_ORDER) {
            if (process.env[ENV_VAR_MAP[ct]]) {
                return this.resolveModel(DEFAULT_LLM_MODELS[ct]);
            }
        }

        throw new Error("No cloud LLM API key available. Set GROQ_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY.");
    }

    private async resolveModel(spec: string): Promise<Parameters<typeof import("ai").generateText>[0]["model"]> {
        const [providerName, ...modelParts] = spec.split("/");
        const modelId = modelParts.join("/");

        switch (providerName) {
            case "groq": {
                const { createGroq } = await import("@ai-sdk/groq");
                const groq = createGroq();
                return groq(modelId);
            }
            case "openrouter": {
                const { createOpenAI } = await import("@ai-sdk/openai");
                const openrouter = createOpenAI({
                    apiKey: process.env.OPENROUTER_API_KEY,
                    baseURL: "https://openrouter.ai/api/v1",
                });
                return openrouter(modelId);
            }
            case "openai": {
                const { createOpenAI } = await import("@ai-sdk/openai");
                const openai = createOpenAI();
                return openai(modelId);
            }
            default:
                throw new Error(`Unknown cloud provider: ${providerName}. Use groq/, openrouter/, or openai/.`);
        }
    }
}

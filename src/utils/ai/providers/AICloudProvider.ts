import { tmpdir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import { TranscriptionManager } from "@ask/audio/TranscriptionManager";
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
} from "../types";

const API_KEY_ENV_VARS = [
    "GROQ_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ASSEMBLYAI_API_KEY",
    "DEEPGRAM_API_KEY",
    "GLADIA_API_KEY",
];

const SUPPORTED_TASKS: AITask[] = ["transcribe", "translate", "summarize", "embed"];

export class AICloudProvider
    implements AITranscriptionProvider, AITranslationProvider, AISummarizationProvider, AIEmbeddingProvider
{
    readonly type = "cloud" as const;
    readonly dimensions = 1536;
    private transcriptionManager: TranscriptionManager;

    constructor() {
        this.transcriptionManager = new TranscriptionManager();
    }

    async isAvailable(): Promise<boolean> {
        return API_KEY_ENV_VARS.some((key) => !!process.env[key]);
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.includes(task);
    }

    async transcribe(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult> {
        // TranscriptionManager works with file paths, so write buffer to a temp file
        const tempPath = join(tmpdir(), `ai-transcribe-${Date.now()}.wav`);
        await Bun.write(tempPath, audio);

        try {
            const result = await this.transcriptionManager.transcribeAudio(tempPath, {
                language: options?.language,
                model: options?.model,
            });

            // TranscriptionManager doesn't return segments/language yet — pass through what's available
            return {
                text: result.text,
                duration: result.duration,
            };
        } finally {
            // Clean up temp file
            try {
                const { unlinkSync } = await import("node:fs");
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

        // OpenAI supports up to 2048 inputs per request
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
        // Default: groq > openrouter > openai
        if (modelSpec) {
            return this.resolveModel(modelSpec);
        }

        if (process.env.GROQ_API_KEY) {
            return this.resolveModel("groq/llama-3.1-8b-instant");
        }

        if (process.env.OPENROUTER_API_KEY) {
            return this.resolveModel("openrouter/meta-llama/llama-3.1-8b-instant");
        }

        if (process.env.OPENAI_API_KEY) {
            return this.resolveModel("openai/gpt-4o-mini");
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

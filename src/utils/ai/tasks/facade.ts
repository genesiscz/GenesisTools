import { logger } from "@genesiscz/utils/logger";
import { embed as sdkEmbed, embedMany as sdkEmbedMany, generateImage as sdkGenerateImage } from "ai";
import { type CallLLMOptions, type CallLLMResult, callLLM } from "../core/call";
import type { ModelRef } from "../core/model-ref";
import type { ResolvedBinding } from "../core/types";
import type {
    EmbeddingResult,
    EmbedOptions,
    SummarizationResult,
    SummarizeOptions,
    TranscribeOptions,
    TranscriptionResult,
    TranslateOptions,
    TranslationResult,
    TTSResult,
} from "../types";
import { resolveForTask } from "./resolve-task";
import type { SpeakOptions } from "./Synthesizer";
import { Synthesizer } from "./Synthesizer";
import { Transcriber } from "./Transcriber";

/**
 * One entry point per task verb.
 *
 * Before this there were four ways to speak (`AI.speak`, `Synthesizer`,
 * `say/lib/speak.ts` forcing `provider:"local"`, and youtube reaching for
 * `getTextToSpeechProvider` directly) and each had picked up its own idea of how
 * a provider gets chosen. `ai.*` is the only entry point new code should use:
 * every verb resolves through the same ladder, binds a provider plugin, and
 * disposes it.
 *
 * `dispose()` is not optional politeness — a local binding holds a loaded model
 * per bind (local/adapters/index.ts:102-139), so every method here runs its work
 * inside `withBinding`, which frees it in a `finally` even on throw.
 */

export interface ImageOptions {
    /** How many images to generate. Provider-capped; HuggingFace serves one per call. */
    n?: number;
    /** `<width>x<height>`, the ai-sdk spelling. */
    size?: `${number}x${number}`;
}

export interface ImageResult {
    images: Uint8Array[];
    model: string;
    provider: string;
}

export interface TaskCommonOptions {
    /** `opus`, `deepgram/nova-3`, `@account/acc_x:whisper-1` — or nothing, to use the config default. */
    model?: ModelRef;
    /** Tool name, for `defaults.app.<app>.<task>` overrides. */
    app?: string;
}

export class NotImplementedError extends Error {
    constructor(what: string, where: string) {
        super(`${what} is not implemented yet — ${where}`);
        this.name = "NotImplementedError";
    }
}

async function withBinding<T>(
    opts: Parameters<typeof resolveForTask>[0],
    use: (resolved: ResolvedBinding) => Promise<T>
): Promise<T> {
    const resolved = await resolveForTask(opts);

    try {
        return await use(resolved);
    } finally {
        resolved.binding.dispose?.();
    }
}

/**
 * Prompts copied verbatim from the provider they replace, so a summary or a
 * translation produced through the facade reads the same as one produced before
 * it (providers/AICloudProvider.ts:175-194 and :150-173).
 */
function summarizePrompt(text: string, options?: SummarizeOptions): string {
    const maxLengthInstruction = options?.maxLength ? ` Keep the summary under ${options.maxLength} characters.` : "";

    return `Summarize the following text concisely.${maxLengthInstruction} Return ONLY the summary.\n\n${text}`;
}

export const ai = {
    /** A chat completion. Thin over `callLLM`, which owns the single generateText/streamText call. */
    async chat(options: CallLLMOptions): Promise<CallLLMResult> {
        return callLLM(options);
    },

    /**
     * Batch-first, unlike the `AI.embed(text)` it replaces: every caller that
     * embedded more than one thing was already looping, and a provider that can
     * embed 2048 vectors per request should not be asked 2048 times.
     */
    async embed(texts: string[], options?: TaskCommonOptions & EmbedOptions): Promise<EmbeddingResult[]> {
        if (texts.length === 0) {
            return [];
        }

        return withBinding(
            { task: "embed", model: options?.model, app: options?.app, needs: "embedding" },
            async (resolved) => {
                const model = resolved.binding.embedding?.(resolved.model.id);

                if (!model) {
                    throw new Error(`${resolved.plugin.id} exposes no embedding model`);
                }

                const vectors =
                    texts.length === 1
                        ? [(await sdkEmbed({ model, value: texts[0] })).embedding]
                        : (await sdkEmbedMany({ model, values: texts })).embeddings;

                return vectors.map((vector) => ({
                    vector: Float32Array.from(vector),
                    dimensions: vector.length,
                }));
            }
        );
    },

    /**
     * Cloud or on-device, one call.
     *
     * `Transcriber` stays the engine: chunking audio too large for a single
     * upload, retrying transient failures, cleaning repetition loops and running
     * local diarization over the WHOLE buffer are none of them vendor-specific,
     * and re-deriving them here would be two implementations of the same subtle
     * rules. What changed underneath is only who gets asked — its provider now
     * comes from `resolveForTask` and a plugin binding.
     */
    async transcribe(
        audio: Buffer | string,
        options?: TaskCommonOptions & TranscribeOptions
    ): Promise<TranscriptionResult> {
        const transcriber = await Transcriber.create({
            ...(options?.model ? { model: options.model } : {}),
            ...(options?.app ? { app: options.app } : {}),
        });

        try {
            return await transcriber.transcribe(audio, options);
        } finally {
            transcriber.dispose();
        }
    },

    /**
     * Speak, out loud. The one entry point that replaced four.
     *
     * `Synthesizer` is the engine — it owns the rate curve, the volume handling,
     * the streaming threshold and the playback — while WHO speaks comes from
     * `resolveForTask` through `app`/`model`. The `provider` selector remains for
     * the callers that genuinely mean "any local one" rather than a named
     * provider, which is what `tools say` has always meant by default.
     */
    async speak(text: string, options?: TaskCommonOptions & SpeakOptions): Promise<void> {
        const synth = await Synthesizer.create({
            ...(options?.provider ? { provider: options.provider } : {}),
            ...(options?.model ? { model: options.model } : {}),
            ...(options?.app ? { app: options.app } : {}),
        });

        await synth.speak(text, options);
    },

    /** The same resolution, but the audio comes back instead of being played. */
    async synthesize(text: string, options?: TaskCommonOptions & SpeakOptions): Promise<TTSResult> {
        const synth = await Synthesizer.create({
            ...(options?.provider ? { provider: options.provider } : {}),
            ...(options?.model ? { model: options.model } : {}),
            ...(options?.app ? { app: options.app } : {}),
        });

        return synth.synthesize(text, options);
    },

    async summarize(text: string, options?: TaskCommonOptions & SummarizeOptions): Promise<SummarizationResult> {
        const result = await callLLM({
            systemPrompt: "",
            userPrompt: summarizePrompt(text, options),
            task: "summarize",
            ...(options?.model ? { model: options.model } : {}),
            ...(options?.app ? { app: options.app } : {}),
        });

        return { summary: result.content, originalLength: text.length };
    },

    async translate(text: string, options: TaskCommonOptions & TranslateOptions): Promise<TranslationResult> {
        const result = await callLLM({
            systemPrompt: "",
            userPrompt:
                `Translate the following text${options.from ? ` from ${options.from}` : ""} to ${options.to}. ` +
                `Return ONLY the translation.\n\n${text}`,
            task: "translate",
            ...(options.model ? { model: options.model } : {}),
            ...(options.app ? { app: options.app } : {}),
        });

        return {
            text: result.content,
            from: options.from ?? "auto",
            to: options.to,
        };
    },

    /**
     * Image generation.
     *
     * Only the HuggingFace plugin declares the `image` capability today, so in
     * practice this resolves to an `hf-cloud`-style account. The verb exists
     * regardless of how many providers back it: a caller should ask the facade
     * rather than go looking for whichever SDK client happens to be wired up,
     * which is what `tools ai image` still does (src/ai/index.ts:206).
     */
    async image(prompt: string, options?: TaskCommonOptions & ImageOptions): Promise<ImageResult> {
        return withBinding(
            { task: "image", model: options?.model, app: options?.app, needs: "image" },
            async (resolved) => {
                const model = resolved.binding.image?.(resolved.model.id);

                if (!model) {
                    throw new Error(`${resolved.plugin.id} exposes no image model`);
                }

                const result = await sdkGenerateImage({
                    model,
                    prompt,
                    ...(options?.n ? { n: options.n } : {}),
                    ...(options?.size ? { size: options.size } : {}),
                });

                logger.debug(
                    { provider: resolved.plugin.id, model: resolved.model.id, images: result.images.length },
                    "generated images"
                );

                return {
                    images: result.images.map((image) => image.uint8Array),
                    model: resolved.model.id,
                    provider: resolved.plugin.id,
                };
            }
        );
    },

    /**
     * Realtime sessions are the ai-proxy's job, not a per-call binding's; the
     * design lives in the Realtime plan doc.
     */
    async realtime(): Promise<never> {
        throw new NotImplementedError(
            "ai.realtime()",
            "realtime sessions are planned as an ai-proxy surface (see 2026-07-28-RearchitectureRealtime.plan)"
        );
    },
};

export type { AIConfigData, AppConfig, AppDefaults, ProviderConfig } from "@genesiscz/utils/config/ai.types";
export { AIAccount } from "./AIAccount";
export type { AIAccountEntry, AIAccountTokens, AIProvider } from "./account-types";
export type { AccountResolver } from "./resolvers";
export { ensureResolversInitialized, getResolver, registerResolver, resetResolvers } from "./resolvers";

import { Embedder } from "./tasks/Embedder";
import { ai } from "./tasks/facade";
import { Summarizer } from "./tasks/Summarizer";
import type { SpeakOptions } from "./tasks/Synthesizer";
import { Synthesizer } from "./tasks/Synthesizer";
import { Transcriber } from "./tasks/Transcriber";
import { Translator } from "./tasks/Translator";
import { TranscriptionManager } from "./transcription/TranscriptionManager";
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
} from "./types";

export { AIConfig } from "./AIConfig";
export type { EmbeddingProviderOption, EmbeddingSelection } from "./embedding-selection";
export {
    discoverEmbeddingProviders,
    getDefaultModel,
    logProviderChoice,
    selectEmbeddingModel,
    selectEmbeddingProvider,
} from "./embedding-selection";
export type {
    LanguageDetectionDriver,
    LanguageDetectionResult,
    LanguageDetectorOptions,
    TextLanguageDetectionDriver,
} from "./LanguageDetector";
export { createLanguageDetector, LanguageDetector } from "./LanguageDetector";
export { ModelManager } from "./ModelManager";
export {
    findModel,
    getEmbedModelsForType,
    getMaxEmbedChars,
    getModelsByProvider,
    getModelsForTask,
    getTaskPrefix,
} from "./ModelRegistry";
export { Embedder } from "./tasks/Embedder";
export { ai, type TaskCommonOptions } from "./tasks/facade";
export { Summarizer } from "./tasks/Summarizer";
export type { ProviderSelector, SpeakOptions, VoicesByProvider } from "./tasks/Synthesizer";
export { Synthesizer } from "./tasks/Synthesizer";
export { Transcriber } from "./tasks/Transcriber";
export { Translator } from "./tasks/Translator";
export { TranscriptionManager, transcriptionManager } from "./transcription/TranscriptionManager";
export * from "./types";

/**
 * @deprecated Use `ai.*` (`./tasks/facade`). Every member here forwards to it.
 *
 * The two objects differ in exactly one place: `AI.embed` takes one string and
 * returns one result, while `ai.embed` is batch-first. That arity change is why
 * this alias still exists rather than being a re-export — it keeps the ~20 call
 * sites that embed a single string compiling until they are moved.
 */
export const AI = {
    Embedder,
    Synthesizer,
    Transcriber,
    Translator,
    Summarizer,
    TranscriptionManager,

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        const [result] = await ai.embed([text], options);

        if (!result) {
            throw new Error("Embedding provider returned no vector");
        }

        return result;
    },

    async transcribe(audio: Buffer | string, options?: TranscribeOptions): Promise<TranscriptionResult> {
        const t = await Transcriber.create();
        try {
            return await t.transcribe(audio, options);
        } finally {
            t.dispose();
        }
    },

    async translate(text: string, options: TranslateOptions): Promise<TranslationResult> {
        return ai.translate(text, options);
    },

    async summarize(text: string, options?: SummarizeOptions): Promise<SummarizationResult> {
        return ai.summarize(text, options);
    },

    async speak(text: string, options?: SpeakOptions): Promise<void> {
        const s = await Synthesizer.create({ provider: options?.provider });
        await s.speak(text, options);
    },

    async synthesize(text: string, options?: SpeakOptions): Promise<TTSResult> {
        const s = await Synthesizer.create({ provider: options?.provider });
        return s.synthesize(text, options);
    },
};

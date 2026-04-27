export type { AIConfigData, AppConfig, AppDefaults, ProviderConfig } from "@app/utils/config/ai.types";
export { AIAccount } from "./AIAccount";
export type { AIAccountEntry, AIAccountTokens, AIProvider } from "./account-types";
export type { AccountResolver } from "./resolvers";
export { ensureResolversInitialized, getResolver, registerResolver, resetResolvers } from "./resolvers";

import { Embedder } from "./tasks/Embedder";
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
export { Summarizer } from "./tasks/Summarizer";
export type { ProviderSelector, SpeakOptions, VoicesByProvider } from "./tasks/Synthesizer";
export { Synthesizer } from "./tasks/Synthesizer";
export { Transcriber } from "./tasks/Transcriber";
export { Translator } from "./tasks/Translator";
export { TranscriptionManager, transcriptionManager } from "./transcription/TranscriptionManager";
export * from "./types";

export const AI = {
    Embedder,
    Synthesizer,
    Transcriber,
    Translator,
    Summarizer,
    TranscriptionManager,

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        const e = await Embedder.create();

        try {
            return await e.embed(text, options);
        } finally {
            e.dispose();
        }
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
        const t = await Translator.create();
        try {
            return await t.translate(text, options);
        } finally {
            t.dispose();
        }
    },

    async summarize(text: string, options?: SummarizeOptions): Promise<SummarizationResult> {
        const s = await Summarizer.create();
        try {
            return await s.summarize(text, options);
        } finally {
            s.dispose();
        }
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

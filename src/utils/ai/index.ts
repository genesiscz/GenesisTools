export type { AIConfigData, AppConfig, AppDefaults, ProviderConfig } from "@genesiscz/utils/config/ai.types";
export { AIAccount } from "./AIAccount";
export { AIConfig } from "./AIConfig";
export type { AIAccountEntry, AIAccountTokens, AIProvider } from "./account-types";
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
export {
    byTask as getModelsForTask,
    byTaskAndProvider as getModelsByProvider,
    embedModelsForType as getEmbedModelsForType,
    findDescriptor as findModel,
    maxEmbedChars as getMaxEmbedChars,
    taskPrefix as getTaskPrefix,
} from "./local/descriptors";
export { ModelManager } from "./ModelManager";
export type { AccountResolver } from "./resolvers";
export { ensureResolversInitialized, getResolver, registerResolver, resetResolvers } from "./resolvers";
export { Embedder } from "./tasks/Embedder";
export { ai, type TaskCommonOptions, type TextTaskOptions } from "./tasks/facade";
export type { ProviderSelector, SpeakOptions, VoicesByProvider } from "./tasks/Synthesizer";
export { Synthesizer } from "./tasks/Synthesizer";
export { Transcriber } from "./tasks/Transcriber";
export { TranscriptionManager, transcriptionManager } from "./transcription/TranscriptionManager";
export * from "./types";

// Client

// Classification
export { classifyBatch, classifyText, groupByCategory } from "./classification";
export type { DarwinKitOptions } from "./darwinkit";
export { closeDarwinKit, DarwinKit, DarwinKitError, getDarwinKit } from "./darwinkit";
// NLP
export {
    analyzeSentiment,
    areSimilar,
    detectLanguage,
    embedText,
    extractEntities,
    findNeighbors,
    getKeywords,
    lemmatize,
    scoreRelevance,
    tagText,
    textDistance,
} from "./nlp";
export type { NotificationOptions } from "./notifications";
// Notifications
export { sendNotification } from "./notifications";
export type { OcrOptions } from "./ocr";
// OCR
export {
    extractText,
    recognizeText,
    recognizeTextFromBuffer,
} from "./ocr";
export type {
    BatchSentimentOptions,
    ClusterOptions,
    DeduplicateOptions,
    GroupByLanguageOptions,
    RankOptions,
    TextEntities,
} from "./text-analysis";
// Text Analysis (higher-level)
export {
    batchSentiment,
    clusterBySimilarity,
    deduplicateTexts,
    extractEntitiesBatch,
    groupByLanguage,
    rankBySimilarity,
} from "./text-analysis";
export type { SpeakOptions } from "./tts";
// TTS
export { listVoices, speak } from "./tts";

// Types
export type {
    CapabilitiesResult,
    ClassificationItem,
    ClassificationResult,
    Cluster,
    DistanceResult,
    EmbedResult,
    EmbedType,
    Keyword,
    LanguageItem,
    LanguageResult,
    NamedEntity,
    NeighborsResult,
    NlpScheme,
    OcrBlock,
    OcrBounds,
    OcrLevel,
    OcrResult,
    ScoredItem,
    SentimentItem,
    SentimentResult,
    TaggedToken,
    TagResult,
    TextItem,
} from "./types";

// Auth
export { authenticate, checkBiometry } from "./auth";
// Classification
export { classifyBatch, classifyText, groupByCategory } from "./classification";
export type { DarwinKitOptions } from "./darwinkit";
export { closeDarwinKit, DarwinKit, DarwinKitError, getDarwinKit } from "./darwinkit";
// iCloud
export {
    icloudCopy,
    icloudDelete,
    icloudList,
    icloudMkdir,
    icloudMove,
    icloudRead,
    icloudStartMonitoring,
    icloudStatus,
    icloudStopMonitoring,
    icloudWrite,
    icloudWriteBytes,
    onIcloudFilesChanged,
} from "./icloud";
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
// System
export { getCapabilities } from "./system";
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
    AuthAvailableResult,
    AuthenticateResult,
    BiometryType,
    CapabilitiesResult,
    ClassificationItem,
    ClassificationResult,
    Cluster,
    DistanceResult,
    EmbedResult,
    EmbedType,
    ICloudDirEntry,
    ICloudListDirResult,
    ICloudOkResult,
    ICloudReadResult,
    ICloudStatusResult,
    Keyword,
    LanguageItem,
    LanguageResult,
    MethodCapability,
    NamedEntity,
    Neighbor,
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

// src/utils/macos/index.ts

// Client
export { DarwinKitClient, getDarwinKit, closeDarwinKit } from "./darwinkit";

// NLP
export {
  detectLanguage,
  analyzeSentiment,
  tagText,
  extractEntities,
  embedText,
  textDistance,
  areSimilar,
  findNeighbors,
  lemmatize,
  getKeywords,
  scoreRelevance,
} from "./nlp";

// OCR
export {
  recognizeText,
  recognizeTextFromBuffer,
  extractText,
} from "./ocr";
export type { OcrOptions } from "./ocr";

// Text Analysis (higher-level)
export {
  rankBySimilarity,
  batchSentiment,
  groupByLanguage,
  extractEntitiesBatch,
  deduplicateTexts,
  clusterBySimilarity,
} from "./text-analysis";
export type {
  RankOptions,
  BatchSentimentOptions,
  GroupByLanguageOptions,
  TextEntities,
  DeduplicateOptions,
  ClusterOptions,
} from "./text-analysis";

// Classification
export { classifyText, classifyBatch, groupByCategory } from "./classification";

// Types
export type {
  DarwinKitConfig,
  LanguageResult,
  SentimentResult,
  TagResult,
  TaggedToken,
  EmbedResult,
  DistanceResult,
  NeighborsResult,
  NlpScheme,
  EmbedType,
  OcrBlock,
  OcrBounds,
  OcrResult,
  OcrLevel,
  CapabilitiesResult,
  ScoredItem,
  TextItem,
  SentimentItem,
  LanguageItem,
  NamedEntity,
  Keyword,
  ClassificationResult,
  ClassificationItem,
  Cluster,
} from "./types";

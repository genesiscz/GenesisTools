// Re-export types from @genesiscz/darwinkit package
export type {
    AuthAvailableResult,
    AuthenticateResult,
    BiometryType,
    CapabilitiesResult,
    DistanceResult,
    EmbedResult,
    EmbedType,
    ICloudDirEntry,
    ICloudListDirResult,
    ICloudOkResult,
    ICloudReadResult,
    ICloudStatusResult,
    LanguageResult,
    MethodCapability,
    NeighborsResult,
    OCRBlock as OcrBlock,
    OCRBounds as OcrBounds,
    OCRResult as OcrResult,
    RecognitionLevel as OcrLevel,
    SentimentResult,
    TagScheme as NlpScheme,
} from "@genesiscz/darwinkit";

// ─── Local Types (different shape from package) ──────────────────────────────

/** A single token annotation from nlp.tag (flattened format) */
export interface TaggedToken {
    text: string;
    /** e.g. "Noun", "Verb", "PersonalName", "OrganizationName", "PlaceName" */
    tag: string;
    /** The scheme that produced this tag, e.g. "lexicalClass", "nameType" */
    scheme: string;
}

export interface TagResult {
    tokens: TaggedToken[];
}

// ─── Higher-level Utility Types ───────────────────────────────────────────────

/** An item with an attached semantic similarity score (lower = more similar) */
export interface ScoredItem<T> {
    item: T;
    /** Cosine distance from query: 0 = identical */
    score: number;
}

/** Input for batch sentiment analysis */
export interface TextItem<IdType = string> {
    id: IdType;
    text: string;
}

/** Sentiment result for a single item in a batch */
export interface SentimentItem<IdType = string> {
    id: IdType;
    score: number;
    label: "positive" | "negative" | "neutral";
}

/** Language detection result for a single item in a batch */
export interface LanguageItem<IdType = string> {
    id: IdType;
    language: string;
    confidence: number;
}

/** Named entity extracted by NER */
export interface NamedEntity {
    text: string;
    type: "person" | "organization" | "place" | "other";
}

/** A content word extracted from text with its POS class and lemma */
export interface Keyword {
    word: string;
    /** Root/lemma form of the word */
    lemma: string;
    lexicalClass: "Noun" | "Verb" | "Adjective" | "Other";
}

/** Result of text classification against a list of candidate categories */
export interface ClassificationResult {
    /** The best-matching category */
    category: string;
    /** Similarity confidence 0–1 (higher = more confident) */
    confidence: number;
    /** All categories ranked by score descending */
    scores: Array<{ category: string; score: number }>;
}

/** A classification result for a single item in a batch */
export interface ClassificationItem<IdType = string> extends ClassificationResult {
    id: IdType;
}

/** A group of semantically similar items produced by clusterBySimilarity */
export interface Cluster<T> {
    /** All items in this cluster */
    items: T[];
    /** The text of the first item, used as the cluster centroid label */
    centroid: string;
}

// src/utils/macos/types.ts

// ─── JSON-RPC Protocol ────────────────────────────────────────────────────────

export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: string;
    method: string;
    params: Record<string, unknown>;
}

export interface JsonRpcResponse<T = unknown> {
    jsonrpc: "2.0";
    id?: string;
    result?: T;
    error?: { code: number; message: string };
}

/** Client configuration */
export interface DarwinKitConfig {
    /** Per-request timeout in ms. Default: 15_000 */
    timeout?: number;
    /** How long to wait for the "ready" notification on startup. Default: 8_000 */
    startupTimeout?: number;
    /** Override the darwinkit binary path. Default: "darwinkit" (resolved from PATH) */
    binaryPath?: string;
}

// ─── NLP Types ────────────────────────────────────────────────────────────────

export interface LanguageResult {
    /** BCP-47 language code, e.g. "en", "fr", "zh" */
    language: string;
    /** 0.0–1.0 */
    confidence: number;
}

export interface SentimentResult {
    /** -1.0 to 1.0, positive = happy/good, negative = bad/angry */
    score: number;
    label: "positive" | "negative" | "neutral";
}

/** A single token annotation from nlp.tag */
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

export interface EmbedResult {
    vector: number[];
    dimension: number;
}

export interface DistanceResult {
    /** 0 = identical, 2 = maximally different */
    distance: number;
    type: "cosine";
}

export interface Neighbor {
    text: string;
    distance: number;
}

export interface NeighborsResult {
    neighbors: Neighbor[];
}

/** Valid NLP tag schemes */
export type NlpScheme = "lexicalClass" | "nameType" | "lemma" | "sentimentScore" | "language";

/** Word or sentence embedding */
export type EmbedType = "word" | "sentence";

// ─── OCR Types ────────────────────────────────────────────────────────────────

export interface OcrBounds {
    /** Normalized 0–1, bottom-left origin (native macOS coordinates) */
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface OcrBlock {
    text: string;
    /** 0.0–1.0 */
    confidence: number;
    bounds: OcrBounds;
}

export interface OcrResult {
    text: string;
    blocks: OcrBlock[];
}

export type OcrLevel = "fast" | "accurate";

// ─── System Types ─────────────────────────────────────────────────────────────

export interface CapabilitiesResult {
    version: string;
    os: string;
    methods: string[];
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
export interface SentimentItem<IdType = string> extends SentimentResult {
    id: IdType;
}

/** Language detection result for a single item in a batch */
export interface LanguageItem<IdType = string> extends LanguageResult {
    id: IdType;
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

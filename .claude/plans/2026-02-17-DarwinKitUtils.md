# DarwinKit macOS Utilities Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a `src/utils/macos/` utility layer that wraps [darwinkit](https://github.com/0xMassi/darwinkit) — a Swift CLI exposing Apple's NaturalLanguage and Vision frameworks via JSON-RPC over stdio — providing strongly-typed TypeScript modules for NLP (sentiment, language detection, semantic embeddings, NER) and OCR, plus a higher-level text analysis module ready to plug into any tool in the codebase.

**Architecture:** A `DarwinKitClient` class manages the `darwinkit serve` subprocess lifecycle (singleton, lazy start). Thin typed wrappers in `nlp.ts` and `ocr.ts` call through the client. A `text-analysis.ts` module provides higher-level utilities (semantic ranking, batch sentiment, language grouping) built on top of those wrappers. All modules are exported from a barrel `index.ts`. No integration with specific tools yet — that's the job of the Connect plan.

**Tech Stack:** TypeScript, Bun (`Bun.spawn`, `readline`), darwinkit CLI (external binary), no new npm deps required.

**darwinkit capabilities used:**

| darwinkit method | What it gives us |
|---|---|
| `nlp.language` | Language detection (BCP-47 code + confidence) |
| `nlp.sentiment` | Sentiment score + label (positive/negative/neutral) |
| `nlp.tag` | POS tags, NER (people/orgs/places), lemmatization |
| `nlp.embed` | 512-dim semantic text vectors |
| `nlp.distance` | Cosine distance between two texts |
| `nlp.neighbors` | Semantically similar words/sentences |
| `vision.ocr` | On-device OCR from image file (Apple Vision) |
| `system.capabilities` | Probe available methods + OS version |

**Prerequisites:**
```bash
brew install darwinkit
# verify:
darwinkit query '{"jsonrpc":"2.0","id":"1","method":"system.capabilities","params":{}}'
```

---

## File Map

```
src/utils/macos/
  types.ts          # All TypeScript interfaces for darwinkit requests/responses
  darwinkit.ts      # DarwinKitClient subprocess manager (JSON-RPC, singleton)
  nlp.ts            # Typed wrappers for nlp.* methods
  ocr.ts            # Typed wrapper for vision.ocr
  text-analysis.ts  # Higher-level utilities (semantic ranking, batch sentiment, language grouping)
  index.ts          # Barrel export
```

---

## Task 1: Define All Types

**Files:**
- Create: `src/utils/macos/types.ts`

**Step 1: Write the file**

```typescript
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
export type NlpScheme =
  | "lexicalClass"
  | "nameType"
  | "lemma"
  | "sentimentScore"
  | "language";

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
```

**Step 2: Commit**

```bash
git add src/utils/macos/types.ts
git commit -m "feat(macos-utils): add darwinkit type definitions"
```

---

## Task 2: DarwinKit Client

**Files:**
- Create: `src/utils/macos/darwinkit.ts`

This is the most important file — it manages the long-running `darwinkit serve` subprocess, handles the NDJSON JSON-RPC protocol, and exposes a `call<T>()` method.

**Step 1: Write the file**

```typescript
// src/utils/macos/darwinkit.ts

import { createInterface } from "readline";
import logger from "@app/logger";
import type {
  DarwinKitConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  CapabilitiesResult,
} from "./types";

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class DarwinKitClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private pending = new Map<string, PendingEntry>();
  private nextId = 1;
  private startPromise: Promise<void> | null = null;
  private config: Required<DarwinKitConfig>;

  constructor(config: DarwinKitConfig = {}) {
    this.config = {
      timeout: config.timeout ?? 15_000,
      startupTimeout: config.startupTimeout ?? 8_000,
      binaryPath: config.binaryPath ?? "darwinkit",
    };
  }

  /** Ensure the subprocess is running. Idempotent — safe to call multiple times. */
  async start(): Promise<void> {
    // If already starting or started, reuse the same promise
    if (this.startPromise) return this.startPromise;

    this.startPromise = this._doStart();
    return this.startPromise;
  }

  private async _doStart(): Promise<void> {
    logger.debug("DarwinKitClient: spawning darwinkit serve");

    this.proc = Bun.spawn([this.config.binaryPath, "serve"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = createInterface({ input: this.proc.stdout as NodeJS.ReadableStream });

    // Wire up line handler — runs for the lifetime of the process
    this.rl.on("line", (line: string) => this._handleLine(line));

    // Wait for the "ready" notification (darwinkit emits it on startup)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`DarwinKit did not send ready notification within ${this.config.startupTimeout}ms. Is darwinkit installed? Run: brew install darwinkit`));
      }, this.config.startupTimeout);

      // The ready notification has no id (it's a notification, not a response)
      const originalHandler = this._handleLine.bind(this);
      this._handleLine = (line: string) => {
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          // Notifications have no id — the first one is the "ready" notification
          if (!msg.id) {
            clearTimeout(timer);
            // Restore normal handler
            this._handleLine = originalHandler;
            resolve();
            return;
          }
        } catch {
          // ignore parse errors during startup
        }
        originalHandler(line);
      };
    });

    logger.debug("DarwinKitClient: ready");
  }

  private _handleLine(line: string): void {
    if (!line.trim()) return;

    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      logger.warn(`DarwinKitClient: failed to parse line: ${line}`);
      return;
    }

    // Skip notifications (no id)
    if (!msg.id) return;

    const entry = this.pending.get(msg.id);
    if (!entry) {
      logger.warn(`DarwinKitClient: received response for unknown id: ${msg.id}`);
      return;
    }

    this.pending.delete(msg.id);
    clearTimeout(entry.timer);

    if (msg.error) {
      entry.reject(new Error(`DarwinKit error ${msg.error.code}: ${msg.error.message}`));
    } else {
      entry.resolve(msg.result);
    }
  }

  /** Call a darwinkit method and return the typed result. Starts the process lazily. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.start();

    const id = String(this.nextId++);
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DarwinKit request "${method}" timed out after ${this.config.timeout}ms`));
      }, this.config.timeout);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      const line = JSON.stringify(request) + "\n";
      (this.proc!.stdin as NodeJS.WritableStream).write(line);
    });
  }

  /** Close the subprocess and clean up resources. */
  close(): void {
    if (this.proc) {
      try {
        (this.proc.stdin as NodeJS.WritableStream).end();
      } catch {
        // ignore
      }
      this.proc = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    // Reject all pending requests
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`DarwinKitClient closed before request ${id} completed`));
    }
    this.pending.clear();
    this.startPromise = null;
    logger.debug("DarwinKitClient: closed");
  }

  /** Check if the subprocess is running. */
  get isRunning(): boolean {
    return this.proc !== null;
  }

  /** Query available methods and OS info. Useful for capability detection. */
  async capabilities(): Promise<CapabilitiesResult> {
    return this.call<CapabilitiesResult>("system.capabilities");
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance: DarwinKitClient | null = null;

/**
 * Get the shared DarwinKitClient instance.
 * Creates it on first call with default config.
 * The process is started lazily on first `call()` invocation.
 */
export function getDarwinKit(config?: DarwinKitConfig): DarwinKitClient {
  if (!_instance) {
    _instance = new DarwinKitClient(config);
  }
  return _instance;
}

/**
 * Shut down and destroy the shared instance.
 * Call this in process cleanup handlers if needed.
 */
export function closeDarwinKit(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}
```

**Step 2: Commit**

```bash
git add src/utils/macos/darwinkit.ts
git commit -m "feat(macos-utils): add DarwinKitClient subprocess manager"
```

---

## Task 3: NLP Module

**Files:**
- Create: `src/utils/macos/nlp.ts`

Typed convenience functions for every `nlp.*` method.

**Step 1: Write the file**

```typescript
// src/utils/macos/nlp.ts

import { getDarwinKit } from "./darwinkit";
import type {
  LanguageResult,
  SentimentResult,
  TagResult,
  EmbedResult,
  DistanceResult,
  NeighborsResult,
  NlpScheme,
  EmbedType,
  NamedEntity,
  TaggedToken,
} from "./types";

/**
 * Detect the language of a text string.
 *
 * @example
 * const result = await detectLanguage("Bonjour le monde");
 * // → { language: "fr", confidence: 0.999 }
 */
export async function detectLanguage(text: string): Promise<LanguageResult> {
  return getDarwinKit().call<LanguageResult>("nlp.language", { text });
}

/**
 * Analyze sentiment of a text string.
 * Returns a score (-1 to 1) and a label.
 *
 * @example
 * const result = await analyzeSentiment("I love this product!");
 * // → { score: 1.0, label: "positive" }
 */
export async function analyzeSentiment(text: string): Promise<SentimentResult> {
  return getDarwinKit().call<SentimentResult>("nlp.sentiment", { text });
}

/**
 * Tag a text string with POS tags, named entities, or lemmas.
 *
 * @param schemes - One or more schemes to apply. Defaults to ["lexicalClass"].
 *   - "lexicalClass"   → POS tags (Noun, Verb, Adjective, ...)
 *   - "nameType"       → NER (PersonalName, OrganizationName, PlaceName)
 *   - "lemma"          → Root form of each word
 *   - "sentimentScore" → Sentiment score per token
 *   - "language"       → Per-token language
 *
 * @example
 * const result = await tagText("Apple was founded by Steve Jobs", ["nameType"]);
 * // tokens: [{ text: "Apple", tag: "OrganizationName", scheme: "nameType" }, ...]
 */
export async function tagText(
  text: string,
  schemes: NlpScheme[] = ["lexicalClass"],
  language?: string,
): Promise<TagResult> {
  return getDarwinKit().call<TagResult>("nlp.tag", {
    text,
    schemes,
    ...(language ? { language } : {}),
  });
}

/**
 * Extract named entities (people, organizations, places) from text.
 * Convenience wrapper around tagText with the "nameType" scheme.
 *
 * @example
 * const entities = await extractEntities("Tim Cook visited Paris last week.");
 * // → [{ text: "Tim Cook", type: "person" }, { text: "Paris", type: "place" }]
 */
export async function extractEntities(text: string): Promise<NamedEntity[]> {
  const result = await tagText(text, ["nameType"]);
  const nameTypeMap: Record<string, NamedEntity["type"]> = {
    PersonalName: "person",
    OrganizationName: "organization",
    PlaceName: "place",
  };
  return result.tokens
    .filter((t: TaggedToken) => t.tag in nameTypeMap)
    .map((t: TaggedToken) => ({
      text: t.text,
      type: nameTypeMap[t.tag] ?? "other",
    }));
}

/**
 * Compute a 512-dimensional semantic embedding vector for a text string.
 * Requires macOS 11+ for sentence embeddings.
 *
 * @param language - BCP-47 language code. Default: "en"
 * @param type     - "word" or "sentence". Default: "sentence"
 *
 * @example
 * const result = await embedText("quarterly earnings report", "en", "sentence");
 * // → { vector: [...512 floats...], dimension: 512 }
 */
export async function embedText(
  text: string,
  language = "en",
  type: EmbedType = "sentence",
): Promise<EmbedResult> {
  return getDarwinKit().call<EmbedResult>("nlp.embed", { text, language, type });
}

/**
 * Compute the cosine distance between two texts.
 * Returns 0 for identical texts, up to 2 for maximally different.
 *
 * Useful for quick similarity checks without storing embeddings.
 *
 * @example
 * const result = await textDistance("cat", "dog", "en", "word");
 * // → { distance: 0.312, type: "cosine" }
 */
export async function textDistance(
  text1: string,
  text2: string,
  language = "en",
  type: EmbedType = "sentence",
): Promise<DistanceResult> {
  return getDarwinKit().call<DistanceResult>("nlp.distance", { text1, text2, language, type });
}

/**
 * Quick boolean similarity check. Returns true if the cosine distance
 * between the two texts is below the given threshold.
 *
 * @param threshold - Cosine distance threshold. Default: 0.5 (roughly "related")
 *
 * @example
 * const similar = await areSimilar("machine learning", "deep learning");
 * // → true
 */
export async function areSimilar(
  text1: string,
  text2: string,
  threshold = 0.5,
  language = "en",
): Promise<boolean> {
  const result = await textDistance(text1, text2, language);
  return result.distance < threshold;
}

/**
 * Find semantically similar words or sentences.
 *
 * @param count    - Number of neighbors to return. Default: 5
 * @param language - BCP-47 code. Default: "en"
 * @param type     - "word" or "sentence". Default: "word"
 *
 * @example
 * const result = await findNeighbors("programming", 5);
 * // → { neighbors: [{ text: "coding", distance: 0.21 }, ...] }
 */
export async function findNeighbors(
  text: string,
  count = 5,
  language = "en",
  type: EmbedType = "word",
): Promise<NeighborsResult> {
  return getDarwinKit().call<NeighborsResult>("nlp.neighbors", { text, language, type, count });
}
```

**Step 2: Commit**

```bash
git add src/utils/macos/nlp.ts
git commit -m "feat(macos-utils): add typed NLP wrappers (sentiment, language, NER, embeddings)"
```

---

## Task 4: OCR Module

**Files:**
- Create: `src/utils/macos/ocr.ts`

**Step 1: Write the file**

```typescript
// src/utils/macos/ocr.ts

import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getDarwinKit } from "./darwinkit";
import type { OcrResult, OcrLevel } from "./types";

export interface OcrOptions {
  /** BCP-47 language codes to use for recognition. Default: ["en-US"] */
  languages?: string[];
  /** "fast" for speed, "accurate" for quality. Default: "accurate" */
  level?: OcrLevel;
}

/**
 * Extract text from an image file using Apple's Vision framework.
 * Returns the recognized text and per-block bounding boxes.
 *
 * Coordinates in blocks are normalized (0–1) with bottom-left origin
 * (native macOS coordinate system).
 *
 * @param imagePath - Absolute path to the image file (JPEG, PNG, TIFF, HEIC, PDF)
 *
 * @example
 * const result = await recognizeText("/tmp/screenshot.png");
 * console.log(result.text);
 * result.blocks.forEach(b => console.log(b.text, b.confidence));
 */
export async function recognizeText(
  imagePath: string,
  options: OcrOptions = {},
): Promise<OcrResult> {
  return getDarwinKit().call<OcrResult>("vision.ocr", {
    path: imagePath,
    languages: options.languages ?? ["en-US"],
    level: options.level ?? "accurate",
  });
}

/**
 * Extract text from an image buffer (e.g. a downloaded image or screenshot buffer).
 * Writes the buffer to a temp file, runs OCR, then cleans up.
 *
 * @param buffer    - Raw image bytes
 * @param extension - File extension hint, e.g. "png", "jpg". Default: "png"
 *
 * @example
 * const imageBuffer = await fetch("https://example.com/image.png")
 *   .then(r => r.arrayBuffer())
 *   .then(b => Buffer.from(b));
 * const result = await recognizeTextFromBuffer(imageBuffer);
 */
export async function recognizeTextFromBuffer(
  buffer: Buffer | Uint8Array,
  extension = "png",
  options: OcrOptions = {},
): Promise<OcrResult> {
  const tempPath = join(tmpdir(), `darwin-ocr-${Date.now()}.${extension}`);
  try {
    writeFileSync(tempPath, buffer);
    return await recognizeText(tempPath, options);
  } finally {
    if (existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch {}
    }
  }
}

/**
 * Extract only the plain text string from an image file (no bounding boxes).
 * Convenience wrapper around recognizeText.
 *
 * @example
 * const text = await extractText("/tmp/invoice.png");
 */
export async function extractText(
  imagePath: string,
  options: OcrOptions = {},
): Promise<string> {
  const result = await recognizeText(imagePath, options);
  return result.text;
}
```

**Step 2: Commit**

```bash
git add src/utils/macos/ocr.ts
git commit -m "feat(macos-utils): add OCR module wrapping Apple Vision via darwinkit"
```

---

## Task 5: Higher-Level Text Analysis

**Files:**
- Create: `src/utils/macos/text-analysis.ts`

This module builds on `nlp.ts` to provide batch utilities useful for processing lists of texts (e.g. email bodies, commit messages, PR descriptions).

**Step 1: Write the file**

```typescript
// src/utils/macos/text-analysis.ts

import { textDistance, analyzeSentiment, detectLanguage, extractEntities } from "./nlp";
import type {
  ScoredItem,
  TextItem,
  SentimentItem,
  LanguageItem,
  NamedEntity,
  SentimentResult,
} from "./types";

// ─── Semantic Ranking ─────────────────────────────────────────────────────────

export interface RankOptions {
  /** BCP-47 language code. Default: "en" */
  language?: string;
  /** Max results to return. Default: all */
  maxResults?: number;
  /** Maximum cosine distance to include (0–2). Default: 2.0 (include all) */
  maxDistance?: number;
}

/**
 * Rank a list of text items by semantic similarity to a query.
 * Items with the lowest cosine distance to the query come first.
 *
 * Uses Apple's NLEmbedding for on-device semantic similarity — no cloud needed.
 *
 * @example
 * const emails = [
 *   { id: "1", text: "Q4 budget review meeting tomorrow" },
 *   { id: "2", text: "Lunch plans this week?" },
 *   { id: "3", text: "Annual financial planning session" },
 * ];
 * const ranked = await rankBySimilarity("budget planning", emails);
 * // → ranked[0] is email 3 (annual financial planning), ranked[1] is email 1
 */
export async function rankBySimilarity<T extends { text: string }>(
  query: string,
  items: T[],
  options: RankOptions = {},
): Promise<Array<ScoredItem<T>>> {
  if (items.length === 0) return [];

  const language = options.language ?? "en";

  // Compute distance for each item (parallelized for throughput)
  const scored = await Promise.all(
    items.map(async (item) => {
      try {
        const result = await textDistance(query, item.text, language, "sentence");
        return { item, score: result.distance };
      } catch {
        // If embedding fails for an item, push it to the end
        return { item, score: 2.0 };
      }
    }),
  );

  // Sort ascending (lower distance = more similar)
  scored.sort((a, b) => a.score - b.score);

  // Apply filters
  let results = scored;
  if (options.maxDistance !== undefined) {
    results = results.filter((r) => r.score <= options.maxDistance!);
  }
  if (options.maxResults !== undefined) {
    results = results.slice(0, options.maxResults);
  }

  return results;
}

// ─── Batch Sentiment ──────────────────────────────────────────────────────────

export interface BatchSentimentOptions {
  /** Filter output to only items matching this label */
  filterLabel?: SentimentResult["label"];
  /** Concurrency limit to avoid overwhelming darwinkit. Default: 5 */
  concurrency?: number;
}

/**
 * Analyze sentiment for a batch of text items.
 * Returns results in the same order as the input.
 *
 * @example
 * const items = [
 *   { id: "e1", text: "Great work on the release!" },
 *   { id: "e2", text: "This is completely broken." },
 * ];
 * const results = await batchSentiment(items);
 * // → [{ id: "e1", score: 0.9, label: "positive" }, { id: "e2", score: -0.8, label: "negative" }]
 */
export async function batchSentiment<IdType = string>(
  items: TextItem<IdType>[],
  options: BatchSentimentOptions = {},
): Promise<Array<SentimentItem<IdType>>> {
  const concurrency = options.concurrency ?? 5;
  const results: Array<SentimentItem<IdType>> = [];

  // Process in chunks to respect concurrency limit
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map(async (item) => {
        try {
          const sentiment = await analyzeSentiment(item.text);
          return { id: item.id, ...sentiment };
        } catch {
          return { id: item.id, score: 0, label: "neutral" as const };
        }
      }),
    );
    results.push(...chunkResults);
  }

  if (options.filterLabel) {
    return results.filter((r) => r.label === options.filterLabel);
  }

  return results;
}

// ─── Language Grouping ────────────────────────────────────────────────────────

export interface GroupByLanguageOptions {
  /** Minimum confidence to trust the detected language. Default: 0.7 */
  minConfidence?: number;
  /** Concurrency limit. Default: 5 */
  concurrency?: number;
}

/**
 * Detect language for each item and group them by language code.
 * Items where language detection confidence is below minConfidence
 * are grouped under "unknown".
 *
 * @example
 * const items = [
 *   { id: "1", text: "Hello world" },
 *   { id: "2", text: "Bonjour le monde" },
 *   { id: "3", text: "Hola mundo" },
 * ];
 * const groups = await groupByLanguage(items);
 * // → { en: [...], fr: [...], es: [...] }
 */
export async function groupByLanguage<IdType = string>(
  items: TextItem<IdType>[],
  options: GroupByLanguageOptions = {},
): Promise<Record<string, Array<LanguageItem<IdType>>>> {
  const concurrency = options.concurrency ?? 5;
  const minConfidence = options.minConfidence ?? 0.7;
  const groups: Record<string, Array<LanguageItem<IdType>>> = {};

  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map(async (item) => {
        try {
          const lang = await detectLanguage(item.text);
          const language = lang.confidence >= minConfidence ? lang.language : "unknown";
          return { id: item.id, language, confidence: lang.confidence };
        } catch {
          return { id: item.id, language: "unknown", confidence: 0 };
        }
      }),
    );
    for (const result of chunkResults) {
      const key = result.language;
      if (!groups[key]) groups[key] = [];
      groups[key].push(result);
    }
  }

  return groups;
}

// ─── Entity Extraction (Batch) ────────────────────────────────────────────────

export interface TextEntities<IdType = string> {
  id: IdType;
  entities: NamedEntity[];
}

/**
 * Extract named entities from a batch of text items.
 * Returns people, organizations, and places found in each text.
 *
 * @example
 * const items = [{ id: "1", text: "Elon Musk founded SpaceX in California" }];
 * const result = await extractEntitiesBatch(items);
 * // → [{ id: "1", entities: [{ text: "Elon Musk", type: "person" }, ...] }]
 */
export async function extractEntitiesBatch<IdType = string>(
  items: TextItem<IdType>[],
  concurrency = 5,
): Promise<Array<TextEntities<IdType>>> {
  const results: Array<TextEntities<IdType>> = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map(async (item) => {
        try {
          const entities = await extractEntities(item.text);
          return { id: item.id, entities };
        } catch {
          return { id: item.id, entities: [] };
        }
      }),
    );
    results.push(...chunkResults);
  }

  return results;
}
```

**Step 2: Commit**

```bash
git add src/utils/macos/text-analysis.ts
git commit -m "feat(macos-utils): add text analysis utilities (semantic ranking, batch sentiment, language grouping)"
```

---

## Task 6: Barrel Export

**Files:**
- Create: `src/utils/macos/index.ts`

**Step 1: Write the file**

```typescript
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
} from "./text-analysis";
export type { RankOptions, BatchSentimentOptions, GroupByLanguageOptions } from "./text-analysis";

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
  TextEntities,
} from "./types";
```

**Step 2: Commit**

```bash
git add src/utils/macos/index.ts
git commit -m "feat(macos-utils): add barrel export for src/utils/macos"
```

---

## Task 7: Manual Smoke Test

No automated test suite exists in this project yet. Verify the utilities work end-to-end with a quick manual test script.

**Step 1: Ensure darwinkit is installed**

```bash
which darwinkit || brew install darwinkit
darwinkit query '{"jsonrpc":"2.0","id":"1","method":"system.capabilities","params":{}}'
# Should print JSON with version, os, methods
```

**Step 2: Write a one-off smoke test script**

Create `src/utils/macos/_smoke-test.ts` (prefixed with `_` so it won't be treated as a tool):

```typescript
// src/utils/macos/_smoke-test.ts
// Run with: bun run src/utils/macos/_smoke-test.ts

import {
  detectLanguage,
  analyzeSentiment,
  extractEntities,
  textDistance,
  recognizeText,
  rankBySimilarity,
  batchSentiment,
  groupByLanguage,
  getDarwinKit,
  closeDarwinKit,
} from "./index";

async function main() {
  console.log("=== DarwinKit Smoke Test ===\n");

  // 1. Capabilities
  const caps = await getDarwinKit().capabilities();
  console.log("✓ Capabilities:", caps.version, "on", caps.os);
  console.log("  Methods:", caps.methods.join(", "), "\n");

  // 2. Language detection
  const lang = await detectLanguage("Bonjour le monde, comment ça va?");
  console.log("✓ Language detection:", lang);

  // 3. Sentiment
  const sentiment = await analyzeSentiment("This feature is absolutely amazing!");
  console.log("✓ Sentiment:", sentiment);

  // 4. NER
  const entities = await extractEntities("Steve Jobs and Tim Cook built Apple in Cupertino.");
  console.log("✓ Named entities:", entities);

  // 5. Semantic distance
  const dist = await textDistance("budget planning session", "financial review meeting");
  console.log("✓ Semantic distance (budget/financial):", dist.distance.toFixed(3));

  // 6. Semantic ranking
  const emails = [
    { id: "1", text: "Q4 budget review is scheduled for next Tuesday" },
    { id: "2", text: "Happy birthday! Hope you have a great day" },
    { id: "3", text: "Annual financial planning workshop - please attend" },
    { id: "4", text: "Your package has been shipped" },
  ];
  const ranked = await rankBySimilarity("finance budget planning", emails, { maxResults: 2 });
  console.log("✓ Semantic ranking (top 2 for 'finance budget planning'):");
  ranked.forEach((r, i) => console.log(`  ${i + 1}. [score: ${r.score.toFixed(3)}] ${r.item.text}`));

  // 7. Batch sentiment
  const items = emails.map((e) => ({ id: e.id, text: e.text }));
  const sentiments = await batchSentiment(items);
  console.log("\n✓ Batch sentiment:");
  sentiments.forEach((s) => console.log(`  [${s.label}] ${emails.find(e => e.id === s.id)?.text}`));

  // 8. Language grouping
  const multiLang = [
    { id: "a", text: "Hello world" },
    { id: "b", text: "Bonjour le monde" },
    { id: "c", text: "Hola mundo" },
  ];
  const groups = await groupByLanguage(multiLang);
  console.log("\n✓ Language groups:", Object.keys(groups));

  console.log("\n✓ All tests passed!");
  closeDarwinKit();
}

main().catch((err) => {
  console.error("✗ Smoke test failed:", err);
  closeDarwinKit();
  process.exit(1);
});
```

**Step 3: Run it**

```bash
bun run src/utils/macos/_smoke-test.ts
```

Expected output:
```
=== DarwinKit Smoke Test ===

✓ Capabilities: 0.1.0 on macOS 14.x
  Methods: nlp.embed, nlp.distance, nlp.neighbors, nlp.tag, nlp.sentiment, nlp.language, vision.ocr, system.capabilities

✓ Language detection: { language: 'fr', confidence: 0.999 }
✓ Sentiment: { score: 1.0, label: 'positive' }
✓ Named entities: [ { text: 'Steve Jobs', type: 'person' }, ... ]
✓ Semantic distance (budget/financial): 0.312
✓ Semantic ranking (top 2 for 'finance budget planning'):
  1. [score: 0.18] Annual financial planning workshop - please attend
  2. [score: 0.25] Q4 budget review is scheduled for next Tuesday
...
✓ All tests passed!
```

**Step 4: Commit the smoke test**

```bash
git add src/utils/macos/_smoke-test.ts
git commit -m "test(macos-utils): add smoke test script for darwinkit utilities"
```

---

## Task 8: Write the Connect Plan

This task triggers writing the follow-up plan that connects these utilities to the `macos` tool and `automate`.

**Prerequisite:** The `macos` umbrella tool refactor must be complete first.
See: `.claude/plans/2026-02-17-RefactorMacosMailToMacos.md`

**Step 1: Run the write-plan skill**

Invoke the `superpowers:writing-plans` skill with the following arguments:

> **Plan file:** `.claude/plans/2026-02-17-DarwinKitUtils-Connect.md`
>
> **Goal:** Connect `src/utils/macos/` darwinkit utilities to two places in the codebase.
>
> **Context:** `macos-mail` has been refactored to `src/macos/` umbrella tool. The mail search command is now at `src/macos/commands/mail/search.ts`. The lib files are at `src/macos/lib/mail/`.
>
> **Connection A — `macos mail search` semantic re-ranking (default ON):**
> - Semantic search is the **default** behavior — no flag needed to enable it
> - Add `--no-semantic` flag to opt out (falls back to the current SQLite+JXA substring results)
> - After the existing SQLite+JXA result set is fetched and bodies are retrieved, pipe them through `rankBySimilarity()` from `src/utils/macos/text-analysis.ts`
> - Re-rank results by semantic similarity score (ascending, lowest = most relevant)
> - Add `--max-distance <n>` option (default: `1.0`, range 0–2) to filter out low-relevance results
> - Add a `semanticScore` field to `MailMessage` type (optional number)
> - Display semantic score column in the output table (when semantic is active)
> - Gracefully degrade: if darwinkit is not installed or fails, fall back to the original ordering with a warning
> - Relevant files: `src/macos/commands/mail/search.ts`, `src/macos/lib/mail/format.ts`, `src/macos/lib/mail/types.ts`
>
> **Connection B — `automate` `nlp.*` step handler:**
> - Create `src/automate/lib/steps/nlp.ts` step handler
> - Register as prefix `nlp`
> - Supported sub-actions: `nlp.sentiment`, `nlp.language`, `nlp.tag`, `nlp.distance`, `nlp.embed`
> - Each sub-action maps to the corresponding function from `src/utils/macos/nlp.ts`
> - Add `NlpStepParams` interface to `src/automate/lib/types.ts`
> - Register in `src/automate/lib/steps/index.ts`
> - Add an example preset: `src/automate/presets/email-sentiment-check.json`
> - Relevant files: `src/automate/lib/steps/`, `src/automate/lib/types.ts`, `src/automate/lib/steps/index.ts`

---

## Summary

After completing all 8 tasks, the following will exist and be ready to use from anywhere in the codebase:

```typescript
import {
  // NLP
  detectLanguage,     // → { language: "en", confidence: 0.99 }
  analyzeSentiment,   // → { score: 0.9, label: "positive" }
  tagText,            // → { tokens: [{ text, tag, scheme }] }
  extractEntities,    // → [{ text: "Apple", type: "organization" }]
  embedText,          // → { vector: [...512], dimension: 512 }
  textDistance,       // → { distance: 0.31, type: "cosine" }
  areSimilar,         // → boolean
  findNeighbors,      // → { neighbors: [{ text, distance }] }

  // OCR
  recognizeText,      // path → { text, blocks }
  extractText,        // path → string

  // Batch / Higher-level
  rankBySimilarity,   // query + items → sorted by semantic similarity
  batchSentiment,     // items → [{ id, score, label }]
  groupByLanguage,    // items → { en: [...], fr: [...] }
  extractEntitiesBatch, // items → [{ id, entities }]
} from "@app/utils/macos";
```

The Connect plan (written in Task 8) will wire these into `macos-mail` and `automate`.

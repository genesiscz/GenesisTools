# SocratiCode vs GenesisTools Indexer — Deep Comparison

> Explored on 2026-03-20 | Scope: GT `src/indexer/`, `src/utils/search/`, `src/utils/ai/`; SC `src/services/`, `src/tools/`, `src/constants.ts`

## Executive Summary

**GenesisTools (GT)** and **SocratiCode (SC)** take fundamentally different architectural approaches to the same problem: index code/text, generate embeddings, enable search.

| Dimension | GT | SC |
|-----------|----|----|
| **Database** | SQLite (embedded, zero-infra) | Qdrant (dedicated vector DB) + Docker |
| **FTS** | SQLite FTS5 (BM25, local) | Qdrant built-in BM25 (server-side) |
| **Vector search** | Brute-force cosine in SQLite BLOB | HNSW index in Qdrant |
| **Hybrid search** | Client-side RRF fusion | Server-side RRF fusion (Qdrant native) |
| **Embedding providers** | DarwinKit, local-HF, OpenAI | Ollama, OpenAI, Google |
| **Source types** | Files, macOS Mail, Telegram | Code files only |
| **Chunking** | AST + line + heading + message + JSON | AST + line + character |
| **Change detection** | PathHashStore (flat SQLite table) | SHA-256 hashes in Qdrant metadata |
| **File watching** | Polling (`setInterval`) | Native OS events (`@parcel/watcher`) |
| **Code graph** | None | Full import/dependency graph |
| **MCP integration** | CLI-only | Full MCP server |

**Bottom line:** GT is more versatile (multi-source, zero-infra, embedded), SC is more production-ready for code search (better vector indexing, native watching, code graph). Each has clear adoption opportunities from the other.

---

## 1. Embedding Approach

### GenesisTools

**Providers** (3): DarwinKit (macOS NLFramework), local-HF (HuggingFace Transformers.js), cloud (OpenAI)

`src/utils/ai/tasks/Embedder.ts:5-43`

The `Embedder` class is a thin adapter over `AIEmbeddingProvider`. It embeds one text at a time:

```typescript
// Embedder.ts:32-34
async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
    return this.provider.embed(text, options);
}
```

`embedMany` is just `Promise.all` over individual embeds -- no native batching:

```typescript
// Embedder.ts:36-38
async embedMany(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((t) => this.provider.embed(t, options)));
}
```

**DarwinKit** (`src/utils/ai/providers/AIDarwinKitProvider.ts:5-75`): Uses macOS NaturalLanguage.framework via Swift bridge. Fixed 512 dimensions. Free, fast, but NOT code-trained.

**Model registry** (`src/indexer/lib/model-registry.ts:17-114`): 8 models ranging from 22M params (MiniLM) to 7.1B (NV-EmbedCode). Includes code-specific models (CodeRankEmbed, Nomic Embed Code, Voyage Code 3).

**Embedding during sync** is sequential, one chunk at a time, truncated to 500 chars:

```typescript
// indexer.ts:68, 448
const MAX_EMBED_CHARS = 500;
const result = await this.embedder.embed(c.content.slice(0, MAX_EMBED_CHARS));
```

### SocratiCode

**Providers** (3): Ollama (local Docker or native), OpenAI, Google

`src/services/embedding-provider.ts:35-72`

SC uses true batch embedding with configurable batch size (32 texts per request):

```typescript
// embeddings.ts:8, 68-81
const BATCH_SIZE = 32;
for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await withRetry(() => provider.embed(batch), batchLabel);
    results.push(...embeddings);
}
```

**Pre-truncation** is model-aware with known context lengths:

```typescript
// embedding-config.ts:79-91
const MODEL_CONTEXT_LENGTHS: Record<string, number> = {
    "nomic-embed-text": 2048,
    "text-embedding-3-small": 8191,
    "gemini-embedding-001": 2048,
};
```

**Rate limiting** per provider:

```typescript
// embeddings.ts:17-21
const PROVIDER_BATCH_DELAY: Record<string, number> = {
    ollama: 0,
    openai: 0,
    google: 15_000, // 15s for free-tier 5 RPM
};
```

**Task prefixes** for nomic-embed-text:

```typescript
// embeddings.ts:103-105
export function prepareDocumentText(content: string, filePath: string): string {
    return `search_document: ${filePath}\n${content}`;
}
```

Query embedding uses `search_query:` prefix:
```typescript
// embeddings.ts:92
return provider.embedSingle(`search_query: ${query}`);
```

### Verdict: SC wins on embedding quality

| Factor | GT | SC |
|--------|----|----|
| Batching | Sequential (1 at a time) | 32 per batch |
| Retry | Basic warmup retry | Exponential backoff, rate-limit aware |
| Context awareness | Hardcoded 500 char truncation | Model-specific context lengths |
| Task prefixes | None | `search_document:` / `search_query:` |
| Rate limiting | None | Per-provider delays |
| GPU | DarwinKit only | Ollama (native GPU via Metal/CUDA) |

### Improvement Opportunities

**GT should adopt from SC:**
- True batch embedding (especially for OpenAI which supports up to 2048 inputs/request)
- Model-aware context length truncation instead of fixed 500 chars
- Task prefixes for asymmetric search (document vs query)
- Exponential backoff with rate-limit detection
- Ollama as a provider (most popular local embedding runtime)
- Google as a provider (gemini-embedding-001 has 3072 dims, free tier)

**SC should adopt from GT:**
- DarwinKit for zero-infra macOS experience (no Docker needed)
- Richer model registry with code-specific recommendations

---

## 2. Database/Storage

### GenesisTools

**SQLite only** -- everything in one `.db` file per index.

`src/indexer/lib/store.ts:131-211`

Schema:
- `{name}_content` -- content table with `id, content, name, filePath, source_id`
- `{name}_fts` -- FTS5 virtual table synced via triggers
- `{name}_embeddings` -- BLOB storage `(doc_id TEXT, embedding BLOB)`
- `path_hashes` -- change detection `(path TEXT, hash TEXT, is_file INTEGER)`
- `index_meta` -- JSON blob with stats
- `search_log` -- query analytics

WAL mode enabled:
```typescript
// store.ts:141
db.run("PRAGMA journal_mode = WAL");
```

Advisory file-based locking (`index.lock` with PID):
```typescript
// store.ts:182-200
writeFileSync(lockPath, String(process.pid));
```

### SocratiCode

**Qdrant** -- dedicated vector database running in Docker.

`src/services/qdrant.ts:61-105`

Collection schema:
- Dense vectors (cosine distance) for semantic search
- Sparse vectors (BM25, `qdrant/bm25` model) for lexical search
- Payload indexes on `filePath`, `relativePath`, `language`, `contentHash`
- Metadata collection (`socraticode_metadata`) stores project hashes, graph data, artifact states

```typescript
// qdrant.ts:69-86
await qdrant.createCollection(name, {
    vectors: { dense: { size: embeddingDimensions, distance: "Cosine" } },
    sparse_vectors: { bm25: { modifier: "idf" } },
    optimizers_config: { default_segment_number: 2 },
    on_disk_payload: true,
});
```

File hashes are stored as a JSON blob in Qdrant metadata:
```typescript
// qdrant.ts:490-511
await qdrant.upsert(METADATA_COLLECTION, {
    points: [{ id, vector: [0], payload: { fileHashes: JSON.stringify(hashObj), ... } }],
});
```

### Verdict: Architectural tradeoff -- both valid

| Factor | GT (SQLite) | SC (Qdrant) |
|--------|------------|-------------|
| Zero-infra | Yes -- just a file | No -- requires Docker + Qdrant + Ollama |
| Vector search quality | O(n) brute-force scan | HNSW index (O(log n)) |
| Scale limit | ~50K chunks before slow | Millions of vectors |
| BM25 quality | FTS5 native BM25 | Qdrant server-side BM25 (qdrant/bm25) |
| Portability | Single file, copy anywhere | Requires running services |
| Crash recovery | SQLite WAL + advisory lock | Qdrant handles consistency |
| Payload queries | SQL flexibility | Qdrant filter DSL |

### Improvement Opportunities

**GT should consider:**
- Using `sqlite-vec` extension for ANN vector search (keeps zero-infra but scales)
- Or optional Qdrant backend for large codebases (>50K chunks)

**SC should consider:**
- SQLite fallback for lightweight/offline use cases
- Reducing Docker dependency (e.g., Qdrant embedded mode or SQLite)

---

## 3. Chunking Strategy

### GenesisTools

**5 strategies**: `ast`, `line`, `heading`, `message`, `json` + `auto` selector.

`src/indexer/lib/chunker.ts:1-616`

**AST-aware** chunking using `@ast-grep/napi` for TS/JS/HTML/CSS:

```typescript
// chunker.ts:14-26
const EXT_TO_LANG: Record<string, Lang> = {
    ".ts": Lang.TypeScript, ".tsx": Lang.Tsx, ".js": Lang.JavaScript,
    ".jsx": Lang.Tsx, ".html": Lang.Html, ".css": Lang.Css,
};
```

AST node kinds extracted: `function_declaration`, `arrow_function`, `class_declaration`, `method_definition`, `interface_declaration`, `type_alias_declaration`, `export_statement`.

**Key features:**
- Parent-child relationships (methods -> class) via `parentChunkId`
- Deduplication of overlapping AST nodes (export_statement containing function_declaration)
- Token-based size estimation (1 token ~ 4 chars)
- Content hashing via `Bun.hash` (xxHash64)
- Default max tokens: 500 per chunk

**Heading strategy** for markdown splits on `#{1,6}` headers.
**Message strategy** for email/chat splits on `From:/Subject:` headers.
**JSON strategy** splits arrays by element, objects by key.

### SocratiCode

**3 strategies**: AST-aware, line-based, character-based.

`src/services/indexer.ts:238-606`

**AST-aware** chunking with MUCH broader language support:

```typescript
// indexer.ts:238-265
const TOP_LEVEL_KINDS: Record<string, string[]> = {
    JavaScript: [...], TypeScript: [...], Tsx: [...],
    python: [...], java: [...], kotlin: [...], scala: [...],
    c: [...], cpp: [...], csharp: [...], go: [...],
    rust: [...], ruby: [...], php: [...], swift: [...], bash: [...],
};
```

16 languages vs GT's 4 (TS, JS, HTML, CSS).

**Key differences:**
- Fixed chunk size: 100 lines, 10 lines overlap
- Minified file detection: average line length > 500 triggers character-based chunking
- Hard character cap: 2000 chars per chunk (`MAX_CHUNK_CHARS`)
- UUID-format chunk IDs (required by Qdrant): SHA-256 of `relativePath:startLine`
- Merges small AST declarations together (< 5 lines merged with neighbors)
- Sub-chunks large declarations (> 150 lines) with overlap

```typescript
// indexer.ts:68-69
export const CHUNK_SIZE = 100; // lines per chunk
export const CHUNK_OVERLAP = 10; // overlap lines
```

```typescript
// indexer.ts:334-341 -- character cap safety net
function applyCharCap(chunks: FileChunk[]): FileChunk[] {
    return chunks.map((c) =>
        c.content.length > MAX_CHUNK_CHARS
            ? { ...c, content: c.content.substring(0, MAX_CHUNK_CHARS) }
            : c,
    );
}
```

### Verdict: Both strong, different strengths

| Factor | GT | SC |
|--------|----|----|
| Language support | 4 (TS/JS/HTML/CSS) | 16+ languages |
| Content types | Code + markdown + email + JSON + chat | Code only |
| Chunk overlap | None | 10 lines |
| Minified detection | None | avgLineLength > 500 -> char-based |
| Character cap | None (500 char embed truncation) | 2000 chars hard cap |
| Parent-child | Yes (class -> method) | No |
| Deduplication | Yes (containment check) | No (merge-based) |
| Auto-selection | Per-file by extension + index type | Per-file by AST availability |

### Improvement Opportunities

**GT should adopt from SC:**
- Chunk overlap (critical for semantic continuity at boundaries)
- Minified/bundled file detection (character-based fallback)
- Hard character cap per chunk (defense in depth)
- More AST language support via `registerDynamicLanguage` (Python, Go, Rust, Java, etc.)
- Merge small AST nodes to avoid trivially small chunks

**SC should adopt from GT:**
- Heading-based markdown chunking (much better than line-based for docs)
- JSON-aware chunking
- Parent-child chunk relationships
- Multiple source types beyond code files

---

## 4. Change Detection

### GenesisTools

**PathHashStore** -- flat SQLite table mapping `path -> hash`:

`src/indexer/lib/path-hashes.ts:3-79`

```sql
CREATE TABLE path_hashes (path TEXT PRIMARY KEY, hash TEXT NOT NULL, is_file INTEGER DEFAULT 1)
```

Hash function: `Bun.hash(entry.content).toString(16)` (xxHash64 -- fast, non-cryptographic).

Change detection in `FileSource.detectChanges()`:
```typescript
// file-source.ts:117-141
for (const entry of currentEntries) {
    const currentHash = this.hashEntry(entry);
    const previousHash = previousHashes.get(rel);
    if (!previousHash) added.push(entry);
    else if (previousHash !== currentHash) modified.push(entry);
    else unchanged.push(rel);
}
```

Supports incremental sync via `sinceId` for append-only sources (mail ROWIDs).

Migration from legacy Merkle tree blob to flat table:
```typescript
// store.ts:83-129 -- migrateFromMerkleBlob()
```

### SocratiCode

**SHA-256 truncated to 16 hex chars**, stored as a JSON blob in Qdrant metadata:

```typescript
// indexer.ts:216-218
export function hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
```

Hashes loaded from Qdrant on first use, cached in-memory:
```typescript
// indexer.ts:137-158
const projectHashes = new Map<string, Map<string, string>>();
const stored = await loadProjectHashes(collection);
```

Includes migration from absolute to relative path keys:
```typescript
// indexer.ts:164-189 -- migrateAbsolutePathKeys()
```

Checkpointing after each batch:
```typescript
// indexer.ts:878-880
await saveProjectMetadata(collection, resolvedPath, files.length, hashes.size, hashes, "in-progress");
```

### Verdict: GT wins on storage, SC wins on crash recovery

| Factor | GT | SC |
|--------|----|----|
| Hash storage | SQLite table (instant lookup) | JSON blob in Qdrant (serialize/deserialize) |
| Hash function | xxHash64 (fastest) | SHA-256 truncated (crypto-grade, slower) |
| Incremental sync | sinceId for append-only sources | Content hash comparison |
| Crash recovery | Hashes written per batch | Full checkpoint after each batch |
| Deletion detection | Yes (compare current vs stored) | Yes (compare current vs stored) |
| Cancellation | No graceful cancel | Yes (`requestCancellation()`) |

### Improvement Opportunities

**GT should adopt from SC:**
- Graceful cancellation support (`requestCancellation()`)
- Persisted indexing status ("in-progress" / "completed") for crash recovery display
- Cross-process locking (`acquireProjectLock`)

**SC should adopt from GT:**
- SQLite-based hash storage (faster than JSON blob in Qdrant metadata)
- xxHash for speed (SHA-256 is overkill for change detection)

---

## 5. Search Algorithm

### GenesisTools

**3 modes**: fulltext (BM25), vector (cosine), hybrid (RRF).

`src/utils/search/drivers/sqlite-fts5/index.ts:125-392`

**BM25** via SQLite FTS5:
```typescript
// index.ts:223-228
const ftsQuery = query.replace(/['"]/g, "").split(/\s+/)
    .filter(Boolean).map((word) => `"${word}"`).join(" ");
```

Supports field-level boosting:
```typescript
// index.ts:236-240
if (boost) {
    const weights = textFields.map((f) => boost[f] ?? 1.0);
    rankExpr = `bm25(${ftsTable}, ${weights.join(", ")})`;
}
```

**Vector search** -- brute-force scan of ALL embeddings:
```typescript
// sqlite-vector-store.ts:33-64
search(queryVector: Float32Array, limit: number): VectorSearchHit[] {
    const rows = this.db.query(`SELECT doc_id, embedding FROM ${this.embTable}`).all();
    for (const row of rows) {
        const distance = cosineDistance(queryVector, storedVec);
        scored.push({ docId: row.doc_id, score: 1 - distance });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}
```

**Hybrid** -- client-side RRF with configurable weights:
```typescript
// index.ts:324-377
const K = 60;
const textWeight = opts.weights?.text ?? 1.0;
const vectorWeight = opts.weights?.vector ?? 1.0;
// ... rank fusion ...
```

### SocratiCode

**Hybrid-only** via Qdrant's server-side RRF:

```typescript
// qdrant.ts:305-355
const results = await qdrant.query(collectionName, {
    prefetch: [
        { query: queryVector, using: "dense", limit: prefetchLimit, filter: activeFilter },
        { query: { text: query, model: "qdrant/bm25" }, using: "bm25", limit: prefetchLimit },
    ],
    query: { fusion: "rrf" },
    limit,
    with_payload: true,
});
```

Over-fetches 3x candidates per sub-query for better RRF ranking:
```typescript
// qdrant.ts:324
const prefetchLimit = Math.max(limit * 3, 30);
```

Supports filtering by `filePath`, `language`, and arbitrary payload fields.

Minimum score threshold filtering:
```typescript
// constants.ts:62-64
export const SEARCH_MIN_SCORE = Math.max(0, Math.min(1,
    parseFloat(process.env.SEARCH_MIN_SCORE || "0.10") || 0,
));
```

### Verdict: SC wins on search quality and scale

| Factor | GT | SC |
|--------|----|----|
| BM25 quality | SQLite FTS5 (excellent) | Qdrant BM25 (good) |
| Vector search | O(n) brute-force | O(log n) HNSW |
| Hybrid fusion | Client-side RRF | Server-side RRF |
| Over-fetch | Fixed 100 | 3x limit |
| Filters | SQL WHERE | Qdrant payload filters |
| Scale | Slow at >10K embeddings | Millions |
| Score threshold | None | Configurable min score |
| Field boosting | Yes (BM25 weights) | No |

### Improvement Opportunities

**GT should adopt from SC:**
- HNSW or ANN index for vector search (sqlite-vec extension, or optional Qdrant)
- Over-fetch for RRF (fetch 3x candidates, then fuse)
- Minimum score threshold
- Server-side fusion if using Qdrant backend

**SC should adopt from GT:**
- Field-level BM25 boosting (weight `content` higher than `filePath`)
- Separate fulltext-only mode (useful for exact string matching without embedding overhead)
- Configurable hybrid weights (text vs vector balance)

---

## 6. Indexing Pipeline

### GenesisTools

`Indexer.runSync()` -- `src/indexer/lib/indexer.ts:489-766`

**Pipeline flow:**
```
Phase 1: SCAN
  Source.scan() -> SourceEntry[]
  +-- onBatch callback: chunkEntries() -> insertChunks() -> upsert path_hashes
  +-- onProgress callback

Phase 2: DETECT CHANGES + STORE REMAINING
  Source.detectChanges() -> {added, modified, deleted, unchanged}
  +-- chunk remaining (added + modified not in batch)
  +-- insertChunks()
  +-- upsert path_hashes
  +-- removeChunks(deleted)

Phase 3: EMBED
  embedUnembeddedChunks()
  +-- getUnembeddedChunksPage(1000)
  +-- embed each chunk (sequential, 500 char truncation)
  +-- insertChunks([], embeddings) -- batch store
  +-- repeat until no unembedded chunks

FINALIZE
  updateMeta(), emit sync:complete
```

Content and embeddings are **decoupled** -- chunks can exist without embeddings (FTS still works). Embedding is a separate phase that can fail gracefully.

### SocratiCode

`indexProject()` -- `src/services/indexer.ts:631-948`

**Pipeline flow:**
```
Phase 0: SETUP
  acquireProjectLock()
  getProjectHashes() from Qdrant
  ensureCollection()

Phase 1: SCAN + CHUNK
  getIndexableFiles() via glob
  For each file batch (50 files parallel I/O):
    +-- stat + read content
    +-- hashContent() -> skip if unchanged
    +-- chunkFileContent() -> FileChunk[]

Phase 2+3: EMBED + UPSERT (per batch of 50 files)
  generateEmbeddings(batchTexts) -- 32 texts per embed call
  upsertPreEmbeddedChunks() -- 100 points per Qdrant upsert
  saveProjectMetadata() -- checkpoint hashes

Phase 4: CODE GRAPH
  rebuildGraph() -- AST-based import analysis

Phase 5: CONTEXT ARTIFACTS
  ensureArtifactsIndexed() -- non-code documents
```

Embedding happens **inline** with upsert -- no separate phase. All chunks must have embeddings before storage.

### Verdict: GT wins on flexibility, SC wins on throughput

| Factor | GT | SC |
|--------|----|----|
| Content without embeddings | Yes (FTS still works) | No |
| Parallel file I/O | Sequential | 50 files parallel |
| Batch embedding | No (one at a time) | 32 per batch |
| Checkpoint frequency | Every 10 batches | Every file batch |
| Graceful degradation | Embed failure -> FTS only | Embed failure -> abort |
| Code graph | None | Auto-built after index |
| Cross-process lock | PID file advisory | File-based lock with operation type |

### Improvement Opportunities

**GT should adopt from SC:**
- Parallel file I/O (Promise.all batches of 50)
- Batch embedding (32+ texts per provider call)
- Auto code graph building
- Cross-process lock with operation type (index vs watch)
- Graceful cancellation between batches

**SC should adopt from GT:**
- Decoupled content/embedding phases (FTS works without embeddings)
- Event emitter pattern for progress (GT's `IndexerEventEmitter`)
- Streaming page-based embedding (GT's `getUnembeddedChunksPage`)

---

## 7. Source Types

### GenesisTools

**3 source types** via the `IndexerSource` interface:

`src/indexer/lib/sources/source.ts:88-103`

| Source | File | Description |
|--------|------|-------------|
| FileSource | `sources/file-source.ts` | Any file directory, git-ignore aware |
| MailSource | `sources/mail-source.ts` | macOS Mail.app (reads Envelope Index SQLite) |
| TelegramSource | `sources/telegram-source.ts` | Telegram chat history (local SQLite DB) |

FileSource supports git-tracked files via `git ls-files --cached --others --exclude-standard`.

MailSource reads from macOS Mail.app's envelope index, extracts bodies via EmlxBodyExtractor.

TelegramSource reads from a local Telegram history database.

### SocratiCode

**1 source type**: code files only.

`src/services/indexer.ts:608-628`

Uses `glob("**/*")` with an ignore filter, supports 40+ file extensions, and special files (Dockerfile, Makefile, etc.).

Additional non-code data via "context artifacts":
```typescript
// types.ts:54-61
export interface ContextArtifact {
    name: string;
    path: string;
    description: string;
}
```

### Verdict: GT wins decisively

GT's `IndexerSource` interface is clean and extensible. SC is limited to code files.

### Improvement Opportunities

**SC should adopt from GT:**
- Pluggable source interface
- Mail, chat, and document sources

**GT could adopt from SC:**
- Context artifacts pattern (index non-code project docs alongside code)
- Special files support (Dockerfile, Makefile, etc.)

---

## 8. Configuration

### GenesisTools

Rich configuration per index:

```typescript
// types.ts:1-41
interface IndexConfig {
    name: string;
    baseDir: string;
    type?: "code" | "files" | "mail" | "chat";
    source?: IndexerSource;
    respectGitIgnore?: boolean;
    ignoredPaths?: string[];
    includedSuffixes?: string[];
    chunking?: "ast" | "line" | "heading" | "message" | "json" | "auto";
    chunkMaxTokens?: number;
    embedding?: { enabled?: boolean; provider?: string; model?: string };
    storage?: { driver?: "sqlite" | "orama" | "turbopuffer"; ... };
    watch?: { enabled?: boolean; strategy?: "git" | "merkle" | "git+merkle" | "chokidar"; interval?: number };
}
```

Per-index model selection, chunk size, strategy, watch interval. Config persisted via `IndexerManager`.

### SocratiCode

Global configuration via environment variables:

```typescript
// embedding-config.ts:107-168
// EMBEDDING_PROVIDER, OLLAMA_MODE, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, etc.
```

Per-project: `.socraticodeignore` file for exclude patterns, `.socraticodecontextartifacts.json` for non-code docs.

Constants are mostly fixed:
```typescript
// constants.ts:68-102
export const CHUNK_SIZE = 100;
export const CHUNK_OVERLAP = 10;
export const INDEX_BATCH_SIZE = 50;
export const MAX_CHUNK_CHARS = 2000;
```

### Verdict: GT wins on configurability

GT allows per-index configuration of every parameter. SC uses fixed constants and global env vars.

### Improvement Opportunities

**SC should adopt from GT:**
- Per-project configuration (chunk size, embedding model, etc.)
- Named indexes with different configurations

**GT should adopt from SC:**
- `.socraticodeignore` pattern (project-level ignore file)
- Context artifacts configuration

---

## 9. Performance

### GenesisTools

- Embedding: sequential, one chunk at a time
- File I/O: sequential reads
- Vector search: O(n) brute-force scan of all embeddings
- DB pages of 1000 for embedding backfill
- FTS5 BM25 search: very fast (SQLite native)

No explicit benchmarks. Estimated bottleneck: embedding at ~100 chunks/min for DarwinKit.

### SocratiCode

- Embedding: 32 texts per batch
- File I/O: 50 files parallel (`Promise.all`)
- Vector search: HNSW index (O(log n))
- Qdrant upsert: 100 points per batch
- Rate-limit aware with provider-specific delays

No explicit benchmarks either. Estimated bottleneck: Ollama Docker embedding speed, Qdrant upsert latency.

**Concurrency guards:**
```typescript
// indexer.ts:122-130
export function requestCancellation(projectPath: string): boolean { ... }
```

```typescript
// code-graph.ts:113-136
// Deduplication: if already building, return existing promise
const existing = graphBuildPromises.get(resolved);
if (existing) return existing;
```

### Verdict: SC wins on throughput, GT wins on latency (for small indexes)

For <5K files, GT's zero-overhead SQLite is faster. For >10K files, SC's batching and HNSW dominate.

### Improvement Opportunities

**GT should adopt:**
- Parallel file I/O
- Batch embedding (32+ per call)
- ANN index (sqlite-vec) for vector search
- Concurrency deduplication (if already syncing, join existing)

**SC should adopt:**
- SQLite fallback for fast small-project indexing (avoid Docker overhead)

---

## 10. Architecture Patterns

### GenesisTools

**Clean layered architecture:**

```
commands/ (CLI)  ->  Indexer class  ->  IndexStore interface  ->  SQLite
                         |                    |
                    IndexerSource       SearchEngine (FTS5)
                    (FileSource,              |
                     MailSource,        SqliteVectorStore
                     TelegramSource)
```

- `IndexerManager` -- manages multiple named indexes
- `Indexer` -- orchestrates scan/chunk/embed/search
- `IndexStore` -- storage interface (could be swapped)
- `SearchEngine` -- FTS5 + vector hybrid search
- `IndexerSource` -- pluggable data source interface
- `Embedder` -- provider-agnostic embedding task
- `IndexerEventEmitter` -- progress events

**Strengths:** Clean interfaces, pluggable sources, event-driven progress.

### SocratiCode

**MCP-first, function-based architecture:**

```
tools/ (MCP handlers)  ->  services/ (business logic)  ->  Qdrant + Ollama
                               |-- indexer.ts
                               |-- embeddings.ts
                               |-- code-graph.ts
                               |-- watcher.ts
                               |-- ignore.ts
                               +-- qdrant.ts
```

- No class-based Indexer -- functions with module-level state
- Singleton patterns everywhere (`getClient()`, `getEmbeddingProvider()`)
- Progress tracking via module-level Maps
- MCP tool handlers in `tools/` directory
- Cross-process locking via file locks

**Strengths:** MCP integration, code graph, native file watching, robust error handling.

### Verdict: GT wins on architecture, SC wins on features

GT has cleaner abstractions (interfaces, dependency injection, event emitter). SC has more features (code graph, MCP, native watching, context artifacts).

### Improvement Opportunities

**GT should adopt from SC:**
- MCP server integration
- Code dependency graph (import analysis)
- Native file watching (`@parcel/watcher` instead of `setInterval`)
- Context artifacts (non-code project docs)
- Cross-process file locking with operation type
- Indexing status persistence ("in-progress" / "completed")
- Graceful cancellation

**SC should adopt from GT:**
- Class-based architecture with clean interfaces
- Event emitter for progress (instead of module-level Maps)
- Pluggable source interface
- Multi-index management
- Separate content and embedding phases

---

## File Map

### GenesisTools Indexer

| File | Role |
|------|------|
| `src/indexer/index.ts` | CLI entry point (Commander) |
| `src/indexer/lib/indexer.ts` | Core `Indexer` class -- orchestrates scan/chunk/embed/search |
| `src/indexer/lib/store.ts` | `IndexStore` interface + SQLite implementation |
| `src/indexer/lib/chunker.ts` | 5 chunking strategies (AST, line, heading, message, JSON) |
| `src/indexer/lib/path-hashes.ts` | `PathHashStore` -- flat SQLite table for change detection |
| `src/indexer/lib/model-registry.ts` | 8 embedding models with metadata |
| `src/indexer/lib/manager.ts` | `IndexerManager` -- multi-index management |
| `src/indexer/lib/types.ts` | `IndexConfig`, `ChunkRecord`, `IndexMeta`, etc. |
| `src/indexer/lib/events.ts` | `IndexerEventEmitter` -- typed progress events |
| `src/indexer/lib/sources/source.ts` | `IndexerSource` interface + `defaultDetectChanges()` |
| `src/indexer/lib/sources/file-source.ts` | `FileSource` -- directory scanning with git-ignore |
| `src/indexer/lib/sources/mail-source.ts` | `MailSource` -- macOS Mail.app integration |
| `src/indexer/lib/sources/telegram-source.ts` | `TelegramSource` -- Telegram history DB |
| `src/utils/search/drivers/sqlite-fts5/index.ts` | `SearchEngine` -- FTS5 + vector hybrid search |
| `src/utils/search/drivers/sqlite-fts5/schema.ts` | FTS5 table creation + sync triggers |
| `src/utils/search/stores/sqlite-vector-store.ts` | `SqliteVectorStore` -- brute-force cosine in SQLite |
| `src/utils/ai/tasks/Embedder.ts` | `Embedder` -- provider-agnostic embedding wrapper |
| `src/utils/ai/providers/AIDarwinKitProvider.ts` | macOS NaturalLanguage.framework provider |

### SocratiCode

| File | Role |
|------|------|
| `src/index.ts` | MCP server entry point |
| `src/config.ts` | Project ID + collection name derivation |
| `src/constants.ts` | Chunk sizes, file extensions, Qdrant/Ollama config |
| `src/types.ts` | `FileChunk`, `CodeGraph`, `SearchResult`, etc. |
| `src/services/indexer.ts` | Full index + incremental update + chunking (all-in-one, ~1100 lines) |
| `src/services/embeddings.ts` | Batch embedding with retry + rate limiting |
| `src/services/embedding-provider.ts` | Provider factory (Ollama/OpenAI/Google) |
| `src/services/embedding-config.ts` | Environment-based embedding configuration |
| `src/services/embedding-types.ts` | `EmbeddingProvider` interface |
| `src/services/provider-ollama.ts` | Ollama provider (Docker + external + auto-detect) |
| `src/services/provider-openai.ts` | OpenAI provider with batch support |
| `src/services/provider-google.ts` | Google Gemini provider with batch support |
| `src/services/qdrant.ts` | Qdrant client -- collections, upsert, hybrid search, metadata |
| `src/services/code-graph.ts` | Code dependency graph (AST-based, 16+ languages) |
| `src/services/watcher.ts` | Native file watching via `@parcel/watcher` |
| `src/services/ignore.ts` | `.gitignore` + `.socraticodeignore` processing |
| `src/services/lock.ts` | Cross-process file locking |
| `src/tools/query-tools.ts` | MCP tool handlers (search, status) |
| `src/tools/index-tools.ts` | MCP tool handlers (index, update, remove) |
| `src/tools/graph-tools.ts` | MCP tool handlers (graph build, query, visualize) |

---

## Priority Adoption Recommendations for GT

Ranked by impact / effort ratio:

### High Impact, Low Effort
1. **Batch embedding** -- Change `embedMany` to use provider's native batch API. OpenAI supports 2048 inputs/request. Would speed up indexing by ~30x.
2. **Chunk overlap** -- Add 10-line overlap in `chunkByLine()`. Trivial change, big quality improvement at chunk boundaries.
3. **Model-aware truncation** -- Replace `MAX_EMBED_CHARS = 500` with per-model context lengths. Currently discards most of each chunk.
4. **Parallel file I/O** -- Batch file reads with `Promise.all` in `FileSource.scan()`. Easy change, ~5x faster scanning.

### High Impact, Medium Effort
5. **Task prefixes** -- Add `search_document:` / `search_query:` for nomic-embed-text models. Requires storing prefix config per model.
6. **Ollama provider** -- Add as GT AI provider. Most popular local embedding runtime, GPU-accelerated.
7. **Google provider** -- Add Gemini Embedding API (3072 dims, free tier).
8. **More AST languages** -- Use `registerDynamicLanguage()` for Python, Go, Rust, Java, etc. SC already has the kinds lists.
9. **Minified file detection** -- Add character-based fallback when avg line length > 500.
10. **Hard character cap** -- Add `MAX_CHUNK_CHARS = 2000` safety net.

### High Impact, High Effort
11. **ANN vector index** -- Replace brute-force with `sqlite-vec` extension. Unlocks >50K chunk indexes.
12. **Native file watching** -- Replace `setInterval` with `@parcel/watcher`. Real-time, low overhead.
13. **Code dependency graph** -- Import analysis using AST. SC's implementation is solid reference.
14. **MCP server** -- Expose indexer as MCP tools for Claude/AI assistants.
15. **Graceful cancellation** -- Cancel between batches with progress checkpoint.

### Nice to Have
16. Context artifacts (non-code project docs)
17. `.socraticodeignore` pattern
18. Cross-process locking with operation types
19. Rate-limit-aware retry with exponential backoff
20. Indexing status persistence ("in-progress" / "completed")

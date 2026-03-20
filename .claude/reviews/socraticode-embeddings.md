# SocratiCode Embedding System -- Deep Dive

> Explored on 2026-03-20 | Scope: `.worktrees/socraticode/src/services/`, `src/constants.ts`, `src/types.ts`, `src/config.ts`, `tests/`

## Summary

SocratiCode uses a **provider-abstracted embedding pipeline** with three backends: Ollama (local, default), OpenAI, and Google Generative AI. Text is chunked using an AST-aware strategy (with line-based and character-based fallbacks), embedded in batches of 32, and stored alongside BM25 sparse vectors in **Qdrant** for hybrid semantic+lexical search via RRF fusion. There is no client-side vector similarity computation -- all search runs server-side in Qdrant using cosine distance. Vectors are stored as plain `number[]` arrays (no `Float32Array`, no binary encoding). No explicit L2 normalization is performed client-side; Qdrant's cosine distance metric handles that internally.

---

## Key Findings

### 1. Provider Abstraction (Factory Pattern)

Three embedding providers implement a common `EmbeddingProvider` interface. A factory singleton selects the active provider based on the `EMBEDDING_PROVIDER` env var.

**Interface** (`src/services/embedding-types.ts:13-37`):
```typescript
export interface EmbeddingProvider {
  readonly name: string;
  ensureReady(): Promise<EmbeddingReadinessResult>;
  embed(texts: string[]): Promise<number[][]>;
  embedSingle(text: string): Promise<number[]>;
  healthCheck(): Promise<EmbeddingHealthStatus>;
}
```

**Factory** (`src/services/embedding-provider.ts:35-72`):
- Singleton pattern with lazy dynamic imports per provider
- Recreates if config changes (supports test resets)
- `getEmbeddingProvider()` is the single entry point

### 2. Embedding Models and Dimensions

Default models and dimensions per provider (`src/services/embedding-config.ts:58-62`):

| Provider | Default Model | Dimensions | Context Length (tokens) |
|----------|--------------|------------|----------------------|
| `ollama` | `nomic-embed-text` | 768 | 2048 |
| `openai` | `text-embedding-3-small` | 1536 | 8191 |
| `google` | `gemini-embedding-001` | 3072 | 2048 |

**Known model context lengths** (`embedding-config.ts:79-91`):
```
nomic-embed-text:         2048
mxbai-embed-large:         512
snowflake-arctic-embed:    512
all-minilm:                256
text-embedding-3-small:   8191
text-embedding-3-large:   8191
text-embedding-ada-002:   8191
gemini-embedding-001:     2048
```

All overridable via env vars: `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_CONTEXT_LENGTH`.

### 3. Ollama Mode Selection (Auto/Docker/External)

Configured via `OLLAMA_MODE` env var (`embedding-config.ts:40, 66-71`):

| Mode | URL Default | Behavior |
|------|-------------|----------|
| `auto` (default) | `localhost:11434` | Probes native Ollama with 2s timeout; falls back to Docker container on `:11435` |
| `docker` | `localhost:11435` | Always uses managed Docker container |
| `external` | `localhost:11434` | User-managed Ollama instance, no container management |

Auto-detection logic in `provider-ollama.ts:113-136`: fetches `http://localhost:11434/api/tags` with AbortController timeout. Result is cached after first probe and updates the config singleton via `setResolvedOllamaMode()`.

### 4. Task Prefixes (nomic-embed-text convention)

SocratiCode follows the nomic-embed-text convention of prefixing texts with task descriptors for asymmetric retrieval:

- **Documents**: `search_document: {filePath}\n{content}` (`embeddings.ts:103-105`)
- **Queries**: `search_query: {query}` (`embeddings.ts:94`)

These prefixes are applied regardless of which provider is active. For OpenAI/Google models that were not trained with these prefixes, they become slight noise tokens -- harmless but architecturally imprecise.

### 5. Batch Embedding Pipeline

**Two-level batching** (`src/services/embeddings.ts`):

1. **Application-level batching** (line 8): Texts split into groups of **32** (`BATCH_SIZE = 32`)
2. **Provider-internal batching**: Each provider has its own sub-batch size:
   - Ollama: sends all 32 in one `client.embed()` call (`provider-ollama.ts:235`)
   - OpenAI: up to **512** per API call (`provider-openai.ts:28`)
   - Google: up to **100** per `batchEmbedContents` call (`provider-google.ts:27`)

**Rate limiting** (`embeddings.ts:17-21`):
```typescript
const PROVIDER_BATCH_DELAY: Record<string, number> = {
  ollama: 0,
  openai: 0,
  google: 15_000,  // 15s between batches (Google free tier: 5 RPM)
};
```

**Retry logic** (`embeddings.ts:24-51`):
- Up to 3 retries with exponential backoff (base 500ms)
- Rate-limit errors (429, RESOURCE_EXHAUSTED, quota) get at least 15s delay
- Applied per batch via `withRetry()` wrapper

**No concurrency**: Batches are processed sequentially in a `for` loop. There is no parallel embedding of multiple batches.

### 6. Pre-truncation (3-Layer Context Window Protection)

Three defensive layers prevent context-window overflows:

**Layer 1 -- Chunking cap** (`constants.ts:102`):
- `MAX_CHUNK_CHARS = 2000` applied to every chunk via `applyCharCap()` in `indexer.ts:334-341`

**Layer 2 -- Provider pre-truncation** (per provider):

| Provider | `CHARS_PER_TOKEN_ESTIMATE` | Max chars for default model |
|----------|---------------------------|-----------------------------|
| Ollama   | **1.0** (ultra-conservative for dense code) | 2048 chars |
| OpenAI   | **3.0** | 24,573 chars |
| Google   | **3.0** | 6,144 chars |

Ollama uses 1.0 because dense minified code can have nearly 1 char per token. This works around an Ollama bug (issue #12710) where server-side truncation hangs for batched requests.

For unknown Ollama models, a fallback context length of 2048 tokens is used (`provider-ollama.ts:233`).

**Layer 3 -- Server-side truncation** (Ollama only):
The `truncate: true` flag in `client.embed()` (`provider-ollama.ts:235`) -- last-resort defense.

### 7. Vector Storage: Qdrant with Hybrid Search

**Collection creation** (`src/services/qdrant.ts:62-104`):
```typescript
await qdrant.createCollection(name, {
  vectors: {
    dense: {
      size: embeddingDimensions,  // 768/1536/3072 depending on provider
      distance: "Cosine",
    },
  },
  sparse_vectors: {
    bm25: {
      modifier: "idf",
    },
  },
  optimizers_config: { default_segment_number: 2 },
  on_disk_payload: true,
});
```

Each collection stores:
- **Dense vectors** (named `dense`): the embedding from the provider
- **Sparse vectors** (named `bm25`): server-side BM25 tokenization by Qdrant (requires v1.15.2+)
- **Payload indexes** on: `filePath`, `relativePath`, `language`, `contentHash`

**Upsert format** (`qdrant.ts:183-212`):
```typescript
const points = chunks.map((chunk, i) => ({
  id: chunk.id,            // SHA-256-derived UUID from "relativePath:startLine"
  vector: {
    dense: embeddings[i],  // number[]
    bm25: {
      text: texts[i],      // raw text for server-side BM25
      model: "qdrant/bm25",
    },
  },
  payload: { filePath, relativePath, content, startLine, endLine, language, type, contentHash },
}));
```

Upserted in sub-batches of 100 points per Qdrant call (`qdrant.ts:205`).

**Per-point fallback** (`qdrant.ts:260-286`): On batch upsert failure (after 3 retries), falls back to per-point upsert to isolate bad points. Skipped points are counted and logged. If ALL points in a batch are skipped, the operation throws (collection may have been deleted externally).

BM25 text is truncated to 32,000 chars (`MAX_BM25_TEXT_CHARS`, line 217) before upsert.

### 8. Hybrid Search (RRF Fusion)

**Search** (`qdrant.ts:305-355`):
```typescript
const results = await qdrant.query(collectionName, {
  prefetch: [
    { query: queryVector, using: "dense", limit: prefetchLimit, filter: activeFilter },
    {
      query: { text: query, model: "qdrant/bm25" },
      using: "bm25",
      limit: prefetchLimit,
      filter: activeFilter,
    },
  ],
  query: { fusion: "rrf" },
  limit,
  with_payload: true,
  filter: activeFilter,
});
```

- **Two-stage retrieval**: dense semantic + BM25 lexical, fused via Reciprocal Rank Fusion (RRF)
- `prefetchLimit = max(limit * 3, 30)` -- fetches 3x candidates per sub-query for re-ranking
- Query embedding generated client-side; BM25 runs server-side
- Supports filtering by `relativePath` and `language`
- Minimum score threshold (default 0.10) via `SEARCH_MIN_SCORE` constant (`constants.ts:62`)

Also supports arbitrary payload filters via `searchChunksWithFilter()` (`qdrant.ts:359-402`) for context artifact searches filtered by `artifactName`.

### 9. Chunking Strategy

Three-tier chunking hierarchy in `src/services/indexer.ts`:

#### Tier 1: AST-Aware Chunking (preferred)
For languages with AST support via `@ast-grep/napi` (16 language grammars):

- **`findAstBoundaries()`** (indexer.ts:281-326): Finds top-level declarations (functions, classes, interfaces, etc.) per language
- **`chunkByAstRegions()`** (indexer.ts:461-574): Groups declarations into chunks, merging small ones (<5 lines), sub-chunking large ones (>150 lines)
- Includes preamble (imports before first declaration) and epilogue (code after last declaration)
- Sub-chunking uses `CHUNK_SIZE - CHUNK_OVERLAP` step (100 - 10 = 90 lines)

Supported AST languages: JavaScript, TypeScript, Tsx, Python, Java, Kotlin, Scala, C, C++, C#, Go, Rust, Ruby, PHP, Swift, Bash.

#### Tier 2: Character-Based Chunking (minified files)
Triggered when `avgLineLength > 500` chars (`MAX_AVG_LINE_LENGTH`):

- **`chunkByCharacters()`** (indexer.ts:353-401): Splits at `MAX_CHUNK_CHARS` (2000) boundaries
- Scans backward from limit to find safe split points: `\n`, space, tab, `;`, `,`
- Uses byte offset as chunk ID discriminator (not line number)

#### Tier 3: Line-Based Chunking (fallback)
For unsupported languages or AST parse failures:

- **`chunkByLines()`** (indexer.ts:579-606): Fixed 100-line chunks with 10-line overlap

#### Universal Safety Net
- **`applyCharCap()`** (indexer.ts:334-341): Truncates any chunk exceeding `MAX_CHUNK_CHARS = 2000` chars
- Applied to every chunk from every strategy

**Chunking constants** (`constants.ts:68-102`):

| Constant | Value | Purpose |
|----------|-------|---------|
| `CHUNK_SIZE` | 100 lines | Target chunk size |
| `CHUNK_OVERLAP` | 10 lines | Overlap between adjacent chunks |
| `MAX_CHUNK_CHARS` | 2000 chars | Hard character cap per chunk |
| `MAX_AVG_LINE_LENGTH` | 500 chars | Threshold for minified detection |
| `MAX_FILE_BYTES` | 5 MB | Skip files larger than this |
| `INDEX_BATCH_SIZE` | 50 files | Files per embed+upsert batch |

### 10. Embedding Normalization

**SocratiCode does NOT perform L2 normalization of vectors client-side.** Vectors flow directly from the provider API response to Qdrant as `number[]`.

Qdrant's `"Cosine"` distance metric internally normalizes vectors during indexing/search, so explicit normalization is unnecessary. The default models (nomic-embed-text, OpenAI text-embedding-3-*) return unit vectors anyway.

The integration test (`tests/integration/embeddings.test.ts:69-76`) computes cosine similarity manually to verify consistency:
```typescript
let dot = 0, norm1 = 0, norm2 = 0;
for (let i = 0; i < emb1.length; i++) {
  dot += emb1[i] * emb2[i];
  norm1 += emb1[i] * emb1[i];
  norm2 += emb2[i] * emb2[i];
}
const similarity = dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
expect(similarity).toBeGreaterThan(0.99);
```

### 11. Vector Format

Vectors are plain JavaScript `number[]` arrays (64-bit IEEE 754 doubles in JS runtime). The `@qdrant/js-client-rest` SDK serializes to JSON over HTTP REST. Qdrant stores them as Float32 server-side. No explicit Float32 conversion, quantization, or binary encoding is configured client-side.

No Qdrant quantization config is set (no scalar_quantization, product_quantization, or binary_quantization). Vectors are stored at full precision.

### 12. Indexing Pipeline (End-to-End)

```
getIndexableFiles()
    |  glob + ignore filter + extension check
    v
[Parallel file scan in batches of 50]
    |  fsp.stat -> fsp.readFile -> hashContent -> chunkFileContent
    v
[Skip unchanged files via SHA-256 content hashes]
    |  hashes stored in Qdrant metadata collection
    v
[Process in file batches of 50 (INDEX_BATCH_SIZE)]
    |  For each batch:
    |    1. prepareDocumentText() adds "search_document:" prefix
    |    2. generateEmbeddings() -> provider.embed() in sub-batches of 32
    |    3. upsertPreEmbeddedChunks() -> Qdrant in sub-batches of 100
    |    4. Checkpoint: saveProjectMetadata(status="in-progress") after each batch
    v
[Final: save "completed" status, build code graph, index context artifacts]
```

**Cancellation**: Checked between file batches via `isCancellationRequested()`. Progress is preserved (checkpointed after each batch). Re-running `codebase_index` resumes from the last checkpoint.

**Cross-process locking**: `acquireProjectLock()` prevents concurrent indexing of the same project.

**Auto-resume on startup** (`startup.ts:37-150`):
- On MCP server start, checks `process.cwd()` for an existing index
- If status is `"in-progress"`: resumes via `indexProject()` (skips already-hashed files)
- If status is `"completed"`: starts file watcher + runs `updateProjectIndex()` for incremental catch-up

### 13. Error Handling Summary

| Layer | Retry Count | Backoff | Special Handling |
|-------|-------------|---------|-----------------|
| Embedding batches | 3 | Exponential (500ms base) | Rate-limit errors get 15s+ delay |
| Qdrant upserts | 3 | Exponential (500ms base) | Per-point fallback on batch failure |
| Qdrant searches | 3 | Exponential (500ms base) | -- |
| Ollama model pull | 1 | -- | 15-minute timeout |
| Ollama readiness | Cached for 60s | -- | TTL-based readiness cache |

**No provider fallbacks**: If the configured provider fails after retries, the error propagates up. There is no automatic fallback from e.g. OpenAI to Ollama.

### 14. Metadata Storage

Project metadata (file hashes, indexing status) is stored as a point in a special `socraticode_metadata` Qdrant collection:
- Dummy 1-dim vector (Qdrant requires vectors)
- Point ID: SHA-256 UUID derived from collection name
- Payload: `collectionName`, `projectPath`, `lastIndexedAt`, `filesTotal`, `filesIndexed`, `fileHashes` (JSON-stringified), `indexingStatus`
- Also stores code graph data and context artifact metadata as separate points

---

## Architecture / Flow

```
                    +---------------------+
                    |   Environment Vars   |
                    |  EMBEDDING_PROVIDER  |
                    |  EMBEDDING_MODEL     |
                    |  EMBEDDING_DIMENSIONS|
                    |  OLLAMA_MODE         |
                    +---------+-----------+
                              |
                              v
                    +------------------+
                    | embedding-config |  singleton, cached from env
                    |   loadConfig()   |
                    +---------+--------+
                              |
                              v
                   +--------------------+
                   | embedding-provider |  factory singleton
                   | getEmbedding...()  |  dynamic import()
                   +--+------+-------+--+
                      |      |       |
              +-------+      |       +--------+
              v              v                 v
    +--------------+ +------------+  +--------------+
    | provider-    | | provider-  |  | provider-    |
    | ollama.ts    | | openai.ts  |  | google.ts    |
    | nomic 768d   | | 3-sm 1536d |  | gemini 3072d |
    | pretrunc 1.0 | | pretrunc 3 |  | pretrunc 3.0 |
    | Docker/auto  | | API key    |  | batchEmbed   |
    +------+-------+ +-----+------+  +------+-------+
           |               |                |
           +-------+-------+----------------+
                   |  embed(texts) -> number[][]
                   v
          +-----------------+
          |  embeddings.ts  |  batch=32, retry=3x
          |  rate limit     |  "search_document:" / "search_query:"
          +--------+--------+
                   |
                   v
          +-----------------+
          |   qdrant.ts     |  upsert batch=100
          |   dense+bm25    |  cosine distance
          |   RRF fusion    |  payload on-disk
          |   Qdrant v1.17  |
          +-----------------+
```

---

## File Map

| File | Role |
|------|------|
| `src/services/embedding-types.ts` | `EmbeddingProvider` interface, health/readiness types |
| `src/services/embedding-config.ts` | Config singleton: provider, model, dimensions, context length from env vars |
| `src/services/embedding-provider.ts` | Factory singleton: creates the active provider based on config |
| `src/services/embeddings.ts` | Batch orchestration: 32/batch, retry, rate limiting, task prefixes |
| `src/services/provider-ollama.ts` | Ollama provider: Docker/external auto-detect, model pull, pre-truncation (1.0 chars/token) |
| `src/services/provider-openai.ts` | OpenAI provider: 512 sub-batch, pre-truncation (3.0 chars/token) |
| `src/services/provider-google.ts` | Google provider: 100 sub-batch, pre-truncation (3.0 chars/token), 15s rate limit |
| `src/services/qdrant.ts` | Qdrant client: collection CRUD, hybrid search (dense+BM25+RRF), metadata persistence |
| `src/services/indexer.ts` | Full indexing pipeline: file scanning, 3-tier chunking (AST/char/line), batch embed+upsert |
| `src/services/context-artifacts.ts` | Context artifact chunking and embedding (line-based only) |
| `src/services/startup.ts` | Auto-resume on MCP start: detects incomplete indexes, starts watchers |
| `src/services/watcher.ts` | File watcher: debounced incremental updates via `updateProjectIndex()` |
| `src/services/ollama.ts` | Re-exports from provider-ollama for backward compatibility |
| `src/constants.ts` | Chunk sizes, file limits, Qdrant/Ollama ports, search defaults |
| `src/config.ts` | Project ID generation, collection naming |
| `src/types.ts` | `FileChunk`, `SearchResult`, `CodeGraph` types |
| `docker-compose.yml` | Qdrant v1.17.0 + Ollama Docker services |
| `tests/unit/embeddings.test.ts` | Unit tests: batching, retry, progress callbacks |
| `tests/unit/embedding-config.test.ts` | Unit tests: config loading, defaults, overrides |
| `tests/unit/embedding-provider.test.ts` | Unit tests: factory, provider selection, API key validation |
| `tests/integration/embeddings.test.ts` | Integration tests: real Ollama, cosine similarity checks |

---

## Open Questions

1. **Task prefixes for non-Ollama providers**: The `search_document:` and `search_query:` prefixes are a nomic-embed-text convention. They are applied to all providers (OpenAI, Google) even though those models were not trained with these prefixes. This likely has minimal negative impact but is architecturally imprecise.

2. **No parallel embedding batches**: The 32-text batches are processed sequentially. For large codebases with thousands of files, parallel batches (especially for OpenAI with generous rate limits) could significantly speed up indexing.

3. **No vector caching layer**: Embeddings are regenerated every time a file changes. There is no local cache (e.g., SQLite) of previously computed embeddings -- change detection relies solely on content hashes in Qdrant metadata. If Qdrant is reset, all embeddings must be recomputed.

4. **MAX_CHUNK_CHARS = 2000 is tight for Ollama 2048 context**: After adding the `search_document: {path}\n` prefix (~50 chars) and accounting for 1.0 chars/token, a 2000-char chunk maps to ~2050 tokens. The pre-truncation at the provider level is the safety net, but it means the last ~50 chars of some chunks may be silently dropped.

5. **Google free tier rate limiting**: The 15-second inter-batch delay is hardcoded. For paid Google API tiers with higher RPM limits, this would unnecessarily slow indexing. Could be made configurable.

6. **No quantization config**: Qdrant supports scalar/product quantization for large indexes but none is configured. For very large codebases, this could reduce memory usage significantly while maintaining acceptable recall.

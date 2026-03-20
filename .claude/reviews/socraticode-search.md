# SocratiCode Search & Retrieval System — Deep Dive

> Explored on 2026-03-20 | Scope: `.worktrees/socraticode/src/` (all services, tools, types, constants)

## Summary

SocratiCode implements a **hybrid search system** combining dense semantic vectors (cosine similarity) with sparse BM25 lexical matching, fused via **Reciprocal Rank Fusion (RRF)** — all executed server-side in Qdrant v1.17.0. Queries are embedded client-side by one of three pluggable providers (Ollama/OpenAI/Google), while BM25 inference runs entirely within Qdrant. There is **no client-side reranking step**, no search result cache, and no query rewriting/expansion. The system is straightforward and well-engineered: embed query, send two prefetch sub-queries, let Qdrant fuse and rank, filter by min score, return formatted chunks.

## Key Findings

### 1. Hybrid Search Architecture (Dense + BM25 + RRF)

The core search function is `searchChunks()` in `src/services/qdrant.ts:305-355`. It uses Qdrant's native Query API with **two prefetch sub-queries** that are fused server-side:

```typescript
// qdrant.ts:327-343
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

- **Dense sub-query**: Uses the client-generated embedding vector, cosine distance, via the `dense` named vector.
- **BM25 sub-query**: Sends raw query text to Qdrant's built-in BM25 inference engine (`model: "qdrant/bm25"`), using the `bm25` named sparse vector.
- **Fusion**: Qdrant fuses both result sets using Reciprocal Rank Fusion (`{ fusion: "rrf" }`).
- **Prefetch over-retrieval**: Each sub-query fetches `max(limit * 3, 30)` candidates to give RRF enough material to re-rank (`qdrant.ts:324`).

### 2. Query Processing Pipeline

Query processing is minimal — no rewriting, expansion, or multi-step reasoning:

1. **Query embedding** (`embeddings.ts:91-97`): The raw query string is prefixed with `search_query: ` and embedded via the configured provider:
   ```typescript
   export async function generateQueryEmbedding(query: string): Promise<number[]> {
     const provider = await getEmbeddingProvider();
     return provider.embedSingle(`search_query: ${query}`);
   }
   ```
   The `search_query:` prefix is a nomic-embed-text convention for asymmetric retrieval (documents use `search_document:`).

2. **BM25 text**: The raw query string (without any prefix) is sent directly to Qdrant for server-side BM25 tokenization.

3. **No query rewriting**: The user's natural language query goes straight to embedding + BM25 without any LLM-based reformulation or term expansion.

### 3. Collection & Vector Configuration

Collections are created in `qdrant.ts:62-104` with dual vector spaces:

```typescript
await qdrant.createCollection(name, {
  vectors: {
    dense: {
      size: embeddingDimensions,  // 768 (Ollama) / 1536 (OpenAI) / 3072 (Google)
      distance: "Cosine",
    },
  },
  sparse_vectors: {
    bm25: {
      modifier: "idf",  // IDF-weighted BM25
    },
  },
  optimizers_config: { default_segment_number: 2 },
  on_disk_payload: true,
});
```

Payload indexes are created on: `filePath`, `relativePath`, `language`, `contentHash` — all as `keyword` type for fast exact-match filtering.

### 4. Document Indexing & Embedding

Documents are embedded with a path-prefixed format (`embeddings.ts:103-105`):

```typescript
export function prepareDocumentText(content: string, filePath: string): string {
  return `search_document: ${filePath}\n${content}`;
}
```

Each point is upserted with **both** a dense vector and a BM25 text field (`qdrant.ts:183-202`):

```typescript
vector: {
  dense: embeddings[i],
  bm25: {
    text: texts[i],
    model: "qdrant/bm25",  // Server-side BM25 tokenization
  },
},
```

The BM25 text has a hard limit of 32,000 characters (`MAX_BM25_TEXT_CHARS` at `qdrant.ts:217`), truncated before upsert while the stored `content` payload remains full-length.

### 5. Chunking Strategy (Three-Tier)

Defined in `indexer.ts`, chunking uses three strategies in priority order:

| Strategy | Trigger | Method |
|----------|---------|--------|
| Character-based | Avg line length > 500 chars (minified/bundled) | Split at safe boundaries (newline, space, semicolon, comma), max 2000 chars per chunk |
| AST-aware | Supported language with ast-grep grammar | Top-level declarations (functions, classes, interfaces, etc.) as chunk boundaries; small declarations merged, large ones sub-chunked with overlap |
| Line-based fallback | Everything else | 100-line segments with 10-line overlap |

Key constants (`constants.ts`):
- `CHUNK_SIZE = 100` lines per chunk
- `CHUNK_OVERLAP = 10` lines overlap
- `MAX_CHUNK_CHARS = 2000` hard character cap on every chunk
- `MAX_AVG_LINE_LENGTH = 500` triggers character-based chunking
- `MAX_FILE_BYTES = 5MB` default file size limit

All chunks pass through `applyCharCap()` as a universal safety net.

### 6. Result Format & Score Threshold

Search results are mapped from Qdrant points to `SearchResult` (`types.ts:34-42`):

```typescript
interface SearchResult {
  filePath: string;      // Absolute path
  relativePath: string;  // Relative to project root
  content: string;       // The chunk content
  startLine: number;     // 1-based start line
  endLine: number;       // End line
  language: string;      // Detected from extension (e.g., "typescript")
  score: number;         // RRF score from hybrid search
}
```

**Score filtering** (`query-tools.ts:78-82`):
- Default minimum score: `SEARCH_MIN_SCORE = 0.10` (configurable via env var `SEARCH_MIN_SCORE`, range 0-1)
- Results below the threshold are filtered out after retrieval
- The `minScore` parameter on the MCP tool allows per-query override
- Setting `minScore: 0` disables filtering entirely

**Output format** (`query-tools.ts:112-116`):
```
--- src/services/qdrant.ts (lines 305-355) [typescript] score: 0.8432 ---
<chunk content>
```

### 7. Filtering Capabilities

Two filter dimensions are available on `codebase_search` (`index.ts:131-139`):

| Filter | Field | Type | Example |
|--------|-------|------|---------|
| `fileFilter` | `relativePath` | Exact match (keyword) | `"src/services/qdrant.ts"` |
| `languageFilter` | `language` | Exact match (keyword) | `"typescript"`, `"python"` |

Filters are applied as Qdrant `must` conditions on **both** the dense and BM25 prefetch sub-queries, ensuring consistent filtering across the hybrid search.

For context artifact search, an additional `artifactName` filter is available via `searchChunksWithFilter()` (`qdrant.ts:359-401`), which accepts arbitrary `{ key, value }` pairs.

**Not supported**: path glob/prefix matching, date-based filtering, file size filtering, or content-type filtering beyond language. Filters are exact string matches only.

### 8. Pagination

There is **no cursor-based pagination**. The `limit` parameter (default 10, max 50, configurable via `SEARCH_DEFAULT_LIMIT` env var) controls how many results are returned. If more results are needed, the caller must increase `limit`.

The prefetch over-retrieval factor of 3x (`prefetchLimit = max(limit * 3, 30)`) means Qdrant internally evaluates more candidates than returned, but there's no mechanism to page through results beyond the initial fetch.

### 9. Context Window / Token Budgeting

SocratiCode does **not** build context windows or manage token budgets for LLM consumption. It returns raw search results as formatted text. Token management is delegated to the MCP client (e.g., Claude, Cline).

The system does manage embedding context windows to prevent exceeding model limits:

| Provider | Context Length | Chars-per-token | Max chars |
|----------|---------------|-----------------|-----------|
| Ollama (nomic-embed-text) | 2048 tokens | 1.0 (conservative) | ~2048 chars |
| OpenAI (text-embedding-3-small) | 8191 tokens | 3.0 | ~24,573 chars |
| Google (gemini-embedding-001) | 2048 tokens | 3.0 | ~6,144 chars |

Pre-truncation is applied in each provider before sending to the embedding API. Combined with the 2000-char chunk cap, this creates defense-in-depth against context overflow.

### 10. Reranking

There is **no reranking step**. The RRF fusion within Qdrant's Query API is the only ranking mechanism. Results come back from Qdrant already ranked by RRF score, and the only post-processing is the `minScore` threshold filter.

### 11. Caching

There is **no search result cache**. Every `codebase_search` call generates a fresh embedding and hits Qdrant. However, several infrastructure elements are cached:

| Cache | TTL | Purpose |
|-------|-----|---------|
| Ollama readiness | 60s | Skip re-probing Ollama on every search (`provider-ollama.ts:94`) |
| Qdrant readiness | 60s | Skip Docker container health check (`docker.ts:140`) |
| Code graph (in-memory) | Until invalidated | Avoid re-loading graph from Qdrant on every query (`code-graph.ts:77`) |
| Metadata collection flag | Process lifetime | Skip checking if `socraticode_metadata` collection exists (`qdrant.ts:436`) |
| Embedding provider singleton | Process lifetime | Only instantiate provider once (`embedding-provider.ts:27`) |
| Embedding config | Process lifetime | Load env vars once (`embedding-config.ts:101`) |

### 12. Two Search Domains

SocratiCode provides two independent search domains, both using the same hybrid search engine:

| Domain | Collection | MCP Tool | Purpose |
|--------|-----------|----------|---------|
| Code search | `codebase_{projectId}` | `codebase_search` | Source code files |
| Context artifact search | `context_{projectId}` | `codebase_context_search` | DB schemas, API specs, configs, docs |

Context artifact search (`context-artifacts.ts:462-486`) adds auto-indexing on first use and automatic staleness detection (content hash comparison).

### 13. Performance Characteristics

No formal benchmarks exist in the codebase. Performance is bounded by:

1. **Embedding generation**: Single query embedding (~1 API call). Ollama local: ~10-50ms. OpenAI: ~100-300ms network round-trip. Google: ~100-300ms.
2. **Qdrant search**: Hybrid prefetch + RRF fusion. With on-disk payload and keyword indexes, typical latency for small-to-medium collections is sub-100ms.
3. **Retry overhead**: Both embedding and Qdrant calls have retry wrappers with exponential backoff (500ms base, 3 retries max). Rate-limit errors get 15s minimum backoff.

## Architecture / Flow

```
                                  codebase_search (MCP tool)
                                         |
                                         v
                               handleQueryTool()
                               (query-tools.ts:47)
                                         |
                        +----------------+----------------+
                        v                v                v
              ensureQdrantReady()  ensureProvider()  ensureWatcherStarted()
                        |                |                (fire-and-forget)
                        +-------+--------+
                                v
                     searchChunks(collection, query, limit, filters)
                     (qdrant.ts:305)
                                |
                    +-----------+-----------+
                    v                       v
         generateQueryEmbedding()    raw query text
         (embeddings.ts:91)                 |
                    |                       |
                    v                       v
         "search_query: {query}"    Qdrant BM25 inference
         -> provider.embedSingle()  (server-side, model: qdrant/bm25)
                    |                       |
                    +-----------+-----------+
                                v
                    Qdrant Query API (prefetch)
                    +-----------------------------+
                    | prefetch[0]: dense           |
                    |   query: vector, using: dense|
                    |   limit: max(N*3, 30)        |
                    |   filter: filePath/language   |
                    |                              |
                    | prefetch[1]: bm25            |
                    |   query: text, using: bm25   |
                    |   limit: max(N*3, 30)        |
                    |   filter: filePath/language   |
                    |                              |
                    | fusion: "rrf"                |
                    | limit: N                     |
                    +-------------+---------------+
                                  v
                    RRF-ranked SearchResult[]
                                  |
                                  v
                    Filter: score >= minScore (default 0.10)
                                  |
                                  v
                    Format: "--- path (lines X-Y) [lang] score: 0.XXXX ---"
```

## File Map

| File | Role |
|------|------|
| `src/index.ts` | MCP server entry point; registers all 21 tools with zod schemas |
| `src/types.ts` | Core type definitions: `FileChunk`, `SearchResult`, `CodeGraph`, `ContextArtifact` |
| `src/constants.ts` | All configuration constants: chunk sizes, search defaults, supported extensions |
| `src/config.ts` | Project ID generation (SHA-256), collection name derivation |
| `src/tools/query-tools.ts` | `codebase_search` and `codebase_status` tool handlers |
| `src/tools/context-tools.ts` | `codebase_context_search` and other context artifact tool handlers |
| `src/services/qdrant.ts` | Qdrant client: collection CRUD, upsert, **hybrid search**, metadata persistence |
| `src/services/embeddings.ts` | Embedding orchestration: batch generation, query embedding, document text preparation |
| `src/services/embedding-config.ts` | Provider config from env vars: model, dimensions, context length |
| `src/services/embedding-provider.ts` | Factory singleton for Ollama/OpenAI/Google providers |
| `src/services/embedding-types.ts` | `EmbeddingProvider` interface contract |
| `src/services/provider-ollama.ts` | Ollama embedding provider (Docker/external/auto mode) |
| `src/services/provider-openai.ts` | OpenAI embedding provider (`text-embedding-3-small`) |
| `src/services/provider-google.ts` | Google embedding provider (`gemini-embedding-001`) |
| `src/services/indexer.ts` | Full/incremental indexing, AST-aware chunking, batched embedding pipeline |
| `src/services/context-artifacts.ts` | Context artifact loading, chunking, indexing, staleness detection, search |
| `src/services/watcher.ts` | File system watcher for auto-incremental updates |
| `DEVELOPER.md` | Comprehensive developer documentation with data flow diagrams |

## Code Excerpts

### The hybrid search call (the heart of the system)

`src/services/qdrant.ts:303-355`:
```typescript
/** Hybrid search: combines dense semantic search with BM25 lexical search via RRF fusion.
 * Dense vector is generated client-side; BM25 inference runs server-side in Qdrant (requires v1.15.2+). */
export async function searchChunks(
  collectionName: string,
  query: string,
  limit: number = 10,
  fileFilter?: string,
  languageFilter?: string,
): Promise<SearchResult[]> {
  const qdrant = getClient();
  const queryVector = await generateQueryEmbedding(query);

  const filter = { must: [] };
  if (fileFilter) {
    filter.must.push({ key: "relativePath", match: { value: fileFilter } });
  }
  if (languageFilter) {
    filter.must.push({ key: "language", match: { value: languageFilter } });
  }

  const prefetchLimit = Math.max(limit * 3, 30);
  const activeFilter = filter.must.length > 0 ? filter : undefined;

  const results = await withRetry(
    () => qdrant.query(collectionName, {
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
    }),
    "Qdrant hybrid search",
  );

  return results.points.map((r) => ({
    filePath: r.payload?.filePath as string,
    relativePath: r.payload?.relativePath as string,
    content: r.payload?.content as string,
    startLine: r.payload?.startLine as number,
    endLine: r.payload?.endLine as number,
    language: r.payload?.language as string,
    score: r.score,
  }));
}
```

### Query embedding with asymmetric prefix

`src/services/embeddings.ts:91-105`:
```typescript
export async function generateQueryEmbedding(query: string): Promise<number[]> {
  const provider = await getEmbeddingProvider();
  return withRetry(
    () => provider.embedSingle(`search_query: ${query}`),
    "Query embedding",
  );
}

export function prepareDocumentText(content: string, filePath: string): string {
  return `search_document: ${filePath}\n${content}`;
}
```

### Score threshold filtering

`src/tools/query-tools.ts:78-82`:
```typescript
const minScore = (args.minScore as number) ?? SEARCH_MIN_SCORE;
const results = minScore > 0
  ? allResults.filter((r) => r.score >= minScore)
  : allResults;
```

## Open Questions

1. **No path prefix/glob filtering**: The `fileFilter` parameter requires an exact `relativePath` match. Users cannot filter by path prefix (e.g., `src/services/*`) or glob pattern. This limits discoverability when you know the directory but not the exact file.

2. **No pagination**: With a max of 50 results per query and no cursor, large codebases may have relevant results that are unreachable. The 3x prefetch factor helps ranking quality but doesn't solve pagination.

3. **No search result caching**: Repeated identical queries regenerate the embedding and hit Qdrant each time. For MCP tool usage patterns where the same query might be retried, a short-lived cache could save latency.

4. **RRF score semantics**: RRF scores are not normalized probabilities — they are inversely proportional to rank position. The default `0.10` threshold was likely tuned empirically; there is no documentation on how this value was chosen or calibrated across different embedding providers.

5. **No reranking**: For high-precision use cases, a cross-encoder reranker (e.g., via Jina or Cohere) after the initial RRF fusion could improve result quality, especially for code-specific queries where lexical and semantic signals may disagree.

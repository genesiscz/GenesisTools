# SocratiCode Database & Storage Architecture

> Explored on 2026-03-20 | Scope: `.worktrees/socraticode/src/` (all services, tools, types, config)

## Summary

SocratiCode uses **Qdrant** (v1.17.0) as its sole database -- a purpose-built vector database running in Docker. There is no SQLite, no relational database, and no on-disk file-based store beyond temporary lock files. All data -- code chunks, embeddings, BM25 sparse vectors, file hashes, code graphs, and context artifact metadata -- is stored in Qdrant collections. Hybrid search combines dense vector similarity (cosine) with server-side BM25 lexical matching, fused via Reciprocal Rank Fusion (RRF). Incremental indexing uses SHA-256 content hashes persisted as a JSON blob inside Qdrant metadata points.

## Key Findings

### 1. Database Choice: Qdrant (Vector DB) -- Nothing Else

SocratiCode uses **only Qdrant**. The `@qdrant/js-client-rest` client (v1.17.0) is the sole database dependency. There is no SQLite, no better-sqlite3, no LanceDB, no Chroma, no Pinecone, and no FTS5. The Qdrant server runs as a Docker container (`qdrant/qdrant:v1.17.0`) managed by the MCP server itself.

**Docker volume**: `socraticode_qdrant_data` mounted at `/qdrant/storage` inside the container.

```
src/services/docker.ts:120-128   -- docker run with volume mount
docker-compose.yml:10            -- socraticode_qdrant_data:/qdrant/storage
```

Configuration supports two modes (`constants.ts:28-29`):
- **`managed`** (default): Docker-managed local Qdrant on port 16333
- **`external`**: User-provided remote/cloud Qdrant instance via `QDRANT_URL`

### 2. Collection Schema Design

SocratiCode uses **4 types of Qdrant collections** with naming conventions:

| Collection Pattern | Purpose | Vector Config |
|---|---|---|
| `codebase_{projectId}` | Code chunks + embeddings | Dense (N-dim cosine) + Sparse BM25 |
| `context_{projectId}` | Context artifacts (schemas, API specs) | Dense (N-dim cosine) + Sparse BM25 |
| `codegraph_{projectId}` | Code graph data (stored as metadata point, not a real collection) | N/A (metadata only) |
| `socraticode_metadata` | Project metadata, file hashes, graph data, artifact state | Dummy 1-dim cosine |

**Project ID generation** (`config.ts:15-27`):
- Default: SHA-256 of the absolute project path, truncated to 12 hex chars
- Override: `SOCRATICODE_PROJECT_ID` env var (for shared indexes across worktrees)

**Collection creation** (`qdrant.ts:62-104`):

```typescript
// Codebase/context collections:
await qdrant.createCollection(name, {
  vectors: {
    dense: {
      size: embeddingDimensions,  // 768 (ollama), 1536 (openai), 3072 (google)
      distance: "Cosine",
    },
  },
  sparse_vectors: {
    bm25: {
      modifier: "idf",
    },
  },
  optimizers_config: {
    default_segment_number: 2,
  },
  on_disk_payload: true,
});
```

**Payload indexes** created on codebase collections:
- `filePath` (keyword)
- `relativePath` (keyword)
- `language` (keyword)
- `contentHash` (keyword)

Context collections also get an `artifactName` (keyword) index.

**Metadata collection** (`qdrant.ts:450-463`):
```typescript
// Dummy 1-dim vector since Qdrant requires vectors
await qdrant.createCollection(METADATA_COLLECTION, {
  vectors: { size: 1, distance: "Cosine" },
  on_disk_payload: true,
});
// Single payload index:
// field_name: "collectionName", field_schema: "keyword"
```

### 3. Vector Storage Format

Vectors are stored natively in Qdrant's format -- **not** as BLOBs or JSON arrays. Each point has:

**Named dense vector** (`dense`): a `number[]` of dimension N (768/1536/3072 depending on provider). Generated client-side by the embedding provider.

**Named sparse vector** (`bm25`): server-side BM25 inference. The client sends the raw text; Qdrant's built-in BM25 tokenizer generates the sparse vector.

Point structure (`qdrant.ts:183-202`):
```typescript
{
  id: chunk.id,          // UUID derived from SHA-256 of "relativePath:startLine"
  vector: {
    dense: embeddings[i],             // number[] from embedding provider
    bm25: {
      text: texts[i],                 // raw text for server-side BM25
      model: "qdrant/bm25",           // Qdrant v1.15.2+ built-in tokenizer
    },
  },
  payload: {
    filePath: string,
    relativePath: string,
    content: string,        // full chunk text (for display)
    startLine: number,
    endLine: number,
    language: string,
    type: "code" | "comment" | "mixed",
    contentHash: string,    // SHA-256 of full file content (truncated to 16 hex)
  },
}
```

BM25 text is truncated to 32KB (`MAX_BM25_TEXT_CHARS = 32_000`) before sending to Qdrant.

### 4. Full-Text Search: Qdrant Built-in BM25 (Not SQLite FTS5)

There is **no FTS5, no SQLite, no custom tokenizer**. SocratiCode uses Qdrant's native server-side BM25 inference (`model: "qdrant/bm25"`) introduced in Qdrant v1.15.2.

Key details:
- BM25 sparse vectors use IDF modifier (`sparse_vectors.bm25.modifier: "idf"`)
- Qdrant handles tokenization server-side -- no client-side tokenizer configuration
- The BM25 index is a "sparse vector" in Qdrant terminology, separate from the dense vector

### 5. Hybrid Search: Dense + BM25 with RRF Fusion

Search uses Qdrant's `query()` API with **prefetch + RRF fusion** (`qdrant.ts:305-354`):

```typescript
const results = await qdrant.query(collectionName, {
  prefetch: [
    {
      query: queryVector,                    // Dense embedding
      using: "dense",
      limit: prefetchLimit,                  // max(limit * 3, 30)
      filter: activeFilter,
    },
    {
      query: { text: query, model: "qdrant/bm25" },  // BM25 lexical
      using: "bm25",
      limit: prefetchLimit,
      filter: activeFilter,
    },
  ],
  query: { fusion: "rrf" },  // Reciprocal Rank Fusion
  limit,
  with_payload: true,
  filter: activeFilter,
});
```

**Fusion strategy**: Reciprocal Rank Fusion (RRF). Qdrant merges the ranked lists from both sub-queries.

**Prefetch over-sampling**: Each sub-query fetches `max(limit * 3, 30)` candidates, then RRF selects the top `limit`.

**Score filtering**: Results below `SEARCH_MIN_SCORE` (default 0.10, env-configurable) are dropped.

**Filters**: Optional `fileFilter` (relativePath keyword match), `languageFilter` (language keyword match), `artifactName` (for context artifact search).

### 6. Incremental Updates: SHA-256 Content Hashing

Change detection is **hash-based** (`indexer.ts:216-218`):

```typescript
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
```

The hash map (`Map<relativePath, contentHash>`) is stored **inside Qdrant** as a JSON-stringified payload on a metadata point in `socraticode_metadata` (`qdrant.ts:490-511`):

```typescript
payload: {
  collectionName: collName,
  projectPath,
  lastIndexedAt: new Date().toISOString(),
  filesTotal,
  filesIndexed,
  fileHashes: JSON.stringify(hashObj),  // {"src/foo.ts": "a1b2c3d4e5f67890", ...}
  indexingStatus: "in-progress" | "completed",
}
```

**Incremental update flow** (`indexer.ts:950-1246`):
1. Load stored hashes from Qdrant metadata
2. Scan all indexable files and compute content hashes
3. Compare: identify added, changed, and deleted files
4. Delete stale chunks for changed files (`deleteFileChunks` by relativePath filter)
5. Generate embeddings for new/changed chunks in batches of 50 files
6. Upsert to Qdrant in batches of 100 points
7. Checkpoint after each batch (persist hashes to metadata)

**Migration**: Old indexes with absolute path keys are auto-migrated to relative paths on first load (`indexer.ts:164-189`).

### 7. Data Model: Entities and Relationships

```
Project (identified by projectId = sha256(path)[0:12])
  |-- codebase_{projectId} collection
  |     +-- Points: code chunks (one per AST region / line range)
  |           - id: UUID from sha256(relativePath:startLine)
  |           - dense vector: embedding from provider
  |           - bm25 vector: server-side from content text
  |           - payload: filePath, relativePath, content, startLine, endLine,
  |                      language, type, contentHash
  |
  |-- context_{projectId} collection
  |     +-- Points: context artifact chunks
  |           - same structure as code chunks
  |           - extra payload: artifactName, artifactDescription
  |
  +-- socraticode_metadata collection (shared across all projects)
        |-- Project metadata point (1 per project)
        |     - payload: collectionName, projectPath, lastIndexedAt,
        |                filesTotal, filesIndexed, fileHashes (JSON), indexingStatus
        |
        |-- Graph metadata point (1 per project)
        |     - payload: collectionName, projectPath, lastBuiltAt,
        |                nodeCount, edgeCount, graphData (JSON-serialized CodeGraph)
        |
        +-- Context metadata point (1 per project)
              - payload: collectionName, projectPath, lastIndexedAt,
                         artifactCount, artifacts (JSON-serialized ArtifactIndexState[])
```

**Chunk ID generation** (`indexer.ts:221-225`):
```typescript
function chunkId(relativePath: string, startLine: number): string {
  const hash = createHash("sha256").update(`${relativePath}:${startLine}`).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-...-${hash.slice(20, 32)}`; // UUID format
}
```

**Metadata point ID** (`qdrant.ts:468-472`): SHA-256 of collection name, formatted as UUID.

### 8. Chunking Strategy

Three chunking strategies with priority order (`indexer.ts:410-455`):

1. **Character-based** (for minified/bundled files): triggers when avg line length > 500 chars. Splits at safe boundaries (newline, space, semicolon). Uses byte offset for chunk ID.

2. **AST-aware** (for supported languages): uses `@ast-grep/napi` to find top-level declarations (functions, classes, interfaces, etc.). Merges small declarations, sub-chunks large ones (>150 lines).

3. **Line-based** (fallback): fixed 100-line chunks with 10-line overlap.

**Constants**:
- `CHUNK_SIZE = 100` lines
- `CHUNK_OVERLAP = 10` lines
- `MAX_CHUNK_CHARS = 2000` (hard cap on all chunks)
- `MAX_FILE_BYTES = 5MB` (files larger are skipped)
- `MAX_AVG_LINE_LENGTH = 500` (triggers character-based chunking)

### 9. Storage Location

| Data | Location |
|---|---|
| Qdrant database files | Docker volume `socraticode_qdrant_data` at `/qdrant/storage` |
| Ollama models | Docker volume `socraticode_ollama_data` at `/root/.ollama` |
| Cross-process lock files | `$TMPDIR/socraticode-locks/{projectId}-{operation}.lock` |
| Application logs | Pino logger (stdout/MCP notifications) |

There is **no per-project local database** and **no global SQLite file**. All persistent state lives in Qdrant.

### 10. Migration Strategy: None (No Schema Versioning)

There is **no formal migration system**. The schema is implicit in the code:

- Collection creation is idempotent (`ensureCollection` checks if it exists first)
- Payload indexes are added idempotently (`ensurePayloadIndex` ignores "already exists" errors)
- The only migration is the absolute-to-relative path key migration for file hashes (`migrateAbsolutePathKeys`)
- Schema changes would require re-indexing (`codebase_remove` + `codebase_index`)

### 11. Embedding Provider Architecture

Three providers, same interface (`embedding-types.ts`):

| Provider | Model (default) | Dimensions | Context Length | Batch Size |
|---|---|---|---|---|
| `ollama` | nomic-embed-text | 768 | 2048 tokens | 32 |
| `openai` | text-embedding-3-small | 1536 | 8191 tokens | 32 (API limit: 2048) |
| `google` | gemini-embedding-001 | 3072 | 2048 tokens | 32 |

Provider-specific rate limiting: Google = 15s between batches (5 RPM free tier), others = 0.

Pre-truncation: each provider truncates input text to the model's context window. The `MAX_CHUNK_CHARS = 2000` limit ensures chunks are typically within bounds.

Document text is prefixed with `search_document: {filePath}\n` for indexing, and queries are prefixed with `search_query: ` for retrieval (nomic-embed-text task prefixes).

### 12. Concurrency & Crash Safety

- **Cross-process locking**: `proper-lockfile` with 2-minute staleness, 30-second refresh. Lock files in `$TMPDIR/socraticode-locks/`.
- **Batch checkpointing**: Metadata (including file hashes) is persisted to Qdrant after every batch of 50 files. A crash mid-indexing loses at most 50 files of work.
- **Indexing status**: `indexingStatus` field in metadata = `"in-progress"` | `"completed"`. Incomplete indexes are auto-resumed on next MCP server startup.
- **Graceful cancellation**: `codebase_stop` sets a cancellation flag checked between batches. Current batch completes, checkpoints, then stops.
- **Upsert fallback**: If a batch of 100 points fails Qdrant upsert, falls back to per-point upsert to isolate bad points (`qdrant.ts:250-287`).

## Architecture / Flow

```
                              MCP Client (Claude, Cline, etc.)
                                         |
                                         v
                              src/index.ts (MCP Server)
                                         |
                         +---------------+---------------+
                         v               v               v
                   index-tools.ts  query-tools.ts  graph-tools.ts
                         |               |               |
                         v               v               v
                    indexer.ts      qdrant.ts        code-graph.ts
                    (chunk +       (search +        (ast-grep +
                     batch)         CRUD)            graph persist)
                         |               |               |
                         v               v               v
                    embeddings.ts ------>|<------  context-artifacts.ts
                         |               |
                         v               v
               embedding-provider.ts   Qdrant Server (Docker)
               +--------+--------+     +------------------+
               v        v        v     | Collections:     |
           Ollama    OpenAI   Google   |  codebase_*      |
           (Docker)  (API)   (API)     |  context_*       |
                                       |  socraticode_    |
                                       |    metadata      |
                                       +------------------+
```

**Indexing flow**:
```
codebase_index
  -> ensureInfrastructure (Docker + Qdrant + Embedding provider)
  -> indexProject (background, fire-and-forget)
      -> acquireProjectLock("index")
      -> getProjectHashes (from Qdrant metadata)
      -> getIndexableFiles (glob + ignore filter)
      -> Phase 1: scan + chunk (50 files/batch, parallel I/O)
          -> chunkFileContent (AST -> line -> char fallback)
      -> Phase 2: embed + upsert (50 files/batch, sequential)
          -> generateEmbeddings (32 texts/batch to provider)
          -> upsertPreEmbeddedChunks (100 points/batch to Qdrant)
          -> saveProjectMetadata (checkpoint after each batch)
      -> Phase 3: finalize
          -> rebuildGraph (ast-grep static analysis)
          -> ensureArtifactsIndexed (context artifacts)
      -> releaseProjectLock("index")
```

**Search flow**:
```
codebase_search
  -> ensureQdrantReady
  -> ensureOllamaReady (or cloud provider init)
  -> generateQueryEmbedding(query)  -- single vector from provider
  -> qdrant.query(collection, {
      prefetch: [
        { dense vector, limit: 30 },
        { bm25 text,    limit: 30 },
      ],
      fusion: "rrf",
      limit: 10,
    })
  -> filter by minScore (default 0.10)
  -> return ranked results with content, path, lines, score
```

## File Map

| File | Role |
|------|------|
| `src/services/qdrant.ts` | All Qdrant CRUD: collection management, upsert, search, metadata persistence |
| `src/services/indexer.ts` | Core indexing logic: file scanning, chunking, batched embed+upsert, incremental updates |
| `src/services/embeddings.ts` | Embedding generation: batching, retry, provider delegation |
| `src/services/embedding-config.ts` | Provider configuration: model, dimensions, context length |
| `src/services/embedding-provider.ts` | Provider factory: Ollama / OpenAI / Google |
| `src/services/embedding-types.ts` | Shared interfaces for embedding providers |
| `src/services/context-artifacts.ts` | Non-code artifact indexing (DB schemas, API specs, etc.) |
| `src/services/code-graph.ts` | AST-based dependency graph (persisted as JSON in Qdrant metadata) |
| `src/services/docker.ts` | Docker container lifecycle for Qdrant and Ollama |
| `src/services/lock.ts` | Cross-process file-based locking via `proper-lockfile` |
| `src/services/watcher.ts` | File system watcher (`@parcel/watcher`) for auto-updates |
| `src/services/startup.ts` | Auto-resume: restart watchers and resume interrupted indexes |
| `src/config.ts` | Project ID generation and collection name derivation |
| `src/constants.ts` | All tuning constants: ports, chunk sizes, file types |
| `src/types.ts` | Core type definitions: FileChunk, CodeGraph, SearchResult |
| `src/index.ts` | MCP server entry point: tool registration and lifecycle |
| `src/tools/query-tools.ts` | codebase_search and codebase_status handlers |
| `src/tools/index-tools.ts` | codebase_index, update, remove, stop, watch handlers |
| `docker-compose.yml` | Docker Compose for Qdrant + Ollama with named volumes |

## Code Excerpts

### Collection creation with dual vectors (qdrant.ts:67-84)

```typescript
await qdrant.createCollection(name, {
  vectors: {
    dense: {
      size: embeddingDimensions,
      distance: "Cosine",
    },
  },
  sparse_vectors: {
    bm25: {
      modifier: "idf",
    },
  },
  optimizers_config: {
    default_segment_number: 2,
  },
  on_disk_payload: true,
});
```

### Hybrid search with RRF fusion (qdrant.ts:327-343)

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

### Metadata persistence -- file hashes as JSON blob (qdrant.ts:495-511)

```typescript
await qdrant.upsert(METADATA_COLLECTION, {
  points: [{
    id,
    vector: [0],  // dummy vector
    payload: {
      collectionName: collName,
      projectPath,
      lastIndexedAt: new Date().toISOString(),
      filesTotal,
      filesIndexed,
      fileHashes: JSON.stringify(hashObj),
      indexingStatus,
    },
  }],
});
```

### Batch checkpointing during indexing (indexer.ts:877-881)

```typescript
// Checkpoint: persist hashes after each batch so progress survives crashes
progress.phase = `checkpointing (batch ${batchNum}/${totalBatches})`;
await saveProjectMetadata(collection, resolvedPath, files.length, hashes.size, hashes, "in-progress");
progress.batchesProcessed = batchNum;
```

## Open Questions

1. **Metadata scalability**: The file hashes for an entire project are stored as a single JSON string in one Qdrant payload field. For projects with 100K+ files, this could become a very large payload (estimated ~5MB+). No sharding strategy exists.

2. **Graph data scalability**: Similarly, the entire `CodeGraph` (nodes + edges) is serialized as a single JSON payload. Large codebases could hit Qdrant's per-payload size limits.

3. **No schema versioning**: If the payload structure changes (e.g., adding a field), existing collections will have inconsistent payloads. There is no migration path other than full re-index.

4. **BM25 tokenizer configuration**: The BM25 sparse vector uses Qdrant's default tokenizer with no language-specific configuration. This may produce suboptimal results for non-English codebases or special identifiers like `camelCase`/`snake_case` splitting.

5. **Collection isolation**: Each project gets its own collection. There is no cross-project search capability. The metadata collection is the only shared resource.

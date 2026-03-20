# SocratiCode Indexing Pipeline -- Deep Dive

> Explored on 2026-03-20 | Scope: `.worktrees/socraticode/src/` (all services, tools, types, constants)

## Summary

SocratiCode is an MCP (Model Context Protocol) server that indexes codebases into a Qdrant vector database for semantic search. The pipeline discovers files via glob patterns filtered through a 3-layer ignore system (defaults + .gitignore + .socraticodeignore), detects changes via SHA-256 content hashing stored in Qdrant metadata, chunks files using AST-aware boundaries (ast-grep for 15+ languages) with line-based and character-based fallbacks, generates embeddings via pluggable providers (Ollama/OpenAI/Google), and stores them in Qdrant with both dense vectors and BM25 sparse vectors for hybrid search. The system is fully resumable -- indexing checkpoints after every batch of 50 files and can be interrupted/resumed without data loss.

## Key Findings

### 1. File Discovery: Glob + 3-Layer Ignore System

File discovery uses the `glob` npm package with `**/*` pattern, NOT git-based discovery:

```typescript
// indexer.ts:615-617
const allFiles = await glob("**/*", {
  cwd: projectPath,
  nodir: true,
  dot: (process.env.INCLUDE_DOT_FILES ?? "false").toLowerCase() === "true",
  absolute: false,
});
```

Files pass through two filters:
1. **Extension check** (`isIndexableFile`): Must match `SUPPORTED_EXTENSIONS` (46 extensions), `SPECIAL_FILES` (Dockerfile, Makefile, etc.), or user-configured `EXTRA_EXTENSIONS`
2. **Ignore check** (`shouldIgnore`): 3-layer ignore system (see below)

The ignore system (`ignore.ts`) layers three sources in order:

| Layer | Source | Examples |
|-------|--------|---------|
| 1. Defaults | Hardcoded `DEFAULT_IGNORE_PATTERNS` (54 patterns) | `node_modules`, `.git`, `dist`, `*.lock`, `*.min.js`, `.DS_Store` |
| 2. `.gitignore` | Root + recursively nested `.gitignore` files | Respects negation (`!`), relative directory scoping |
| 3. `.socraticodeignore` | Optional project-specific file | User-defined patterns, same syntax as `.gitignore` |

Nested `.gitignore` files are properly scoped: patterns are prefixed with the relative directory path before being added to the ignore filter. Can be disabled via `RESPECT_GITIGNORE=false` env var.

### 2. Change Detection: SHA-256 Content Hashing

Change detection uses **content hashing**, not timestamps, not git diff, not Merkle trees:

```typescript
// indexer.ts:216-218
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
```

Hashes are stored per-file in a `Map<relativePath, hash>` that is persisted to Qdrant as a JSON blob in the `socraticode_metadata` collection. On subsequent runs:

1. Load hash map from Qdrant (`loadProjectHashes` in `qdrant.ts:520-545`)
2. For each file: read content, compute hash, compare to stored hash
3. Skip if hash matches (unchanged), re-index if different

There is also a one-time migration for old indexes that stored absolute paths as hash keys (`migrateAbsolutePathKeys` at `indexer.ts:164-189`).

### 3. Incremental Indexing

Two distinct paths:

**Full Index (`indexProject`)** -- `indexer.ts:631-948`:
- Scans ALL files, skips unchanged ones by hash comparison
- Detects and handles: fresh start, re-index (collection has data but no hashes), resume after interruption
- NEVER deletes an existing collection -- only `removeProjectIndex` can do that
- After indexing: auto-builds code graph, auto-indexes context artifacts

**Incremental Update (`updateProjectIndex`)** -- `indexer.ts:951-1246`:
- Only called by watcher and `codebase_update` tool
- Identifies changed/new/deleted files by comparing current file set + hashes against stored hashes
- For updated files: delete old chunks first, then re-embed
- For deleted files: remove chunks and hash entry
- Falls back to full index if no hash metadata exists

Both paths share the same embed-upsert-checkpoint batch loop.

### 4. File Watching: @parcel/watcher (Native OS Events)

The watcher (`watcher.ts`) uses `@parcel/watcher`, NOT chokidar or `fs.watch`:

```typescript
// watcher.ts:148
const subscription = await watcher.subscribe(resolvedPath, callback, { ignore: ignoreGlobs });
```

This provides native OS-level file watching:
- **macOS**: FSEvents
- **Windows**: ReadDirectoryChangesW
- **Linux**: inotify

Key design decisions:
- **Debounce**: 2 seconds (`DEBOUNCE_MS = 2000`) -- multiple rapid changes trigger a single update
- **Error circuit breaker**: After 10 consecutive errors (`MAX_WATCHER_ERRORS`), the watcher stops itself
- **Cross-process lock**: Only one process can watch a project at a time (via `proper-lockfile`)
- **External watch cache**: 60s TTL to avoid retrying lock acquisition on every tool call
- **Infrastructure back-off**: If Qdrant is unreachable (ECONNREFUSED, fetch failed, timeout), pauses updates for 30 seconds

Watch events are filtered through the same `isIndexableFile` + `shouldIgnore` checks before triggering updates.

Auto-start behavior:
- After `codebase_index` completes, watcher starts automatically
- After `codebase_update` completes, watcher starts automatically
- On any tool use (search, status), `ensureWatcherStarted()` fires opportunistically -- but only if the index is complete and no indexing is in progress

### 5. Indexing Pipeline Stages

The complete pipeline flows through these stages:

```
Discovery --> Filter --> Read+Hash --> [Skip unchanged] --> Chunk --> Embed --> Upsert --> Checkpoint
    |            |           |                                 |          |          |           |
  glob()    isIndexable  fsp.readFile                   chunkFile   generateEmbeddings  Qdrant  saveProjectMetadata
            shouldIgnore hashContent                    Content()                     upsertPre
                                                                                     Embedded
```

Detailed stage breakdown for a full index:

| Stage | What happens | File:Line |
|-------|-------------|-----------|
| 1. Setup | Acquire cross-process lock, load/create collection, load hash map | `indexer.ts:642-704` |
| 2. Scan | `glob("**/*")` + extension filter + ignore filter | `indexer.ts:707-710` |
| 3. Read & Hash | Read file content, compute SHA-256 hash, skip if unchanged | `indexer.ts:722-754` |
| 4. Chunk | AST-aware chunking (or line-based/char-based fallback) | `indexer.ts:741` calls `chunkFileContent` |
| 5. Clean stale | Delete old chunks for changed files, handle deleted files | `indexer.ts:756-775` |
| 6. Embed | Generate embeddings in batches of 32 texts per provider request | `indexer.ts:825-831` |
| 7. Upsert | Store points in Qdrant (dense vector + BM25 + payload), batches of 100 | `indexer.ts:834-861` |
| 8. Checkpoint | Save hash map + indexing status ("in-progress") to metadata | `indexer.ts:877-881` |
| 9. Finalize | Save metadata with "completed" status | `indexer.ts:888-889` |
| 10. Code graph | Auto-build dependency graph via ast-grep | `indexer.ts:891-901` |
| 11. Context artifacts | Auto-index `.socraticodecontextartifacts.json` artifacts | `indexer.ts:903-920` |

### 6. Concurrency Model

**File scanning**: 50 files in parallel (`FILE_SCAN_BATCH = 50` at `indexer.ts:40`) -- I/O only, no network:

```typescript
// indexer.ts:722-724
for (let i = 0; i < files.length; i += FILE_SCAN_BATCH) {
  const batch = files.slice(i, i + FILE_SCAN_BATCH);
  const results = await Promise.all(batch.map(async (relativePath) => { ... }));
```

**File batching for embed+upsert**: 50 files per batch (`INDEX_BATCH_SIZE = 50` at `constants.ts:70`):
- All chunks from 50 files are collected
- Embeddings generated in sub-batches of 32 texts (`BATCH_SIZE = 32` in `embeddings.ts:8`)
- Upserted to Qdrant in sub-batches of 100 points (`qdrant.ts:251`)
- Checkpoint saved after each file batch

**Cross-process concurrency**:
- File-based locks via `proper-lockfile` (`lock.ts`)
- Separate lock keys for `index` and `watch` operations per project
- Stale locks reclaimed after 2 minutes, refreshed every 30 seconds
- Lock directory: `$TMPDIR/socraticode-locks/`

**In-process concurrency guards**:
- `indexingInProgress` Map prevents duplicate indexing of the same project
- `graphBuildPromises` Map deduplicates concurrent graph builds (callers share the same promise)

### 7. Progress Tracking

Progress is tracked via an `IndexingProgress` object stored in-memory:

```typescript
// indexer.ts:47-60
export interface IndexingProgress {
  type: "full-index" | "incremental-update";
  startedAt: number;
  filesTotal: number;
  filesProcessed: number;
  chunksTotal?: number;
  chunksProcessed?: number;
  batchesTotal?: number;
  batchesProcessed?: number;
  phase: string;         // "scanning files" | "generating embeddings (batch 2/5)" | etc.
  error?: string;
}
```

Progress is reported through:
1. **In-memory state**: Polled by `codebase_status` tool via `getIndexingProgress()`
2. **Callback**: `onProgress?: (message: string) => void` parameter on `indexProject` and `updateProjectIndex`
3. **Logger**: All progress messages also logged via pino
4. **Persisted metadata**: `indexingStatus: "in-progress" | "completed"` saved to Qdrant after each batch checkpoint

The `codebase_index` tool returns immediately and fires indexing in the background. The LLM is instructed to poll `codebase_status` every ~60 seconds.

### 8. Error Handling Strategy

The system uses a **layered error handling** approach:

| Layer | Strategy | Example |
|-------|----------|---------|
| **File read** | Silent skip | `catch { return null; }` in scan batch -- `indexer.ts:743` |
| **File too large** | Skip with message | `stat.size > MAX_FILE_BYTES` (5MB default) -- `indexer.ts:729` |
| **Embedding generation** | Retry 3x with exponential backoff | `withRetry()` in `embeddings.ts:24-51`, rate-limit aware (15s min for 429) |
| **Qdrant upsert** | Retry batch 3x, then fallback to per-point upsert | `qdrant.ts:250-287` -- isolates bad points |
| **All points skipped** | Throw (collection may be deleted) | `indexer.ts:863-869` |
| **Collection state check** | Throw on transient errors (protects against false clean-start) | `indexer.ts:669-677` |
| **Code graph build** | Non-fatal catch, log warning | `indexer.ts:897-901` |
| **Context artifacts** | Non-fatal catch, log warning | `indexer.ts:916-920` |
| **Watcher update failure** | Log error, back off 30s for infra issues | `watcher.ts:131-141` |
| **Watcher errors** | Circuit breaker: stop after 10 consecutive errors | `watcher.ts:164-171` |

**Critical safety feature**: Qdrant connectivity failures during collection state checks ABORT the operation rather than cascading into a destructive clean-start. The comment at `indexer.ts:666-667` makes this explicit.

### 9. Language/File Type Handling: AST-Aware Chunking

SocratiCode uses **@ast-grep/napi** for AST parsing, NOT tree-sitter directly. ast-grep is built on tree-sitter but provides a higher-level query API.

Three chunking strategies, selected by file characteristics:

**Strategy 1 -- AST-Aware Chunking** (preferred):
- For files with ast-grep grammar support (JS/TS/Python/Java/Go/Rust/C/C++/C#/Ruby/PHP/Swift/Bash/Kotlin/Scala + Svelte/Vue via HTML re-parse)
- Finds top-level declaration boundaries (functions, classes, interfaces, etc.)
- Groups small declarations together (< 5 lines merged with neighbors)
- Sub-chunks large declarations (> 150 lines) with overlap
- Includes preamble (imports) and epilogue as separate chunks

Dynamic languages registered at runtime via `@ast-grep/lang-*` packages (`code-graph.ts:252-266`):
python, go, java, rust, c, cpp, csharp, ruby, kotlin, swift, scala, bash, php

Built-in ast-grep languages: JavaScript, TypeScript, Tsx, Html, Css

**Strategy 2 -- Line-Based Chunking** (fallback):
- For files where AST parsing fails or language not supported
- Fixed 100-line chunks with 10-line overlap
- `CHUNK_SIZE = 100`, `CHUNK_OVERLAP = 10` (constants.ts:68-69)

**Strategy 3 -- Character-Based Chunking** (minified files):
- Triggered when average line length > 500 chars (`MAX_AVG_LINE_LENGTH = 500`)
- Splits at safe token boundaries (newline, space, tab, semicolon, comma)
- Uses byte offset for chunk IDs (single-line files would have identical line-based IDs)

**Universal safety net**: Every chunk, regardless of strategy, is capped at `MAX_CHUNK_CHARS = 2000` characters (`indexer.ts:334-341`).

Small files (<= 100 lines) are always a single chunk, regardless of language.

### 10. Resumability

Indexing is **fully resumable** at the file-batch level:

1. After each batch of 50 files is embedded and upserted, a checkpoint is saved:
   ```typescript
   // indexer.ts:877-880
   await saveProjectMetadata(collection, resolvedPath, files.length, hashes.size, hashes, "in-progress");
   ```

2. The checkpoint contains: all file hashes processed so far, indexing status = "in-progress"

3. On resume (re-running `codebase_index`):
   - Loads hash map from Qdrant
   - Detects existing collection with data
   - Skips files whose hash matches (already indexed in previous run)
   - Embeds only remaining files

4. **Graceful cancellation**: `codebase_stop` sets a cancellation flag checked between batches:
   ```typescript
   // indexer.ts:792-806
   if (isCancellationRequested(resolvedPath)) { ... return { cancelled: true }; }
   ```

5. **Auto-resume on server restart**: `startup.ts:37-150` -- if the server starts and finds an incomplete index (`indexingStatus === "in-progress"`), it automatically resumes via `indexProject()`.

6. **Process crash recovery**: Since hashes are persisted after each batch, a crash loses at most 1 batch worth of work (50 files). The lock file becomes stale after 2 minutes and is automatically reclaimed.

### 11. Configuration

**Environment Variables:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `EMBEDDING_PROVIDER` | `ollama` | Embedding backend: `ollama`, `openai`, `google` |
| `EMBEDDING_MODEL` | (per provider) | Model name: `nomic-embed-text`, `text-embedding-3-small`, `gemini-embedding-001` |
| `EMBEDDING_DIMENSIONS` | (per provider) | Vector dimensions: 768, 1536, 3072 |
| `EMBEDDING_CONTEXT_LENGTH` | (auto-detected) | Override context window in tokens |
| `OLLAMA_MODE` | `auto` | `auto`, `docker`, `external` |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API URL |
| `OLLAMA_API_KEY` | (none) | Optional API key for authenticated Ollama proxies |
| `OPENAI_API_KEY` | (none) | Required for OpenAI provider |
| `GOOGLE_API_KEY` | (none) | Required for Google provider |
| `QDRANT_HOST` | `localhost` | Qdrant server host |
| `QDRANT_PORT` | `16333` | Qdrant REST port |
| `QDRANT_URL` | (none) | Full URL for remote Qdrant (overrides host+port) |
| `QDRANT_API_KEY` | (none) | Qdrant authentication |
| `QDRANT_MODE` | `managed` | `managed` (Docker) or `external` (user-provided) |
| `SEARCH_DEFAULT_LIMIT` | `10` | Default search result count (1-50) |
| `SEARCH_MIN_SCORE` | `0.10` | Minimum RRF score threshold |
| `MAX_FILE_SIZE_MB` | `5` | Skip files larger than this |
| `EXTRA_EXTENSIONS` | (none) | Additional file extensions to index (comma-separated) |
| `INCLUDE_DOT_FILES` | `false` | Include dot-files in glob scan |
| `RESPECT_GITIGNORE` | `true` | Whether to honor .gitignore rules |
| `SOCRATICODE_PROJECT_ID` | (none) | Override project ID (e.g., for git worktrees sharing an index) |

**Per-tool parameters** (passed via MCP tool calls):
- `extraExtensions`: Additional file extensions for this specific operation
- `limit`, `minScore`, `fileFilter`, `languageFilter`: Search refinement

**Project-level config files:**
- `.socraticodeignore`: Additional ignore patterns (gitignore syntax)
- `.socraticodecontextartifacts.json`: Define non-code artifacts (schemas, API specs, etc.)

## Architecture / Flow

### Full Indexing Flow

```
MCP Tool Call: codebase_index
        |
        v
  index-tools.ts --> ensureInfrastructure() --> Docker/Ollama/Qdrant ready
        |
        | fire-and-forget (returns immediately)
        v
  indexProject()
        |
        +-- acquireProjectLock("index")
        +-- getProjectHashes() -----------------> Qdrant metadata collection
        +-- getCollectionInfo() -----------------> check existing data
        +-- ensureCollection()
        |
        +-- Phase 1: SCAN
        |   +-- glob("**/*") --> isIndexableFile() --> shouldIgnore()
        |   +-- Read file content (50 files parallel)
        |   +-- hashContent() --> compare with stored hash
        |   +-- chunkFileContent() for changed files
        |           +-- [minified?] --> chunkByCharacters()
        |           +-- [small?] --> single chunk
        |           +-- [AST grammar?] --> findAstBoundaries() --> chunkByAstRegions()
        |           +-- [fallback] --> chunkByLines()
        |
        +-- Phase 2: CLEAN (if re-index)
        |   +-- deleteFileChunks() for changed files
        |   +-- deleteFileChunks() for deleted files
        |
        +-- Phase 3: EMBED + STORE (batches of 50 files)
        |   +-- prepareDocumentText() --> "search_document: {path}\n{content}"
        |   +-- generateEmbeddings() --> provider.embed() (sub-batches of 32)
        |   |       +-- withRetry() (3x, exponential backoff)
        |   +-- upsertPreEmbeddedChunks() --> Qdrant (sub-batches of 100)
        |   |       +-- per-point fallback on batch failure
        |   +-- saveProjectMetadata("in-progress") --> CHECKPOINT
        |
        +-- Phase 4: FINALIZE
        |   +-- saveProjectMetadata("completed")
        |
        +-- Phase 5: CODE GRAPH (non-fatal)
        |   +-- rebuildGraph() --> ast-grep import extraction --> Qdrant
        |
        +-- Phase 6: CONTEXT ARTIFACTS (non-fatal)
        |   +-- ensureArtifactsIndexed() --> chunk + embed --> Qdrant
        |
        +-- releaseProjectLock("index")
```

### Watcher Flow

```
startWatching()
    |
    +-- acquireProjectLock("watch")
    +-- createIgnoreFilter()
    +-- @parcel/watcher.subscribe(projectPath, callback, { ignore: dirs })
    |
    |  +- On file change events ----------------------------------------+
    |  | Filter: isIndexableFile() + shouldIgnore()                      |
    |  | Debounce: 2000ms                                                |
    |  |                                                                 |
    |  | invalidateGraphCache()                                          |
    |  | updateProjectIndex() --> incremental embed+upsert               |
    |  |                                                                 |
    |  | On error: log, back off 30s for infra issues                    |
    |  | Circuit breaker: stop after 10 consecutive errors               |
    |  +------------------------------------------------------------------+
    |
stopWatching()
    +-- subscription.unsubscribe()
    +-- releaseProjectLock("watch")
```

### Search Flow

```
codebase_search(query)
    |
    +-- generateQueryEmbedding("search_query: " + query)
    |
    +-- Qdrant hybrid query:
    |   prefetch:
    |     +-- dense: cosine similarity on embedding vector
    |     +-- bm25: server-side BM25 on stored text (Qdrant v1.15.2+)
    |   fusion: RRF (Reciprocal Rank Fusion)
    |
    +-- Filter: minScore, fileFilter, languageFilter
```

## File Map

| File | Role |
|------|------|
| `src/index.ts` | MCP server entry point, tool registration (17 tools), graceful shutdown |
| `src/config.ts` | Project ID generation (SHA-256 of path), collection name derivation |
| `src/constants.ts` | All configuration constants, supported extensions, chunk sizes |
| `src/types.ts` | Core type definitions: FileChunk, CodeGraph, SearchResult |
| `src/services/indexer.ts` | **Core indexing engine**: file scanning, chunking, embedding, upsert, progress tracking, cancellation |
| `src/services/watcher.ts` | File system watching via @parcel/watcher, debounced updates |
| `src/services/ignore.ts` | 3-layer ignore system: defaults + .gitignore + .socraticodeignore |
| `src/services/embeddings.ts` | Embedding generation with batching (32/batch) and retry logic |
| `src/services/embedding-config.ts` | Provider configuration from env vars (ollama/openai/google) |
| `src/services/embedding-provider.ts` | Provider factory (lazy loading of provider implementations) |
| `src/services/embedding-types.ts` | Shared EmbeddingProvider interface |
| `src/services/provider-ollama.ts` | Ollama embedding provider (Docker or external) |
| `src/services/provider-openai.ts` | OpenAI embedding provider |
| `src/services/provider-google.ts` | Google AI embedding provider |
| `src/services/qdrant.ts` | Qdrant client wrapper: CRUD, search (hybrid dense+BM25), metadata persistence |
| `src/services/code-graph.ts` | Code dependency graph: AST parsing, import extraction, graph caching |
| `src/services/graph-imports.ts` | Import statement extraction for 15+ languages via ast-grep |
| `src/services/graph-resolution.ts` | Module specifier resolution to project files (per-language) |
| `src/services/graph-aliases.ts` | Path alias resolution from tsconfig.json/jsconfig.json |
| `src/services/graph-analysis.ts` | Graph analysis: circular deps, stats, Mermaid diagrams |
| `src/services/context-artifacts.ts` | Non-code artifact indexing (.socraticodecontextartifacts.json) |
| `src/services/lock.ts` | Cross-process file locking via proper-lockfile |
| `src/services/startup.ts` | Auto-resume on server start, graceful shutdown orchestration |
| `src/services/docker.ts` | Docker/Qdrant container management |
| `src/services/ollama.ts` | Ollama container/model management |
| `src/services/logger.ts` | Pino-based logging with MCP log forwarding |
| `src/tools/index-tools.ts` | MCP tool handlers: codebase_index, update, remove, stop, watch |
| `src/tools/query-tools.ts` | MCP tool handlers: codebase_search, codebase_status |
| `src/tools/graph-tools.ts` | MCP tool handlers: graph build/query/stats/circular/visualize |
| `src/tools/context-tools.ts` | MCP tool handlers: context list/search/index/remove |
| `src/tools/manage-tools.ts` | MCP tool handlers: health check, list projects, about |

## Code Excerpts

### Chunking Strategy Selection (`indexer.ts:410-455`)

```typescript
export function chunkFileContent(filePath, relativePath, content): FileChunk[] {
  const lines = content.split("\n");
  const ext = path.extname(filePath).toLowerCase();
  const language = getLanguageFromExtension(ext);

  // Minified detection: character-based chunking
  const avgLineLength = lines.length > 0 ? content.length / lines.length : 0;
  if (avgLineLength > MAX_AVG_LINE_LENGTH) {
    return applyCharCap(chunkByCharacters(filePath, relativePath, content, language));
  }

  // Small files: single chunk
  if (lines.length <= CHUNK_SIZE) {
    return applyCharCap([{ id: chunkId(relativePath, 1), ... }]);
  }

  // AST-aware chunking for supported languages
  const astLang = getAstGrepLang(ext);
  const regions = astLang ? findAstBoundaries(content, astLang) : [];
  if (regions.length > 0) {
    return applyCharCap(chunkByAstRegions(filePath, relativePath, lines, language, regions));
  }

  // Fallback: line-based chunking
  return applyCharCap(chunkByLines(filePath, relativePath, lines, language));
}
```

### Batch Checkpoint Loop (`indexer.ts:791-882`)

```typescript
for (let batchIdx = 0; batchIdx < chunkedFiles.length; batchIdx += INDEX_BATCH_SIZE) {
  // Cancellation check
  if (isCancellationRequested(resolvedPath)) {
    return { filesIndexed: ..., chunksCreated: ..., cancelled: true };
  }

  const fileBatch = chunkedFiles.slice(batchIdx, batchIdx + INDEX_BATCH_SIZE);
  // ... collect chunks, generate embeddings, upsert ...

  // Checkpoint: persist hashes so progress survives crashes
  await saveProjectMetadata(collection, resolvedPath, files.length, hashes.size, hashes, "in-progress");
}
```

### Qdrant Hybrid Search (`qdrant.ts:305-355`)

```typescript
const results = await qdrant.query(collectionName, {
  prefetch: [
    { query: queryVector, using: "dense", limit: prefetchLimit, filter },
    { query: { text: query, model: "qdrant/bm25" }, using: "bm25", limit: prefetchLimit, filter },
  ],
  query: { fusion: "rrf" },
  limit,
  with_payload: true,
});
```

## Numerical Constants Summary

| Constant | Value | Location |
|----------|-------|----------|
| `FILE_SCAN_BATCH` | 50 files | `indexer.ts:40` |
| `INDEX_BATCH_SIZE` | 50 files | `constants.ts:70` |
| `CHUNK_SIZE` | 100 lines | `constants.ts:68` |
| `CHUNK_OVERLAP` | 10 lines | `constants.ts:69` |
| `MAX_CHUNK_CHARS` | 2000 chars | `constants.ts:102` |
| `MAX_FILE_BYTES` | 5 MB | `constants.ts:74-76` |
| `MAX_GRAPH_FILE_BYTES` | 1 MB | `constants.ts:81` |
| `MAX_AVG_LINE_LENGTH` | 500 chars | `constants.ts:89` |
| `MIN_CHUNK_LINES` | 5 lines | `indexer.ts:268` |
| `MAX_CHUNK_LINES` | 150 lines | `indexer.ts:270` |
| `BATCH_SIZE` (embeddings) | 32 texts | `embeddings.ts:8` |
| `MAX_RETRIES` (embeddings) | 3 | `embeddings.ts:9` |
| `DEBOUNCE_MS` (watcher) | 2000 ms | `watcher.ts:21` |
| `MAX_WATCHER_ERRORS` | 10 | `watcher.ts:24` |
| `STALE_MS` (lock) | 120000 ms (2 min) | `lock.ts:30` |
| `MAX_BM25_TEXT_CHARS` | 32000 chars | `qdrant.ts:217` |
| Qdrant upsert batch | 100 points | `qdrant.ts:251` |

## Open Questions

1. **No parallel embedding across file batches**: Each batch of 50 files is processed sequentially (embed -> upsert -> checkpoint). There is no pipelining where batch N+1 starts embedding while batch N is upserting. This is intentional for checkpoint consistency but could be a performance bottleneck on large codebases.

2. **Hash map persistence scalability**: The entire file hash map is serialized as a single JSON blob and stored as a Qdrant payload on every checkpoint. For projects with 100K+ files, this could become a significant payload size (each entry is ~80 bytes: 50-char path + 16-char hash + JSON overhead, so ~8MB for 100K files).

3. **No content-addressable deduplication**: If the same file content exists at two different paths, it gets indexed twice with separate chunks and embeddings. There is no dedup at the content level.

4. **Watcher does not track which specific files changed**: When the debounce timer fires, it calls `updateProjectIndex()` which re-scans ALL files. The watcher events are used only as a trigger signal, not to narrow the scope of the update. This is a deliberate simplicity-over-performance trade-off.

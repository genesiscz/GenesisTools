# SocratiCode vs GenesisTools Indexer -- Final Comparison (Post v3 Overhaul)

> Authored on 2026-03-22 | Covers GT indexer after Plans 1-4 implementation, with forward-looking columns for Plans 5-7

## 1. Executive Summary

After Plans 1-4, the GenesisTools indexer has closed the majority of the feature gap with SocratiCode. The overhaul added: Ollama embedding provider with native batch support (`embedBatch`), model-aware context-length truncation via a 12-model registry, task prefixes for asymmetric retrieval, AST chunking for 16 languages (matching SC), chunk overlap and character cap, minified file detection, native file watching via `@parcel/watcher`, cross-process locking via `proper-lockfile`, graceful cancellation with cross-process stop signals, indexing status persistence (`in-progress`/`completed`/`cancelled`/`error`), a full code dependency graph with AST-based import extraction for 11 languages, a Qdrant vector store backend with server-side hybrid RRF search, sqlite-vec for ANN vector search, and RRF overfetch (3x candidates). What GT still does not have: Docker container lifecycle management, Qdrant BM25 sparse vector indexing at index time (only at search time via `searchHybridAsync`), context artifacts, auto-resume on server restart, a Google embedding provider, and SC's plugin/skill/agent ecosystem for Claude Code. Plans 5-7 address safety/correctness fixes, full AST-based import extraction for all 11+ languages, and code quality improvements (FakeEmbedder, better types) but do not close the remaining SC-unique features.

---

## 2. Feature-by-Feature Comparison Table

| Feature | SocratiCode | GT Before v3 | GT After v3 (Plans 1-4) | GT After Plans 5-7 | Verdict |
|---------|-------------|--------------|-------------------------|---------------------|---------|
| **EMBEDDING** | | | | | |
| Providers | Ollama, OpenAI, Google | DarwinKit, local-HF, OpenAI | + Ollama, CoreML | Same | **GT wins** (5 providers vs 3) |
| Batch embedding | 32 texts/batch via provider | Sequential (1 at a time) | `embedBatch()` native on Ollama, fallback sequential | Same | **Parity** |
| Retry with backoff | 3x exponential, 429-aware (15s min) | Basic warmup retry | 3x via `rateLimitAwareDelay()`, skips permanent (401/403/404) | Same | **Parity** |
| Model selection | 3 models (1 per provider), env vars | 8 models via `model-registry.ts` | 12 models incl. 3 Ollama models, per-index config | Same | **GT wins** (richer registry, per-index) |
| Context-length truncation | Per-provider hardcoded (2048/8191/2048 tokens) | Hardcoded 500 chars | Per-model via `getMaxEmbedChars()`, chars-per-token ratio | Same | **GT wins** (per-model, configurable) |
| Task prefixes | `search_document:`/`search_query:` for nomic only | None | Per-model `taskPrefix` in registry (nomic-embed-text, jina-v3, nomic-embed-code) | Same | **GT wins** (model-aware, not hardcoded) |
| GPU acceleration | Ollama (Metal/CUDA via Docker) | DarwinKit (Neural Engine) | + Ollama (Metal/CUDA native), CoreML (Neural Engine) | Same | **GT wins** (more GPU paths) |
| Rate limiting | Per-provider delay (Google 15s) | None | `rateLimitAwareDelay()` in retry util | Same | **Parity** |
| Batch-to-individual fallback | N/A (batch always works via provider) | N/A | Yes -- batch failure falls back to per-item embed (`indexer.ts:539-567`) | Same | **GT wins** |
| **CHUNKING** | | | | | |
| AST languages | 16 (5 built-in + 11 dynamic + 2 regex) | 4 (TS/JS/HTML/CSS) | 16 (5 built-in + 11 dynamic via `@ast-grep/lang-*`) | Same | **Parity** |
| Chunk overlap | 10 lines fixed | None | Configurable via `overlap` param (default 0, used in sub-chunking) | Same | **Parity** (SC fixed, GT configurable) |
| Character cap | 2000 chars (truncation) | None | 2000 chars via `applyCharCap()` -- re-splits into sub-chunks, no data loss | Same | **GT wins** (re-splits vs truncates) |
| Minified detection | avg line > 500 -> char-based | None | avg line > 500 -> `chunkByCharacter()` with safe boundary splitting | Same | **Parity** |
| Merge small chunks | < 5 lines merged with neighbors | None | `mergeSmallChunks()` with token + char limit guards | Same | **Parity** |
| Sub-chunk large decls | > 150 lines sub-chunked with overlap | None | `subChunkLargeNode()` > 150 lines, header preservation (2 lines) | Same | **Parity** |
| Content types | Code only | Code + markdown + email + JSON + chat | Same (6 strategies: ast, line, heading, message, json, character) | Same | **GT wins** (multi-source) |
| Parent-child chunks | None | class -> method via parentChunkId | Same | Same | **GT wins** |
| Deduplication | Merge-based (small nodes) | Containment check (export wrapping function) | Both: containment dedup + merge small | Same | **GT wins** |
| **VECTOR SEARCH** | | | | | |
| Algorithm | HNSW (Qdrant server) | O(n) brute-force scan | sqlite-vec `vec0` ANN (cosine) + optional Qdrant HNSW | Same | **Parity** (both have ANN) |
| Backend options | Qdrant only | SQLite BLOB only | sqlite-vec (default) / sqlite-brute (fallback) / Qdrant | Same | **GT wins** (3 backends) |
| ANN scalability | Millions of vectors | ~10K before slow | sqlite-vec: ~100K; Qdrant: millions | Same | **SC edge** for very large codebases |
| Zero-infra | No (Docker required) | Yes (single .db file) | Yes (sqlite-vec default) + optional Qdrant | Same | **GT wins** |
| **FTS / BM25** | | | | | |
| Implementation | Qdrant built-in `qdrant/bm25` sparse vectors | SQLite FTS5 | SQLite FTS5 (unchanged) | Same | **Different** -- both excellent |
| Tokenizer config | Qdrant default (no customization) | FTS5 default (configurable tokenizer param) | Same -- configurable tokenizer | Same | **GT edge** (configurable) |
| Field boosting | None | BM25 weight per field | Same (`bm25(table, w1, w2, ...)`) | Same | **GT wins** |
| Standalone mode | No (always hybrid) | Yes (fulltext-only search) | Same | Same | **GT wins** |
| **HYBRID SEARCH** | | | | | |
| RRF implementation | Server-side in Qdrant | Client-side RRF | Client-side RRF (default) + Qdrant server-side via `searchHybridAsync()` | Same | **GT wins** (both paths available) |
| Overfetch | `max(limit*3, 30)` | Fixed limit | `max(limit*3, 30)` matching SC exactly (`rrfHybridSearch`) | Same | **Parity** |
| Configurable weights | No (equal weighting) | Yes (`hybridWeights: {text, vector}`) | Same | Same | **GT wins** |
| Min score threshold | 0.10 default (env configurable) | None | Per-mode normalized `normalizeMinScore()` | Same | **Parity** |
| **CHANGE DETECTION** | | | | | |
| Hash algorithm | SHA-256 truncated to 16 hex | xxHash64 via `Bun.hash()` | Same (xxHash64) | Same | **GT wins** (faster) |
| Hash storage | JSON blob in Qdrant metadata point | SQLite `path_hashes` table | Same (SQLite table) | Same | **GT wins** (instant lookup, no serialize) |
| Crash recovery checkpoint | After every 50-file batch | Every 10 batches + per-batch hash upsert | Per-batch hash upsert + every 10 batches meta update | Same | **Parity** |
| **FILE WATCHING** | | | | | |
| Native watcher | `@parcel/watcher` (FSEvents/inotify) | `setInterval` polling | `@parcel/watcher` (native) with polling fallback | Same | **Parity** |
| Debounce | 2000ms | N/A (polling interval) | 2000ms default, configurable via `debounceMs` | Same | **Parity** |
| Circuit breaker | 10 consecutive errors -> stop | None | 10 consecutive errors -> unsubscribe | Same | **Parity** |
| Infrastructure back-off | 30s pause on Qdrant ECONNREFUSED | None | None (error counted toward circuit breaker) | Same | **SC edge** (infra awareness) |
| Auto-start after index | Yes | No | Strategy-configurable (`native` / `polling`) | Same | **SC edge** (automatic) |
| **LOCKING** | | | | | |
| Cross-process lock | `proper-lockfile` with operation type (index/watch) | PID file advisory | `proper-lockfile` with stale detection, PID tracking | Plan 5: fix onCompromised, resolve paths | **Parity** (Plan 5 reaches SC parity) |
| Stale detection | 2 min stale, 30s refresh | None | 2 min stale, 30s refresh (matching SC) | Same | **Parity** |
| Lock holder PID | Not exposed | Written but not queryable | `getLockHolderPid()` with process-alive check | Same | **GT wins** |
| **CODE GRAPH** | | | | | |
| Import extraction languages | 15+ (AST-grep + regex for Dart, Lua) | None | 11 (TS/JS/TSX + Python, Go, Java, Rust, C/C++, Ruby, Swift, PHP) | Plan 6: all AST-based (no regex) | **SC edge** (Dart, Lua, Kotlin, Scala, C#, Bash via regex) |
| Resolution (relative) | Extensionless, directory index, SCSS partials | None | Extensionless + directory index + language-specific | Plan 6: improved | **Parity** |
| Resolution (path aliases) | tsconfig.json `paths` with `extends` chain | None | None | Not planned | **SC wins** |
| Graph persistence | JSON blob in Qdrant metadata | None | In-memory (returned by `buildCodeGraph()`) | Same | **SC wins** (persisted) |
| Mermaid visualization | Yes (color-coded, circular deps highlighted) | None | Yes (`toMermaidDiagram()` with dynamic import, top-N nodes) | Same | **Parity** |
| Circular dependency detection | Yes (dedicated tool) | None | None | Not planned | **SC wins** |
| Graph statistics | Yes (dedicated tool) | None | `getGraphStats()` (totalNodes, totalEdges, avg, max, orphans) | Same | **Parity** |
| Incremental graph update | No (full rebuild) | N/A | No (full rebuild) | Same | **Parity** (neither has it) |
| **SOURCE TYPES** | | | | | |
| Code files | Yes | Yes | Yes | Same | Parity |
| macOS Mail | None | Yes (MailSource) | Same | Same | **GT wins** |
| Telegram chat | None | Yes (TelegramSource) | Same | Same | **GT wins** |
| Context artifacts | Yes (`.socraticodecontextartifacts.json`) | None | None | Not planned | **SC wins** |
| Pluggable source interface | None (hardcoded file scanning) | `IndexerSource` interface | Same | Same | **GT wins** |
| **CONFIGURATION** | | | | | |
| Per-index config | No (global env vars only) | Yes (`IndexConfig` per index) | Same + more options (vectorDriver, qdrant, watch strategy) | Same | **GT wins** |
| Chunk size | Fixed (100 lines) | Configurable (`chunkMaxTokens`) | Same | Same | **GT wins** |
| Ignore patterns | `.socraticodeignore` + `.gitignore` + defaults | `.gitignore` + `ignoredPaths` array | Same | Same | **SC edge** (dedicated ignore file) |
| Search tuning | `SEARCH_MIN_SCORE` env var | None | `search.minScore` + `search.hybridWeights` in IndexConfig | Same | **GT wins** |
| **MCP INTEGRATION** | | | | | |
| MCP server | Yes (21 tools, 5 categories) | None | None | Not planned | **SC wins** |
| Claude Code plugin | Yes (skills, agents, hooks) | None | None | Not planned | **SC wins** |
| **CANCELLATION** | | | | | |
| Graceful cancel | Between batches, flag-based | None | Between batches + cross-process `stop.signal` file | Same | **GT wins** (cross-process signal) |
| Checkpoint on cancel | Yes (in-progress status) | N/A | Yes -- progress already in DB, status set to `cancelled` | Same | **Parity** |
| **STATUS PERSISTENCE** | | | | | |
| Indexing status | `in-progress` / `completed` in Qdrant | None | `idle` / `in-progress` / `completed` / `cancelled` / `error` in `IndexMeta` | Same | **GT wins** (richer states) |
| Auto-resume on restart | Yes (startup.ts checks status, resumes) | None | None | Not planned | **SC wins** |
| **ARCHITECTURE** | | | | | |
| Core pattern | Function-based with module-level singletons | Class-based with interfaces and DI | Same (clean `Indexer` class + `IndexerSource` interface) | Same | **GT wins** (cleaner) |
| Events | None (callback + module Maps) | `IndexerEventEmitter` with typed events | Same (22+ event types across sync/scan/chunk/embed/watch) | Same | **GT wins** |
| Multi-index | None (one project per MCP instance) | `IndexerManager` with named indexes | Same | Same | **GT wins** |
| **TESTING** | | | | | |
| Unit tests | 20 files (Vitest) | None before v3 | Test files for lock, watcher, RRF, min-score, cancellation | Plan 7: FakeEmbedder, more tests | **SC still ahead** |
| Integration tests | 8 files (Docker-based) | None | Store-embedder test | Plan 7: cross-platform via FakeEmbedder | **SC still ahead** |
| E2E tests | 1 file | None | None | Not planned | **SC wins** |

---

## 3. Where GT Now Shines Over SC

### 3.1 Five Embedding Providers vs Three

GT supports DarwinKit (macOS Neural Engine), CoreML (contextual BERT on macOS 14+), local-HF (Transformers.js), OpenAI, and Ollama. SC supports only Ollama, OpenAI, and Google. GT's DarwinKit and CoreML providers are zero-download, zero-configuration options that work offline on any Mac.

### 3.2 Zero-Infrastructure Default

GT works out of the box with a single `.db` file per index. No Docker, no Qdrant, no Ollama server needed. The `sqlite-vec` extension provides ANN search without any external service. SC requires Docker + Qdrant (and optionally Docker + Ollama) just to start.

### 3.3 Multi-Backend Architecture

GT offers three vector backends (`sqlite-vec`, `sqlite-brute`, `qdrant`) selectable per-index via `IndexConfig.storage.vectorDriver`. SC is locked to Qdrant. GT can be deployed in environments where Docker is not available (CI pipelines, embedded devices, sandboxed environments) without any feature loss.

### 3.4 Rich Model Registry (12 Models)

`model-registry.ts` catalogs 12 models with metadata: context length, chars-per-token ratio, task prefixes, RAM requirements, speed rating, license, best-for categories, and install commands. SC hardcodes 3 models in `embedding-config.ts` without any recommendation system.

### 3.5 Multi-Source Indexing

GT indexes code files, macOS Mail (via envelope index + emlx extraction), and Telegram chat history through a pluggable `IndexerSource` interface. SC only indexes code files (plus context artifacts for non-code docs, but those are manually configured).

### 3.6 Six Chunking Strategies

GT has AST, line, heading (markdown), message (email/chat), JSON (array/object-aware), and character-based strategies with an auto-selector. SC has three: AST, line, character. GT's heading strategy is significantly better than SC's line-based fallback for markdown documentation. GT's JSON strategy splits on object keys and array elements, preserving semantic structure.

### 3.7 Per-Index Configuration

Every parameter (chunk size, embedding model/provider, vector backend, search tuning, watch strategy/interval) is configurable per index. SC uses global environment variables and hardcoded constants, meaning all projects share the same configuration.

### 3.8 Hybrid Search Weights

GT's `hybridWeights: { text: number; vector: number }` lets callers tune the BM25-vs-cosine balance per search. SC's RRF fusion has no weight parameter -- both sub-queries contribute equally.

### 3.9 BM25 Field Boosting

GT supports `bm25(table, w1, w2, ...)` with per-field weights. SC's Qdrant BM25 offers no field-level weight configuration.

### 3.10 Cross-Process Cancellation

GT uses a `stop.signal` file that any process can create to request cancellation of a running sync. SC's cancellation is in-process only (`requestCancellation` flag in memory).

### 3.11 Richer Indexing Status

GT persists five states: `idle`, `in-progress`, `completed`, `cancelled`, `error`. SC has two: `in-progress`, `completed`.

### 3.12 Batch-to-Individual Fallback

When `embedBatch()` fails, GT falls back to individual `embed()` calls per text, isolating the failing chunk while preserving the rest of the batch (`indexer.ts:539-567`). SC's Qdrant upsert has per-point fallback, but embedding failures abort the entire batch.

### 3.13 Character Cap Re-Splits

GT's `applyCharCap()` re-splits oversized chunks into multiple sub-chunks via `chunkByCharacter()`, preserving all content. SC's `applyCharCap()` truncates, discarding content beyond 2000 chars.

---

## 4. Where SC Still Shines Over GT

### 4.1 MCP Server (21 Tools)

SC is a fully functional MCP server with 21 tools across 5 categories (indexing, query, graph, context, management). GT is a CLI tool with no MCP integration. Any AI assistant (Claude, Cline, Cursor) can use SC's tools directly.

### 4.2 Claude Code Plugin Ecosystem

SC ships with a `.claude-plugin/` directory containing skills (`codebase-exploration`, `codebase-management`), agents (`codebase-explorer.md`), and hooks (`hooks.json` for duplicate MCP detection). This teaches Claude Code how to use the tools effectively.

### 4.3 Context Artifacts

SC's `.socraticodecontextartifacts.json` lets users define non-code project knowledge (DB schemas, API specs, infrastructure config) that gets chunked, embedded, and searched alongside code. Includes automatic staleness detection via content hashing. GT has no equivalent.

### 4.4 Auto-Resume on Restart

SC's `startup.ts` checks for `indexingStatus === "in-progress"` on server start and automatically resumes interrupted indexing. GT persists the status but does not act on it -- the user must manually re-run sync.

### 4.5 Docker Container Lifecycle

SC manages Docker containers for both Qdrant and Ollama: pull images, start/stop containers, health checks, volume management. GT expects the user to manage external services manually.

### 4.6 Circular Dependency Detection

SC has a dedicated `codebase_graph_circular` tool that finds and reports circular import chains. GT's graph has stats and Mermaid visualization but no circular dependency analysis.

### 4.7 Path Alias Resolution

SC resolves TypeScript/JavaScript path aliases by reading `tsconfig.json`/`jsconfig.json` `compilerOptions.paths` with `extends` chain following. GT's import resolution does not handle path aliases.

### 4.8 Graph Persistence

SC persists the code graph as a JSON blob in Qdrant metadata, surviving server restarts. GT's graph is in-memory only, computed on demand.

### 4.9 Comprehensive Test Suite

SC has 20 unit test files, 8 integration test files, and 1 E2E test file running on Vitest. GT's test coverage is growing (lock, watcher, RRF, min-score, cancellation tests) but is not yet comparable.

### 4.10 Infrastructure Back-Off

SC's watcher pauses for 30 seconds when Qdrant is unreachable (ECONNREFUSED, fetch timeout). GT's watcher counts all errors toward the circuit breaker equally, without distinguishing transient infrastructure failures from permanent errors.

### 4.11 Google Embedding Provider

SC supports Google's `gemini-embedding-001` (3072 dimensions, free tier with 5 RPM). GT does not have a Google provider.

---

## 5. Remaining Gaps (After Plans 5-7)

Even after all 7 plans are fully implemented, these gaps will remain:

| Gap | Impact | Effort to Close |
|-----|--------|-----------------|
| No MCP server | High -- AI assistants can't use GT indexer directly | High (new MCP entry point, tool registration) |
| No context artifacts | Medium -- non-code docs must be indexed as regular files | Medium (new config format, separate collection) |
| No auto-resume | Medium -- manual re-run after crash | Low (check status on `IndexerManager.load()`) |
| No Docker lifecycle | Low -- Qdrant/Ollama must be user-managed | Medium (docker.ts equivalent) |
| No Google embedding provider | Low -- Ollama + OpenAI + DarwinKit cover most cases | Low (HTTP POST to Gemini API) |
| No circular dependency detection | Low -- graph exists, analysis missing | Low (DFS cycle detection on edges) |
| No path alias resolution | Medium -- `@app/*` imports unresolved in graph | Medium (tsconfig.json parser + resolution) |
| No graph persistence | Low -- fast to rebuild, but lost on restart | Low (serialize to SQLite or JSON file) |
| No auto-watcher start | Low -- user must call `startWatch()` | Low (hook into sync completion) |
| Fewer test files than SC | Medium -- harder to refactor safely | Ongoing (Plan 7 starts this) |
| No per-project ignore file | Low -- `ignoredPaths` in config works | Low (read `.genesistoolsignore` or similar) |

---

## 6. Unique GT Features SC Doesn't Have

These are GT-exclusive capabilities with no SC equivalent:

1. **macOS Mail indexing** -- Index and search Apple Mail via MailSource, with emlx body extraction and message-aware chunking.

2. **Telegram chat indexing** -- Index Telegram history from local SQLite database with message-aware chunking.

3. **Pluggable source interface** -- `IndexerSource` interface allows adding new data sources without modifying the indexer core. SC's file scanning is hardcoded.

4. **DarwinKit + CoreML providers** -- Zero-download, zero-configuration embedding on macOS using NaturalLanguage.framework and contextual BERT on Neural Engine.

5. **JSON-aware chunking** -- Splits JSON arrays by element and objects by key, preserving semantic structure. SC falls through to line-based chunking for JSON.

6. **Markdown heading-based chunking** -- Splits on `#{1-6}` headers with per-section sub-chunking. SC uses line-based chunking for markdown.

7. **Parent-child chunk relationships** -- `parentChunkId` links method chunks to their containing class chunk, enabling navigation from search results up to the enclosing context.

8. **Chunk deduplication** -- Removes chunks fully contained within another (e.g., a function_declaration inside its export_statement). SC merges small nodes but doesn't deduplicate overlapping AST extractions.

9. **Named multi-index management** -- `IndexerManager` maintains multiple named indexes with independent configurations, each stored in its own SQLite database. SC manages one collection per project path.

10. **No-embed mode** -- `--no-embed` creates FTS-only indexes (BM25 search without embeddings). Useful when embedding infrastructure is unavailable. SC requires embeddings for all indexed content.

11. **Reembed by source ID** -- `reembedBySourceIds()` re-embeds specific source entries without touching others. Useful when upgrading embedding models for a subset of content.

12. **Search query logging** -- `search_log` table records every search query with mode, result count, and duration for analytics.

13. **Consistency diagnostics** -- `getConsistencyInfo()` reports path hash count, content count, embedding count, unembedded count, DB size, and SQLite integrity check result.

14. **Cross-process stop signal** -- Any process can create `stop.signal` to cancel a running sync from outside the indexer process. SC's cancellation is in-process only.

---

## 7. Recommendations for Future Work

### Priority 1: MCP Server (Highest Impact)

Expose the indexer as an MCP server. This is the single highest-impact gap. An MCP layer would:
- Let Claude Code/Cline/Cursor use the indexer tools directly
- Enable the skills/agents pattern SC uses for guided exploration
- Make GT competitive as a Claude Code plugin

Implementation: Create `src/indexer/mcp-server.ts` registering tools like `index_search`, `index_sync`, `index_status`, `index_graph`, mirroring SC's tool categories.

### Priority 2: Auto-Resume

Check `indexingStatus` on `IndexerManager.load()`. If any index has `in-progress` status, offer to resume or clean up. This is a small change with outsized user experience impact.

### Priority 3: Context Artifacts

Implement a `.genesistoolscontext.json` (or reuse SC's format) for indexing non-code project knowledge alongside code. This fills the gap for DB schemas, API specs, and infrastructure docs.

### Priority 4: Path Alias Resolution

Read `tsconfig.json`/`jsconfig.json` `compilerOptions.paths` with `extends` chain following. Wire into `code-graph.ts` import resolution. SC's `graph-aliases.ts` is a good reference.

### Priority 5: Circular Dependency Detection

Add a `findCircularDependencies(graph: CodeGraph)` function using DFS with back-edge detection on the existing graph edges. Expose via CLI and (future) MCP.

### Priority 6: Google Embedding Provider

Add `AIGoogleProvider` for `gemini-embedding-001` (3072 dims, free tier). Simple HTTP POST to `https://generativelanguage.googleapis.com/v1/models/gemini-embedding-001:batchEmbedContents`. Add to model registry.

### Priority 7: Graph Persistence

Serialize `CodeGraph` to a JSON file in the index storage directory (or a SQLite table alongside the index DB). Load on startup to avoid full rebuild.

### Priority 8: Infrastructure-Aware Watcher

Distinguish transient infrastructure errors (ECONNREFUSED, DNS failure, timeout) from permanent errors in the watcher circuit breaker. Transient errors should trigger a back-off delay rather than incrementing the fatal error counter.

### Priority 9: Dedicated Ignore File

Support `.genesistoolsignore` (gitignore syntax) in project roots, layered on top of `.gitignore` + `ignoredPaths`. Gives users a project-level escape hatch without modifying the index config.

### Priority 10: Test Parity

Continue expanding test coverage. Plan 7's `FakeEmbedder` unblocks cross-platform testing. Target: unit tests for every service module (graph-imports, code-graph, chunker strategies, change-detector, search engine modes).

---

## File Map: GT Indexer v3

| File | Role |
|------|------|
| `src/indexer/lib/indexer.ts` | Core `Indexer` class: scan/chunk/embed/search orchestration, cancellation, events |
| `src/indexer/lib/chunker.ts` | 6 chunking strategies (AST/line/heading/message/JSON/character), 16 AST languages |
| `src/indexer/lib/code-graph.ts` | Dependency graph builder: 14 languages, resolution, Mermaid, stats |
| `src/indexer/lib/graph-imports.ts` | AST-based import extraction: 11 languages via ast-grep |
| `src/indexer/lib/model-registry.ts` | 12 embedding models with context lengths, task prefixes, metadata |
| `src/indexer/lib/types.ts` | `IndexConfig`, `ChunkRecord`, `IndexMeta` (with `indexingStatus`) |
| `src/indexer/lib/events.ts` | Typed event emitter: 22+ events across sync/scan/chunk/embed/watch |
| `src/indexer/lib/store.ts` | `IndexStore` interface + SQLite implementation |
| `src/indexer/lib/path-hashes.ts` | `PathHashStore`: flat SQLite table for change detection |
| `src/indexer/lib/manager.ts` | `IndexerManager`: multi-index lifecycle management |
| `src/indexer/lib/sources/source.ts` | `IndexerSource` interface for pluggable data sources |
| `src/indexer/lib/sources/file-source.ts` | File system source with git-ignore support |
| `src/indexer/lib/sources/mail-source.ts` | macOS Mail.app source (envelope index + emlx) |
| `src/utils/search/drivers/sqlite-fts5/index.ts` | `SearchEngine`: FTS5 BM25 + vector hybrid + RRF with overfetch |
| `src/utils/search/stores/sqlite-vec-store.ts` | sqlite-vec `vec0` virtual table: ANN cosine search |
| `src/utils/search/stores/sqlite-vector-store.ts` | Brute-force cosine search (fallback) |
| `src/utils/search/stores/qdrant-vector-store.ts` | Qdrant backend: dense + BM25 + server-side RRF |
| `src/utils/fs/watcher.ts` | `@parcel/watcher` wrapper: debounce, circuit breaker, filter |
| `src/utils/fs/change-detector.ts` | Agnostic change detection: `detectChanges()` with pluggable hash |
| `src/utils/fs/lock.ts` | `proper-lockfile` wrapper: stale detection, PID tracking |
| `src/utils/ai/tasks/Embedder.ts` | Embedding task: native batch, retry, fallback to sequential |
| `src/utils/ai/providers/AIOllamaProvider.ts` | Ollama HTTP client: batch embed, model pull, availability check |
| `src/utils/ai/providers/AIDarwinKitProvider.ts` | macOS NaturalLanguage.framework via Swift bridge |
| `src/utils/ai/providers/AICoreMLProvider.ts` | macOS CoreML contextual BERT embeddings |

# SocratiCode vs GenesisTools Indexer -- Post-Plans 1-7 Comparison

> Generated on 2026-03-22 | Scope: GT `src/indexer/`, `src/utils/search/`, `src/utils/ai/`; SC `.worktrees/SocratiCode/src/`

## Executive Summary

Plans 1-7 closed the majority of the gap between GenesisTools (GT) and SocratiCode (SC). The indexer now has batch embedding with native provider support, AST chunking for 17+ languages, a code dependency graph with 11-language import extraction, sqlite-vec ANN search, minified file detection, chunk overlap, character caps, task prefixes, model-aware truncation, native file watching, Ollama/CoreML providers, and cancellation support. What remains are primarily SC's **MCP server integration**, **context artifacts system**, **cross-process locking**, **auto-resume on crash**, and **Qdrant-native hybrid search with server-side RRF**.

---

## 1. Feature Matrix

| Feature | GenesisTools (current) | SocratiCode | Status |
|---------|----------------------|-------------|--------|
| **Chunking: AST languages** | 17 (TS/JS/TSX/HTML/CSS + Py/Go/Rust/Java/C/C++/Ruby/PHP/Swift/Kotlin/Scala/C#) | 16 + Svelte/Vue composite | DONE -- GT has parity plus `.mts/.cts` |
| **Chunking: line-based** | Yes, with token-based sizing + overlap | Yes, 100 lines + 10 overlap | DONE |
| **Chunking: character-based** | Yes, minified detection (avg line > 500) | Yes, identical threshold | DONE |
| **Chunking: markdown headings** | Yes | No | GT ahead |
| **Chunking: JSON** | Yes | No | GT ahead |
| **Chunking: email/chat** | Yes | No | GT ahead |
| **Chunk overlap** | Yes (configurable, default 0) | 10 lines fixed | DONE |
| **Chunk char cap** | 2000 chars, re-splits via character chunker | 2000 chars, hard truncation | DONE (GT preserves content) |
| **Merge small AST nodes** | Yes (< 5 lines) | Yes (< 5 lines) | DONE |
| **Sub-chunk large AST nodes** | Yes (> 150 lines, header preserved) | Yes (> 150 lines) | DONE |
| **Parent-child chunks** | Yes (class -> method) | No | GT ahead |
| **Chunk deduplication** | Yes (containment check) | No | GT ahead |
| **Embedding: batch** | Yes (EMBEDDING_BATCH_SIZE=32, native provider batch) | Yes (32/batch) | DONE |
| **Embedding: retry** | Yes (3 retries, rate-limit-aware delay) | Yes (3 retries, exponential backoff) | DONE |
| **Embedding: task prefixes** | Yes (per-model from registry) | Yes (nomic convention, all providers) | DONE |
| **Embedding: model-aware truncation** | Yes (per-model contextLength * charsPerToken) | Yes (per-provider) | DONE |
| **Embedding: fallback on batch failure** | Yes (sequential fallback, zero-vec on item failure) | Yes (per-point upsert fallback in Qdrant) | DONE |
| **Providers: DarwinKit** | Yes | No | GT ahead |
| **Providers: CoreML** | Yes (contextual + custom models) | No | GT ahead |
| **Providers: local-hf** | Yes (Transformers.js) | No | GT ahead |
| **Providers: Ollama** | Yes (native batch, model pull) | Yes | DONE |
| **Providers: OpenAI** | Yes (cloud provider) | Yes | DONE |
| **Providers: Google** | No | Yes (gemini-embedding-001) | GAP |
| **Model registry** | 12 models with metadata, context lengths, task prefixes | 3 models, env-var config | GT ahead |
| **Vector search: brute-force** | Yes (SQLite BLOB, fallback) | No | GT has more options |
| **Vector search: sqlite-vec** | Yes (vec0 virtual table, cosine) | No | DONE (Plan 3) |
| **Vector search: Qdrant** | Yes (adapter exists, hybrid search) | Yes (primary backend) | DONE (Plan 3) |
| **FTS: BM25** | SQLite FTS5, field-level boosting | Qdrant built-in BM25 | Both have it |
| **Hybrid search: RRF** | Client-side RRF with configurable weights | Server-side Qdrant RRF | Both have it |
| **Hybrid search: min score** | Yes (configurable, mode-normalized) | Yes (0.10 default) | DONE |
| **Hybrid search: over-fetch** | No | 3x prefetch limit | GAP |
| **Code graph: import extraction** | 11 languages (TS/JS/TSX/Py/Go/Java/Rust/C/C++/Ruby/Swift/PHP) | 15+ languages (adds Kotlin/Scala/C#/Bash/Dart/Lua/Svelte/Vue) | MOSTLY DONE (3 langs missing) |
| **Code graph: resolution** | TS/JS + Python + C/C++ + Rust + Java/Kotlin/Scala + PHP + Ruby | TS/JS + Python + C/C++ + Rust + SCSS + path aliases (tsconfig) | GT has more resolvers |
| **Code graph: Mermaid** | Yes (top-N, dynamic edge styles) | Yes (color-coded, circular highlighted, legend) | Both have it |
| **Code graph: stats** | Yes (nodes, edges, avg imports, max, orphans) | Yes (+ language breakdown, circular count) | Both -- SC slightly richer |
| **Code graph: circular detection** | No | Yes (DFS cycle finder) | GAP |
| **Code graph: path aliases** | Reserved (`baseDir` param unused) | Yes (tsconfig.json paths with extends) | GAP |
| **Code graph: persistence** | In-memory only (rebuilt per session) | JSON in Qdrant metadata, cached in-memory | GAP |
| **Code graph: visualization** | Mermaid text output | Mermaid + color-coded nodes + cycle highlighting + legend | SC richer |
| **Change detection** | PathHashStore (flat SQLite, xxHash64) | SHA-256 truncated, JSON blob in Qdrant | Both work, GT faster |
| **File watching: native** | Yes (@parcel/watcher via `createWatcher`) | Yes (@parcel/watcher) | DONE |
| **File watching: debounce** | Yes (configurable, default 2s) | 2s fixed | DONE |
| **File watching: error circuit breaker** | Yes (maxErrors: 10) | Yes (10 consecutive errors) | DONE |
| **Cancellation** | Yes (flag + cross-process stop.signal file) | Yes (flag checked between batches) | DONE |
| **Indexing status persistence** | Yes (indexingStatus in meta) | Yes (in-progress/completed in Qdrant) | DONE |
| **Source types** | Files, macOS Mail, Telegram | Code files only | GT ahead |
| **MCP server** | No | 21 tools, full MCP integration | GAP |
| **Context artifacts** | No | Yes (non-code docs, auto-staleness) | GAP |
| **Cross-process locking** | PID file advisory | proper-lockfile with operation types | GAP (partial) |
| **Auto-resume on crash** | No | Yes (startup.ts detects incomplete, resumes) | GAP |
| **Docker management** | No | Manages Qdrant + Ollama containers | N/A (GT is zero-infra) |
| **Background indexing** | No (blocks caller) | Yes (fire-and-forget, poll status) | GAP |
| **Event system** | Full typed EventEmitter + callbacks | Module-level Maps + logger | GT ahead |
| **Multi-index management** | Yes (IndexerManager) | No (one index per MCP instance) | GT ahead |
| **Per-index config** | Yes (chunking, model, watch, storage per index) | Global env vars + fixed constants | GT ahead |
| **Search query logging** | Yes (search_log table, analytics) | No | GT ahead |

---

## 2. Where GenesisTools Shines

### 2.1 Zero-Infrastructure Design
GT runs entirely embedded -- SQLite file, no Docker, no external services. This is a fundamental architectural advantage for developer tooling that should "just work" on any machine.

### 2.2 Multi-Source Architecture
GT's `IndexerSource` interface (`src/indexer/lib/sources/source.ts`) supports files, macOS Mail, and Telegram. SC only indexes code files. GT's pattern is extensible to any data source.

### 2.3 Richer Model Registry
12 models with detailed metadata: context lengths, chars-per-token estimates, task prefixes, best-for categories, install commands. SC has 3 models configured via env vars.

Key file: `src/indexer/lib/model-registry.ts`

### 2.4 Content/Embedding Decoupling
GT stores content and embeddings independently. FTS search works without embeddings. If embedding fails, content is still searchable via BM25. SC requires embeddings for every point -- embedding failure means the chunk isn't stored at all.

### 2.5 Per-Index Configuration
Each GT index can have its own chunking strategy, embedding model, watch settings, and storage backend. SC uses global env vars and fixed constants for all projects.

### 2.6 More Embedding Providers
GT has 5 provider types (DarwinKit, CoreML, local-HF, Ollama, Cloud/OpenAI). SC has 3 (Ollama, OpenAI, Google). DarwinKit and CoreML are unique -- zero-dependency on-device inference using macOS frameworks.

### 2.7 Richer Chunking Strategies
GT supports 6 strategies (AST, line, heading, message, JSON, character). SC has 3 (AST, line, character). Heading-based markdown chunking and JSON-aware splitting are valuable for non-code content.

### 2.8 Typed Event System
GT's `IndexerEventEmitter` (`src/indexer/lib/events.ts`) provides strongly-typed events for every pipeline phase -- scan, chunk, embed, sync, watch, search. SC uses module-level Maps and logger output.

### 2.9 Parent-Child Chunk Relationships
GT tracks class-to-method relationships via `parentChunkId`. This enables hierarchical result presentation and context-aware retrieval. SC does not maintain these relationships.

---

## 3. Where SocratiCode Shines

### 3.1 MCP Server Integration (21 Tools)
SC is a full MCP server with 21 tools organized in 5 categories. This is the single biggest differentiator -- it integrates directly with Claude, Cline, and other MCP hosts. GT is CLI-only.

Reference: `SocratiCode/src/index.ts` (tool registration), `SocratiCode/src/tools/*.ts`

### 3.2 Context Artifacts System
SC lets users define non-code project knowledge (DB schemas, API specs, configs) via `.socraticodecontextartifacts.json`. These are separately indexed, auto-refreshed on staleness, and searchable via `codebase_context_search`.

Reference: `SocratiCode/src/services/context-artifacts.ts`

### 3.3 Circular Dependency Detection
SC has a DFS-based cycle finder (`findCircularDependencies`) that identifies all circular imports. GT builds the graph but cannot detect cycles.

Reference: `SocratiCode/src/services/graph-analysis.ts:27-67`

### 3.4 Path Alias Resolution (tsconfig.json)
SC reads `tsconfig.json`/`jsconfig.json` `compilerOptions.paths` (with `extends` chain following) to resolve aliased imports. GT has a `baseDir` parameter reserved but unimplemented.

Reference: `SocratiCode/src/services/graph-aliases.ts`

### 3.5 Auto-Resume on Crash
SC persists `indexingStatus: "in-progress"` in Qdrant metadata. On MCP server restart, `startup.ts` detects incomplete indexes and automatically resumes from the last checkpoint. GT has the status field but no auto-resume logic.

Reference: `SocratiCode/src/services/startup.ts:37-150`

### 3.6 Background Indexing
`codebase_index` returns immediately and fires indexing in the background. The LLM polls `codebase_status` for progress. GT blocks the caller during sync.

### 3.7 Cross-Process Locking (proper-lockfile)
SC uses `proper-lockfile` with separate lock keys for `index` and `watch` operations, stale lock reclamation (2 min), and periodic refresh (30s). GT uses a PID file advisory lock.

Reference: `SocratiCode/src/services/lock.ts`

### 3.8 Server-Side Hybrid Search (Qdrant RRF)
SC's hybrid search runs entirely server-side in Qdrant with prefetch + RRF fusion and 3x over-fetching. GT does client-side RRF which is correct but less efficient for large indexes.

### 3.9 Richer Mermaid Visualization
SC generates color-coded Mermaid diagrams with language-specific node styling, circular dependency highlighting (red dotted lines), and an auto-generated legend subgraph. GT's Mermaid is simpler (no colors, no cycle highlighting).

Reference: `SocratiCode/src/services/graph-analysis.ts:113-210`

---

## 4. Gap Analysis -- What's Still Missing

### GAP 1: MCP Server Integration
**What:** Expose the indexer as an MCP server with tools for index/search/graph/status/watch.
**Why it matters:** This is the primary way AI assistants interact with code search. Without MCP, the indexer can only be used via CLI.
**Effort:** L (Large) -- requires MCP SDK integration, tool schema design, background task management.
**Reference:** `SocratiCode/src/index.ts` (21 tool definitions), `SocratiCode/src/tools/*.ts` (5 handler modules)

### GAP 2: Context Artifacts
**What:** Allow users to define non-code project docs (schemas, API specs, infra configs) that are indexed alongside code and searchable separately.
**Why it matters:** AI agents need context beyond source code -- understanding database schemas, API contracts, and infrastructure configs is essential for useful code assistance.
**Effort:** M (Medium) -- needs config file format, separate chunk collection, staleness detection.
**Reference:** `SocratiCode/src/services/context-artifacts.ts` (~551 lines)

### GAP 3: Circular Dependency Detection
**What:** DFS-based cycle detection in the code graph.
**Why it matters:** Circular imports cause subtle bugs (undefined at runtime, loading order issues). This is a high-value graph analysis feature.
**Effort:** S (Small) -- pure algorithm, no infrastructure needed. GT already has the graph data structure.
**Reference:** `SocratiCode/src/services/graph-analysis.ts:27-67` (40 lines)

### GAP 4: tsconfig.json Path Alias Resolution
**What:** Resolve TypeScript/JavaScript path aliases (e.g., `@app/utils/...`) from `tsconfig.json` `compilerOptions.paths`, including `extends` chain following.
**Why it matters:** Many TS projects use path aliases. Without this, graph edges for aliased imports are missing, making the graph incomplete.
**Effort:** S-M -- read and parse tsconfig, resolve paths relative to baseUrl, follow extends chain.
**Reference:** `SocratiCode/src/services/graph-aliases.ts` (~90 lines)

### GAP 5: Auto-Resume on Server Restart
**What:** Detect interrupted indexing operations and automatically resume from the last checkpoint.
**Why it matters:** If the process crashes mid-indexing (or user kills it), work should not be lost. GT already persists `indexingStatus` but has no startup logic to check and resume.
**Effort:** S -- GT already has the metadata. Just need a check-and-resume function.
**Reference:** `SocratiCode/src/services/startup.ts:37-150`

### GAP 6: Background Indexing (Fire-and-Forget)
**What:** Run indexing in the background, return immediately, allow polling for status.
**Why it matters:** For MCP integration and large codebases, blocking the caller during indexing is impractical.
**Effort:** M -- requires async task management, progress polling API, cleanup on errors.
**Reference:** `SocratiCode/src/tools/index-tools.ts` (fire-and-forget pattern)

### GAP 7: Cross-Process Locking (Proper Lockfile)
**What:** Replace PID-file advisory lock with `proper-lockfile` or similar, with operation-typed locks and stale lock reclamation.
**Why it matters:** Multiple processes (CLI + MCP + watch) may try to access the same index simultaneously. Stale locks from crashes need automatic cleanup.
**Effort:** S -- swap lock implementation, add operation type parameter.
**Reference:** `SocratiCode/src/services/lock.ts` (~251 lines)

### GAP 8: Hybrid Search Over-Fetch
**What:** When doing RRF fusion, fetch 3x candidates from each sub-query before fusing, not just the final limit.
**Why it matters:** RRF quality improves significantly with more candidates per sub-query. Currently GT fetches `limit` from each side.
**Effort:** S -- one-line change in the hybrid search logic.
**Reference:** `SocratiCode/src/services/qdrant.ts:324` -- `prefetchLimit = Math.max(limit * 3, 30)`

### GAP 9: Google Embedding Provider
**What:** Add Google Gemini Embedding API (gemini-embedding-001, 3072 dimensions) as a provider option.
**Why it matters:** Free tier available, highest dimensionality, good for users who want cloud quality without OpenAI dependency.
**Effort:** S-M -- implement provider interface, add rate limiting (5 RPM free tier = 15s delay).
**Reference:** `SocratiCode/src/services/provider-google.ts` (~100 lines)

### GAP 10: Graph Persistence and Caching
**What:** Persist the code graph to disk (SQLite or JSON) and invalidate cache on file changes.
**Why it matters:** Rebuilding the graph from scratch on every session is wasteful. For large codebases (1000+ files), graph building can take several seconds.
**Effort:** M -- serialize/deserialize graph, invalidation on file changes.
**Reference:** `SocratiCode/src/services/code-graph.ts` (graph cached in-memory, persisted to Qdrant metadata)

### GAP 11: Kotlin/Scala/C# Import Extraction
**What:** Add import extraction for the 3 languages that have AST chunking support but no import extractor.
**Why it matters:** Graph completeness. These languages have AST kinds in `chunker.ts` but no corresponding extractors in `graph-imports.ts`.
**Effort:** S -- follow the pattern of existing extractors. SC has reference implementations.
**Reference:** `SocratiCode/src/services/graph-imports.ts` (Kotlin: `import_list`, Scala: `import_declaration`, C#: `using_directive`)

### GAP 12: Richer Mermaid Visualization
**What:** Add language-based color coding, circular dependency highlighting, and legend to Mermaid diagrams.
**Why it matters:** Visual quality and information density in graph output.
**Effort:** S -- enhance `toMermaidDiagram()` with styling.
**Reference:** `SocratiCode/src/services/graph-analysis.ts:113-210`

---

## 5. Architecture Differences

### 5.1 Entry Point

| Aspect | GT | SC |
|--------|----|----|
| Interface | CLI (`commander`) | MCP server (`@modelcontextprotocol/sdk`) |
| Execution | User-initiated, blocking | AI-initiated, fire-and-forget |
| Process model | One process per command | Long-running server (stdin/stdout) |

### 5.2 State Management

| Aspect | GT | SC |
|--------|----|----|
| Pattern | Class-based (`Indexer` with private state) | Module-level Maps and singletons |
| Progress | EventEmitter + callbacks | Module-level `IndexingProgress` objects |
| Configuration | Per-instance config objects | Global env vars + constants |

GT's class-based approach is cleaner for multi-index scenarios. SC's module-level state works for single-project MCP instances.

### 5.3 Storage Architecture

```
GT:                                    SC:

SQLite (single .db file)               Qdrant (Docker container)
  +-- content table (FTS5 synced)        +-- codebase_{id} (dense + BM25)
  +-- fts5 virtual table                 +-- context_{id}  (dense + BM25)
  +-- embeddings (BLOB or vec0)          +-- socraticode_metadata
  +-- path_hashes table                  |     (hashes, graph, status)
  +-- index_meta (JSON blob)             |
  +-- search_log                         Qdrant does vector + BM25 natively.
                                         No separate FTS engine needed.
Everything in one file.                  Requires running services.
```

### 5.4 Embedding Pipeline

```
GT Pipeline (current):                 SC Pipeline:

 Scan -> Chunk -> Insert(content)       Scan -> Chunk -> Embed -> Upsert
              +-> Embed(separate phase)   (all-in-one per batch)
              |   Page(1000) -> Batch(32)
              |   -> provider.embedBatch()
              |   -> store embeddings
              v
 Content and embeddings are decoupled.  Content and embeddings are coupled.
 FTS works without embeddings.          All chunks must have embeddings.
```

GT's decoupled model is more resilient -- embedding failures don't prevent content indexing. SC's coupled model is simpler but less fault-tolerant.

### 5.5 Vector Search Architecture

```
GT:                                    SC:

 sqlite-vec (default)                   Qdrant HNSW (always)
   +-- vec0 virtual table                 +-- Dense cosine
   +-- KNN via WHERE embedding MATCH ?    +-- Sparse BM25
   +-- cosine distance metric             +-- Server-side RRF fusion

 sqlite-brute (fallback)               No fallback -- requires Qdrant.
   +-- Read all BLOBs into JS
   +-- Manual cosine distance
   +-- O(n) scan

 Qdrant adapter (optional)
   +-- In-memory mirror for sync API
   +-- Async upsert/delete queue
   +-- Hybrid search bypass method
```

GT has the most flexible architecture: three vector backends (sqlite-vec, brute-force, Qdrant). SC is locked to Qdrant. GT's sqlite-vec path gives near-ANN performance without external services.

---

## 6. Recommendations (Prioritized)

### Tier 1: Quick Wins (S effort, High impact)

1. **Circular dependency detection** -- Pure algorithm, ~50 lines. Add `findCircularDependencies(graph)` to `code-graph.ts`. Reference SC implementation.

2. **Hybrid search over-fetch** -- Change RRF fusion to fetch `limit * 3` from each sub-query before fusing. One-line change in `SearchEngine.hybridSearch()`.

3. **Kotlin/Scala/C# import extraction** -- Follow existing extractor patterns in `graph-imports.ts`. SC has the AST node kinds already documented.

4. **Richer Mermaid diagrams** -- Add color-coded nodes by language, cycle highlighting, and a legend subgraph to `toMermaidDiagram()`.

### Tier 2: Medium Effort, High Impact

5. **tsconfig.json path alias resolution** -- Read `compilerOptions.paths` + `extends` for graph resolution. Essential for TS/JS project graph completeness.

6. **Graph persistence** -- Serialize `CodeGraph` to SQLite (new table in the index DB) with cache invalidation on file changes. Avoids re-parsing all files on every session.

7. **Context artifacts** -- Add a `.genesistools-context.json` (or similar) config for non-code docs. Chunk and index alongside code. Useful for AI-powered code exploration.

8. **Google embedding provider** -- Implement `AIGoogleProvider` following the existing provider pattern. 3072 dims, free tier. Rate-limit with 15s delay.

9. **Cross-process locking** -- Replace PID advisory lock with `proper-lockfile` or similar. Add operation type (`sync`, `watch`, `embed`).

### Tier 3: Large Effort, Strategic

10. **MCP server** -- This is the gateway to AI assistant integration. Expose index/search/graph/status/watch as MCP tools. Requires background task management, JSON-RPC transport.

11. **Background indexing** -- Run sync in a background task, return immediately, provide polling API. Prerequisite for MCP integration.

12. **Auto-resume on restart** -- Check `indexingStatus` on Indexer creation. If `in-progress`, resume from last checkpoint. Small code change but needs careful testing.

### Tier 4: Nice to Have

13. **Svelte/Vue composite parsing** -- Re-parse HTML mode to extract script blocks, then parse those with TS/JS grammar. SC does this for both import extraction and chunking.

14. **Bash/Dart/Lua import extraction** -- Lower priority languages. Bash: `source` commands. Dart: `import '...'`. Lua: `require('...')`. SC uses regex for Dart/Lua.

15. **Plugin/skill system** -- SC ships as a Claude Code plugin with agents, skills, and hooks. GT could define similar structured knowledge for AI assistants.

---

## File Map

### GenesisTools Indexer (Key Files)

| File | Role |
|------|------|
| `src/indexer/lib/indexer.ts` | Core `Indexer` class: scan, chunk, embed, search, watch |
| `src/indexer/lib/chunker.ts` | 6 strategies: AST (17 langs), line, heading, message, JSON, character |
| `src/indexer/lib/code-graph.ts` | Graph builder: nodes, edges, resolution, Mermaid, stats |
| `src/indexer/lib/graph-imports.ts` | Import extraction: 11 languages via ast-grep |
| `src/indexer/lib/store.ts` | `IndexStore` interface + SQLite implementation |
| `src/indexer/lib/manager.ts` | Multi-index management |
| `src/indexer/lib/model-registry.ts` | 12 models with metadata, context lengths, task prefixes |
| `src/indexer/lib/types.ts` | `IndexConfig`, `ChunkRecord`, `IndexMeta`, `IndexStats` |
| `src/indexer/lib/events.ts` | Typed event system: 14 event types |
| `src/indexer/lib/path-hashes.ts` | Change detection: flat SQLite table |
| `src/indexer/lib/sources/file-source.ts` | File system scanning with git-ignore |
| `src/indexer/lib/sources/mail-source.ts` | macOS Mail.app integration |
| `src/indexer/lib/sources/telegram-source.ts` | Telegram chat history |
| `src/utils/search/drivers/sqlite-fts5/index.ts` | FTS5 + vector hybrid search engine |
| `src/utils/search/drivers/sqlite-fts5/schema.ts` | FTS5 table creation + sync triggers |
| `src/utils/search/stores/sqlite-vec-store.ts` | sqlite-vec ANN vector store |
| `src/utils/search/stores/sqlite-vector-store.ts` | Brute-force cosine vector store (fallback) |
| `src/utils/search/stores/qdrant-vector-store.ts` | Qdrant adapter with hybrid search |
| `src/utils/ai/tasks/Embedder.ts` | Embedding pipeline: batch, retry, provider-agnostic |
| `src/utils/ai/providers/AIOllamaProvider.ts` | Ollama: native batch embed, model management |
| `src/utils/ai/providers/AICoreMLProvider.ts` | CoreML: contextual + custom model embedding |
| `src/utils/ai/providers/AIDarwinKitProvider.ts` | macOS NaturalLanguage.framework |
| `src/utils/ai/providers/AICloudProvider.ts` | OpenAI + other cloud APIs |
| `src/utils/ai/providers/AILocalProvider.ts` | HuggingFace Transformers.js |

### SocratiCode (Reference Files)

| File | Role |
|------|------|
| `src/index.ts` | MCP server: 21 tools, lifecycle, transport |
| `src/services/indexer.ts` | Indexing + chunking (all-in-one, ~1200 lines) |
| `src/services/qdrant.ts` | Qdrant client: search, upsert, metadata |
| `src/services/code-graph.ts` | Dependency graph: build, cache, persist |
| `src/services/graph-imports.ts` | Import extraction (15+ languages) |
| `src/services/graph-resolution.ts` | Module resolution (per-language) |
| `src/services/graph-aliases.ts` | tsconfig.json path alias loading |
| `src/services/graph-analysis.ts` | Circular deps, stats, Mermaid diagrams |
| `src/services/context-artifacts.ts` | Non-code artifact indexing + search |
| `src/services/watcher.ts` | @parcel/watcher + debounced updates |
| `src/services/lock.ts` | Cross-process locking |
| `src/services/startup.ts` | Auto-resume + graceful shutdown |

---

## What Plans 1-7 Accomplished (Summary)

| Plan | What Was Done |
|------|--------------|
| **Plan 1: Embedding Pipeline** | Batch embedding (32/batch), native provider support, retry with rate-limit awareness, model-aware truncation, task prefixes |
| **Plan 2: AST Chunking** | 12 additional language grammars, minified detection, chunk overlap, char cap with re-splitting, merge small nodes, sub-chunk large nodes |
| **Plan 3: Search & Storage** | sqlite-vec ANN search, Qdrant adapter with hybrid search, configurable vector backends, min score filtering |
| **Plan 4: Infrastructure** | Native file watching (@parcel/watcher), cancellation support, indexing status persistence, Ollama provider |
| **Plan 5: Critical Safety Fixes** | Review fixes from code review sessions |
| **Plan 6: AST Import Extraction** | 11-language import extraction, graph builder, per-language resolution (TS/JS/Py/Go/Java/Rust/C/C++/Ruby/Swift/PHP) |
| **Plan 7: Code Quality Fixes** | Code cleanup, type safety improvements |

## Quantitative Comparison

| Metric | GT (before Plans 1-7) | GT (after Plans 1-7) | SocratiCode |
|--------|----------------------|---------------------|-------------|
| AST chunking languages | 4 | 17 | 16+ |
| Import extraction languages | 0 | 11 | 15 |
| Embedding providers | 3 | 5 | 3 |
| Embedding batch size | 1 | 32 | 32 |
| Vector search backends | 1 (brute-force) | 3 (vec, brute, qdrant) | 1 (qdrant) |
| Chunking strategies | 5 | 6 (+ character) | 3 |
| Source types | 3 | 3 | 1 |
| Models in registry | 8 | 12 | 3 |
| Remaining gaps | ~20 | 12 | N/A |

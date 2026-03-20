# SocratiCode Architecture Deep Dive

> Explored on 2026-03-20 | Scope: entire `.worktrees/socraticode/` directory (31 source files, 32 test files)

## Summary

SocratiCode is a **Model Context Protocol (MCP) server** that provides local codebase indexing, hybrid semantic + keyword search, and AST-based dependency graph analysis. It runs as a single Node.js process communicating over stdio, backed by a Docker-managed Qdrant vector database and pluggable embedding providers (Ollama/OpenAI/Google). The project is a single-package TypeScript project (v1.3.0) published to npm under AGPL-3.0, with ~5,200 source lines across a clean 3-layer architecture: index.ts (MCP tool registration) -> tools/ (request handling) -> services/ (business logic).

## Key Findings

### 1. Single-Package, MCP-Only Entry Point

There is exactly **one entry point**: `src/index.ts`, a shebang script (`#!/usr/bin/env node`) that:
1. Creates an `McpServer` from `@modelcontextprotocol/sdk`
2. Registers **21 MCP tools** organized into 5 categories
3. Connects via `StdioServerTransport` (JSON-RPC over stdin/stdout)
4. Auto-resumes watchers/indexes for already-indexed projects
5. Handles graceful shutdown (SIGINT, SIGTERM, stdin EOF/error/close)

There is **no CLI**, **no REST server**, **no library API**. The only way to interact is via MCP tool calls.

```
src/index.ts:17-27  -- McpServer creation
src/index.ts:371-425 -- main() function, transport, shutdown
```

### 2. 21 MCP Tools in 5 Categories

| Category | Tools | Handler |
|----------|-------|---------|
| **Indexing** (5) | `codebase_index`, `codebase_update`, `codebase_remove`, `codebase_stop`, `codebase_watch` | `src/tools/index-tools.ts` |
| **Query** (2) | `codebase_search`, `codebase_status` | `src/tools/query-tools.ts` |
| **Graph** (7) | `codebase_graph_build`, `codebase_graph_query`, `codebase_graph_stats`, `codebase_graph_circular`, `codebase_graph_visualize`, `codebase_graph_remove`, `codebase_graph_status` | `src/tools/graph-tools.ts` |
| **Context** (4) | `codebase_context`, `codebase_context_search`, `codebase_context_index`, `codebase_context_remove` | `src/tools/context-tools.ts` |
| **Management** (3) | `codebase_health`, `codebase_list_projects`, `codebase_about` | `src/tools/manage-tools.ts` |

All tool parameters are validated with **Zod schemas** defined inline in `src/index.ts:39-367`.

### 3. Three-Layer Architecture

```
src/index.ts (MCP registration, transport, lifecycle)
    |
    v
src/tools/*.ts (5 handler modules -- thin orchestration layer)
    |
    v
src/services/*.ts (20 service modules -- all business logic)
```

The **tools layer** is a routing/orchestration layer. Each `handleXxxTool()` function:
- Resolves `projectPath` (defaults to `process.cwd()`)
- Ensures infrastructure is ready (Docker, Qdrant, embedding provider)
- Delegates to service functions
- Formats text responses for the LLM

The **services layer** contains all domain logic. Key services:

| Service | File | Role |
|---------|------|------|
| **Indexer** | `services/indexer.ts` (~1200 lines) | Core chunking, hashing, batched embedding, resume, incremental update |
| **Qdrant** | `services/qdrant.ts` (~838 lines) | Qdrant client wrapper: collections, hybrid search, metadata, graph persistence |
| **Code Graph** | `services/code-graph.ts` (~486 lines) | AST-based dependency graph build, cache, persistence |
| **Graph Imports** | `services/graph-imports.ts` (~357 lines) | Import extraction for 15+ languages via ast-grep |
| **Graph Resolution** | `services/graph-resolution.ts` (~352 lines) | Module specifier -> file path resolution (per-language rules) |
| **Context Artifacts** | `services/context-artifacts.ts` (~551 lines) | Non-code knowledge: config parsing, chunking, indexing, search |
| **Docker** | `services/docker.ts` (~368 lines) | Docker container lifecycle for Qdrant + Ollama |
| **Watcher** | `services/watcher.ts` (~331 lines) | @parcel/watcher integration, debounced incremental updates |
| **Embedding** | `services/embeddings.ts` (~106 lines) | Batched embedding generation, retry with backoff |
| **Embedding Config** | `services/embedding-config.ts` (~190 lines) | Provider/model configuration from env vars |
| **Embedding Provider** | `services/embedding-provider.ts` (~79 lines) | Provider factory (Ollama/OpenAI/Google) |
| **Lock** | `services/lock.ts` (~251 lines) | Cross-process file locks via proper-lockfile |

### 4. Dependency Graph (Internal Module Map)

```
index.ts
 +- tools/index-tools.ts --+
 +- tools/query-tools.ts --+
 +- tools/graph-tools.ts --+
 +- tools/context-tools.ts +
 +- tools/manage-tools.ts -+
 +- services/logger.ts     |
 +- services/startup.ts    |
                           |
    All tools/ depend on --+
        |
        v
    services/indexer.ts ------> services/qdrant.ts ------> @qdrant/js-client-rest
        |                           |
        +-> services/embeddings.ts -+--> services/embedding-provider.ts
        |                           |        +-> services/provider-ollama.ts --> ollama (npm)
        |                           |        +-> services/provider-openai.ts --> openai (npm)
        |                           |        +-> services/provider-google.ts --> @google/generative-ai
        |                           |
        +-> services/code-graph.ts -+
        |       +-> services/graph-imports.ts --> @ast-grep/napi + 13 language packages
        |       +-> services/graph-resolution.ts
        |       +-> services/graph-aliases.ts
        |       +-> services/graph-analysis.ts
        |
        +-> services/context-artifacts.ts
        +-> services/ignore.ts --> ignore (npm)
        +-> services/lock.ts --> proper-lockfile (npm)
        +-> services/docker.ts
        +-> services/watcher.ts --> @parcel/watcher
```

### 5. Search Architecture: Hybrid Dense + BM25 with RRF

Search uses a **two-stage hybrid approach** (`services/qdrant.ts:305-355`):

1. **Dense semantic search**: Client-side vector embedding via the configured provider, cosine similarity in Qdrant
2. **BM25 lexical search**: Server-side tokenization in Qdrant (v1.15.2+), built-in `qdrant/bm25` model
3. **Reciprocal Rank Fusion (RRF)**: Qdrant fuses results from both sub-queries

The Qdrant collection uses **named vectors**:
- `dense`: Cosine similarity vectors (768/1536/3072 dims depending on provider)
- `bm25`: Server-side BM25 inference with `qdrant/bm25` model

```typescript
// src/services/qdrant.ts:327-343
prefetch: [
  { query: queryVector, using: "dense", limit: prefetchLimit },
  { query: { text: query, model: "qdrant/bm25" }, using: "bm25", limit: prefetchLimit },
],
query: { fusion: "rrf" },
```

### 6. Indexing Pipeline

The indexer (`services/indexer.ts`) follows a **batched, resumable** design:

1. **File discovery**: Walk project tree, respect .gitignore + .socraticodeignore + built-in ignores
2. **Hash comparison**: SHA-256 content hashes stored in Qdrant metadata; skip unchanged files
3. **Chunking**: Three strategies:
   - **AST-aware** (not yet fully implemented -- falls through to line-based)
   - **Line-based**: 100 lines/chunk with 10-line overlap (CHUNK_SIZE=100, CHUNK_OVERLAP=10)
   - **Character-based**: For minified files (avg line length > 500 chars)
   - Hard cap: MAX_CHUNK_CHARS=2000 chars per chunk
4. **Batched embedding**: 50 files/batch (INDEX_BATCH_SIZE), 32 texts/embedding request (BATCH_SIZE)
5. **Checkpoint**: After each batch, hashes are persisted to Qdrant metadata so indexing can resume
6. **Graph auto-build**: After indexing completes, the dependency graph is automatically rebuilt
7. **Context artifacts auto-index**: .socraticodecontextartifacts.json artifacts are indexed alongside code

Key features:
- **Background async**: codebase_index returns immediately; poll codebase_status
- **Cancellation**: codebase_stop requests cancellation at the next batch boundary
- **Cross-process locking**: proper-lockfile prevents concurrent indexing/watching from multiple MCP instances
- **Auto-resume**: On server startup, incomplete indexes are automatically resumed

### 7. Code Graph: AST-Based Static Analysis

The dependency graph (`services/code-graph.ts`) uses **ast-grep** for polyglot import extraction:

**Supported languages for import extraction** (13 AST grammars + 2 regex-only):
- AST-grep native: TypeScript, JavaScript, TSX, HTML, CSS
- AST-grep dynamic: Python, Go, Java, Rust, C, C++, C#, Ruby, Kotlin, Swift, Scala, Bash, PHP
- Regex-only: Dart, Lua
- Composite (HTML re-parse): Svelte, Vue

**Resolution pipeline** (`services/graph-resolution.ts`):
1. Extract raw import specifiers from AST
2. Filter external/stdlib modules (per-language allowlists)
3. Resolve to project files: relative paths, extensionless imports, directory indexes, SCSS partials, Python __init__.py
4. Path alias support: reads tsconfig.json/jsconfig.json compilerOptions.paths with extends chain following

**Output**: CodeGraph = { nodes: CodeGraphNode[], edges: CodeGraphEdge[] }
- Persisted as a single JSON blob in Qdrant's metadata collection
- In-memory cache per project, invalidated by the file watcher
- Visualized as color-coded Mermaid diagrams with circular dependencies highlighted

### 8. Context Artifacts System

Users define non-code project knowledge in `.socraticodecontextartifacts.json`:

```json
{
  "artifacts": [
    { "name": "database-schema", "path": "docs/schema.sql", "description": "..." },
    { "name": "api-spec", "path": "docs/openapi.yaml", "description": "..." },
    { "name": "infra-config", "path": "infrastructure/", "description": "..." }
  ]
}
```

- Artifacts can point to **files or directories** (directories are recursively concatenated)
- Chunked and embedded into a separate `context_{projectId}` Qdrant collection
- **Staleness detection**: SHA-256 content hash compared on each search; auto-re-index if stale
- Searched with the same hybrid dense + BM25 approach as code

### 9. Configuration System

**All configuration is via environment variables** -- no config files, no CLI args (beyond what MCP hosts provide).

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_PROVIDER` | `ollama` | `ollama`, `openai`, `google` |
| `OLLAMA_MODE` | `auto` | `auto` (detect native, fallback Docker), `docker`, `external` |
| `OLLAMA_URL` | auto-detected | Ollama API URL |
| `QDRANT_MODE` | `managed` | `managed` (Docker) or `external` (remote) |
| `QDRANT_URL` | -- | Full URL for remote/cloud Qdrant |
| `QDRANT_PORT` | `16333` | Local Qdrant REST port |
| `EMBEDDING_MODEL` | per-provider | Model name |
| `EMBEDDING_DIMENSIONS` | per-provider | Vector dimensions |
| `SEARCH_DEFAULT_LIMIT` | `10` | Default search result count |
| `SEARCH_MIN_SCORE` | `0.10` | Minimum RRF score threshold |
| `MAX_FILE_SIZE_MB` | `5` | Max file size for indexing |
| `EXTRA_EXTENSIONS` | -- | Additional file extensions |
| `SOCRATICODE_PROJECT_ID` | -- | Override project ID (for worktrees sharing an index) |
| `SOCRATICODE_LOG_LEVEL` | `info` | Log level |
| `SOCRATICODE_LOG_FILE` | -- | Optional file logging path |
| `RESPECT_GITIGNORE` | `true` | Whether to honor .gitignore |

Configuration is loaded once at startup (constants.ts, embedding-config.ts) and cached as singletons.

### 10. Plugin/Extension System (Claude Code Plugin)

SocratiCode ships as a **Claude Code plugin** via the `.claude-plugin/` directory:

- **plugin.json**: Plugin metadata (name, version, description, MCP server reference)
- **marketplace.json**: Marketplace listing metadata
- **hooks/hooks.json**: Session-start hook that warns about duplicate MCP configurations
- **agents/codebase-explorer.md**: A pre-configured agent prompt for deep codebase exploration (delegated to Sonnet)
- **skills/codebase-exploration/SKILL.md**: Skill definition for exploration workflows
- **skills/codebase-management/SKILL.md**: Skill definition for indexing/management workflows

The plugin bundles the MCP server (.mcp.json -> npx -y socraticode) plus skills/agents/hooks that teach Claude Code _how_ to use the tools effectively.

### 11. Error Handling Patterns

SocratiCode uses a consistent error handling strategy:

1. **Retry with exponential backoff**: Both `services/embeddings.ts` and `services/qdrant.ts` have `withRetry()` helpers (3 retries, 500ms base delay). Rate-limit errors (429) get longer backoff (15s minimum).

2. **Graceful degradation**: Non-critical operations (watcher auto-start, metadata checks, artifact status) use catch blocks that log warnings and continue. Phrases like "non-fatal", "ignored", "best-effort" appear throughout.

3. **Structured error propagation**: Critical operations (Qdrant upsert, collection creation) propagate errors. `getCollectionInfo()` explicitly distinguishes "not found" (returns null) from transient errors (throws). `loadProjectHashes()` throws on errors so callers can distinguish "no metadata" from "Qdrant unreachable".

4. **Per-point fallback**: `upsertPreEmbeddedChunks()` falls back from batch to per-point upsert when a batch fails, isolating individual bad points.

5. **Process-level handlers**: `unhandledRejection` logs but continues; `uncaughtException` logs and exits.

### 12. Logging System

Custom structured logger (`services/logger.ts`) with dual output:

1. **MCP notifications**: When connected, log entries are forwarded as `notifications/message` to the MCP host (e.g., Cline). This is the primary path during normal operation.
2. **stderr JSON**: Before MCP transport connects (startup, tests), JSON-structured log lines go to stderr.
3. **File logging**: When `SOCRATICODE_LOG_FILE` is set, all entries are also appended to that file.

Log levels: debug < info < warn < error. Controlled by `SOCRATICODE_LOG_LEVEL`.

### 13. Testing

- **Framework**: Vitest 4.x with `pool: "forks"` for ESM support
- **Sequential execution**: `fileParallelism: false` because tests share Docker resources and Qdrant collections
- **Long timeouts**: 120s per test and hook (Docker-based integration tests)
- **Coverage**: V8 provider, excluding `src/index.ts` (stdio transport)

Test organization:
- **Unit tests** (20 files): Test individual services in isolation
- **Integration tests** (8 files): Test against real Docker/Qdrant/Ollama
- **E2E tests** (1 file): Full workflow test

CI runs lint + typecheck + unit tests on Node 18/20/22 (GitHub Actions). Integration/E2E tests require Docker and are presumably run locally.

### 14. Build and Release

- **Build**: `tsc` -> `dist/` (ES2022, Node16 modules, declarations + source maps)
- **Runtime**: Node.js >= 18 (no Bun dependency)
- **Linter**: Biome 2.x (recommended rules, no formatter)
- **Release**: release-it with conventional-changelog, publishes to npm + GitHub Releases
- **Published files**: `dist/`, `.claude-plugin/`, `skills/`, `agents/`, `hooks/`, `.mcp.json`, licenses, README

### 15. External Dependencies

**Runtime** (12 dependencies):
| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.26.0 | MCP server framework |
| `@qdrant/js-client-rest` | ^1.17.0 | Qdrant vector DB client |
| `@ast-grep/napi` + 13 lang packages | ^0.40.5 | AST parsing for code graph |
| `ollama` | ^0.5.14 | Ollama embedding client |
| `openai` | ^6.22.0 | OpenAI embedding client |
| `@google/generative-ai` | ^0.24.1 | Google embedding client |
| `@parcel/watcher` | ^2.5.6 | Native file system watching |
| `glob` | ^11.0.1 | File pattern matching |
| `ignore` | ^7.0.3 | .gitignore parser |
| `proper-lockfile` | ^4.1.2 | Cross-process file locks |
| `zod` | ^3.24.2 | Schema validation |

**Dev** (6 dependencies): biome, @types/node, @types/proper-lockfile, @vitest/coverage-v8, tsx, typescript

## Architecture / Flow

### Indexing Flow
```
codebase_index (tool call)
    |
    +-- ensureInfrastructure()
    |      +-- ensureQdrantReady() --> Docker pull/start Qdrant container
    |      +-- getEmbeddingProvider().ensureReady() --> Docker pull/start Ollama + pull model
    |
    +-- indexProject() [background, fire-and-forget]
           +-- acquireProjectLock("index")
           +-- scanFiles() --> walk tree, apply ignore filters
           +-- loadProjectHashes() --> Qdrant metadata collection
           |
           +-- FOR EACH batch of 50 files:
           |      +-- Check cancellation flag
           |      +-- Hash files, skip unchanged
           |      +-- chunkFile() --> line-based/char-based chunking
           |      +-- generateEmbeddings() --> provider.embed()
           |      +-- upsertPreEmbeddedChunks() --> Qdrant batch upsert
           |      +-- saveProjectMetadata() --> checkpoint hashes
           |
           +-- rebuildGraph() --> AST analysis, Qdrant persist
           +-- ensureArtifactsIndexed() --> context artifacts
           +-- releaseProjectLock("index")
```

### Search Flow
```
codebase_search (tool call)
    |
    +-- ensureQdrantReady()
    +-- ensureOllamaReady() / getEmbeddingProvider()
    |
    +-- searchChunks()
           +-- generateQueryEmbedding() --> "search_query: <query>"
           +-- qdrant.query()
                  +-- prefetch[0]: dense vector search (cosine)
                  +-- prefetch[1]: BM25 text search (server-side)
                  +-- query: { fusion: "rrf" }
```

### Auto-Resume on Startup
```
main()
    +-- server.connect(StdioServerTransport)
    +-- autoResumeIndexedProjects() [fire-and-forget]
           +-- Check Docker + Qdrant available
           +-- Check CWD has an indexed collection
           |
           +-- IF persisted status == "in-progress":
           |      +-- indexProject() [resume from checkpoint]
           |
           +-- IF persisted status == "completed":
                  +-- startWatching()
                  +-- updateProjectIndex() [incremental catch-up]
```

## File Map

| File | Role |
|------|------|
| `src/index.ts` | MCP server entry point: tool registration, transport, lifecycle |
| `src/types.ts` | Core type definitions: FileChunk, CodeGraph, SearchResult, etc. |
| `src/config.ts` | Project ID generation, collection name derivation |
| `src/constants.ts` | All configuration constants, supported extensions, language mapping |
| `src/tools/index-tools.ts` | Handles index/update/remove/stop/watch tool calls |
| `src/tools/query-tools.ts` | Handles search and status tool calls |
| `src/tools/graph-tools.ts` | Handles all graph tool calls |
| `src/tools/context-tools.ts` | Handles context artifact tool calls |
| `src/tools/manage-tools.ts` | Handles health, list-projects, about tool calls |
| `src/services/indexer.ts` | Core indexing engine: file scanning, chunking, batching, resume |
| `src/services/qdrant.ts` | Qdrant client: collections, search, metadata, graph persistence |
| `src/services/embeddings.ts` | Batched embedding generation with retry |
| `src/services/embedding-config.ts` | Provider/model configuration from env vars |
| `src/services/embedding-provider.ts` | Provider factory (Ollama/OpenAI/Google) |
| `src/services/embedding-types.ts` | EmbeddingProvider interface |
| `src/services/provider-ollama.ts` | Ollama provider: Docker management, model pulling, embedding |
| `src/services/provider-openai.ts` | OpenAI provider: API key validation, batch embedding |
| `src/services/provider-google.ts` | Google provider: Gemini API, batch embedding |
| `src/services/code-graph.ts` | Dependency graph: build, cache, rebuild, persist, status |
| `src/services/graph-imports.ts` | AST-based import extraction for 15+ languages |
| `src/services/graph-resolution.ts` | Module specifier -> file path resolution |
| `src/services/graph-aliases.ts` | tsconfig/jsconfig path alias loading |
| `src/services/graph-analysis.ts` | Graph stats, circular deps, Mermaid diagram generation |
| `src/services/context-artifacts.ts` | Non-code artifact indexing and search |
| `src/services/docker.ts` | Docker container lifecycle (Qdrant + Ollama) |
| `src/services/watcher.ts` | @parcel/watcher integration, debounced updates |
| `src/services/ignore.ts` | .gitignore + .socraticodeignore filter building |
| `src/services/lock.ts` | Cross-process file locking via proper-lockfile |
| `src/services/logger.ts` | Structured logger: MCP notifications + stderr + file |
| `src/services/startup.ts` | Auto-resume and graceful shutdown coordination |
| `src/services/ollama.ts` | Legacy Ollama API re-exports |
| `.claude-plugin/plugin.json` | Claude Code plugin manifest |
| `agents/codebase-explorer.md` | Agent prompt for deep exploration |
| `skills/codebase-exploration/SKILL.md` | Exploration skill definition |
| `skills/codebase-management/SKILL.md` | Management skill definition |
| `hooks/hooks.json` | Session-start hook for duplicate MCP detection |

## Code Excerpts

### Hybrid Search (RRF Fusion)
```typescript
// src/services/qdrant.ts:327-343
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
```

### Embedding Provider Interface
```typescript
// src/services/embedding-types.ts:13-37
export interface EmbeddingProvider {
  readonly name: string;
  ensureReady(): Promise<EmbeddingReadinessResult>;
  embed(texts: string[]): Promise<number[][]>;
  embedSingle(text: string): Promise<number[]>;
  healthCheck(): Promise<EmbeddingHealthStatus>;
}
```

### Collection Naming Convention
```typescript
// src/config.ts:15-48
export function projectIdFromPath(folderPath: string): string {
  // SHA-256(absolute_path).slice(0, 12) -- or explicit SOCRATICODE_PROJECT_ID
}
export function collectionName(projectId: string): string {
  return `codebase_${projectId}`;  // code chunks
}
export function graphCollectionName(projectId: string): string {
  return `codegraph_${projectId}`; // graph metadata
}
export function contextCollectionName(projectId: string): string {
  return `context_${projectId}`;   // context artifact chunks
}
```

## Open Questions

1. **AST-aware chunking**: The indexer imports `@ast-grep/napi` and uses `parse()` for chunking (indexer.ts:7), but the actual chunking strategy in the large indexer file would need closer inspection to determine if it's using AST boundaries or falling back to line-based.

2. **No incremental graph rebuild**: The graph is rebuilt entirely on each change -- there's no incremental graph update that only re-analyzes changed files. For large codebases this could be slow (though it's cached after build).

3. **Qdrant metadata as pseudo-collection**: The `socraticode_metadata` collection uses a dummy 1-dim vector and stores all project metadata (hashes, graph data, artifact states) as JSON blobs in payloads. This works but could become a bottleneck for very large projects with thousands of files (each hash map is serialized as a single JSON payload).

4. **No Bun support**: Despite the parent GenesisTools project using Bun, SocratiCode targets Node.js >= 18 with standard npm commands. The tsx dev dependency provides TypeScript execution for development.

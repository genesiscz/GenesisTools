# Indexer v3 - Plan 8: MCP Server

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose the indexer as an MCP server so AI assistants (Claude Code, Cline, Cursor) can index, search, and analyze codebases directly via tool calls. Thin handler layer delegates to existing `IndexerManager`, `Indexer`, and graph utilities.

**Architecture:**

```
src/indexer/mcp-server.ts          -- Entry point: McpServer + StdioServerTransport
src/indexer/mcp/tools/search.ts    -- indexer_search handler
src/indexer/mcp/tools/index.ts     -- indexer_index, indexer_sync handlers
src/indexer/mcp/tools/manage.ts    -- indexer_status, indexer_remove, indexer_stop handlers
src/indexer/mcp/tools/graph.ts     -- graph build/query/stats/visualize handlers
src/indexer/mcp/tools/models.ts    -- indexer_models handler
src/indexer/mcp/shared.ts          -- Shared manager instance + helpers
```

**Tech Stack:** TypeScript/Bun, `@modelcontextprotocol/sdk` (already in deps), `zod` (already in deps)

**Key Design Decisions:**

1. **Single IndexerManager instance** shared across all tool handlers via `mcp/shared.ts` (lazy-init on first tool call).
2. **Thin tool handlers** -- each handler is a function that takes typed args and returns a string. The MCP registration in `mcp-server.ts` wraps these into `{ content: [{ type: "text", text }] }`.
3. **index/sync run synchronously** (unlike SC which backgrounds). Our indexer already supports cancellation + checkpointing, so the LLM can call `indexer_stop` if it takes too long.
4. **No new dependencies** -- both `@modelcontextprotocol/sdk` and `zod` already exist in `package.json`.
5. **CLI entry** via `tools indexer mcp-serve` subcommand + direct `bun run src/indexer/mcp-server.ts` for MCP host configs.

---

## Task 1: Create shared manager module + helpers

**Files:**
- Create: `src/indexer/mcp/shared.ts`

**Steps:**

1. Create the directory structure.
   ```bash
   mkdir -p src/indexer/mcp/tools
   ```

2. Create `src/indexer/mcp/shared.ts` with:
   ```typescript
   import { IndexerManager } from "../lib/manager";

   let manager: IndexerManager | null = null;

   /** Lazy-init singleton IndexerManager. Reused across all tool handlers. */
   export async function getManager(): Promise<IndexerManager> {
       if (!manager) {
           manager = await IndexerManager.load();
       }

       return manager;
   }

   /** Graceful shutdown: close all open indexers. */
   export async function shutdownManager(): Promise<void> {
       if (manager) {
           await manager.close();
           manager = null;
       }
   }

   /** Format an error into a user-friendly MCP response string. */
   export function formatError(action: string, err: unknown): string {
       const msg = err instanceof Error ? err.message : String(err);
       return `Error during ${action}: ${msg}`;
   }
   ```

3. Verify it compiles.
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "mcp/shared"
   ```

4. Commit: `feat(indexer): add MCP shared manager module`

---

## Task 2: Create MCP server entry point with stdio transport + graceful shutdown

**Files:**
- Create: `src/indexer/mcp-server.ts`

**Steps:**

1. Create `src/indexer/mcp-server.ts`:
   ```typescript
   #!/usr/bin/env bun
   import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
   import { shutdownManager } from "./mcp/shared";
   import { registerGraphTools } from "./mcp/tools/graph";
   import { registerIndexTools } from "./mcp/tools/index";
   import { registerManageTools } from "./mcp/tools/manage";
   import { registerModelsTools } from "./mcp/tools/models";
   import { registerSearchTools } from "./mcp/tools/search";

   const server = new McpServer(
       {
           name: "genesis-indexer",
           version: "1.0.0",
       },
       {
           capabilities: {
               tools: {},
           },
       },
   );

   // Register all tool groups
   registerSearchTools(server);
   registerIndexTools(server);
   registerManageTools(server);
   registerGraphTools(server);
   registerModelsTools(server);

   // ── Start server ─────────────────────────────────────────────
   async function main(): Promise<void> {
       const transport = new StdioServerTransport();
       await server.connect(transport);

       // ── Process-level error handlers ─────────────────────────
       process.on("unhandledRejection", (reason) => {
           const msg = reason instanceof Error ? reason.message : String(reason);
           console.error(`Unhandled rejection: ${msg}`);
       });

       // ── Graceful shutdown ────────────────────────────────────
       let shuttingDown = false;

       const shutdown = async (signal: string): Promise<void> => {
           if (shuttingDown) {
               return;
           }

           shuttingDown = true;
           console.error(`Shutting down (${signal})...`);
           await shutdownManager();
           await server.close();
           process.exit(0);
       };

       process.on("SIGINT", () => shutdown("SIGINT"));
       process.on("SIGTERM", () => shutdown("SIGTERM"));
       process.stdin.on("end", () => shutdown("stdin EOF"));
       process.stdin.on("close", () => shutdown("stdin close"));
   }

   main().catch((err) => {
       console.error("Fatal error:", err);
       process.exit(1);
   });
   ```

2. Create stub files for each tool group so the imports resolve. Each stub exports a no-op `register*Tools` function that takes `McpServer`:
   - `src/indexer/mcp/tools/search.ts`
   - `src/indexer/mcp/tools/index.ts`
   - `src/indexer/mcp/tools/manage.ts`
   - `src/indexer/mcp/tools/graph.ts`
   - `src/indexer/mcp/tools/models.ts`

   Each stub:
   ```typescript
   import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

   export function register<Name>Tools(_server: McpServer): void {
       // TODO: implement
   }
   ```

3. Verify it compiles.
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "mcp"
   ```

4. Commit: `feat(indexer): add MCP server entry point with stdio transport`

---

## Task 3: Implement `indexer_search` tool

**Files:**
- Modify: `src/indexer/mcp/tools/search.ts`

**Steps:**

1. Replace the stub with the full implementation:
   ```typescript
   import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { z } from "zod";
   import type { ChunkRecord } from "../../lib/types";
   import { formatError, getManager } from "../shared";

   export function registerSearchTools(server: McpServer): void {
       server.tool(
           "indexer_search",
           "Search across indexed codebases. Returns matching code chunks with file paths, line numbers, and relevance scores. Supports fulltext (BM25), vector (semantic), or hybrid search modes.",
           {
               query: z.string().describe("Search query (natural language or code terms)."),
               indexName: z
                   .string()
                   .describe("Index name to search. Omit to search all indexes.")
                   .optional(),
               limit: z
                   .number()
                   .min(1)
                   .max(100)
                   .describe("Max results. Default: 20.")
                   .optional(),
               mode: z
                   .enum(["fulltext", "vector", "hybrid"])
                   .describe("Search mode. Default: fulltext. Use 'hybrid' for best results if embeddings exist.")
                   .optional(),
               minScore: z
                   .number()
                   .min(0)
                   .max(1)
                   .describe("Minimum score threshold. Default: 0 (no filtering).")
                   .optional(),
               fileFilter: z
                   .string()
                   .describe("Filter results to files matching this substring.")
                   .optional(),
           },
           async (args) => ({
               content: [{ type: "text", text: await handleSearch(args) }],
           }),
       );
   }

   interface SearchArgs {
       query: string;
       indexName?: string;
       limit?: number;
       mode?: "fulltext" | "vector" | "hybrid";
       minScore?: number;
       fileFilter?: string;
   }

   async function handleSearch(args: SearchArgs): Promise<string> {
       try {
           const manager = await getManager();
           const limit = args.limit ?? 20;
           const mode = args.mode ?? "fulltext";
           const minScore = args.minScore ?? 0;

           let allResults: Array<{ indexName: string; doc: ChunkRecord; score: number; method: string }> = [];

           if (args.indexName) {
               const indexer = await manager.getIndex(args.indexName);
               const results = await indexer.search(args.query, { mode, limit });

               for (const r of results) {
                   allResults.push({
                       indexName: args.indexName,
                       doc: r.doc,
                       score: r.score,
                       method: r.method,
                   });
               }
           } else {
               const names = manager.getIndexNames();

               if (names.length === 0) {
                   return "No indexes configured. Use indexer_index to create one.";
               }

               for (const name of names) {
                   const indexer = await manager.getIndex(name);
                   const results = await indexer.search(args.query, { mode, limit });

                   for (const r of results) {
                       allResults.push({
                           indexName: name,
                           doc: r.doc,
                           score: r.score,
                           method: r.method,
                       });
                   }
               }

               allResults.sort((a, b) => b.score - a.score);
               allResults = allResults.slice(0, limit);
           }

           // Apply minScore filter
           if (minScore > 0) {
               allResults = allResults.filter((r) => r.score >= minScore);
           }

           // Apply fileFilter
           if (args.fileFilter) {
               const filter = args.fileFilter;
               allResults = allResults.filter((r) => r.doc.filePath.includes(filter));
           }

           if (allResults.length === 0) {
               return `No results found for "${args.query}". Ensure indexes exist (indexer_status) and have been synced.`;
           }

           const lines = [`Search results for "${args.query}" (${allResults.length} matches, mode: ${mode}):\n`];

           for (const r of allResults) {
               lines.push(`--- ${r.doc.filePath} (lines ${r.doc.startLine}-${r.doc.endLine}) [${r.doc.language ?? r.doc.kind}] score: ${r.score.toFixed(4)} ---`);
               lines.push(r.doc.content);
               lines.push("");
           }

           return lines.join("\n");
       } catch (err) {
           return formatError("indexer_search", err);
       }
   }
   ```

2. Verify it compiles.
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "mcp/tools/search"
   ```

3. Commit: `feat(indexer): implement indexer_search MCP tool`

---

## Task 4: Implement `indexer_index` + `indexer_sync` tools

**Files:**
- Modify: `src/indexer/mcp/tools/index.ts`

**Steps:**

1. Replace the stub with:
   ```typescript
   import { basename, resolve } from "node:path";
   import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { z } from "zod";
   import type { IndexConfig } from "../../lib/types";
   import { formatError, getManager } from "../shared";

   export function registerIndexTools(server: McpServer): void {
       server.tool(
           "indexer_index",
           "Create a new index for a codebase directory. Scans files, chunks content using AST-aware parsing, and optionally generates embeddings for semantic search. Returns when indexing completes.",
           {
               path: z.string().describe("Absolute path to the directory to index."),
               name: z
                   .string()
                   .describe("Index name. Default: directory basename.")
                   .optional(),
               provider: z
                   .string()
                   .describe("Embedding provider: darwinkit, local-hf, cloud, ollama. Default: darwinkit.")
                   .optional(),
               model: z
                   .string()
                   .describe("Embedding model ID. Default: auto-selected by provider.")
                   .optional(),
               noEmbed: z
                   .boolean()
                   .describe("Skip embeddings entirely. Fulltext-only search. Default: false.")
                   .optional(),
           },
           async (args) => ({
               content: [{ type: "text", text: await handleIndex(args) }],
           }),
       );

       server.tool(
           "indexer_sync",
           "Incrementally sync an existing index. Re-scans for changed/added/deleted files and updates the index. Much faster than a full re-index.",
           {
               name: z.string().describe("Index name to sync."),
           },
           async (args) => ({
               content: [{ type: "text", text: await handleSync(args) }],
           }),
       );
   }

   interface IndexArgs {
       path: string;
       name?: string;
       provider?: string;
       model?: string;
       noEmbed?: boolean;
   }

   async function handleIndex(args: IndexArgs): Promise<string> {
       try {
           const manager = await getManager();
           const absPath = resolve(args.path);
           const indexName = args.name ?? basename(absPath);

           // Check if index already exists
           const existing = manager.getIndexNames();

           if (existing.includes(indexName)) {
               return `Index "${indexName}" already exists. Use indexer_sync to update it, or indexer_remove + indexer_index to recreate.`;
           }

           const config: IndexConfig = {
               name: indexName,
               baseDir: absPath,
               type: "code",
               respectGitIgnore: true,
               chunking: "auto",
               embedding: {
                   enabled: args.noEmbed !== true,
                   provider: args.provider,
                   model: args.model,
               },
           };

           const indexer = await manager.addIndex(config);
           const stats = indexer.stats;

           const lines = [
               `Index "${indexName}" created and synced.`,
               `  Path: ${absPath}`,
               `  Files: ${stats.totalFiles}`,
               `  Chunks: ${stats.totalChunks}`,
               `  Embeddings: ${stats.totalEmbeddings}`,
               `  DB Size: ${(stats.dbSizeBytes / 1024).toFixed(0)} KB`,
               "",
               "Use indexer_search to query the index.",
           ];

           return lines.join("\n");
       } catch (err) {
           return formatError("indexer_index", err);
       }
   }

   async function handleSync(args: { name: string }): Promise<string> {
       try {
           const manager = await getManager();
           const indexer = await manager.getIndex(args.name);
           const syncStats = await indexer.sync();

           const totalChanges = syncStats.chunksAdded + syncStats.chunksUpdated + syncStats.chunksRemoved;

           if (totalChanges === 0 && syncStats.embeddingsGenerated === 0) {
               return `Index "${args.name}" is up to date. No changes detected.`;
           }

           const lines = [
               `Synced index "${args.name}":`,
               `  Files scanned: ${syncStats.filesScanned}`,
               `  Chunks added: ${syncStats.chunksAdded}`,
               `  Chunks updated: ${syncStats.chunksUpdated}`,
               `  Chunks removed: ${syncStats.chunksRemoved}`,
               `  Embeddings generated: ${syncStats.embeddingsGenerated}`,
               `  Duration: ${(syncStats.durationMs / 1000).toFixed(1)}s`,
           ];

           if (syncStats.cancelled) {
               lines.push("", "Note: Sync was cancelled. Progress is checkpointed. Run indexer_sync again to resume.");
           }

           return lines.join("\n");
       } catch (err) {
           return formatError("indexer_sync", err);
       }
   }
   ```

2. Verify it compiles.
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "mcp/tools/index"
   ```

3. Commit: `feat(indexer): implement indexer_index + indexer_sync MCP tools`

---

## Task 5: Implement `indexer_status` + `indexer_remove` + `indexer_stop` tools

**Files:**
- Modify: `src/indexer/mcp/tools/manage.ts`

**Steps:**

1. Replace the stub with:
   ```typescript
   import { formatBytes, formatDuration, formatRelativeTime } from "@app/utils/format";
   import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { z } from "zod";
   import { formatError, getManager } from "../shared";

   export function registerManageTools(server: McpServer): void {
       server.tool(
           "indexer_status",
           "Check index status. Without a name, shows a summary of all indexes. With a name, shows detailed stats for that index.",
           {
               name: z
                   .string()
                   .describe("Index name. Omit for overview of all indexes.")
                   .optional(),
           },
           async (args) => ({
               content: [{ type: "text", text: await handleStatus(args) }],
           }),
       );

       server.tool(
           "indexer_remove",
           "Remove an index entirely. Stops watchers, closes the database, and deletes all stored data.",
           {
               name: z.string().describe("Index name to remove."),
           },
           async (args) => ({
               content: [{ type: "text", text: await handleRemove(args) }],
           }),
       );

       server.tool(
           "indexer_stop",
           "Request cancellation of an in-progress sync/index operation. The current batch finishes and checkpoints. Progress is preserved.",
           {
               name: z.string().describe("Index name to stop."),
           },
           async (args) => ({
               content: [{ type: "text", text: await handleStop(args) }],
           }),
       );
   }

   async function handleStatus(args: { name?: string }): Promise<string> {
       try {
           const manager = await getManager();

           if (args.name) {
               const indexes = manager.listIndexes();
               const meta = indexes.find((m) => m.name === args.name);

               if (!meta) {
                   return `Index "${args.name}" not found. Available: ${manager.getIndexNames().join(", ") || "(none)"}`;
               }

               const lastSync = meta.lastSyncAt
                   ? `${formatRelativeTime(new Date(meta.lastSyncAt), { compact: true })} (${formatDuration(meta.stats.lastSyncDurationMs)})`
                   : "never";

               return [
                   `Index: ${meta.name}`,
                   `  Path: ${meta.config.baseDir}`,
                   `  Type: ${meta.config.type ?? "auto"}`,
                   `  Status: ${meta.indexingStatus ?? "idle"}`,
                   `  Files: ${meta.stats.totalFiles}`,
                   `  Chunks: ${meta.stats.totalChunks}`,
                   `  Embeddings: ${meta.stats.totalEmbeddings}`,
                   `  Embedding dims: ${meta.stats.embeddingDimensions}`,
                   `  DB size: ${formatBytes(meta.stats.dbSizeBytes)}`,
                   `  Last sync: ${lastSync}`,
                   `  Searches: ${meta.stats.searchCount}`,
                   `  Avg search: ${meta.stats.avgSearchDurationMs > 0 ? formatDuration(meta.stats.avgSearchDurationMs) : "n/a"}`,
                   ...(meta.indexEmbedding
                       ? [`  Embedding model: ${meta.indexEmbedding.model} (${meta.indexEmbedding.provider})`]
                       : []),
               ].join("\n");
           }

           const indexes = manager.listIndexes();

           if (indexes.length === 0) {
               return "No indexes configured. Use indexer_index to create one.";
           }

           const lines = [`${indexes.length} index(es):\n`];

           for (const meta of indexes) {
               const lastSync = meta.lastSyncAt
                   ? formatRelativeTime(new Date(meta.lastSyncAt), { compact: true })
                   : "never";

               lines.push(`  ${meta.name} — ${meta.stats.totalFiles} files, ${meta.stats.totalChunks} chunks, ${meta.indexingStatus ?? "idle"}, synced ${lastSync}`);
           }

           return lines.join("\n");
       } catch (err) {
           return formatError("indexer_status", err);
       }
   }

   async function handleRemove(args: { name: string }): Promise<string> {
       try {
           const manager = await getManager();
           await manager.removeIndex(args.name);
           return `Index "${args.name}" removed.`;
       } catch (err) {
           return formatError("indexer_remove", err);
       }
   }

   async function handleStop(args: { name: string }): Promise<string> {
       try {
           const manager = await getManager();
           const stopped = await manager.stopIndex(args.name);

           if (!stopped) {
               return `No in-progress operation found for "${args.name}". It may not be loaded or not syncing.`;
           }

           return `Cancellation requested for "${args.name}". The current batch will finish and checkpoint. Run indexer_sync to resume later.`;
       } catch (err) {
           return formatError("indexer_stop", err);
       }
   }
   ```

2. Verify it compiles.
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "mcp/tools/manage"
   ```

3. Commit: `feat(indexer): implement indexer_status + indexer_remove + indexer_stop MCP tools`

---

## Task 6: Implement graph tools (build, query, stats, visualize)

**Files:**
- Modify: `src/indexer/mcp/tools/graph.ts`

**Steps:**

1. Replace the stub with:
   ```typescript
   import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { z } from "zod";
   import { buildCodeGraph, getGraphStats, toMermaidDiagram } from "../../lib/code-graph";
   import { formatError, getManager } from "../shared";

   export function registerGraphTools(server: McpServer): void {
       server.tool(
           "indexer_graph_build",
           "Build a code dependency graph using static import analysis. The index must already exist.",
           {
               name: z.string().describe("Index name."),
           },
           async (args) => ({
               content: [{ type: "text", text: await handleGraphBuild(args) }],
           }),
       );

       server.tool(
           "indexer_graph_query",
           "Query the dependency graph for a specific file. Shows what the file imports and what files depend on it.",
           {
               name: z.string().describe("Index name."),
               file: z.string().describe("File path (relative to index base dir) to query."),
           },
           async (args) => ({
               content: [{ type: "text", text: await handleGraphQuery(args) }],
           }),
       );

       server.tool(
           "indexer_graph_stats",
           "Get statistics about the code dependency graph: total files, edges, most connected files, orphans.",
           {
               name: z.string().describe("Index name."),
           },
           async (args) => ({
               content: [{ type: "text", text: await handleGraphStats(args) }],
           }),
       );

       server.tool(
           "indexer_graph_visualize",
           "Generate a Mermaid diagram of the code dependency graph. Shows the top N most-connected files.",
           {
               name: z.string().describe("Index name."),
               maxNodes: z
                   .number()
                   .min(5)
                   .max(200)
                   .describe("Max nodes in diagram. Default: 30.")
                   .optional(),
           },
           async (args) => ({
               content: [{ type: "text", text: await handleGraphVisualize(args) }],
           }),
       );
   }

   /** Build graph from the index store's file contents. */
   async function buildGraphFromIndex(name: string) {
       const manager = await getManager();
       const indexer = await manager.getIndex(name);
       const store = indexer.getStore();
       const config = indexer.getConfig();

       const fileContents = store.getAllFileContents();

       if (fileContents.size === 0) {
           return null;
       }

       return buildCodeGraph(fileContents, config.baseDir);
   }

   async function handleGraphBuild(args: { name: string }): Promise<string> {
       try {
           const start = performance.now();
           const graph = await buildGraphFromIndex(args.name);

           if (!graph) {
               return `Index "${args.name}" has no file content. Ensure it has been synced with indexer_sync.`;
           }

           const durationMs = performance.now() - start;
           const stats = getGraphStats(graph);

           return [
               `Code graph built for "${args.name}" in ${(durationMs / 1000).toFixed(1)}s.`,
               `  Files: ${stats.totalNodes}`,
               `  Edges: ${stats.totalEdges}`,
               `  Avg imports/file: ${stats.avgImports}`,
               `  Orphan files: ${stats.orphanCount}`,
           ].join("\n");
       } catch (err) {
           return formatError("indexer_graph_build", err);
       }
   }

   async function handleGraphQuery(args: { name: string; file: string }): Promise<string> {
       try {
           const graph = await buildGraphFromIndex(args.name);

           if (!graph) {
               return `No graph data for "${args.name}". Ensure the index has content.`;
           }

           const node = graph.nodes.find(
               (n) => n.path === args.file || n.path.endsWith(args.file),
           );

           if (!node) {
               return `File "${args.file}" not found in graph. Make sure the path is relative to the index base dir.`;
           }

           const imports = graph.edges.filter((e) => e.from === node.path);
           const importedBy = graph.edges.filter((e) => e.to === node.path);

           const lines = [`Dependencies for: ${node.path} (${node.language})\n`];

           if (imports.length > 0) {
               lines.push(`Imports (${imports.length}):`);

               for (const e of imports) {
                   const tag = e.isDynamic ? " (dynamic)" : "";
                   lines.push(`  -> ${e.to}${tag}`);
               }
           }

           if (importedBy.length > 0) {
               lines.push(`\nImported by (${importedBy.length}):`);

               for (const e of importedBy) {
                   lines.push(`  <- ${e.from}`);
               }
           }

           if (imports.length === 0 && importedBy.length === 0) {
               lines.push("No dependency connections found for this file.");
           }

           return lines.join("\n");
       } catch (err) {
           return formatError("indexer_graph_query", err);
       }
   }

   async function handleGraphStats(args: { name: string }): Promise<string> {
       try {
           const graph = await buildGraphFromIndex(args.name);

           if (!graph) {
               return `No graph data for "${args.name}". Ensure the index has content.`;
           }

           const stats = getGraphStats(graph);

           const lines = [
               `Code Graph Statistics for "${args.name}":\n`,
               `Total files: ${stats.totalNodes}`,
               `Total edges: ${stats.totalEdges}`,
               `Avg imports/file: ${stats.avgImports}`,
               `Orphan files: ${stats.orphanCount}`,
           ];

           if (stats.maxImporter) {
               lines.push(`Most imports: ${stats.maxImporter.path} (${stats.maxImporter.count})`);
           }

           if (stats.maxImported) {
               lines.push(`Most imported: ${stats.maxImported.path} (${stats.maxImported.count})`);
           }

           return lines.join("\n");
       } catch (err) {
           return formatError("indexer_graph_stats", err);
       }
   }

   async function handleGraphVisualize(args: { name: string; maxNodes?: number }): Promise<string> {
       try {
           const graph = await buildGraphFromIndex(args.name);

           if (!graph) {
               return `No graph data for "${args.name}". Ensure the index has content.`;
           }

           const mermaid = toMermaidDiagram(graph, { maxNodes: args.maxNodes ?? 30 });

           return [
               `Dependency graph for "${args.name}" (${graph.nodes.length} files, ${graph.edges.length} edges):`,
               "",
               "```mermaid",
               mermaid,
               "```",
           ].join("\n");
       } catch (err) {
           return formatError("indexer_graph_visualize", err);
       }
   }
   ```

2. Verify it compiles.
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "mcp/tools/graph"
   ```

3. Commit: `feat(indexer): implement MCP graph tools (build, query, stats, visualize)`

---

## Task 7: Implement `indexer_models` tool

**Files:**
- Modify: `src/indexer/mcp/tools/models.ts`

**Steps:**

1. Replace the stub with:
   ```typescript
   import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { z } from "zod";
   import { getModelsForType, MODEL_REGISTRY } from "../../lib/model-registry";

   export function registerModelsTools(server: McpServer): void {
       server.tool(
           "indexer_models",
           "List available embedding models. Optionally filter by index type to see best recommendations.",
           {
               type: z
                   .enum(["code", "files", "mail", "chat"])
                   .describe("Filter models by index type. Best matches listed first.")
                   .optional(),
           },
           async (args) => ({
               content: [{ type: "text", text: handleModels(args) }],
           }),
       );
   }

   function handleModels(args: { type?: "code" | "files" | "mail" | "chat" }): string {
       const models = args.type ? getModelsForType(args.type) : MODEL_REGISTRY;

       const lines = [
           args.type
               ? `Embedding models for "${args.type}" indexes (best matches first):\n`
               : `All available embedding models:\n`,
       ];

       for (const m of models) {
           const ram = m.ramGB > 0 ? `${m.ramGB}GB RAM` : m.provider === "cloud" ? "cloud" : "built-in";
           lines.push(`  ${m.id} — ${m.name} (${m.params}, ${m.dimensions}-dim, ${m.speed}, ${ram})`);
           lines.push(`    ${m.description}`);
           lines.push(`    Best for: ${m.bestFor.join(", ")}`);
           lines.push("");
       }

       lines.push("Use with indexer_index: indexer_index({ path: '/path', provider: '<provider>', model: '<model-id>' })");

       return lines.join("\n");
   }
   ```

2. Verify it compiles.
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "mcp/tools/models"
   ```

3. Commit: `feat(indexer): implement indexer_models MCP tool`

---

## Task 8: Register MCP server as CLI subcommand

**Files:**
- Modify: `src/indexer/index.ts`

**Steps:**

1. Add a `mcp-serve` command to the indexer CLI that launches the MCP server. This enables `tools indexer mcp-serve` usage.

   In `src/indexer/index.ts`, add before `async function main()`:
   ```typescript
   program
       .command("mcp-serve")
       .description("Start the indexer MCP server (stdio transport, for AI assistant integration)")
       .action(async () => {
           // Exec the MCP server as a separate process so it owns stdin/stdout
           const proc = Bun.spawn(["bun", "run", import.meta.dir + "/mcp-server.ts"], {
               stdin: "inherit",
               stdout: "inherit",
               stderr: "inherit",
           });

           process.on("SIGINT", () => proc.kill());
           process.on("SIGTERM", () => proc.kill());
           await proc.exited;
           process.exit(proc.exitCode ?? 0);
       });
   ```

2. Verify it compiles.
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "indexer/index"
   ```

3. Test it starts and responds to MCP protocol (should hang waiting for stdio input -- Ctrl+C to exit).
   ```bash
   timeout 2 bun run src/indexer/mcp-server.ts 2>&1 || true
   ```

4. Commit: `feat(indexer): register mcp-serve CLI subcommand`

---

## Task 9: Manual smoke test

**Steps:**

1. Verify the MCP server starts without errors.
   ```bash
   echo '{}' | timeout 2 bun run src/indexer/mcp-server.ts 2>&1 || true
   ```

2. Verify `tools indexer mcp-serve --help` shows the command.
   ```bash
   bun run src/indexer/index.ts --help
   ```

3. Verify all tool registrations by checking the server can initialize (no runtime import errors).
   ```bash
   timeout 3 bun run -e "
     const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
     const { registerSearchTools } = await import('./src/indexer/mcp/tools/search');
     const { registerIndexTools } = await import('./src/indexer/mcp/tools/index');
     const { registerManageTools } = await import('./src/indexer/mcp/tools/manage');
     const { registerGraphTools } = await import('./src/indexer/mcp/tools/graph');
     const { registerModelsTools } = await import('./src/indexer/mcp/tools/models');

     const server = new McpServer({ name: 'test', version: '0.0.1' }, { capabilities: { tools: {} } });
     registerSearchTools(server);
     registerIndexTools(server);
     registerManageTools(server);
     registerGraphTools(server);
     registerModelsTools(server);
     console.log('All tools registered successfully');
   " 2>&1 || true
   ```

4. Run typecheck.
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "mcp"
   ```

5. Commit (if any fixes were needed): `fix(indexer): address MCP smoke test issues`

---

## Task 10: Simplify -- Review all code for reuse, quality, and efficiency

**Files:**
- Review all files created in this plan:
  - `src/indexer/mcp/shared.ts`
  - `src/indexer/mcp/tools/search.ts`
  - `src/indexer/mcp/tools/index.ts`
  - `src/indexer/mcp/tools/manage.ts`
  - `src/indexer/mcp/tools/graph.ts`
  - `src/indexer/mcp/tools/models.ts`
  - `src/indexer/mcp-server.ts`

**Checklist:**

1. **Code reuse**: Are we reimplementing anything that already exists in `src/utils/`?
   - `formatBytes`, `formatDuration`, `formatRelativeTime` from `@app/utils/format` -- already imported where needed.
   - Check that `formatError` helper covers all error paths (no repeated try/catch boilerplate).
   - No copy-paste from CLI commands -- MCP handlers use the lib layer directly.

2. **Code quality**:
   - No `as any` casts.
   - No inline type assertions like `as Array<{...}>` -- use proper interfaces.
   - No parameter sprawl -- handlers take typed arg objects.
   - No redundant state -- single `manager` singleton.
   - Conditional formatting follows the code style rules (braces, empty lines).
   - Tool descriptions are clear, specific, and useful for LLMs.

3. **Efficiency**:
   - Graph tools call `buildGraphFromIndex` which rebuilds the graph each time. This is acceptable for now since the graph is built from in-memory store data. If this becomes a bottleneck, we can cache the graph in the `shared.ts` module, but per YAGNI, skip that for now.
   - `handleSearch` cross-index search properly limits results to avoid unbounded growth.
   - `getManager()` lazily initializes once, not on every call.

4. **DRY**: Ensure no duplicated text formatting patterns across tool handlers. If multiple handlers format the same kind of output, extract a shared formatter.

5. Fix any issues found. Run full typecheck.
   ```bash
   bunx tsgo --noEmit
   ```

6. Run lint.
   ```bash
   bun run lint 2>&1 | head -30
   ```

7. Commit: `refactor(indexer): simplify MCP server code after review`

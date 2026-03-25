# Indexer v3 — Plan 12: Simplify — Code Reuse, Quality, Efficiency

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 38 findings from the /simplify review: N+1 search queries, duplicate functions, copy-pasted patterns, batched SQL extraction, and efficiency improvements across the indexer pipeline.

**Architecture:** Extract shared utilities, batch DB operations, consolidate language maps, eliminate duplicate functions. All changes on `feat/indexer-fixes` branch based on `origin/master`.

**Tech Stack:** TypeScript/Bun, SQLite, existing test framework

---

## HIGH Priority Tasks

---

### Task 1: Fix N+1 DB queries in cosineSearch + rrfHybridSearch

**Finding:** After sqlite-vec returns vector hits, each hit resolves its full doc with a separate `SELECT ... WHERE id = ?`. For 20 results, that is 20 individual DB round-trips.

**Files:**
- **Modify:** `src/utils/search/drivers/sqlite-fts5/index.ts`

**Steps:**

1. **Read** the `cosineSearch` method (lines 370-414). Identify the `for (const hit of hits)` loop that runs a `SELECT ... WHERE id = ?` per hit.

2. **Implement** — replace the per-hit SELECT loop with a batched query:
   ```typescript
   // After getting hits from vectorStore:
   const allDocIds = hits.map((h) => h.docId);
   const filterClause = filters?.sql ? ` AND ${filters.sql}` : "";
   const filterParams = filters?.params ?? [];
   const placeholders = allDocIds.map(() => "?").join(",");

   const rows = this.db
       .query(
           `SELECT c.* FROM ${this.contentTableName} c WHERE c.${this.config.schema.idField} IN (${placeholders})${filterClause}`
       )
       .all(...allDocIds, ...filterParams) as TDoc[];

   // Build lookup map for O(1) access
   const docMap = new Map<string, TDoc>();
   for (const row of rows) {
       const id = String((row as Record<string, unknown>)[this.config.schema.idField]);
       docMap.set(id, row);
   }

   // Preserve original score ordering from vector search
   const results: SearchResult<TDoc>[] = [];
   for (const hit of hits) {
       const doc = docMap.get(hit.docId);
       if (doc) {
           results.push({ doc, score: hit.score, method: "cosine" });
       }
       if (results.length >= limit) {
           break;
       }
   }
   ```

3. **Verify** — The `rrfHybridSearch` method calls `cosineSearch` internally (line 435), so it inherits the fix automatically. No additional changes needed there.

4. **Test** — run `bun test src/indexer/lib/e2e.test.ts` and `bun test src/indexer/lib/store-embedder.test.ts` to confirm search still works.

5. **Commit** — `fix(search): batch N+1 doc lookups in cosineSearch`

---

### Task 2: Centralize estimateTokens — remove 2 duplicate copies

**Finding:** Three identical implementations of `estimateTokens(text) { return Math.ceil(text.length / 4) }`:
- `src/utils/tokens.ts:9` (canonical)
- `src/indexer/lib/chunker.ts:179` (duplicate)
- `src/ask/chat/ChatEngine.ts:324` (duplicate, private method)

**Files:**
- **Modify:** `src/indexer/lib/chunker.ts`
- **Modify:** `src/ask/chat/ChatEngine.ts`

**Steps:**

1. **Modify** `src/indexer/lib/chunker.ts`:
   - Add import: `import { estimateTokens } from "@app/utils/tokens";`
   - Delete the local `estimateTokens` function (lines 178-181).

2. **Modify** `src/ask/chat/ChatEngine.ts`:
   - Add import: `import { estimateTokens } from "@app/utils/tokens";`
   - Delete the private method `estimateTokens` (lines 323-327).
   - Replace all `this.estimateTokens(...)` calls with `estimateTokens(...)`.

3. **Test** — `bun test src/indexer/ && bun test src/ask/` (if tests exist).

4. **Commit** — `refactor: centralize estimateTokens from utils/tokens`

---

### Task 3: Centralize xxhash — extract shared hash utility

**Finding:** `Bun.hash(x).toString(16)` is duplicated in 4 places:
- `src/utils/fs/change-detector.ts:18` — `defaultHash`
- `src/indexer/lib/chunker.ts:184` — `contentHash`
- `src/indexer/lib/sources/source.ts:77` — `defaultHashEntry`
- `src/har-analyzer/core/parser.ts:128` — inline

**Files:**
- **Create:** `src/utils/hash.ts`
- **Modify:** `src/utils/fs/change-detector.ts`
- **Modify:** `src/indexer/lib/chunker.ts`
- **Modify:** `src/indexer/lib/sources/source.ts`
- **Modify:** `src/har-analyzer/core/parser.ts`

**Steps:**

1. **Create** `src/utils/hash.ts`:
   ```typescript
   /**
    * Fast non-cryptographic hash using Bun's built-in xxHash64.
    * Returns a hex string.
    */
   export function xxhash(content: string): string {
       return Bun.hash(content).toString(16);
   }
   ```

2. **Modify** `src/utils/fs/change-detector.ts`:
   - Add import: `import { xxhash } from "@app/utils/hash";`
   - Replace `defaultHash` body with: `return xxhash(content);`

3. **Modify** `src/indexer/lib/chunker.ts`:
   - Add import: `import { xxhash } from "@app/utils/hash";`
   - Replace `contentHash` function body with: `return xxhash(content);`
   - Or inline: replace `contentHash(...)` call sites with `xxhash(...)` and remove the `contentHash` wrapper entirely.

4. **Modify** `src/indexer/lib/sources/source.ts`:
   - Add import: `import { xxhash } from "@app/utils/hash";`
   - Replace `Bun.hash(entry.content).toString(16)` with `xxhash(entry.content)`.

5. **Modify** `src/har-analyzer/core/parser.ts`:
   - Add import: `import { xxhash } from "@app/utils/hash";`
   - Replace `Bun.hash(rawText).toString(16)` (line 128) with `xxhash(rawText)`.

6. **Test** — `bun test src/indexer/ && bun test src/utils/`

7. **Commit** — `refactor: extract shared xxhash utility to utils/hash.ts`

---

### Task 4: Extract shared ensureDynamicLanguages — eliminate duplicate

**Finding:** Identical `ensureDynamicLanguages()` function with its own `let dynamicLangsRegistered = false` guard in two files:
- `src/indexer/lib/chunker.ts:135-173`
- `src/indexer/lib/graph-imports.ts:17-54`

Both register the same 12 language packages via `@ast-grep/napi`.

**Files:**
- **Create:** `src/indexer/lib/ast-languages.ts`
- **Modify:** `src/indexer/lib/chunker.ts`
- **Modify:** `src/indexer/lib/graph-imports.ts`

**Steps:**

1. **Create** `src/indexer/lib/ast-languages.ts`:
   ```typescript
   import { createRequire } from "node:module";
   import { registerDynamicLanguage } from "@ast-grep/napi";

   const esmRequire = createRequire(import.meta.url);

   let dynamicLangsRegistered = false;

   /** Language name -> @ast-grep/lang-XXX package name */
   const DYNAMIC_LANG_PACKAGES: Array<[string, string]> = [
       ["python", "@ast-grep/lang-python"],
       ["go", "@ast-grep/lang-go"],
       ["rust", "@ast-grep/lang-rust"],
       ["java", "@ast-grep/lang-java"],
       ["c", "@ast-grep/lang-c"],
       ["cpp", "@ast-grep/lang-cpp"],
       ["ruby", "@ast-grep/lang-ruby"],
       ["php", "@ast-grep/lang-php"],
       ["swift", "@ast-grep/lang-swift"],
       ["kotlin", "@ast-grep/lang-kotlin"],
       ["scala", "@ast-grep/lang-scala"],
       ["csharp", "@ast-grep/lang-csharp"],
   ];

   /** Register dynamic language grammars. Safe to call multiple times. */
   export function ensureDynamicLanguages(): void {
       if (dynamicLangsRegistered) {
           return;
       }

       dynamicLangsRegistered = true;

       const modules: Record<string, { libraryPath: string; extensions: string[]; languageSymbol?: string }> = {};

       for (const [name, pkg] of DYNAMIC_LANG_PACKAGES) {
           try {
               modules[name] = esmRequire(pkg);
           } catch {
               // Grammar not installed -- skip
           }
       }

       if (Object.keys(modules).length > 0) {
           registerDynamicLanguage(modules);
       }
   }
   ```

2. **Modify** `src/indexer/lib/chunker.ts`:
   - Add import: `import { ensureDynamicLanguages } from "./ast-languages";`
   - Remove `const esmRequire = createRequire(import.meta.url);` (line 8) -- only if no other usage exists. Check first: `esmRequire` is used only for the dynamic languages.
   - Remove local `let dynamicLangsRegistered = false;` (line 135).
   - Remove local `function ensureDynamicLanguages()` (lines 138-173).
   - Remove the `createRequire` import if unused after removal.

3. **Modify** `src/indexer/lib/graph-imports.ts`:
   - Add import: `import { ensureDynamicLanguages } from "./ast-languages";`
   - Remove `const esmRequire = createRequire(import.meta.url);` (line 15).
   - Remove local `let dynamicLangsRegistered = false;` (line 17).
   - Remove local `function ensureDynamicLanguages()` (lines 19-54).
   - Remove the `createRequire` import from `node:module` (line 1).

4. **Test** — `bun test src/indexer/`

5. **Commit** — `refactor: extract ensureDynamicLanguages to ast-languages.ts`

---

### Task 5: Consolidate extension-to-language maps

**Finding:** 4 separate extension-to-language mapping sites:
- `chunker.ts:17-29` — `EXT_TO_LANG` (ext -> ast-grep `Lang` enum)
- `chunker.ts:31-65` — `EXT_TO_LANGUAGE_NAME` (ext -> language string)
- `chunker.ts:68-89` — `EXT_TO_DYNAMIC_LANG` (ext -> dynamic lang string)
- `code-graph.ts:50-97` — `getLanguage()` switch statement (ext -> language string)
- `code-graph.ts:102-117` — `LANGUAGE_EXTENSIONS` (language string -> ext list)

**Files:**
- **Modify:** `src/indexer/lib/ast-languages.ts` (created in Task 4)
- **Modify:** `src/indexer/lib/chunker.ts`
- **Modify:** `src/indexer/lib/code-graph.ts`

**Steps:**

1. **Expand** `src/indexer/lib/ast-languages.ts` to export the consolidated maps:
   ```typescript
   import { Lang } from "@ast-grep/napi";

   /** Extension -> ast-grep built-in Lang (for parse()) */
   export const EXT_TO_LANG: Record<string, Lang> = {
       ".ts": Lang.TypeScript,
       ".tsx": Lang.Tsx,
       ".js": Lang.JavaScript,
       ".jsx": Lang.Tsx,
       ".mjs": Lang.JavaScript,
       ".cjs": Lang.JavaScript,
       ".mts": Lang.TypeScript,
       ".cts": Lang.TypeScript,
       ".html": Lang.Html,
       ".htm": Lang.Html,
       ".css": Lang.Css,
   };

   /** Extension -> human-readable language name (used for chunk metadata and graph) */
   export const EXT_TO_LANGUAGE_NAME: Record<string, string> = {
       ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
       ".mjs": "javascript", ".cjs": "javascript", ".mts": "typescript", ".cts": "typescript",
       ".html": "html", ".htm": "html", ".css": "css",
       ".md": "markdown", ".json": "json",
       ".py": "python", ".pyw": "python", ".pyi": "python",
       ".go": "go", ".rs": "rust", ".java": "java",
       ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp", ".hh": "cpp", ".cxx": "cpp",
       ".rb": "ruby", ".php": "php", ".swift": "swift",
       ".kt": "kotlin", ".kts": "kotlin", ".scala": "scala", ".cs": "csharp",
   };

   /** Extension -> dynamic language string identifier (for registerDynamicLanguage langs) */
   export const EXT_TO_DYNAMIC_LANG: Record<string, string> = {
       ".py": "python", ".pyw": "python", ".pyi": "python",
       ".go": "go", ".rs": "rust", ".java": "java",
       ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp", ".hh": "cpp", ".cxx": "cpp",
       ".rb": "ruby", ".php": "php", ".swift": "swift",
       ".kt": "kotlin", ".kts": "kotlin", ".scala": "scala", ".cs": "csharp",
   };

   /** Language name -> known extensions (inverse of EXT_TO_LANGUAGE_NAME) */
   export const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
       typescript: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
       tsx: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
       python: [".py"], go: [".go"], java: [".java"], rust: [".rs"],
       c: [".c", ".h"], cpp: [".cpp", ".hpp", ".cc", ".hh", ".cxx", ".h"],
       ruby: [".rb"], php: [".php"], swift: [".swift"],
       kotlin: [".kt", ".kts"], scala: [".scala"], csharp: [".cs"],
   };

   /** Get language name from file extension (returns null for unknown) */
   export function getLanguageForExt(ext: string): string | null {
       return EXT_TO_LANGUAGE_NAME[ext.toLowerCase()] ?? null;
   }
   ```

2. **Modify** `src/indexer/lib/chunker.ts`:
   - Import from `./ast-languages`: `{ EXT_TO_LANG, EXT_TO_LANGUAGE_NAME, EXT_TO_DYNAMIC_LANG }`
   - Delete local `EXT_TO_LANG` (lines 17-29), `EXT_TO_LANGUAGE_NAME` (lines 31-65), and `EXT_TO_DYNAMIC_LANG` (lines 68-89).

3. **Modify** `src/indexer/lib/code-graph.ts`:
   - Import from `./ast-languages`: `{ getLanguageForExt, LANGUAGE_EXTENSIONS }`
   - Replace `getLanguage()` function (lines 50-97) with:
     ```typescript
     function getLanguage(filePath: string): string | null {
         return getLanguageForExt(extname(filePath));
     }
     ```
   - Delete local `LANGUAGE_EXTENSIONS` map (lines 102-117).

4. **Test** — `bun test src/indexer/`

5. **Commit** — `refactor: consolidate extension-to-language maps in ast-languages.ts`

---

### Task 6: Extract batched SQL helper — eliminate 5 copy-pasted loops

**Finding:** 5 methods in `store.ts` have identical `batchSize=500` loop pattern:
- `removeChunks` (lines 372-378)
- `getChunkContents` (lines 440-451)
- `getChunkIdsBySourcePaths` (lines 460-472)
- `getChunkIdsBySourceIds` (lines 480-492)
- `clearEmbeddingsBySourceIds` (lines 505-517)

Each does: slice into batches of 500, build `IN (?,?,...)` placeholders, run SQL.

**Files:**
- **Modify:** `src/indexer/lib/store.ts`

**Steps:**

1. **Add** a module-level constant and helper at the top of `store.ts`:
   ```typescript
   /** Max bind parameters per SQL IN(...) clause */
   const SQL_BATCH_SIZE = 500;

   /**
    * Run a batched SQL query for large ID lists that exceed SQLite bind limits.
    * Slices `ids` into batches, builds IN(?,?,...) placeholders, calls `queryFn`.
    */
   function runBatchedQuery<TResult>(opts: {
       ids: string[];
       queryFn: (placeholders: string, batch: string[]) => TResult[];
   }): TResult[] {
       const { ids, queryFn } = opts;
       const results: TResult[] = [];

       for (let i = 0; i < ids.length; i += SQL_BATCH_SIZE) {
           const batch = ids.slice(i, i + SQL_BATCH_SIZE);
           const placeholders = batch.map(() => "?").join(",");
           results.push(...queryFn(placeholders, batch));
       }

       return results;
   }
   ```

2. **Refactor** each of the 5 methods to use the helper. Example for `getChunkContents`:
   ```typescript
   getChunkContents(ids: string[]): Array<{ id: string; content: string }> {
       if (ids.length === 0) {
           return [];
       }

       return runBatchedQuery({
           ids,
           queryFn: (placeholders, batch) =>
               db.query(`SELECT id, content FROM ${contentTable} WHERE id IN (${placeholders})`)
                   .all(...batch) as Array<{ id: string; content: string }>,
       });
   },
   ```
   Apply the same pattern to: `removeChunks` (inside transaction), `getChunkIdsBySourcePaths`, `getChunkIdsBySourceIds`, `clearEmbeddingsBySourceIds`.

3. **Test** — `bun test src/indexer/`

4. **Commit** — `refactor(store): extract runBatchedQuery helper for 5 batched SQL methods`

---

### Task 7: Extract AsyncOpQueue — eliminate duplicate enqueue/flush/drain

**Finding:** Both `LanceDBVectorStore` and `QdrantVectorStore` have identical queue management: `pendingOps`, `flushPromise`, `enqueue()`, `scheduleFlush()`, `drainQueue()`, `flush()`.

**Files:**
- **Modify:** `src/utils/async.ts`
- **Modify:** `src/utils/search/stores/lancedb-vector-store.ts`
- **Modify:** `src/utils/search/stores/qdrant-vector-store.ts`

**Steps:**

1. **Add** `AsyncOpQueue` class to `src/utils/async.ts`:
   ```typescript
   /**
    * A queue that buffers async operations and drains them sequentially.
    * Used by vector stores that wrap async backends behind a sync interface.
    */
   export class AsyncOpQueue {
       private pendingOps: Array<() => Promise<void>> = [];
       private flushPromise: Promise<void> | null = null;
       private label: string;

       constructor(label: string = "AsyncOpQueue") {
           this.label = label;
       }

       enqueue(op: () => Promise<void>): void {
           this.pendingOps.push(op);
           this.scheduleFlush();
       }

       async flush(): Promise<void> {
           if (this.flushPromise) {
               await this.flushPromise;
           }

           while (this.pendingOps.length > 0) {
               await this.drainQueue();
           }
       }

       get pending(): number {
           return this.pendingOps.length;
       }

       private scheduleFlush(): void {
           if (this.flushPromise) {
               return;
           }

           this.flushPromise = this.drainQueue().finally(() => {
               this.flushPromise = null;

               if (this.pendingOps.length > 0) {
                   this.scheduleFlush();
               }
           });
       }

       private async drainQueue(): Promise<void> {
           while (this.pendingOps.length > 0) {
               const op = this.pendingOps.shift()!;

               try {
                   await op();
               } catch (err) {
                   console.error(`[${this.label}] async operation failed:`, err);
               }
           }
       }
   }
   ```

2. **Modify** `src/utils/search/stores/lancedb-vector-store.ts`:
   - Add import: `import { AsyncOpQueue } from "@app/utils/async";`
   - Replace `private pendingOps`, `private flushPromise` fields with: `private queue = new AsyncOpQueue("LanceDBVectorStore");`
   - Replace all `this.enqueue(...)` calls with `this.queue.enqueue(...)`.
   - In `flush()`: replace the manual flush logic with `await this.queue.flush();` (keeping the `initPromise` await before it).
   - Remove private methods: `enqueue()`, `scheduleFlush()`, `drainQueue()`.

3. **Modify** `src/utils/search/stores/qdrant-vector-store.ts`:
   - Same pattern: replace `pendingOps`/`flushPromise`/`enqueue`/`scheduleFlush`/`drainQueue` with `AsyncOpQueue("QdrantVectorStore")`.

4. **Test** — `bun test src/utils/search/` and `bun test src/indexer/`

5. **Commit** — `refactor: extract AsyncOpQueue to utils/async.ts`

---

## MED Priority Tasks

---

### Task 8: Extract bruteForceVectorSearch helper

**Finding:** Both `LanceDBVectorStore.searchMemory()` (lines 202-211) and `QdrantVectorStore.search()` (lines 164-175) have identical brute-force cosine search over `memoryIndex`.

**Files:**
- **Modify:** `src/utils/search/stores/vector-store.ts`
- **Modify:** `src/utils/search/stores/lancedb-vector-store.ts`
- **Modify:** `src/utils/search/stores/qdrant-vector-store.ts`

**Steps:**

1. **Add** to `src/utils/search/stores/vector-store.ts`:
   ```typescript
   import { cosineDistance } from "@app/utils/math";

   /** Brute-force in-memory vector search. Shared by stores that keep an in-memory mirror. */
   export function bruteForceVectorSearch(
       memoryIndex: Map<string, Float32Array>,
       queryVector: Float32Array,
       limit: number,
   ): VectorSearchHit[] {
       const hits: VectorSearchHit[] = [];

       for (const [docId, storedVec] of memoryIndex) {
           const score = 1 - cosineDistance(queryVector, storedVec);
           hits.push({ docId, score });
       }

       hits.sort((a, b) => b.score - a.score);
       return hits.slice(0, limit);
   }
   ```

2. **Modify** `lancedb-vector-store.ts`:
   - Import `bruteForceVectorSearch` from `./vector-store`.
   - Replace `searchMemory()` body: `return bruteForceVectorSearch(this.memoryIndex, queryVector, limit);`
   - Or inline: `search(qv, limit) { return bruteForceVectorSearch(this.memoryIndex, qv, limit); }` and delete `searchMemory`.

3. **Modify** `qdrant-vector-store.ts`:
   - Import `bruteForceVectorSearch` from `./vector-store`.
   - Replace `search()` body with: `return bruteForceVectorSearch(this.memoryIndex, queryVector, limit);`

4. **Commit** — `refactor: extract bruteForceVectorSearch helper`

---

### Task 9: Fix double hashing during sync

**Finding:** In `indexer.ts`, `this.source.hashEntry(entry)` is called multiple times per entry:
- Line 440: during `chunkEntries()` to build `pathEntries`
- Line 818: again in the sync loop to update `pathHashStore`

**Files:**
- **Modify:** `src/indexer/lib/indexer.ts`

**Steps:**

1. **Read** the `chunkEntries` method and the sync loop more carefully.

2. **In `chunkEntries`**: it already computes `hash: this.source.hashEntry(entry)` and returns it in `pathEntries`. The issue is that the sync loop at line 817-819 recomputes the hash:
   ```typescript
   for (const entry of [...changes.added, ...changes.modified]) {
       const hash = this.source.hashEntry(entry);
       pathHashStore.upsert(entry.id, hash, true);
   }
   ```

3. **Fix**: Build a `Map<string, string>` of `entryId -> hash` from the `pathEntries` returned by `chunkEntries()`, and reuse that map at line 817:
   ```typescript
   // After chunkEntries() returns:
   const hashByEntryId = new Map(pathEntries.map((pe) => [pe.path, pe.hash]));

   // At line 817, replace:
   for (const entry of [...changes.added, ...changes.modified]) {
       const hash = hashByEntryId.get(entry.id) ?? this.source.hashEntry(entry);
       pathHashStore.upsert(entry.id, hash, true);
   }
   ```

4. **Note:** Only the entries that went through `chunkEntries()` will be in the map. Entries handled via `onBatch` during scan may not be. The fallback `?? this.source.hashEntry(entry)` handles that case safely.

5. **Test** — `bun test src/indexer/`

6. **Commit** — `perf(indexer): avoid double hashing entries during sync`

---

### Task 10: Fix per-insert queryCount in SearchEngine

**Finding:** `this.docCount = this.queryCount()` (line 303 in `sqlite-fts5/index.ts`) runs a `SELECT COUNT(*)` after every single document insert. During bulk sync of 1000 docs, that is 1000 extra COUNT queries.

**Files:**
- **Modify:** `src/utils/search/drivers/sqlite-fts5/index.ts`

**Steps:**

1. **Read** the `insert()` method and where `docCount` is used. It is only used in `bm25Search` for IDF scoring (optional) and the public `queryCount()` accessor.

2. **Fix**: Instead of running `this.queryCount()` after each insert, simply increment `this.docCount` by 1:
   ```typescript
   // Replace: this.docCount = this.queryCount();
   // With:
   this.docCount++;
   ```
   The `docCount` is initialized via `this.queryCount()` in the constructor, so incrementing keeps it accurate. For bulk inserts, this avoids N extra SELECTs.

3. **Also** ensure `remove()` (if it exists) decrements `docCount--` accordingly.

4. **Test** — `bun test src/indexer/`

5. **Commit** — `perf(search): avoid per-insert COUNT(*) in SearchEngine`

---

### Task 11: Batch vector store removals

**Finding:** In `store.ts:384-388`, removing chunks iterates one-by-one: `for (const id of chunkIds) { vectorStore.remove(id); }`. The `SqliteVecVectorStore` could accept a batch.

**Files:**
- **Modify:** `src/utils/search/stores/sqlite-vec-store.ts`
- **Modify:** `src/utils/search/stores/vector-store.ts`
- **Modify:** `src/indexer/lib/store.ts`

**Steps:**

1. **Add** optional `removeMany` to the `VectorStore` interface in `vector-store.ts`:
   ```typescript
   export interface VectorStore {
       store(id: string, vector: Float32Array): void;
       remove(id: string): void;
       /** Batch remove. Default: calls remove() per id. */
       removeMany?(ids: string[]): void;
       search(queryVector: Float32Array, limit: number): VectorSearchHit[];
       count(): number;
   }
   ```

2. **Add** `removeMany()` to `SqliteVecVectorStore`:
   ```typescript
   removeMany(ids: string[]): void {
       if (ids.length === 0) {
           return;
       }

       for (let i = 0; i < ids.length; i += 500) {
           const batch = ids.slice(i, i + 500);
           const placeholders = batch.map(() => "?").join(",");
           this.db.run(`DELETE FROM ${this.vecTable} WHERE doc_id IN (${placeholders})`, batch);
       }
   }
   ```

3. **Modify** `store.ts` `removeChunks`:
   ```typescript
   if (vectorStoreForRemoval) {
       if (vectorStoreForRemoval.removeMany) {
           vectorStoreForRemoval.removeMany(chunkIds);
       } else {
           for (const id of chunkIds) {
               vectorStoreForRemoval.remove(id);
           }
       }
   }
   ```

4. **Commit** — `perf(store): batch vector store removals via removeMany()`

---

### Task 12: Use truncateText from utils in search.ts

**Finding:** `src/indexer/commands/search.ts:18-26` has a custom `truncatePreview` that does the same as `truncateText` from `@app/utils/string` (but also collapses whitespace first).

**Files:**
- **Modify:** `src/indexer/commands/search.ts`

**Steps:**

1. **Replace** the `truncatePreview` function:
   ```typescript
   import { truncateText } from "@app/utils/string";

   function truncatePreview(text: string, maxLen: number): string {
       const collapsed = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
       return truncateText(collapsed, maxLen);
   }
   ```
   This still does the whitespace collapsing (which `truncateText` does not) but delegates the truncation.

2. **Commit** — `refactor: use truncateText from utils/string in search command`

---

### Task 13: DRY detectChanges — delegate to detectChangesPreHashed

**Finding:** `detectChanges` (lines 36-66) and `detectChangesPreHashed` (lines 77-106) in `change-detector.ts` have identical diff logic. The only difference is that `detectChanges` hashes content first.

**Files:**
- **Modify:** `src/utils/fs/change-detector.ts`

**Steps:**

1. **Refactor** `detectChanges` to hash first, then delegate:
   ```typescript
   export function detectChanges(input: DetectChangesInput): ChangeSet {
       const { current, previous, hashFn = defaultHash } = input;

       const currentHashes = new Map<string, string>();
       for (const [path, content] of current) {
           currentHashes.set(path, hashFn(content));
       }

       return detectChangesPreHashed({
           currentHashes,
           previousHashes: previous,
       });
   }
   ```

2. **Test** — `bun test src/utils/` if tests exist for change-detector.

3. **Commit** — `refactor: DRY detectChanges by delegating to detectChangesPreHashed`

---

### Task 14: Fix FileSource.estimateTotal duplicating scan logic

**Finding:** `FileSource.estimateTotal()` (lines 114-147) and `FileSource.scan()` (lines 34-104) share identical file-listing and filtering logic. The only difference is that `scan()` reads content and `estimateTotal()` just counts.

**Files:**
- **Modify:** `src/indexer/lib/sources/file-source.ts`

**Steps:**

1. **Extract** a private method `getFilteredFilePaths()`:
   ```typescript
   private async getFilteredFilePaths(): Promise<string[]> {
       let filePaths: string[];

       if (this.opts.respectGitIgnore) {
           const isGit = await this.checkIsGitRepo();
           filePaths = isGit ? await this.getGitTrackedFiles() : this.walkDirectory();
       } else {
           filePaths = this.walkDirectory();
       }

       if (this.opts.includedSuffixes && this.opts.includedSuffixes.length > 0) {
           const suffixSet = new Set(this.opts.includedSuffixes.map((s) => (s.startsWith(".") ? s : `.${s}`)));
           filePaths = filePaths.filter((f) => suffixSet.has(extname(f).toLowerCase()));
       }

       if (this.opts.ignoredPaths && this.opts.ignoredPaths.length > 0) {
           const ignored = this.opts.ignoredPaths;
           filePaths = filePaths.filter((f) => {
               const rel = relative(this.absBaseDir, f);
               return !ignored.some((pattern) => rel.startsWith(pattern) || rel.includes(pattern));
           });
       }

       if (this.ignoreFilter) {
           filePaths = filePaths.filter((f) => !this.isIgnoredByFilter(f));
       }

       return filePaths;
   }
   ```

2. **Simplify** `scan()` -- replace lines 35-64 with `let filePaths = await this.getFilteredFilePaths();`.

3. **Simplify** `estimateTotal()`:
   ```typescript
   async estimateTotal(): Promise<number> {
       const filePaths = await this.getFilteredFilePaths();
       return filePaths.length;
   }
   ```

4. **Test** — `bun test src/indexer/`

5. **Commit** — `refactor(file-source): extract getFilteredFilePaths to DRY scan/estimateTotal`

---

### Task 15: Fix redundant searchMode computation in indexer.ts

**Finding:** `searchMode` is assigned at line 212, then `mode` is re-derived at line 233 with the same value.

**Files:**
- **Modify:** `src/indexer/lib/indexer.ts`

**Steps:**

1. **Read** lines 210-235 carefully. Line 212: `const searchMode = opts?.mode ?? "fulltext";`. Line 233: `const mode = searchOpts.mode ?? "fulltext";` -- but `searchOpts.mode` was just set to `searchMode` at line 218.

2. **Fix**: Remove line 233 and use `searchMode` directly in line 235-240:
   ```typescript
   this.store.logSearch({
       query,
       mode: searchMode,
       resultsCount: results.length,
       durationMs,
   });
   ```

3. **Commit** — `fix(indexer): remove redundant searchMode re-derivation`

---

### Task 16: Fix coreml-contextual dimensions mismatch (512 vs 768)

**Finding:**
- `src/utils/ai/providers/index.ts:32` creates `AICoreMLProvider` with `dimensions: 768` (correct -- NLContextualEmbedding outputs 768-dim).
- `src/indexer/lib/model-registry.ts:138` registers `coreml-contextual` with `dimensions: 512` (wrong).

**Files:**
- **Modify:** `src/indexer/lib/model-registry.ts`

**Steps:**

1. **Fix** line 138 in model-registry.ts: change `dimensions: 512` to `dimensions: 768`.

2. **Commit** — `fix(model-registry): correct coreml-contextual dimensions to 768`

---

### Task 17: Fix parser type cast missing "character"

**Finding:** Lines 728 and 809 in `indexer.ts` cast `info.parser` to `"ast" | "line" | "heading" | "message" | "json"`, but the `ChunkResult["parser"]` type also includes `"character"`. The cast drops a valid variant.

**Files:**
- **Modify:** `src/indexer/lib/indexer.ts`

**Steps:**

1. **Fix** both lines 728 and 809 -- replace the inline union cast with the proper type:
   ```typescript
   import type { ChunkResult } from "./chunker";

   // Replace:
   //   parser: info.parser as "ast" | "line" | "heading" | "message" | "json",
   // With:
   parser: info.parser as ChunkResult["parser"],
   ```

2. **Verify** `ChunkResult` is already imported (it should be since `chunkFile` is used). If not, add the import.

3. **Commit** — `fix(indexer): include "character" in parser type cast`

---

## LOW Priority Tasks

---

### Task 18: Extract SQL_BATCH_SIZE constant

**Note:** This is already handled by Task 6 which introduces `SQL_BATCH_SIZE` as a module constant. Mark as done after Task 6.

---

### Task 19: Fix one-line if without braces in test fixture files

**Finding:** Lines like `if (n <= 1) return n;` appear in test fixture strings (written via `writeFileSync` as TypeScript content under test). These are not actual code style violations -- they are test fixture data representing third-party code being indexed.

**Decision:** SKIP -- these are fixture strings, not project code. Changing them would alter test behavior.

---

### Task 20: Rename conflicting ModelInfo interfaces

**Finding:** Two `ModelInfo` interfaces:
- `src/indexer/lib/model-registry.ts:3` -- used for embedding model metadata
- `src/utils/ai/ModelManager.ts:13` -- used for transcription model metadata

**Files:**
- **Modify:** `src/utils/ai/ModelManager.ts`

**Steps:**

1. **Rename** in `ModelManager.ts`: `ModelInfo` -> `TranscriptionModelInfo` (it has `id`, `name`, `description` -- scoped to HF transcription models). Update all references within that file.

2. **Check** for any external imports of `ModelInfo` from `ModelManager.ts`. If none, rename is safe.

3. **Commit** — `refactor: rename ModelManager.ModelInfo to TranscriptionModelInfo`

---

### Task 21: Remove dead searchEmbedding field or add TODO

**Finding:** `IndexMeta.searchEmbedding` (types.ts:92) exists in the interface and is stored/read in `store.ts`, but is never populated with actual data anywhere in the codebase.

**Files:**
- **Modify:** `src/indexer/lib/types.ts`

**Steps:**

1. **Search** for any usage of `searchEmbedding` across the codebase. If it is only in the interface definition and the generic meta read/write, add a TODO:
   ```typescript
   /** @todo Not yet populated -- reserved for separate search-time embedding model */
   searchEmbedding?: EmbeddingModelInfo;
   ```

2. **Commit** — `docs: add TODO for unused searchEmbedding field`

---

### Task 22: Cache parsed meta in store.ts

**Finding:** `readMeta()` is called in `getStats()`, `getMeta()`, and potentially on every `updateMeta()`. Each call does a SELECT + JSON.parse.

**Files:**
- **Modify:** `src/indexer/lib/store.ts`

**Steps:**

1. **Add** a closure variable `let cachedMeta: IndexMeta | null = null;` at the `createIndexStore` scope.

2. **In `readMeta()`**: after parsing, set `cachedMeta = result;`.

3. **In `getMeta()`** and **`getStats()`**: return from `cachedMeta` if set.

4. **In `updateMeta()`**: after writing to DB, set `cachedMeta = current;`.

5. **Add** a `invalidateMetaCache()` if needed for external invalidation.

6. **Commit** — `perf(store): cache parsed IndexMeta to avoid repeated SELECT + JSON.parse`

---

### Task 23: Skip unnecessary DELETE in sqlite-vec for new chunks

**Finding:** `SqliteVecVectorStore.store()` always runs `DELETE FROM ... WHERE doc_id = ?` before `INSERT`, even for new chunks that definitely don't exist.

**Files:**
- **Modify:** `src/utils/search/stores/sqlite-vec-store.ts`

**Steps:**

1. **This is a vec0 limitation** -- vec0 does not support `INSERT OR REPLACE`. The DELETE-then-INSERT pattern is the documented workaround. However, we can add a `storeNew()` method that uses `INSERT OR IGNORE` for known-new chunks:
   ```typescript
   /** Batch store for known-new vectors (skips the precautionary DELETE). */
   storeNew(id: string, vector: Float32Array): void {
       const blob = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
       this.db.run(`INSERT OR IGNORE INTO ${this.vecTable}(doc_id, embedding) VALUES (?, ?)`, [id, blob]);
   }
   ```

2. **Decision**: The overhead of one extra DELETE per insert is negligible (SQLite is fast for single-row DELETEs on primary key). Mark as WONTFIX unless benchmarks show it matters. Add a code comment explaining the vec0 limitation.

3. **Commit** — `docs(sqlite-vec): document vec0 DELETE-before-INSERT requirement`

---

### Task 24: Warn on large brute-force scan in sqlite-vector-store

**Finding:** `SqliteVectorStore.search()` (line 34) loads ALL embeddings from disk into memory for brute-force scoring. No warning for large datasets.

**Files:**
- **Modify:** `src/utils/search/stores/sqlite-vector-store.ts`

**Steps:**

1. **Add** a one-time warning when count exceeds threshold:
   ```typescript
   private warnedLargeScan = false;

   search(queryVector: Float32Array, limit: number): VectorSearchHit[] {
       const rows = this.db.query(...).all() as ...;

       if (!this.warnedLargeScan && rows.length > 10_000) {
           console.warn(
               `[SqliteVectorStore] Brute-force scanning ${rows.length} vectors. ` +
               `Consider using sqlite-vec or LanceDB for better performance.`
           );
           this.warnedLargeScan = true;
       }
       // ... rest unchanged
   }
   ```

2. **Commit** — `perf(sqlite-vector): warn on brute-force scan over 10k vectors`

---

### Task 25: Pass pre-split lines between chunker functions

**Finding:** `chunker.ts` calls `content.split("\n")` multiple times within the same chunk pipeline (e.g., in `splitChunkByLines`, `subChunkLargeNode`, `mergeSmallChunks`).

**Decision:** SKIP for now -- the split is on small per-chunk content (typically <2000 chars), not the whole file. The overhead is negligible. A refactor would complicate function signatures for minimal gain.

---

### Task 26: Use interval containment in deduplicateChunks instead of string includes

**Finding:** `deduplicateChunks` (lines 680-697) uses `other.content.includes(chunk.content)` for O(n*m) string search. Since chunks are sorted by line and have `startLine`/`endLine`, interval containment (`other.startLine <= chunk.startLine && other.endLine >= chunk.endLine`) is sufficient and O(1) per pair.

**Files:**
- **Modify:** `src/indexer/lib/chunker.ts`

**Steps:**

1. **Replace** the containment check:
   ```typescript
   const isContained = chunks.some(
       (other) =>
           other.id !== chunk.id &&
           other.startLine <= chunk.startLine &&
           other.endLine >= chunk.endLine &&
           other.content.length > chunk.content.length
   );
   ```
   This removes the expensive `includes()` string scan while maintaining correctness (line-range containment plus length check).

2. **Commit** — `perf(chunker): use line-range containment in deduplicateChunks`

---

### Task 27: Build chunk Map in insertChunks to avoid find() loop

**Finding:** In `store.ts:315`, during `insertChunks()` with embeddings, `chunks.find((c) => c.id === chunkId)` runs for each embedding entry. For N embeddings, that is O(N*M) where M = chunks.length.

**Files:**
- **Modify:** `src/indexer/lib/store.ts`

**Steps:**

1. **Build** a lookup map before the embedding loop:
   ```typescript
   if (embeddings && embeddings.size > 0) {
       const chunkMap = new Map(chunks.map((c) => [c.id, c]));
       const vectorStore = fts.getVectorStore();

       if (qdrantStore) {
           for (const [chunkId, vector] of embeddings) {
               const chunk = chunkMap.get(chunkId);
               const text = chunk?.content ?? "";
               qdrantStore.storeWithText(chunkId, vector, text);
           }
           // ... rest unchanged
       }
   }
   ```

2. **Commit** — `perf(store): use Map lookup in insertChunks instead of find() loop`

---

### Task 28: Final simplify pass — verify all changes, run tests

**Steps:**

1. **Run** full type check: `tsgo --noEmit 2>&1 | rg "src/indexer/|src/utils/"` -- must be 0 errors.

2. **Run** all tests: `bun test src/indexer/ && bun test src/utils/`

3. **Review** all changed files for:
   - No unused imports left behind
   - No orphaned local functions after extraction
   - Code style compliance (braces on `if`, spacing, etc.)
   - No `as any` introduced

4. **Run** `git diff --stat` to verify scope of changes is reasonable.

5. **Commit** — `chore: final cleanup after simplify pass`

# Efficiency Review Report

**Date:** 2026-03-23 01:37:32
**Branch:** feat/indexer-fixes
**Scope:** .ts file changes only (efficiency focus)

## Summary

Reviewed ~2250 lines of diff across 25+ TypeScript files. The changes are largely positive efficiency work: consolidating duplicated hash/queue/search helpers, replacing N+1 SQL with batch lookups, caching `IndexMeta`, and adding `removeMany` to vector stores. A few items remain that could be tightened further.

---

## Findings

### 1. `FileSource.getFilteredFilePaths()` re-walks the filesystem on every call (no cache)

**File:** `src/indexer/lib/sources/file-source.ts:90-118`
**Severity:** MED

**Problem:**
The refactor correctly DRYed `scan()` and `estimateTotal()` into a shared `getFilteredFilePaths()`. However, both `scan()` and `estimateTotal()` call it independently, and each call spawns a `git ls-files` subprocess + walks+filters the full file tree. In the `sync` command, `estimateTotal()` is called for progress tracking and then `scan()` is called immediately after -- resulting in two full filesystem walks for the same index.

```typescript
 90:    private async getFilteredFilePaths(): Promise<string[]> {
 91:        let filePaths: string[];
 92:
 93:        if (this.opts.respectGitIgnore) {
 94:            const isGit = await this.checkIsGitRepo();
 95:            filePaths = isGit ? await this.getGitTrackedFiles() : this.walkDirectory();
```

**Suggested fix:**
Cache the result with a short TTL or a simple dirty flag. Since `FileSource` instances are short-lived per sync cycle, a single-use cache is safe:

```typescript
private cachedFilePaths: string[] | null = null;

private async getFilteredFilePaths(): Promise<string[]> {
    if (this.cachedFilePaths) {
        return this.cachedFilePaths;
    }
    // ... existing logic ...
    this.cachedFilePaths = filePaths;
    return filePaths;
}
```

---

### 2. Sequential index searches in `searchIndexes()` -- missed concurrency

**File:** `src/indexer/commands/search.ts:68-75`
**Severity:** LOW

**Problem:**
When searching across multiple indexes, each index is queried sequentially. Each `indexer.search()` call does independent SQLite FTS5 + vector work against separate database files. These are independent I/O operations that could run in parallel.

```typescript
 68:    for (const name of indexNames) {
 69:        const indexer = await manager.getIndex(name);
 70:        const results = await indexer.search(query, { mode, limit });
 71:
 72:        for (const result of results) {
 73:            allResults.push({ indexName: name, result });
 74:        }
 75:    }
```

**Suggested fix:**
Use `Promise.all` (or `Promise.allSettled`) to search indexes concurrently:

```typescript
const perIndex = await Promise.all(
    indexNames.map(async (name) => {
        const indexer = await manager.getIndex(name);
        const results = await indexer.search(query, { mode, limit });
        return results.map((result) => ({ indexName: name, result }));
    })
);
const allResults = perIndex.flat();
```

Note: this is LOW because in practice most users have 1-3 indexes, so the sequential penalty is small. But it's free concurrency for the multi-index case.

---

### 3. Redundant `getIndex` + `getConsistencyInfo` on auto-fallback path

**File:** `src/indexer/commands/search.ts:122-123` and `src/indexer/commands/search.ts:144-145`
**Severity:** LOW

**Problem:**
When `mode` is auto-detected, `manager.getIndex(names[0])` is called at line 122 to detect mode. Then inside `searchIndexes()` at line 69, `manager.getIndex(names[0])` is called again. If fulltext returns 0 results, line 144 calls `manager.getIndex(names[0])` a third time. The `getIndex` call is cached in the manager's map after the first call, so only the first is expensive (opens DB). The subsequent `getConsistencyInfo()` calls at lines 123 and 145 each hit the DB. The second one (line 145) is redundant since the embedding count cannot change between the two calls.

```typescript
122:                    const firstIndexer = await manager.getIndex(names[0]);
123:                    mode = detectMode(firstIndexer);
...
144:                    const firstIndexer = await manager.getIndex(names[0]);
145:                    const info = firstIndexer.getConsistencyInfo();
```

**Suggested fix:**
Hoist the `firstIndexer` and its `embeddingCount` to a single lookup before the search, then reuse in the fallback:

```typescript
const firstIndexer = await manager.getIndex(names[0]);
const firstInfo = firstIndexer.getConsistencyInfo();
const mode = opts.mode ?? (firstInfo.embeddingCount > 0 ? "hybrid" : "fulltext");
// ... later in fallback ...
if (allResults.length === 0 && mode === "fulltext" && !opts.mode && firstInfo.embeddingCount > 0) {
```

---

### 4. `deduplicateChunks` remains O(n^2) after the optimization

**File:** `src/indexer/lib/chunker.ts:547-570`
**Severity:** LOW

**Problem:**
The diff replaces `other.content.includes(chunk.content)` (O(n*m) string scan) with `other.content.length > chunk.content.length` (O(1) comparison), which is a significant improvement per comparison. However, the outer structure is still `chunks.some()` nested inside a `for` loop -- O(n^2) overall. For typical file-level chunk counts (10-50 per file) this is fine, but for large JSON or flat files that produce hundreds of chunks it could add up.

```typescript
554:    for (const chunk of chunks) {
555:        const isContained = chunks.some(
556:            (other) =>
557:                other.id !== chunk.id &&
558:                other.startLine <= chunk.startLine &&
559:                other.endLine >= chunk.endLine &&
560:                other.content.length > chunk.content.length
561:        );
```

**Suggested fix (future):**
Sort chunks by `startLine` ascending, then by `endLine` descending (longest range first). This lets you use a single scan: for each chunk, only check the previous chunk (or a small sliding window) to see if it's contained. Reduces to O(n log n) for the sort + O(n) for the scan.

Not urgent because per-file chunk counts are typically small.

---

### 5. `bruteForceVectorSearch` allocates all hits then sorts+slices

**File:** `src/utils/search/stores/vector-store.ts:24-32`
**Severity:** LOW

**Problem:**
The shared `bruteForceVectorSearch` pushes every vector in the memory index into a `hits` array, sorts the entire array, then slices to `limit`. For large in-memory indexes (10k+ vectors), this allocates a large temporary array and does a full sort when only the top-k are needed.

```typescript
24:    const hits: VectorSearchHit[] = [];
25:
26:    for (const [docId, storedVec] of memoryIndex) {
27:        const score = 1 - cosineDistance(queryVector, storedVec);
28:        hits.push({ docId, score });
29:    }
30:
31:    hits.sort((a, b) => b.score - a.score);
32:    return hits.slice(0, limit);
```

**Suggested fix:**
Use a bounded min-heap of size `limit` to keep only top-k during iteration. This reduces from O(n log n) sort to O(n log k) and avoids the large intermediate array. However, since the `SqliteVectorStore` already warns at 10k+ and recommends switching to sqlite-vec/LanceDB, this is a minor concern for the brute-force fallback path.

---

### 6. `SqliteVecVectorStore.removeMany` uses hardcoded batch size 500

**File:** `src/utils/search/stores/sqlite-vec-store.ts:44-55`
**Severity:** LOW

**Problem:**
The new `removeMany` method uses a hardcoded `500` batch size, duplicating the `SQL_BATCH_SIZE` constant defined in `src/indexer/lib/store.ts`. If the SQLite bind limit changes or is tuned differently, these could drift apart.

```typescript
 49:        for (let i = 0; i < ids.length; i += 500) {
 50:            const batch = ids.slice(i, i + 500);
 51:            const placeholders = batch.map(() => "?").join(",");
 52:            this.db.run(`DELETE FROM ${this.vecTable} WHERE doc_id IN (${placeholders})`, batch);
 53:        }
```

**Suggested fix:**
Extract the batch size constant to a shared location (e.g., `src/utils/search/constants.ts` or import from `store.ts`) so all batched SQL operations use the same value.

---

### 7. Same MCP search tool duplicates mode-detection logic

**File:** `src/indexer/mcp/tools/search.ts:71-81`
**Severity:** LOW

**Problem:**
The MCP search handler has its own copy of the auto-detect-mode logic (check `getConsistencyInfo().embeddingCount > 0`), separate from the `detectMode()` function introduced in `src/indexer/commands/search.ts`. If the detection heuristic changes (e.g., minimum embedding threshold), only one location would be updated.

```typescript
 73:        if (!args.mode) {
 74:            const names = args.indexName ? [args.indexName] : manager.getIndexNames();
 75:
 76:            if (names.length > 0) {
 77:                const first = await manager.getIndex(names[0]);
 78:                const info = first.getConsistencyInfo();
 79:                mode = info.embeddingCount > 0 ? "hybrid" : "fulltext";
 80:            }
 81:        }
```

**Suggested fix:**
Export `detectMode` from the search module (or a shared lib file) and reuse it in the MCP handler.

---

## Positive Observations

- **N+1 SQL fix in vectorSearch**: Replacing the per-hit `SELECT ... WHERE id = ?` with a single batched `IN(...)` lookup in `sqlite-fts5/index.ts` is a significant improvement for vector search. Well done.
- **Shared `runBatchedQuery` helper**: Consolidating 5 copy-pasted batch loops in `store.ts` into a single `runBatchedQuery` function is clean and reduces maintenance burden.
- **`cachedMeta` in store**: Caching `IndexMeta` with proper invalidation on `updateMeta()` eliminates repeated `SELECT + JSON.parse` on a hot path (called from `getConsistencyInfo`, `getMeta`, `updateMeta`).
- **`AsyncOpQueue` extraction**: Deduplicating the queue logic from LanceDB and Qdrant vector stores into a shared utility is good factoring.
- **`bruteForceVectorSearch` shared function**: Extracting identical brute-force search from two vector stores into `vector-store.ts` eliminates code duplication.
- **`xxhash()` centralization**: Wrapping `Bun.hash().toString(16)` in a single function avoids scattered `.toString(16)` calls and makes it easy to swap hash implementations later.
- **`removeMany` on VectorStore interface**: Adding optional batch removal avoids the O(n) individual-delete loop for sqlite-vec stores.
- **`chunkMap` in Qdrant insertion**: Replacing `chunks.find()` with a `Map` lookup inside the embedding insertion loop fixes an O(n*m) pattern.
- **Increment/decrement `docCount`**: Replacing `this.docCount = this.queryCount()` (a `SELECT COUNT(*)`) with simple `++`/`--` on insert/remove is a meaningful micro-optimization on the hot insert path.

## Statistics

- Files reviewed: 25 (TypeScript only)
- HIGH issues: 0
- MED issues: 1
- LOW issues: 6

# Code Review Report — Indexer Performance & Architecture

**Date:** 2026-03-20 15:59:00
**Branch:** feat/indexer2
**Scope:** 45 commits (393fc96c..42e30a90), ~11,000 lines
**Focus:** Performance bottlenecks, architectural issues, optimization opportunities

**Reviewed Files:**
- `src/indexer/lib/indexer.ts` (707 lines)
- `src/indexer/lib/store.ts` (457 lines)
- `src/indexer/lib/sources/mail-source.ts` (184 lines)
- `src/indexer/lib/sources/file-source.ts` (224 lines)
- `src/indexer/lib/sources/source.ts` (52 lines)
- `src/indexer/lib/chunker.ts` (618 lines)
- `src/indexer/lib/path-hashes.ts` (65 lines)
- `src/indexer/lib/types.ts` (91 lines)
- `src/indexer/lib/events.ts` (235 lines)
- `src/utils/ai/tasks/Embedder.ts` (43 lines)
- `src/utils/ai/providers/AIDarwinKitProvider.ts` (67 lines)
- `src/utils/macos/nlp.ts` (206 lines)
- `src/utils/macos/darwinkit.ts` (35 lines)
- `src/utils/search/drivers/sqlite-fts5/index.ts` (393 lines)
- `src/utils/search/stores/sqlite-vector-store.ts` (60 lines)
- `src/macos/lib/mail/emlx.ts` (203 lines)

## Summary

The indexer is a well-structured system with a clean source/chunk/embed/store pipeline. However, the embedding phase has a fundamental concurrency model mismatch that explains the observed 67/sec rate vs. the theoretical ~300/sec. The scan phase has significant redundant computation in `onBatch`, and the database layer performs several repeated queries that compound at scale. The vector search implementation is brute-force O(N) which will degrade with index growth.

---

## Critical Issues

### 1. Embedding Concurrency Anti-Pattern: 1000 Promises on a Sequential Bridge

**File:** `src/indexer/lib/indexer.ts:400-404`
**Severity:** Critical
**Estimated Impact:** 3-4x throughput loss (67/sec observed vs. ~200-300/sec achievable)

**Problem:**
The embedding loop fires 1000 concurrent promises via `Promise.allSettled`, but each promise calls `this.embedder!.embed()` which goes through the DarwinKit N-API singleton. The N-API bridge processes calls sequentially — the Swift NLEmbedding framework is single-threaded. This means 999 promises are created, queued in the microtask queue, and sit idle while exactly one processes at a time. The overhead is:
- Creating 1000 Promise objects per page
- 1000 N-API context switches per page
- 1000 individual `Float32Array` allocations from `new Float32Array(result.vector)`
- GC pressure from the 999 idle promise closures

```typescript
400:            // Embed all concurrently — allSettled so one failure doesn't kill the batch
401:            const validPage = page.filter((c) => c.content.length >= 5);
402:            const results = await Promise.allSettled(
403:                validPage.map((c) => this.embedder!.embed(c.content.slice(0, maxEmbedChars)))
404:            );
```

Additionally, `Embedder.embedMany` at `src/utils/ai/tasks/Embedder.ts:36-38` has the same issue:

```typescript
36:    async embedMany(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
37:        return Promise.all(texts.map((t) => this.provider.embed(t, options)));
38:    }
```

**Recommendation:**
Since the DarwinKit bridge is sequential, use a simple `for` loop or a small-batch sequential approach. This eliminates promise/microtask overhead and lets the bridge process without context-switching overhead. Even better, add a batch embedding method to the DarwinKit N-API bridge itself that accepts an array of strings and returns an array of vectors in a single N-API call.

**Suggested Fix (immediate, no bridge changes):**
```typescript
// Sequential — eliminates 999 wasted promise allocations per page
const batchEmbeddings = new Map<string, Float32Array>();
const zeroDims = this.embedder.dimensions;

for (const c of validPage) {
    try {
        const result = await this.embedder!.embed(c.content.slice(0, maxEmbedChars));
        batchEmbeddings.set(c.id, result.vector);
    } catch {
        batchEmbeddings.set(c.id, new Float32Array(zeroDims));
    }
}
```

**Suggested Fix (optimal, requires DarwinKit changes):**
Add `embedBatch(texts: string[]): Promise<EmbedResult[]>` to the N-API bridge that sends all strings in one call and receives all vectors back in one N-API round-trip. This would reduce N-API overhead from O(N) to O(1) per page.

---

### 2. `getStats()` Called 4+ Times Per Batch, Each Time Hitting DB

**File:** `src/indexer/lib/store.ts:355-386` and `src/indexer/lib/indexer.ts:505-517`, `665-675`
**Severity:** Critical
**Estimated Impact:** ~2000 unnecessary DB queries per full mail sync (500 batches x 4 calls)

**Problem:**
`getStats()` runs 3 DB queries every call: COUNT on content table, file size check, and COUNT+AVG on search_log. It also calls `readMeta()` which parses JSON from the DB. In `runSync`, this method is called:

1. Inside `onBatch` at line 505: `const currentStats = this.store.getStats()`
2. Inside `onBatch` at line 506-525: `this.store.updateMeta(...)` which calls `readMeta()` again
3. At finalization lines 665-675: `this.store.getStats()` called **three separate times**

```typescript
665:            this.store.updateMeta({
666:                lastSyncAt: Date.now(),
667:                stats: {
668:                    totalFiles,
669:                    totalChunks: this.store.getStats().totalChunks,
670:                    totalEmbeddings: embeddingsGenerated,
671:                    embeddingDimensions: this.embedder?.dimensions ?? 0,
672:                    dbSizeBytes: this.store.getStats().dbSizeBytes,
673:                    lastSyncDurationMs: durationMs,
674:                    searchCount: this.store.getStats().searchCount,
675:                    avgSearchDurationMs: this.store.getStats().avgSearchDurationMs,
```

Lines 669, 672, 674, 675 each call `getStats()` independently — that's 4 calls (= 12 DB queries + 4 JSON parses) when a single call would suffice.

**Recommendation:**
Call `getStats()` once and reuse the result. In `onBatch`, consider updating metadata only every N batches instead of every batch.

**Suggested Fix:**
```typescript
// Finalization — call once
const finalStats = this.store.getStats();
this.store.updateMeta({
    lastSyncAt: Date.now(),
    stats: {
        totalFiles,
        totalChunks: finalStats.totalChunks,
        totalEmbeddings: embeddingsGenerated,
        embeddingDimensions: this.embedder?.dimensions ?? 0,
        dbSizeBytes: finalStats.dbSizeBytes,
        lastSyncDurationMs: durationMs,
        searchCount: finalStats.searchCount,
        avgSearchDurationMs: finalStats.avgSearchDurationMs,
    },
    indexEmbedding: embeddingModelInfo,
});
```

---

### 3. `pathHashStore.getAllFiles()` Called Inside `onBatch` — Loads Entire Map Every 500 Items

**File:** `src/indexer/lib/indexer.ts:509`
**Severity:** Critical
**Estimated Impact:** ~400 full-table scans loading 214K+ rows each during a full mail sync

**Problem:**
Inside `onBatch`, `updateMeta` is called which includes `totalFiles: pathHashStore.getAllFiles().size`. The `getAllFiles()` method at `src/indexer/lib/path-hashes.ts:34-46` runs `SELECT path, hash FROM path_hashes WHERE is_file = 1`, materializes ALL rows into a `Map`, and then only `.size` is used. With 214K entries, this allocates ~20MB per call and is called on every batch of 500 items.

```typescript
505:                    const currentStats = this.store.getStats();
506:                    this.store.updateMeta({
507:                        lastSyncAt: Date.now(),
508:                        stats: {
509:                            totalFiles: pathHashStore.getAllFiles().size,
```

**Recommendation:**
Add a `getFileCount()` method to `PathHashStore` that uses `SELECT COUNT(*)`:

**Suggested Fix:**
```typescript
// In PathHashStore:
getFileCount(): number {
    const row = this.db.query("SELECT COUNT(*) AS cnt FROM path_hashes WHERE is_file = 1").get() as { cnt: number };
    return row.cnt;
}
```

---

## Important Issues

### 4. Brute-Force Vector Search — O(N) Full Table Scan

**File:** `src/utils/search/stores/sqlite-vector-store.ts:33-53`
**Severity:** High
**Estimated Impact:** Search latency grows linearly with index size; at 281K embeddings, every search loads ~570MB of vectors into memory

**Problem:**
The `search()` method loads ALL embeddings from the database, computes cosine distance against each one, sorts, and returns top-K. With 281K embeddings at 512 dimensions (2048 bytes each), this means loading ~570MB into memory for every single search query.

```typescript
33:    search(queryVector: Float32Array, limit: number): VectorSearchHit[] {
34:        const rows = this.db.query(`SELECT doc_id, embedding FROM ${this.embTable}`).all() as Array<{
35:            doc_id: string;
36:            embedding: Buffer;
37:        }>;
38:
39:        const scored: VectorSearchHit[] = [];
40:
41:        for (const row of rows) {
42:            const storedVec = new Float32Array(
43:                row.embedding.buffer,
44:                row.embedding.byteOffset,
45:                row.embedding.byteLength / 4
46:            );
47:            const distance = cosineDistance(queryVector, storedVec);
48:            scored.push({ docId: row.doc_id, score: 1 - distance });
49:        }
```

**Recommendation:**
Replace with an approximate nearest-neighbor index. Options:
1. Use the existing `LanceDBVectorStore` (already implemented at `src/utils/search/stores/lancedb-vector-store.ts`)
2. Use sqlite-vec extension (built into recent SQLite) for in-DB vector search
3. At minimum, add a simple IVF (inverted file) index or locality-sensitive hashing

---

### 5. Mail Scan: Synchronous `await getBody()` for Each Message Blocks Pipeline

**File:** `src/indexer/lib/sources/mail-source.ts:72-74`
**Severity:** High
**Estimated Impact:** ~80% of scan time is file I/O waiting on `parseEmlxFile`

**Problem:**
The mail scan loop processes messages one-by-one, calling `await this.emlx.getBody(row.rowid)` sequentially. For the ~80% of messages that miss the L1 summary cache, this triggers `parseEmlxFile` which reads the file synchronously (`readFileSync`) and then does `await simpleParser(mimeContent)`. No parallelism.

```typescript
72:        for (let i = 0; i < rows.length; i++) {
73:            const row = rows[i];
74:            const body = (await this.emlx.getBody(row.rowid)) ?? "";
```

The `parseEmlxFile` at `src/macos/lib/mail/emlx.ts:109-139` uses `readFileSync` followed by `await simpleParser()`:

```typescript
109:    async parseEmlxFile(filePath: string): Promise<string | null> {
110:        try {
111:            const content = readFileSync(filePath);
112:            ...
113:            const { simpleParser } = await import("mailparser");
114:            const parsed = await simpleParser(mimeContent);
```

**Recommendation:**
Process email bodies in parallel with a concurrency limiter. Since file I/O and MIME parsing are independent per message, 10-20 concurrent parses would dramatically improve throughput without overwhelming the filesystem.

**Suggested Fix:**
```typescript
// Process bodies in parallel chunks of 20
const BODY_CONCURRENCY = 20;
for (let i = 0; i < rows.length; i += BODY_CONCURRENCY) {
    const chunk = rows.slice(i, i + BODY_CONCURRENCY);
    const bodies = await Promise.all(
        chunk.map(row => this.emlx.getBody(row.rowid).then(b => b ?? ""))
    );
    for (let j = 0; j < chunk.length; j++) {
        // build entry with bodies[j]
    }
}
```

---

### 6. Scanning and Embedding Are Sequential — Should Overlap

**File:** `src/indexer/lib/indexer.ts:465-640`
**Severity:** High
**Estimated Impact:** Pipeline stall — embedding waits for entire scan to finish before starting

**Problem:**
The sync pipeline runs Phase 1 (scan + chunk + store) to completion, then Phase 2 (detect changes), then Phase 3 (embed). With 214K messages, the scan phase takes many minutes. During that time, chunks are being inserted into the DB unembedded. Embedding could start processing these while scanning continues.

```typescript
465:            // -- Phase 1: SCAN --
466:            const sinceId = mode === "incremental" ? this.computeSinceId() : undefined;
...
551:            });
553:            // -- Phase 2: DETECT CHANGES + STORE REMAINING --
...
639:            // -- Phase 3: EMBED --
640:            const embeddingsGenerated = await this.embedUnembeddedChunks(callbacks);
```

**Recommendation:**
Start a background embedding worker after the first batch completes in Phase 1. Use a producer-consumer pattern: `onBatch` inserts chunks (producer), and a concurrent loop polls for unembedded chunks and embeds them (consumer). Signal completion when scan finishes and all chunks are embedded.

---

### 7. `computeSinceId()` Loads All Path Hashes to Find Max ID

**File:** `src/indexer/lib/indexer.ts:261-279`
**Severity:** High
**Estimated Impact:** Loads 214K entries into memory on every incremental sync, just to find max(ROWID)

**Problem:**
`computeSinceId()` calls `pathHashStore.getAllFiles()` which loads the entire `Map<string, string>`, then iterates all keys to find the max numeric ID. With 214K entries, this is ~20MB of allocation for what should be a single SQL query.

```typescript
261:    private computeSinceId(): string | undefined {
262:        const storedHashes = this.store.getPathHashStore().getAllFiles();
263:
264:        if (storedHashes.size === 0) {
265:            return undefined;
266:        }
267:
268:        let maxId = 0;
269:
270:        for (const key of storedHashes.keys()) {
271:            const num = parseInt(key, 10);
272:
273:            if (!Number.isNaN(num) && num > maxId) {
274:                maxId = num;
275:            }
276:        }
```

**Recommendation:**
Add a `getMaxNumericPath()` method to PathHashStore:

**Suggested Fix:**
```typescript
// In PathHashStore:
getMaxNumericPath(): number {
    const row = this.db.query(
        "SELECT MAX(CAST(path AS INTEGER)) AS maxId FROM path_hashes WHERE is_file = 1 AND path GLOB '[0-9]*'"
    ).get() as { maxId: number | null };
    return row.maxId ?? 0;
}
```

---

### 8. `updateMeta` Serializes/Deserializes JSON on Every Batch

**File:** `src/indexer/lib/store.ts:392-417`
**Severity:** High
**Estimated Impact:** ~800 JSON serialize + deserialize cycles during full sync (400 batches x 2 for read + write)

**Problem:**
`updateMeta()` calls `readMeta()` which does `SafeJSON.parse(row.value)` on the stored meta JSON, then modifies it, then calls `SafeJSON.stringify()` to write it back. This happens on every batch of 500 items in `onBatch`. The meta JSON includes the full `IndexConfig` object which is serialized/deserialized needlessly.

```typescript
392:        updateMeta(
393:            updates: Partial<Pick<IndexMeta, "lastSyncAt" | "stats" | "indexEmbedding" | "searchEmbedding">>
394:        ): void {
395:            const current = readMeta(db, config, createdAt);  // JSON.parse
396:            ...
397:            db.run("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)", [
398:                "meta",
399:                SafeJSON.stringify(current),  // JSON.stringify
400:            ]);
```

**Recommendation:**
1. Cache the meta object in memory and only read from DB on first access
2. Only write to DB at the end of sync, not on every batch
3. If crash-safety is needed per-batch, write only the `lastSyncAt` timestamp (a single integer column) instead of the full JSON blob

---

### 9. Watch Timer Has No Overlap Guard

**File:** `src/indexer/lib/indexer.ts:216-221`
**Severity:** High
**Estimated Impact:** Concurrent writes to same DB if sync takes longer than interval

**Problem:**
`startWatch` uses `setInterval` to trigger `this.sync()`. If a sync takes longer than the interval (default 5 minutes), the next interval fires while the previous sync is still running. Two concurrent syncs will cause:
- Double-counting in path_hashes
- SQLite WAL contention (writes are serialized but may timeout)
- Inconsistent metadata updates

```typescript
216:        this.watchTimer = setInterval(() => {
217:            this.sync(callbacks).catch(() => {
218:                // Watch sync errors are non-fatal
219:            });
220:        }, interval);
```

**Recommendation:**
Use `setTimeout` with re-arm, or add a running flag:

**Suggested Fix:**
```typescript
private isSyncing = false;

startWatch(callbacks?: IndexerCallbacks): void {
    // ...
    const tick = async () => {
        if (this.isSyncing) return;
        this.isSyncing = true;
        try {
            await this.sync(callbacks);
        } catch {
            // Watch sync errors are non-fatal
        } finally {
            this.isSyncing = false;
        }
    };
    this.watchTimer = setInterval(tick, interval);
}
```

---

### 10. LEFT JOIN for Unembedded Chunks — Scaling Concern

**File:** `src/indexer/lib/store.ts:253-258`, `297-301`
**Severity:** High
**Estimated Impact:** Query degrades as both tables grow; NOT EXISTS may be 2-5x faster with proper indexing

**Problem:**
`getUnembeddedChunksPage` and `getUnembeddedChunkIds` use `LEFT JOIN ... WHERE e.doc_id IS NULL` to find chunks without embeddings. As both the content and embeddings tables grow (281K+ rows each), this join becomes expensive because it must examine every row in the content table, look up the embeddings table, and filter nulls.

```typescript
297:            return db
298:                .query(
299:                    `SELECT c.id, c.content FROM ${contentTable} c LEFT JOIN ${embTable} e ON c.id = e.doc_id WHERE e.doc_id IS NULL LIMIT ?`
300:                )
301:                .all(limit) as Array<{ id: string; content: string }>;
```

**Recommendation:**
Use `NOT EXISTS` which can short-circuit once a match is found:

**Suggested Fix:**
```sql
SELECT c.id, c.content FROM content_table c
WHERE NOT EXISTS (SELECT 1 FROM embeddings_table e WHERE e.doc_id = c.id)
LIMIT ?
```

Or better, add an `embedded` boolean column to the content table and index it, eliminating the join entirely.

---

## Medium Issues

### 11. `readFileSync` in EmlxBodyExtractor Blocks Event Loop

**File:** `src/macos/lib/mail/emlx.ts:111`
**Severity:** Medium
**Estimated Impact:** Each emlx file read blocks the entire Bun event loop for disk I/O

**Problem:**
```typescript
111:            const content = readFileSync(filePath);
```

Using synchronous file reads in an async method blocks the event loop. For large emlx files (some can be 1MB+), this creates noticeable stalls.

**Recommendation:**
Use `await Bun.file(filePath).bytes()` or `await readFile(filePath)`.

---

### 12. Content Truncated to 200 Chars for Embedding — Loses Semantic Signal

**File:** `src/indexer/lib/indexer.ts:386,403`
**Severity:** Medium
**Estimated Impact:** Embedding quality degradation for longer content; 200 chars is ~1 sentence

**Problem:**
```typescript
386:        const maxEmbedChars = 200;
...
403:                validPage.map((c) => this.embedder!.embed(c.content.slice(0, maxEmbedChars)))
```

Apple's NLEmbedding (sentence embedding) works best on complete semantic units. Truncating to 200 chars (roughly 50 tokens) means a 2000-char chunk has 90% of its content ignored for semantic search. This is a trade-off for speed but the balance may be too aggressive.

**Recommendation:**
Consider 400-500 chars (1-2 sentences) as the truncation point. Alternatively, truncate to the first complete sentence after 200 chars. Profile whether the difference in embedding time is measurable — NLEmbedding processes short texts very fast regardless.

---

### 13. `deduplicateChunks` is O(N^2)

**File:** `src/indexer/lib/chunker.ts:261-285`
**Severity:** Medium
**Estimated Impact:** Quadratic for files with many AST nodes; a 500-node file = 250K comparisons

**Problem:**
For each chunk, it checks against every other chunk whether it is "fully contained within" using both line range comparison AND `other.content.includes(chunk.content)`. The `includes()` call is O(M*N) on string length.

```typescript
268:        for (const chunk of chunks) {
269:            const isContained = chunks.some(
270:                (other) =>
271:                    other.id !== chunk.id &&
272:                    other.startLine <= chunk.startLine &&
273:                    other.endLine >= chunk.endLine &&
274:                    other.content.includes(chunk.content) &&
275:                    other.content !== chunk.content
276:            );
```

**Recommendation:**
Since chunks are sorted by `startLine`, use a sweep-line approach: only check containment against the most recent "parent" chunk (the one with the widest span that hasn't been closed yet). This is O(N).

---

### 14. SearchEngine Creates Its Own DB Connection + WAL for Same Database

**File:** `src/utils/search/drivers/sqlite-fts5/index.ts:60-62`
**Severity:** Medium
**Estimated Impact:** Dual WAL mode setup, dual DB handles for same file when using `fromDatabase`

**Problem:**
The `SearchEngine` constructor always sets `PRAGMA journal_mode = WAL` on the database. But when created via `fromDatabase()` (as the indexer does at `store.ts:182-190`), the database handle is shared with the store's DB which already has WAL enabled. Two `PRAGMA journal_mode = WAL` calls on the same handle are harmless, but the design suggests `SearchEngine` was designed for standalone use and is being force-fit into a shared-DB pattern.

More importantly, `insertSync` at line 211 calls `this.docCount = this.queryCount()` after every insert, running `SELECT COUNT(*)` — but the indexer bypasses `SearchEngine.insert()` entirely and writes directly to the content table (line 201-208 of store.ts). This means `SearchEngine.docCount` is always stale.

```typescript
// store.ts line 356-358 — getStats queries DB directly because fts.count is stale
356:            // Query DB directly — fts.count uses a cached value that's stale
357:            // when chunks are inserted via raw SQL (bypassing SearchEngine.insert)
358:            const countRow = db.query(`SELECT COUNT(*) AS cnt FROM ${tableName}_content`).get()
```

**Recommendation:**
Either route all inserts through `SearchEngine.insertMany()` or remove the cached `docCount` from SearchEngine entirely and always query the DB. The current split is a leaky abstraction — the store knows about SearchEngine's internal table names and writes directly, while SearchEngine maintains a stale count.

---

### 15. `removeChunks` Uses Individual Deletes in a Loop

**File:** `src/indexer/lib/store.ts:228-236`
**Severity:** Medium
**Estimated Impact:** N individual DELETE statements when batch delete is possible

**Problem:**
```typescript
228:        async removeChunks(chunkIds: string[]): Promise<void> {
229:            if (chunkIds.length === 0) {
230:                return;
231:            }
232:
233:            for (const id of chunkIds) {
234:                await fts.remove(id);
235:            }
236:        },
```

Each `fts.remove(id)` does a DELETE + vector store delete + `queryCount()`. For a deletion of 1000 chunks, that's 3000 DB operations.

**Recommendation:**
Add a `removeMany()` method to SearchEngine that wraps deletes in a transaction, or at minimum use `DELETE FROM ... WHERE id IN (...)`.

---

### 16. Entire `sourceEntries` Array Held in Memory Throughout Sync

**File:** `src/indexer/lib/sources/mail-source.ts:68`, `src/indexer/lib/indexer.ts:483-551`
**Severity:** Medium
**Estimated Impact:** 214K SourceEntry objects (~400MB with email bodies) retained for the full sync duration

**Problem:**
`scan()` returns the complete `SourceEntry[]` array, and `runSync` holds it as `sourceEntries`. Each entry includes the full `content` string (email body). For 214K messages averaging 1166 chars, that's ~250MB of string data held in memory throughout the entire sync, even though each batch has already been processed and stored via `onBatch`.

The entries are only needed after scan for `detectChanges()`, but `detectChanges` with `sinceId` short-circuits to return all entries as "added" anyway (since previousHashes is empty Map).

**Recommendation:**
For sinceId scans, don't accumulate entries in the return array — the `onBatch` callback has already processed them. Return an empty array and skip `detectChanges` entirely for sinceId syncs.

---

## Minor Issues

### 17. `detectChanges` After sinceId Scan With Empty previousHashes Is a No-Op

**File:** `src/indexer/lib/indexer.ts:556-561`
**Severity:** Low
**Estimated Impact:** Minor CPU waste, creates large `added` array that duplicates already-processed entries

**Problem:**
When `sinceId` is set, `previousHashes` is `new Map()` (empty). `detectChanges` is called with `previousHashes: null` (since `size > 0` is false for empty map). With null previousHashes, `detectChanges` returns all `currentEntries` as "added". But these were already stored via `onBatch`.

```typescript
556:            const changes = this.source.detectChanges({
557:                previousHashes: sinceId ? null : previousHashes.size > 0 ? previousHashes : null,
558:                currentEntries: sourceEntries,
559:                full: mode === "full",
560:            });
```

Then at line 578, all "added" entries are filtered against `storedInBatch`, which removes them all. The entire detectChanges call was unnecessary.

**Recommendation:**
Skip detectChanges entirely for sinceId incremental syncs:
```typescript
if (sinceId) {
    // All entries already stored via onBatch — skip change detection
    changes = { added: [], modified: [], deleted: [], unchanged: [] };
}
```

---

### 18. SHA-256 Hashing Used for Chunk IDs — Unnecessarily Slow

**File:** `src/indexer/lib/chunker.ts:83-88`
**Severity:** Low
**Estimated Impact:** SHA-256 is ~3x slower than xxHash/FNV for content hashing with no security benefit

**Problem:**
```typescript
84: function sha256(content: string): string {
85:     const hasher = new Bun.CryptoHasher("sha256");
86:     hasher.update(content);
87:     return hasher.digest("hex");
88: }
```

Chunk IDs don't need cryptographic strength. Bun supports faster hash functions like xxHash which are more appropriate for content-addressed deduplication.

**Recommendation:**
Use `Bun.hash(content)` (xxHash64) for chunk IDs. It's ~3-5x faster and still collision-resistant for this use case.

---

### 19. LanceDB VectorStore Exists But Is Never Used by Indexer

**File:** `src/utils/search/stores/lancedb-vector-store.ts` (entire file)
**Severity:** Low
**Estimated Impact:** Dead code adding to bundle/maintenance

**Problem:**
`LanceDBVectorStore` is implemented and exported from `src/utils/search/stores/index.ts`, but the indexer only uses `SqliteVectorStore`. Given the critical brute-force search issue (#4), this existing implementation could solve the problem but isn't wired in.

**Recommendation:**
Either wire LanceDB as the default vector store for indices above a size threshold, or document it as experimental. If it's intentionally unused, consider removing it.

---

### 20. `embedText` Dynamic Import on Every Call

**File:** `src/utils/ai/providers/AIDarwinKitProvider.ts:28-29`
**Severity:** Low
**Estimated Impact:** Dynamic `import()` resolved from module cache but still adds overhead per call

**Problem:**
```typescript
28:        const { embedText } = await import("@app/utils/macos/nlp");
29:        return embedText(text, language);
```

Every `embed()` call does a dynamic import. While Bun caches modules, the async import still creates a promise and lookup each time.

**Recommendation:**
Import `embedText` at the top of the file or cache the import result on first call.

---

## Positive Observations

- **Clean source abstraction**: The `IndexerSource` interface cleanly separates mail/file/chat concerns. Adding new source types requires no changes to the indexer core.
- **Crash-safe batching**: The `onBatch` pattern with path_hash upserts means a Ctrl+C during scan doesn't lose progress. The sinceId incremental scan resumes correctly.
- **Well-typed event system**: The `IndexerEventMap` provides compile-time safety for all event names and payloads, with namespace wildcards for easy subscription.
- **Proper WAL mode**: Using WAL mode for the index DB is the right choice for concurrent read/write workloads.
- **Embedding warmup**: The retry logic at `indexer.ts:376-382` handles transient DarwinKit initialization failures gracefully.

---

## Statistics

| Metric | Count |
|---|---|
| Files reviewed | 16 |
| Critical issues | 3 |
| High issues | 7 |
| Medium issues | 6 |
| Low issues | 4 |

## Priority Action Plan

1. **Fix embedding concurrency** (#1) — switch to sequential loop or batch N-API call. Expected gain: 2-4x embedding throughput.
2. **Fix `getStats()` redundant calls** (#2) and **`getAllFiles()` in onBatch** (#3) — trivial fixes, eliminate ~2400 unnecessary DB queries per sync.
3. **Add overlap guard to watch timer** (#9) — prevents data corruption.
4. **Parallelize mail body extraction** (#5) — expected gain: 3-5x scan throughput.
5. **Skip detectChanges for sinceId syncs** (#17) + **don't hold sourceEntries in memory** (#16) — saves ~400MB.
6. **Replace brute-force vector search** (#4) — required before index exceeds ~50K embeddings.
7. **Pipeline scan/embed overlap** (#6) — advanced optimization, requires producer-consumer refactor.

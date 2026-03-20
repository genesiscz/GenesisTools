# Indexer Fix Plan 2: Performance Optimizations

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate ~3000+ unnecessary DB queries per sync, reduce memory from ~400MB to ~5MB, and improve embedding throughput from 67/sec toward 150+/sec.

**Architecture:** Targeted optimizations to hot paths. No new abstractions. Each task is independent.

**Tech Stack:** TypeScript, Bun SQLite, DarwinKit N-API

---

### Task 1: Add `getFileCount()` and `getMaxNumericPath()` to PathHashStore

Two hot-path methods load the entire `path_hashes` table into memory (214K+ rows = ~20MB) just to get a count or a max ID. Replace with SQL queries.

**Files:**
- Modify: `src/indexer/lib/path-hashes.ts`
- Test: `src/indexer/lib/path-hashes.test.ts`

**Step 1: Write failing tests**

Add to `src/indexer/lib/path-hashes.test.ts`:

```typescript
test("getFileCount returns count without loading all rows", () => {
    store.upsert("100", "hash1", true);
    store.upsert("200", "hash2", true);
    store.upsert("dir1", "hash3", false);
    expect(store.getFileCount()).toBe(2); // Only files, not dirs
});

test("getMaxNumericPath returns highest numeric path", () => {
    store.upsert("100", "h1", true);
    store.upsert("50000", "h2", true);
    store.upsert("999", "h3", true);
    store.upsert("not-a-number", "h4", true);
    expect(store.getMaxNumericPath()).toBe(50000);
});

test("getMaxNumericPath returns 0 when no numeric paths", () => {
    store.upsert("src/foo.ts", "h1", true);
    expect(store.getMaxNumericPath()).toBe(0);
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/indexer/lib/path-hashes.test.ts --timeout 60000
```

**Step 3: Implement**

Add to `PathHashStore`:

```typescript
getFileCount(): number {
    const row = this.db.query("SELECT COUNT(*) AS cnt FROM path_hashes WHERE is_file = 1").get() as { cnt: number };
    return row.cnt;
}

getMaxNumericPath(): number {
    const row = this.db.query(
        "SELECT MAX(CAST(path AS INTEGER)) AS maxId FROM path_hashes WHERE is_file = 1 AND path GLOB '[0-9]*'"
    ).get() as { maxId: number | null };
    return row.maxId ?? 0;
}
```

**Step 4: Run tests**

```bash
bun test src/indexer/lib/path-hashes.test.ts --timeout 60000
```

**Step 5: Commit**

```bash
git add src/indexer/lib/path-hashes.ts src/indexer/lib/path-hashes.test.ts
git commit -m "perf(indexer): add getFileCount() and getMaxNumericPath() to avoid full table loads"
```

---

### Task 2: Use new PathHashStore methods in Indexer hot paths

Replace `getAllFiles().size` and the `computeSinceId()` full-table load with the SQL-only methods from Task 1.

**Files:**
- Modify: `src/indexer/lib/indexer.ts:261-279` (computeSinceId)
- Modify: `src/indexer/lib/indexer.ts:509` (onBatch metadata update)
- Modify: `src/indexer/lib/indexer.ts:643` (finalization)

**Step 1: Fix computeSinceId**

```typescript
private computeSinceId(): string | undefined {
    const maxId = this.store.getPathHashStore().getMaxNumericPath();
    return maxId > 0 ? String(maxId) : undefined;
}
```

**Step 2: Fix onBatch metadata — use getFileCount()**

At `indexer.ts:509`, replace:
```typescript
totalFiles: pathHashStore.getAllFiles().size,
```
with:
```typescript
totalFiles: pathHashStore.getFileCount(),
```

**Step 3: Fix finalization — call getStats() once**

At `indexer.ts:643`, replace:
```typescript
const totalFiles = pathHashStore.getAllFiles().size;
```
with:
```typescript
const totalFiles = pathHashStore.getFileCount();
```

At `indexer.ts:665-678`, call `getStats()` once:

```typescript
const finalStats = this.store.getStats();
this.store.updateMeta({
    lastSyncAt: Date.now(),
    stats: {
        totalFiles,
        totalChunks: finalStats.totalChunks,
        totalEmbeddings: finalStats.totalChunks - this.store.getUnembeddedCount(),
        embeddingDimensions: this.embedder?.dimensions ?? 0,
        dbSizeBytes: finalStats.dbSizeBytes,
        lastSyncDurationMs: durationMs,
        searchCount: finalStats.searchCount,
        avgSearchDurationMs: finalStats.avgSearchDurationMs,
    },
    indexEmbedding: embeddingModelInfo,
});
```

**Step 4: Run tests**

```bash
bun test src/indexer/ --timeout 60000
```

**Step 5: Commit**

```bash
git add src/indexer/lib/indexer.ts
git commit -m "perf(indexer): eliminate ~2400 unnecessary DB queries per sync"
```

---

### Task 3: Reduce `updateMeta` frequency in onBatch — every 10th batch only

`updateMeta` does JSON parse + stringify on every batch of 500 items (~400 times during full sync). The meta is only needed for crash-recovery display ("Indexed: N messages"). Update every 10th batch (every 5000 items) instead.

**Files:**
- Modify: `src/indexer/lib/indexer.ts:504-525` (the onBatch callback)

**Step 1: Add a batch counter and throttle**

In `runSync`, before the scan call, add:
```typescript
let batchCount = 0;
```

In the `onBatch` callback, wrap the metadata update:
```typescript
batchCount++;
// Update metadata every 10 batches for crash-recovery display
if (batchCount % 10 === 0) {
    const currentStats = this.store.getStats();
    this.store.updateMeta({
        lastSyncAt: Date.now(),
        stats: {
            totalFiles: pathHashStore.getFileCount(),
            totalChunks: currentStats.totalChunks,
            totalEmbeddings: currentStats.totalEmbeddings,
            embeddingDimensions: this.embedder?.dimensions ?? 0,
            dbSizeBytes: currentStats.dbSizeBytes,
            lastSyncDurationMs: currentStats.lastSyncDurationMs,
            searchCount: currentStats.searchCount,
            avgSearchDurationMs: currentStats.avgSearchDurationMs,
        },
        indexEmbedding: this.embedder
            ? {
                  model: this.config.embedding?.model ?? "darwinkit",
                  provider: this.config.embedding?.provider ?? "darwinkit",
                  dimensions: this.embedder.dimensions,
              }
            : undefined,
    });
}
```

**Step 2: Commit**

```bash
git add src/indexer/lib/indexer.ts
git commit -m "perf(indexer): throttle updateMeta to every 10th batch, cut ~360 JSON round-trips"
```

---

### Task 4: Skip detectChanges entirely for sinceId incremental syncs

When `sinceId` is set, `detectChanges` is a no-op — it returns all entries as "added" (since previousHashes is null), and they're all filtered out by `storedInBatch`. Also, `sourceEntries` holds ~250MB of email bodies in memory for no reason during sinceId syncs.

**Files:**
- Modify: `src/indexer/lib/indexer.ts:550-610`

**Step 1: Short-circuit after scan for sinceId syncs**

After the scan completes (line 550), add:

```typescript
if (sinceId) {
    // sinceId scan: all entries already stored via onBatch. No deletion detection needed
    // (mail is append-only by ROWID — deletions handled separately if needed).
    this.emitAndDispatch("scan:complete", {
        indexName: this.config.name,
        added: storedInBatch.size,
        modified: 0,
        deleted: 0,
        unchanged: 0,
    }, callbacks);
} else {
    // Full scan: run detectChanges for add/modify/delete detection
    const changes = this.source.detectChanges({ ... });
    // ... existing Phase 2 code ...
}
```

Also, for sinceId scans, make `scan()` not accumulate the return array. In `mail-source.ts`, if `sinceId` is provided and `onBatch` is set, return an empty array:

```typescript
// At end of scan(), if onBatch was used:
if (opts?.onBatch) {
    return []; // Entries already processed — don't hold 250MB in memory
}
return entries;
```

**Step 2: Run tests**

```bash
bun test src/indexer/ --timeout 60000
```

**Step 3: Commit**

```bash
git add src/indexer/lib/indexer.ts src/indexer/lib/sources/mail-source.ts
git commit -m "perf(indexer): skip detectChanges + free 250MB for sinceId incremental syncs"
```

---

### Task 5: Switch embedding from `Promise.allSettled(1000)` to sequential loop

1000 concurrent promises on a sequential N-API bridge wastes ~999 promise allocations per page. A simple `for` loop is faster because it eliminates promise scheduling, microtask queue overhead, and GC pressure.

**Files:**
- Modify: `src/indexer/lib/indexer.ts:397-420`

**Step 1: Replace Promise.allSettled with for loop**

```typescript
const batchEmbeddings = new Map<string, Float32Array>();
const zeroDims = this.embedder.dimensions;

const validPage = page.filter((c) => c.content.length >= 5);

for (const c of validPage) {
    try {
        const result = await this.embedder.embed(c.content.slice(0, maxEmbedChars));
        batchEmbeddings.set(c.id, result.vector);
    } catch {
        batchEmbeddings.set(c.id, new Float32Array(zeroDims));
    }
}

// Mark tiny chunks with zero vector so they don't re-appear
for (const c of page) {
    if (c.content.length < 5) {
        batchEmbeddings.set(c.id, new Float32Array(zeroDims));
    }
}
```

**Step 2: Benchmark before/after**

Run the mail index for 30s and compare embedding count:

```bash
# Before: note the /sec rate
timeout 30 tools macos mail index 2>&1 | tail -3

# After: same test
timeout 30 tools macos mail index 2>&1 | tail -3
```

**Step 3: Commit**

```bash
git add src/indexer/lib/indexer.ts
git commit -m "perf(indexer): sequential embed loop eliminates 999 wasted promises per page"
```

---

### Task 6: Increase `maxEmbedChars` from 200 to 500

200 chars captures only email headers. 500 chars captures headers + first paragraph of body, dramatically improving semantic search quality with negligible speed impact (benchmarks showed 40/sec at 500ch vs 70/sec at 200ch — only ~1.75x difference, well worth the quality gain).

**Files:**
- Modify: `src/indexer/lib/indexer.ts:386`

**Step 1: Change the constant**

```typescript
const maxEmbedChars = 500;
```

**Step 2: Commit**

```bash
git add src/indexer/lib/indexer.ts
git commit -m "perf(indexer): increase maxEmbedChars to 500 for better semantic search quality"
```

---

### Task 7: Use `NOT EXISTS` instead of `LEFT JOIN` for unembedded queries

`LEFT JOIN ... WHERE IS NULL` must examine every content row even with LIMIT. `NOT EXISTS` can short-circuit per row.

**Files:**
- Modify: `src/indexer/lib/store.ts:285-310` (getUnembeddedChunksPage, getUnembeddedCount)

**Step 1: Replace queries**

```typescript
getUnembeddedCount(): number {
    const contentTable = `${tableName}_content`;
    const embTable = `${tableName}_embeddings`;
    const tableExists = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(embTable) as { name: string } | null;
    if (!tableExists) {
        const row = db.query(`SELECT COUNT(*) AS cnt FROM ${contentTable}`).get() as { cnt: number };
        return row.cnt;
    }
    const row = db.query(
        `SELECT COUNT(*) AS cnt FROM ${contentTable} c WHERE NOT EXISTS (SELECT 1 FROM ${embTable} e WHERE e.doc_id = c.id)`
    ).get() as { cnt: number };
    return row.cnt;
},

getUnembeddedChunksPage(limit: number): Array<{ id: string; content: string }> {
    const contentTable = `${tableName}_content`;
    const embTable = `${tableName}_embeddings`;
    const tableExists = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(embTable) as { name: string } | null;
    if (!tableExists) {
        return db.query(`SELECT id, content FROM ${contentTable} LIMIT ?`).all(limit) as Array<{ id: string; content: string }>;
    }
    return db.query(
        `SELECT c.id, c.content FROM ${contentTable} c WHERE NOT EXISTS (SELECT 1 FROM ${embTable} e WHERE e.doc_id = c.id) LIMIT ?`
    ).all(limit) as Array<{ id: string; content: string }>;
},
```

**Step 2: Commit**

```bash
git add src/indexer/lib/store.ts
git commit -m "perf(indexer): use NOT EXISTS instead of LEFT JOIN for unembedded queries"
```

---

### Task 8: Use `Bun.hash()` (xxHash64) instead of SHA-256 for chunk IDs

SHA-256 is cryptographic — overkill for content deduplication. xxHash64 is ~3-5x faster.

**Files:**
- Modify: `src/indexer/lib/chunker.ts:83-88`

**Step 1: Replace hash function**

```typescript
function contentHash(content: string): string {
    return Bun.hash(content).toString(16);
}
```

Replace all `sha256(...)` calls in the chunker with `contentHash(...)`.

**Step 2: Run tests**

```bash
bun test src/indexer/lib/chunker.test.ts --timeout 60000
```

**Step 3: Commit**

```bash
git add src/indexer/lib/chunker.ts
git commit -m "perf(indexer): use xxHash64 instead of SHA-256 for chunk IDs"
```

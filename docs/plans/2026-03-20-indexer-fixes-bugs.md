# Indexer Fix Plan 1: Bugs & Data Integrity

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix critical bugs found by 3 independent code reviews — resource leaks, data corruption, wrong lookups, display errors.

**Architecture:** Targeted fixes to existing files. No new abstractions. Each task is independent and can be committed separately.

**Tech Stack:** TypeScript, Bun SQLite, DarwinKit N-API

---

### Task 1: Fix `resolveDeletedChunks` — ROWID vs filePath mismatch for mail

Mail chunks store `filePath` as `"Inbox/Some Subject"` but `resolveDeletedChunks` passes ROWID strings like `"12345"` to `getChunkIdsBySourcePaths()`. The WHERE clause never matches, so deleted mail chunks are never cleaned up.

**Files:**
- Modify: `src/indexer/lib/indexer.ts:340-350`
- Modify: `src/indexer/lib/store.ts` — add `getChunkIdsBySourceIds(ids: string[]): string[]`
- Modify: `src/indexer/lib/sources/mail-source.ts` — store ROWID in chunk metadata
- Test: `src/indexer/lib/indexer.test.ts`

**Step 1: Write the failing test**

Add to `src/indexer/lib/indexer.test.ts`:

```typescript
test("resolveDeletedChunks finds mail chunks by source ROWID", async () => {
    // Create an indexer with mail-like config
    // Insert chunks with filePath="Inbox/Test" and metadata.rowid=12345
    // Call resolveDeletedChunks(["12345"])
    // Expect it returns the chunk IDs
});
```

**Step 2: Fix the lookup**

The cleanest fix: when chunking mail entries, store the source entry ID (ROWID) in the chunk's `filePath` field as a prefix, e.g. `"rowid:12345:Inbox/Subject"`. Then `resolveDeletedChunks` can query `WHERE filePath LIKE 'rowid:12345:%'`.

**Alternative (simpler):** Add a `source_id` column to the content table that stores the original `entry.id`. Then `getChunkIdsBySourceIds` queries `WHERE source_id IN (...)`.

The simpler approach is better long-term. In `store.ts`, modify the content table schema to add `source_id TEXT`:

```typescript
// In insertChunks, store source_id from chunk.filePath's source entry
db.run(`INSERT OR REPLACE INTO ${contentTable} (id, content, name, filePath, source_id) VALUES (?, ?, ?, ?, ?)`, [
    chunk.id, chunk.content, chunk.name ?? "", chunk.filePath, chunk.sourceId ?? "",
]);
```

Add `sourceId?: string` to `ChunkRecord` in `types.ts`.

In `chunkEntries()` (`indexer.ts:282-325`), set `chunk.sourceId = entry.id` for each chunk.

Add `getChunkIdsBySourceIds(ids: string[])` to `IndexStore` interface and implementation:

```typescript
getChunkIdsBySourceIds(ids: string[]): string[] {
    const contentTable = `${tableName}_content`;
    const results: string[] = [];
    const batchSize = 500;
    for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        const placeholders = batch.map(() => "?").join(",");
        const rows = db.query(`SELECT id FROM ${contentTable} WHERE source_id IN (${placeholders})`)
            .all(...batch) as Array<{ id: string }>;
        results.push(...rows.map(r => r.id));
    }
    return results;
}
```

Update `resolveDeletedChunks` to use `getChunkIdsBySourceIds` for non-FileSource:

```typescript
private resolveDeletedChunks(deletedPaths: string[]): string[] {
    if (deletedPaths.length === 0) return [];
    if (this.source instanceof FileSource) {
        const lookupPaths = deletedPaths.map(p => resolve(this.config.baseDir, p));
        return this.store.getChunkIdsBySourcePaths(lookupPaths);
    }
    return this.store.getChunkIdsBySourceIds(deletedPaths);
}
```

**Step 3: Run tests**

```bash
bun test src/indexer/lib/indexer.test.ts --timeout 60000
```

**Step 4: Commit**

```bash
git add src/indexer/lib/indexer.ts src/indexer/lib/store.ts src/indexer/lib/types.ts src/indexer/lib/indexer.test.ts
git commit -m "fix(indexer): resolve deleted mail chunks by source ROWID, not filePath"
```

---

### Task 2: Fix MailSource DB handle leak — add dispose to Indexer.close()

`Indexer.close()` never calls `source.dispose()`. `MailSource` holds two open SQLite connections (Envelope Index + summary DB) that leak for the process lifetime. In watch mode, this causes lock contention with Mail.app.

**Files:**
- Modify: `src/indexer/lib/indexer.ts:234-243`
- Modify: `src/indexer/lib/sources/source.ts` — add optional `dispose()` to interface

**Step 1: Add `dispose?()` to IndexerSource interface**

In `src/indexer/lib/sources/source.ts`:

```typescript
export interface IndexerSource {
    scan(opts?: ScanOptions): Promise<SourceEntry[]>;
    detectChanges(opts: DetectChangesOptions): SourceChanges;
    estimateTotal?(): Promise<number>;
    hashEntry(entry: SourceEntry): string;
    dispose?(): void;
}
```

**Step 2: Call dispose in Indexer.close()**

In `src/indexer/lib/indexer.ts`, update `close()`:

```typescript
async close(): Promise<void> {
    this.stopWatch();

    if (this.embedder) {
        this.embedder.dispose();
        this.embedder = null;
    }

    this.source.dispose?.();
    await this.store.close();
}
```

**Step 3: Run tests**

```bash
bun test src/indexer/ --timeout 60000
```

**Step 4: Commit**

```bash
git add src/indexer/lib/indexer.ts src/indexer/lib/sources/source.ts
git commit -m "fix(indexer): dispose source on close to prevent DB handle leaks"
```

---

### Task 3: Fix `totalEmbeddings` overwritten with per-sync count

`indexer.ts:670` sets `totalEmbeddings: embeddingsGenerated` — the count from THIS sync only, not the total in the DB. After a sync that generates 50 embeddings, the meta shows 50 even if the DB has 200K.

**Files:**
- Modify: `src/indexer/lib/indexer.ts:665-678`

**Step 1: Fix finalization to query actual embedding count**

Replace the 4 separate `getStats()` calls with one, and query the real embedding count:

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

**Step 2: Commit**

```bash
git add src/indexer/lib/indexer.ts
git commit -m "fix(indexer): report actual embedding count, not per-sync count"
```

---

### Task 4: Fix double-counting in `totalAdded` display

`indexer.ts:563`: `changes.added.length + storedInBatch.size` double-counts entries when `previousHashes` is null (first sync), since `detectChanges` returns all entries as "added" AND they were already in `storedInBatch`.

**Files:**
- Modify: `src/indexer/lib/indexer.ts:563`

**Step 1: Fix the count**

```typescript
const totalAdded = changes.added.filter(e => !storedInBatch.has(e.id)).length + storedInBatch.size;
```

**Step 2: Commit**

```bash
git add src/indexer/lib/indexer.ts
git commit -m "fix(indexer): deduplicate totalAdded count between onBatch and detectChanges"
```

---

### Task 5: Fix `index-cmd.ts` comparing emails to chunks

`index-cmd.ts:160-163` compares `totalInMail` (emails) to `totalChunks` (chunks). When emails produce >1 chunk, `diff` goes negative. Should compare to `totalFiles`.

**Files:**
- Modify: `src/macos/commands/mail/index-cmd.ts:160`

**Step 1: Fix the comparison**

```typescript
const indexed = meta?.stats.totalFiles ?? 0;
const diff = totalInMail - indexed;
```

**Step 2: Commit**

```bash
git add src/macos/commands/mail/index-cmd.ts
git commit -m "fix(mail): compare email count to totalFiles, not totalChunks"
```

---

### Task 6: Fix watch timer overlap — concurrent syncs corrupt state

`indexer.ts:216-221` uses `setInterval` with no guard. If a sync exceeds the interval, concurrent syncs run.

**Files:**
- Modify: `src/indexer/lib/indexer.ts:191-221`

**Step 1: Add a syncing guard**

Add a private field and check it in the timer callback:

```typescript
private isSyncing = false;

startWatch(callbacks?: IndexerCallbacks): void {
    if (this.watchTimer) return;

    const interval = this.config.watch?.interval ?? 300_000;
    const strategy = this.config.watch?.strategy ?? "merkle";

    this.emit("watch:start", { indexName: this.config.name, strategy });

    if (callbacks) {
        this.dispatchCallbacks("watch:start", {
            ts: Date.now(), indexName: this.config.name, strategy,
        }, callbacks);
    }

    this.watchTimer = setInterval(async () => {
        if (this.isSyncing) return;
        this.isSyncing = true;
        try {
            await this.sync(callbacks);
        } catch {
            // Watch sync errors are non-fatal
        } finally {
            this.isSyncing = false;
        }
    }, interval);
}
```

**Step 2: Commit**

```bash
git add src/indexer/lib/indexer.ts
git commit -m "fix(indexer): prevent overlapping watch syncs with isSyncing guard"
```

---

### Task 7: Fix `indexedSearch` ignoring `--mode` and filter flags

`search.ts:114` hardcodes `mode: "fulltext"`, ignoring the `--mode` CLI flag. Also ignores `--from`, `--to`, `--mailbox` filters entirely.

**Files:**
- Modify: `src/macos/commands/mail/search.ts` — `indexedSearch` function

**Step 1: Pass mode through**

```typescript
const results = await indexer.search(query, {
    mode: options.mode ?? "fulltext",
    limit,
});
```

**Step 2: Apply filters to results**

After getting results from the indexer, filter by metadata:

```typescript
let filtered = results;
if (options.from) {
    const from = options.from.toLowerCase();
    filtered = filtered.filter(r => {
        const addr = (r.doc.metadata?.senderAddress as string ?? "").toLowerCase();
        const name = (r.doc.metadata?.senderName as string ?? "").toLowerCase();
        return addr.includes(from) || name.includes(from);
    });
}
// Similar for mailbox, receiver, to
```

**Step 3: Commit**

```bash
git add src/macos/commands/mail/search.ts
git commit -m "fix(mail): pass --mode flag to indexed search, apply --from/--mailbox filters"
```

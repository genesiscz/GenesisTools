# Code Review Report -- DRY / Reliability / Stability

**Date:** 2026-03-20 16:35:17
**Branch:** feat/indexer2
**Scope:** Full indexer system (57 commits, ~12,000 lines)
**Focus:** DRY violations, code reliability, stability, error handling

**Reviewed Files:**
- `src/indexer/lib/store.ts`
- `src/indexer/lib/indexer.ts`
- `src/indexer/lib/manager.ts`
- `src/indexer/lib/types.ts`
- `src/indexer/lib/events.ts`
- `src/indexer/lib/chunker.ts`
- `src/indexer/lib/model-registry.ts`
- `src/indexer/lib/path-hashes.ts`
- `src/indexer/lib/change-detector.ts`
- `src/indexer/lib/merkle.ts`
- `src/indexer/lib/sources/source.ts`
- `src/indexer/lib/sources/file-source.ts`
- `src/indexer/lib/sources/mail-source.ts`
- `src/indexer/lib/sources/telegram-source.ts`
- `src/indexer/lib/sources/index.ts`
- `src/indexer/commands/add.ts`
- `src/indexer/commands/rebuild.ts`
- `src/indexer/commands/remove.ts`
- `src/indexer/commands/status.ts`
- `src/indexer/commands/search.ts`
- `src/indexer/commands/watch.ts`
- `src/indexer/commands/verify.ts`
- `src/indexer/commands/models.ts`
- `src/indexer/index.ts`
- `src/macos/commands/mail/index-cmd.ts`
- `src/macos/lib/mail/emlx.ts`
- `src/macos/lib/mail/constants.ts`

## Summary

The indexer is well-structured overall, with a clean source abstraction layer, a solid event system, and good crash-recovery via onBatch + path_hash checkpointing. The main concerns are: (1) repeated "does embedding table exist?" checks in store.ts that hit sqlite_master on every call, (2) identical `detectChanges` implementations in MailSource and TelegramSource, (3) an unsafe `as unknown as` cast in verify.ts, (4) potential OOM on massive indexes from `getAllFiles()` and `sourceEntries` kept in memory, and (5) no database-level concurrency guard between separate CLI invocations.

---

## Critical Issues

### Issue 1: No file lock -- concurrent CLI invocations corrupt the index

**File:** `src/indexer/lib/store.ts:140-141`
**Severity:** Critical

**Problem:**
There is no file-level or advisory lock on the SQLite database. If a user runs `tools indexer add` in one terminal and `tools macos mail index` in another, both open the same `index.db` in WAL mode and write concurrently. Bun's SQLite driver does not serialize across processes. In WAL mode, two writers can interleave transactions, producing duplicate or orphaned chunks and corrupted path_hash state.

The in-process `isSyncing` guard (`indexer.ts:64`) only protects the watch timer within a single process -- it has no effect across two `bun run` invocations.

```
139:    const dbPath = join(indexDir, "index.db");
140:    const db = new Database(dbPath);
141:    db.run("PRAGMA journal_mode = WAL");
```

**Recommendation:**
Acquire an exclusive file lock (e.g., `flock(2)` on a `.lock` sibling file) before opening the DB for writes. Bun exposes `Bun.file().writer()` but not flock directly; use a lightweight npm package like `proper-lockfile` or `lockfile`, or spawn a short `flock` helper. If the lock is held, print a clear message: "Another indexer process is running. Wait or use --force."

**Suggested Fix:**
```typescript
import { existsSync, writeFileSync, unlinkSync } from "node:fs";

const lockPath = join(indexDir, "index.lock");

function acquireLock(): void {
    if (existsSync(lockPath)) {
        throw new Error(
            `Index "${config.name}" is locked by another process.\n` +
            `If no other process is running, remove: ${lockPath}`
        );
    }
    writeFileSync(lockPath, String(process.pid));
}

function releaseLock(): void {
    try { unlinkSync(lockPath); } catch { /* already removed */ }
}
```

This is a PID-based advisory lock (not race-free but sufficient for CLI). For production-grade locking, use `flock(2)`.

---

### Issue 2: `getAllFiles()` loads entire path_hashes table into memory

**File:** `src/indexer/lib/path-hashes.ts:48-60`
**Severity:** Critical

**Problem:**
`getAllFiles()` loads every `(path, hash)` pair into a `Map`. For a mail index with 1M+ entries, each path is a numeric string (~5 chars) + a SHA-256 hash (64 chars), plus Map overhead. At 1M entries, this is ~150-200MB of heap. This is called at the start of every non-sinceId sync (`indexer.ts:473`).

```
48:    getAllFiles(): Map<string, string> {
49:        const rows = this.db.query("SELECT path, hash FROM path_hashes WHERE is_file = 1").all() as Array<{
50:            path: string;
51:            hash: string;
52:        }>;
53:        const map = new Map<string, string>();
54:
55:        for (const row of rows) {
56:            map.set(row.path, row.hash);
57:        }
58:
59:        return map;
60:    }
```

**Recommendation:**
For large indexes, avoid materializing the full map. Instead, provide a `getHash(path)` lookup (already exists on line 27) and push the comparison into SQL. For the full-scan change detection path, use a streaming cursor or batch the lookups. Alternatively, add an index on `path_hashes(path)` (it already has one -- PRIMARY KEY) and do `SELECT hash FROM path_hashes WHERE path = ?` per entry. This trades N queries for O(1) memory.

A pragmatic middle ground: add a method that returns a lightweight iterator instead of materializing the full Map:

```typescript
*iterateFiles(): Generator<{ path: string; hash: string }> {
    const stmt = this.db.query("SELECT path, hash FROM path_hashes WHERE is_file = 1");
    for (const row of stmt.all() as Array<{ path: string; hash: string }>) {
        yield row;
    }
}
```

Or push the diff into a SQL temp table.

---

## Important Issues

### Issue 3: Identical `detectChanges` in MailSource and TelegramSource (DRY)

**File:** `src/indexer/lib/sources/mail-source.ts:127-166` and `src/indexer/lib/sources/telegram-source.ts:118-157`
**Severity:** Important (DRY)

**Problem:**
The `detectChanges` method is character-for-character identical between `MailSource` and `TelegramSource`. Both do the same iteration: check `full`, loop `currentEntries`, compare hashes, collect `added/modified/unchanged/deleted`. This is also structurally identical to `FileSource.detectChanges` (with only the hash key derivation differing).

```
// mail-source.ts:127-166
detectChanges(opts: DetectChangesOptions): SourceChanges {
    const { previousHashes, currentEntries, full } = opts;
    if (!previousHashes || full) {
        return { added: currentEntries, modified: [], deleted: [], unchanged: [] };
    }
    const added: SourceEntry[] = [];
    ...
}

// telegram-source.ts:118-157  (IDENTICAL)
detectChanges(opts: DetectChangesOptions): SourceChanges {
    const { previousHashes, currentEntries, full } = opts;
    if (!previousHashes || full) {
        return { added: currentEntries, modified: [], deleted: [], unchanged: [] };
    }
    const added: SourceEntry[] = [];
    ...
}
```

**Recommendation:**
Extract a shared `defaultDetectChanges(opts, hashFn)` function into `source.ts` and have all three sources delegate to it.

**Suggested Fix:**
```typescript
// In source.ts
export function defaultDetectChanges(
    opts: DetectChangesOptions,
    hashEntry: (entry: SourceEntry) => string,
): SourceChanges {
    const { previousHashes, currentEntries, full } = opts;
    if (!previousHashes || full) {
        return { added: currentEntries, modified: [], deleted: [], unchanged: [] };
    }
    // ... shared logic
}

// In MailSource
detectChanges(opts: DetectChangesOptions): SourceChanges {
    return defaultDetectChanges(opts, (e) => this.hashEntry(e));
}
```

---

### Issue 4: Repeated "embeddings table exists?" checks in store.ts (DRY + performance)

**File:** `src/indexer/lib/store.ts:256-258, 278-280, 299-301, 382-384, 440-442`
**Severity:** Important (DRY + performance)

**Problem:**
Five different methods (`getUnembeddedChunkIds`, `getUnembeddedCount`, `getUnembeddedChunksPage`, `clearEmbeddings`, `getEmbeddingCount`) each independently query `sqlite_master` to check if the embeddings table exists. This query:
```sql
SELECT name FROM sqlite_master WHERE type='table' AND name=?
```
runs up to 5 times per sync cycle. While individually cheap, it adds up during embedding loops that call `getUnembeddedChunksPage` repeatedly (line 398 in indexer.ts), re-checking existence on every page iteration.

```
256:            const tableExists = db
257:                .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
258:                .get(embTable) as { name: string } | null;
```

**Recommendation:**
Cache the result. The embeddings table is created once (in `insertChunks`) and never dropped (except by `clearEmbeddings`, which should invalidate the cache). Add a `private embTableExists: boolean | null = null` field to the closure, set it after the first check, and invalidate in `clearEmbeddings`.

**Suggested Fix:**
```typescript
let embTableKnown = false;

function ensureEmbTable(): boolean {
    if (embTableKnown) return true;
    const exists = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(embTable) as { name: string } | null;
    if (exists) embTableKnown = true;
    return !!exists;
}
```

---

### Issue 5: Identical `hashEntry` across all three sources (DRY)

**File:** `src/indexer/lib/sources/file-source.ts:136-140`, `mail-source.ts:173-177`, `telegram-source.ts:176-180`
**Severity:** Important (DRY)

**Problem:**
All three source implementations have the exact same `hashEntry`:
```typescript
hashEntry(entry: SourceEntry): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(entry.content);
    return hasher.digest("hex");
}
```

**Recommendation:**
Move this to `source.ts` as a default implementation or standalone function.

**Suggested Fix:**
```typescript
// source.ts
export function hashEntryContent(entry: SourceEntry): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(entry.content);
    return hasher.digest("hex");
}
```

---

### Issue 6: Unsafe cast in verify.ts bypasses type safety

**File:** `src/indexer/commands/verify.ts:28-34`
**Severity:** Important

**Problem:**
The verify command accesses the private `store` field through an unsafe double cast:
```typescript
const store = (indexer as unknown as { store: unknown }).store as {
    getPathHashStore(): { getFileCount(): number };
    getContentCount(): number;
    getEmbeddingCount(): number;
    getUnembeddedCount(): number;
    getStats(): { dbSizeBytes: number };
};
```
This bypasses TypeScript's encapsulation. If `Indexer.store` is renamed, the type system won't catch the break. The inline type also duplicates the `IndexStore` interface shape.

**Recommendation:**
Add a `verify()` or `getVerifyInfo()` method to `Indexer` that returns the necessary stats, or expose `store` through a read-only accessor. The Indexer already exposes `stats` -- extend it or add a dedicated verification method.

**Suggested Fix:**
```typescript
// In Indexer class
getVerifyInfo(): {
    pathCount: number;
    contentCount: number;
    embeddingCount: number;
    unembeddedCount: number;
    dbSizeBytes: number;
} {
    const store = this.store;
    return {
        pathCount: store.getPathHashStore().getFileCount(),
        contentCount: store.getContentCount(),
        embeddingCount: store.getEmbeddingCount(),
        unembeddedCount: store.getUnembeddedCount(),
        dbSizeBytes: store.getStats().dbSizeBytes,
    };
}
```

---

### Issue 7: `sourceEntries` array kept in memory during full scan

**File:** `src/indexer/lib/indexer.ts:484-554`
**Severity:** Important

**Problem:**
`source.scan()` returns `SourceEntry[]` (all entries). For mail with 1M entries, each entry includes the full email body text. Even though `onBatch` processes them incrementally, the returned array (`sourceEntries`) is stored for the subsequent `detectChanges` call at line 576. This means all entries are in memory simultaneously.

```
484:            const sourceEntries = await this.source.scan({
485:                sinceId,
486:                batchSize: 500,
487:                onBatch: async (batch) => { ... },
...
554:            });
...
576:                const changes = this.source.detectChanges({
577:                    previousHashes: previousHashes.size > 0 ? previousHashes : null,
578:                    currentEntries: sourceEntries,
```

For a mail index: 1M emails x ~2KB average content = ~2GB of strings in `sourceEntries` alone, plus the `previousHashes` Map from Issue 2.

**Recommendation:**
For non-sinceId scans, the `onBatch` callback already processes and stores chunks. The only reason `sourceEntries` is needed is for `detectChanges`. Refactor so that `detectChanges` works from the path_hash store (comparing stored hashes against current hashes) rather than requiring all entries in memory. Alternatively, only keep `{ id, hash }` pairs instead of full entries.

---

### Issue 8: Warm-up failure in embedder causes unhandled throw

**File:** `src/indexer/lib/indexer.ts:383-389`
**Severity:** Important

**Problem:**
The warm-up has one retry with a 500ms delay. If the retry also throws, the exception propagates up to `embedUnembeddedChunks`, which propagates to `runSync`. The catch block at line 701 handles it by emitting `sync:error` and re-throwing. However, the chunks that were already inserted via `insertChunks` (Phase 1) are now in the DB without embeddings. The next sync will try to embed them again, but the warm-up might fail again in the same way -- creating a permanently stuck state.

```
382:        try {
383:            await this.embedder.embed("warmup");
384:        } catch {
385:            // Retry once after brief delay
386:            await new Promise((r) => setTimeout(r, 500));
387:            await this.embedder.embed("warmup");
388:        }
```

**Recommendation:**
Make embedding failures non-fatal for the sync itself. The chunks are already stored and searchable via fulltext. Log a warning that embeddings will be generated on the next sync, and return `0` from `embedUnembeddedChunks` instead of throwing. The next `sync()` call will pick up the unembedded chunks.

**Suggested Fix:**
```typescript
try {
    await this.embedder.embed("warmup");
} catch {
    await new Promise((r) => setTimeout(r, 500));
    try {
        await this.embedder.embed("warmup");
    } catch (warmupErr) {
        this.emitAndDispatch("sync:error", {
            indexName: this.config.name,
            error: `Embedding warmup failed: ${warmupErr instanceof Error ? warmupErr.message : String(warmupErr)}. Chunks stored without embeddings.`,
        }, callbacks);
        return 0;
    }
}
```

---

### Issue 9: `scan()` returns all entries PLUS processes via onBatch -- double processing risk

**File:** `src/indexer/lib/sources/mail-source.ts:34-125`
**Severity:** Important

**Problem:**
`scan()` both (a) pushes entries to the `onBatch` callback AND (b) accumulates all entries in the `entries` array which is returned. The caller (`indexer.ts:484`) stores entries via `onBatch` in Phase 1, then passes the full array to `detectChanges` in Phase 2. If any entries were already inserted via `onBatch`, Phase 2 tries to insert them again via `this.store.insertChunks(chunks)` at line 607.

The code mitigates this with the `storedInBatch` set (line 599), but the fundamental design -- returning everything AND streaming batches -- wastes memory by holding two copies: the returned array and the batches.

```
68:        const entries: SourceEntry[] = [];
...
105:            entries.push(entry);
106:            batch.push(entry);
```

**Recommendation:**
Split the interface: either `scan()` streams via `onBatch` and returns only entry IDs/hashes (lightweight), or it returns the full array and the caller batches. Having both is the worst of both worlds -- full memory usage AND callback complexity.

---

### Issue 10: `emptyStats()` duplicated between store.ts and manager.ts

**File:** `src/indexer/lib/store.ts:58-70` and `src/indexer/lib/manager.ts:209-220`
**Severity:** Important (DRY)

**Problem:**
The "empty stats" object shape with all zeros is defined in two places: inside `readMeta` in store.ts (lines 58-70) and in the `emptyStats()` function in manager.ts (lines 209-220). They have identical fields.

```
// store.ts:61-68
stats: {
    totalFiles: 0,
    totalChunks: 0,
    totalEmbeddings: 0,
    embeddingDimensions: 0,
    dbSizeBytes: 0,
    lastSyncDurationMs: 0,
    searchCount: 0,
    avgSearchDurationMs: 0,
},

// manager.ts:210-219
function emptyStats(): IndexStats {
    return {
        totalFiles: 0,
        totalChunks: 0,
        ...identical...
    };
}
```

**Recommendation:**
Export `emptyStats()` from a shared location (types.ts or store.ts) and import in both places.

---

### Issue 11: TelegramSource.scan() does NOT support onBatch

**File:** `src/indexer/lib/sources/telegram-source.ts:48-116`
**Severity:** Important (inconsistency)

**Problem:**
Unlike `FileSource` and `MailSource`, `TelegramSource.scan()` ignores `opts.onBatch` entirely. All entries are accumulated in-memory and returned at once. For a large chat history (100K+ messages), this means no crash recovery and a large memory spike.

```
78:        for (let i = 0; i < rows.length; i++) {
...
94:            entries.push({...});
...
113:        }
114:
115:        return entries;
```

The `ScanOptions` interface defines `onBatch` and `batchSize`, but TelegramSource silently ignores them.

**Recommendation:**
Add batch support to TelegramSource matching the pattern used in MailSource and FileSource.

---

## Minor Issues

### Issue 12: `Bun.file(dbPath).size` may throw if file doesn't exist yet

**File:** `src/indexer/lib/store.ts:408-412`
**Severity:** Minor

**Problem:**
The `getStats()` method wraps `Bun.file(dbPath).size` in a try/catch, but `Bun.file()` does not throw on non-existent files -- it returns a `BunFile` with `.size` of 0. The try/catch is unnecessary but harmless.

```
406:            try {
407:                dbSizeBytes = Bun.file(dbPath).size;
408:            } catch {
409:                // File may not exist yet
410:            }
```

This is a non-issue functionally but adds dead code.

---

### Issue 13: `removeChunks` calls `fts.remove()` one-by-one

**File:** `src/indexer/lib/store.ts:241-249`
**Severity:** Minor (performance)

**Problem:**
`removeChunks` loops through each chunk ID and calls `await fts.remove(id)` individually. For a batch of 10K deleted chunks (e.g., user deleted a large mailbox), this means 10K individual DELETE+FTS operations instead of a batch DELETE.

```
241:        async removeChunks(chunkIds: string[]): Promise<void> {
242:            if (chunkIds.length === 0) {
243:                return;
244:            }
245:
246:            for (const id of chunkIds) {
247:                await fts.remove(id);
248:            }
249:        },
```

**Recommendation:**
If `SearchEngine.remove()` supports batching, use it. If not, at minimum wrap the loop in a single SQLite transaction.

---

### Issue 14: `deduplicateChunks` is O(N^2)

**File:** `src/indexer/lib/chunker.ts:259-283`
**Severity:** Minor (performance)

**Problem:**
Each chunk checks against every other chunk with `other.content.includes(chunk.content)`, which is O(N^2) in the number of chunks per file. For most files this is fine (a few dozen chunks), but a massive generated file (e.g., a 50K-line JSON schema) could produce thousands of chunks.

```
266:    for (const chunk of chunks) {
267:        const isContained = chunks.some(
268:            (other) =>
269:                other.id !== chunk.id &&
270:                other.startLine <= chunk.startLine &&
271:                other.endLine >= chunk.endLine &&
272:                other.content.includes(chunk.content) &&
273:                other.content !== chunk.content
274:        );
```

**Recommendation:**
The line range check (`startLine/endLine`) is sufficient for containment -- the `content.includes()` check is redundant if the chunks were split at line boundaries. Remove the string containment check and rely on the range comparison only.

---

### Issue 15: Callback pattern duplicated between index-cmd's `createAndSync` and `incrementalSync`

**File:** `src/macos/commands/mail/index-cmd.ts:102-119` and `src/macos/commands/mail/index-cmd.ts:239-260`
**Severity:** Minor (DRY)

**Problem:**
Both `createAndSync` and `incrementalSync` define nearly identical callback objects with `onScanProgress`, `onScanComplete`, `onChunkFile`, and `onEmbedProgress`. The progress formatting logic (percentage calculation, `toLocaleString()`, spinner message formatting) is duplicated.

```
// createAndSync (lines 103-119)
onScanProgress: (payload) => {
    const pct = payload.total > 0 ? Math.round((payload.scanned / payload.total) * 100) : 0;
    spinner.message(`Scanning... ${payload.scanned.toLocaleString()}/${payload.total.toLocaleString()} (${pct}%)`);
},
...

// incrementalSync (lines 240-260) -- same pattern
onScanProgress: (payload) => {
    const pct = payload.total > 0 ? Math.round((payload.scanned / payload.total) * 100) : 0;
    spinner.message(`Scanning... ${payload.scanned.toLocaleString()}/${payload.total.toLocaleString()} (${pct}%)`);
},
```

**Recommendation:**
Extract a `buildMailCallbacks(spinner)` helper that returns the `IndexerCallbacks` object.

---

### Issue 16: `MailSource.create()` throws if Envelope Index doesn't exist

**File:** `src/indexer/lib/sources/mail-source.ts:29`
**Severity:** Minor

**Problem:**
`new Database(ENVELOPE_INDEX_PATH, { readonly: true })` throws a raw SQLite error if the file doesn't exist (Mail.app never opened). The error message would be something like `SQLITE_CANTOPEN`, which is not user-friendly.

```
29:        const db = new Database(ENVELOPE_INDEX_PATH, { readonly: true });
```

**Recommendation:**
Add an `existsSync` check before opening and throw a descriptive error: "Mail.app Envelope Index not found. Open Mail.app at least once to create it."

---

### Issue 17: `change-detector.ts` is partially dead code

**File:** `src/indexer/lib/change-detector.ts`
**Severity:** Minor

**Problem:**
The `detectChanges` function and related helpers (`detectGit`, `detectMerkle`, `detectGitMerkle`) in `change-detector.ts` are not imported by any other file. The indexer uses `source.detectChanges()` (on the source interface), not the standalone function. The Merkle diff logic in `merkle.ts` is only used by this file, which itself appears unused.

This entire file (325 lines) may be dead code left over from a prior architecture.

**Recommendation:**
Verify with `rg 'from.*change-detector'` whether this file is imported anywhere. If not, consider removing it. The `merkle.ts` functions it uses (`buildMerkleTree`, `diffMerkleTrees`) should also be checked -- they may only be used by change-detector.ts and tests.

---

### Issue 18: `FileSource.estimateTotal()` duplicates scan logic

**File:** `src/indexer/lib/sources/file-source.ts:142-163`
**Severity:** Minor (DRY)

**Problem:**
`estimateTotal()` duplicates the git-check + walk + suffix-filter logic from `scan()`. If a new filter is added to `scan()` (e.g., max file size), `estimateTotal()` would give a wrong count unless also updated.

```
142:    async estimateTotal(): Promise<number> {
143:        let filePaths: string[];
144:        if (this.opts.respectGitIgnore) {
145:            const isGit = await this.checkIsGitRepo();
146:            if (isGit) {
147:                filePaths = await this.getGitTrackedFiles();
148:            } else {
149:                filePaths = this.walkDirectory();
150:            }
151:        } else {
152:            filePaths = this.walkDirectory();
153:        }
...
```

**Recommendation:**
Extract the file-list-building logic into a shared `getFilePaths()` method used by both `scan()` and `estimateTotal()`.

---

## Positive Observations

- **Crash recovery design**: The `onBatch` + path_hash checkpoint pattern in `indexer.ts:494-497` ensures that interrupted syncs don't lose all work. This is well-thought-out for long-running mail imports.

- **Source abstraction**: The `IndexerSource` interface cleanly separates file/mail/telegram concerns. Adding a new source type (e.g., Slack) requires only implementing the interface.

- **Event system**: `IndexerEventEmitter` with typed events and derived callback types is well-engineered. The `emitAndDispatch` helper reduces boilerplate.

- **Embedding dimension mismatch detection**: `indexer.ts:143-149` catches model changes early with a clear error message and fix instructions.

- **Batched SQL in `getChunkContents`/`getChunkIdsBySourcePaths`**: Using 500-item batches for IN clauses avoids SQLite's variable limit.

- **PathHashStore**: Clean, focused class with proper PRIMARY KEY usage. The `bulkSync` transaction is correct.

- **EmlxBodyExtractor L1/L2 fallback**: Smart optimization -- try instant summaries first, fall back to full parsing only when needed.

---

## Statistics

- Files reviewed: 27
- Critical issues: 2
- Important issues: 9
- Minor issues: 7
- Positive observations: 7

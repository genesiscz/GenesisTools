# Indexer Polish & Remaining Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix remaining issues found by 3 code review agents: progress visibility, DRY violations, performance, search quality, dead code cleanup, and robustness.

**Architecture:** Targeted fixes to existing files. Some refactoring to reduce duplication. No new major abstractions.

**Tech Stack:** TypeScript, Bun SQLite, commander, @clack/prompts

---

### Task 1: Add progress callbacks to `tools indexer add`

Currently `tools indexer add ./` shows just "Indexing..." with zero progress. It should show file count, stage, and embedding progress — same as `tools macos mail index` does.

**Files:**
- Modify: `src/indexer/commands/add.ts:233-241`

**Step 1: Pass callbacks to manager.addIndex**

Replace the bare `manager.addIndex(config)` with callbacks:

```typescript
const manager = await IndexerManager.load();
const indexer = await manager.addIndex(config, {
    onScanProgress: (payload) => {
        const pct = payload.total > 0 ? Math.round((payload.scanned / payload.total) * 100) : 0;
        spinner.message(
            `Scanning... ${payload.scanned.toLocaleString()}/${payload.total.toLocaleString()} (${pct}%)`
        );
    },
    onScanComplete: (payload) => {
        spinner.message(
            `Scanned: ${payload.added.toLocaleString()} files added, ${payload.unchanged.toLocaleString()} unchanged`
        );
    },
    onChunkFile: (payload) => {
        spinner.message(`Chunking: ${payload.filePath.slice(-60)}`);
    },
    onEmbedProgress: (payload) => {
        const pct = Math.round((payload.completed / payload.total) * 100);
        spinner.message(`Embedding... ${payload.completed.toLocaleString()}/${payload.total.toLocaleString()} (${pct}%)`);
    },
});
```

**Step 2: Commit**

```bash
git add src/indexer/commands/add.ts
git commit -m "feat(indexer): add progress callbacks to 'tools indexer add'"
```

---

### Task 2: Add progress callbacks to `tools indexer rebuild`

Same issue — `tools indexer rebuild` shows just "Rebuilding index..." with no progress.

**Files:**
- Modify: `src/indexer/commands/rebuild.ts:47-49`

**Step 1: Pass callbacks to rebuildIndex**

First check if `manager.rebuildIndex()` accepts callbacks:

```typescript
// In manager.ts, rebuildIndex should forward callbacks:
async rebuildIndex(name: string, callbacks?: IndexerCallbacks): Promise<SyncStats> {
    const indexer = await this.getIndex(name);
    return indexer.reindex(callbacks);
}
```

Then in `rebuild.ts`:

```typescript
const stats = await manager.rebuildIndex(targetName, {
    onScanProgress: (payload) => {
        const pct = payload.total > 0 ? Math.round((payload.scanned / payload.total) * 100) : 0;
        spinner.message(`Scanning... ${payload.scanned.toLocaleString()}/${payload.total.toLocaleString()} (${pct}%)`);
    },
    onScanComplete: (payload) => {
        spinner.message(`Scanned: ${payload.added.toLocaleString()} added`);
    },
    onEmbedProgress: (payload) => {
        const pct = Math.round((payload.completed / payload.total) * 100);
        spinner.message(`Embedding... ${payload.completed.toLocaleString()}/${payload.total.toLocaleString()} (${pct}%)`);
    },
});
```

**Step 2: Commit**

```bash
git add src/indexer/commands/rebuild.ts src/indexer/lib/manager.ts
git commit -m "feat(indexer): add progress callbacks to 'tools indexer rebuild'"
```

---

### Task 3: Cache the `source_id` column migration check

`PRAGMA table_info()` runs on every `insertChunks` call (~428 times during full mail sync). Should check once at store creation.

**Files:**
- Modify: `src/indexer/lib/store.ts` — move migration to `createIndexStore`, cache result

**Step 1: Move migration to store creation**

After the `SearchEngine.fromDatabase()` call, run the migration once:

```typescript
// Run source_id column migration once at store creation
const contentTable = `${tableName}_content`;
const contentTableExists = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(contentTable) as { name: string } | null;

if (contentTableExists) {
    const hasSourceId = (
        db.query(`PRAGMA table_info(${contentTable})`).all() as Array<{ name: string }>
    ).some((col) => col.name === "source_id");

    if (!hasSourceId) {
        db.run(`ALTER TABLE ${contentTable} ADD COLUMN source_id TEXT DEFAULT ''`);
    }
}
```

Then remove the per-insert migration check from `insertChunks`.

**Step 2: Commit**

```bash
git add src/indexer/lib/store.ts
git commit -m "perf(indexer): cache source_id migration check at store creation"
```

---

### Task 4: Batch `removeChunks` — eliminate per-item DELETE + COUNT

`removeChunks` loops one-by-one through `fts.remove()`, each doing DELETE + vectorStore.remove + queryCount. Should use batch DELETE.

**Files:**
- Modify: `src/indexer/lib/store.ts:241-249`
- Modify: `src/utils/search/drivers/sqlite-fts5/index.ts` — add `removeMany(ids)`

**Step 1: Add removeMany to SearchEngine**

In `sqlite-fts5/index.ts`:

```typescript
async removeMany(ids: (string | number)[]): Promise<void> {
    if (ids.length === 0) return;

    const batchSize = 500;
    const tx = this.db.transaction(() => {
        for (let i = 0; i < ids.length; i += batchSize) {
            const batch = ids.slice(i, i + batchSize);
            const placeholders = batch.map(() => "?").join(",");
            this.db.run(
                `DELETE FROM ${this.tableName}_content WHERE ${this.config.schema.idField} IN (${placeholders})`,
                batch
            );
        }
    });
    tx();

    if (this.vectorStore) {
        for (const id of ids) {
            this.vectorStore.remove(String(id));
        }
    }

    this.docCount = this.queryCount();
}
```

**Step 2: Use it in store.removeChunks**

```typescript
async removeChunks(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;
    await fts.removeMany(chunkIds);
},
```

**Step 3: Commit**

```bash
git add src/indexer/lib/store.ts src/utils/search/drivers/sqlite-fts5/index.ts
git commit -m "perf(indexer): batch removeChunks with single transaction + one COUNT"
```

---

### Task 5: Use xxHash for `hashEntry` in sources (consistent with chunker)

The chunker uses `Bun.hash()` (xxHash64) for chunk IDs, but `MailSource.hashEntry()` and `FileSource.hashEntry()` still use SHA-256. Make them consistent.

**Files:**
- Modify: `src/indexer/lib/sources/mail-source.ts:173-177`
- Modify: `src/indexer/lib/sources/file-source.ts:136-139`

**Step 1: Replace SHA-256 with Bun.hash in both sources**

```typescript
hashEntry(entry: SourceEntry): string {
    return Bun.hash(entry.content).toString(16);
}
```

Note: This changes hashes for all existing entries, so existing path_hashes won't match. On next full sync, all entries will be detected as "modified" and re-chunked (a one-time cost). For incremental sinceId scans, path_hashes are not compared anyway so no impact.

**Step 2: Commit**

```bash
git add src/indexer/lib/sources/mail-source.ts src/indexer/lib/sources/file-source.ts
git commit -m "perf(indexer): use xxHash for hashEntry, consistent with chunker"
```

---

### Task 6: Store `maxEmbedChars` in index metadata

The truncation length is hardcoded at 500 and not recorded. If changed later, old and new embeddings will be inconsistent. Store it in metadata so the system knows what was used.

**Files:**
- Modify: `src/indexer/lib/types.ts` — add `maxEmbedChars` to `EmbeddingModelInfo`
- Modify: `src/indexer/lib/indexer.ts` — store the value in finalization

**Step 1: Add field to EmbeddingModelInfo**

```typescript
export interface EmbeddingModelInfo {
    model: string;
    provider: string;
    dimensions: number;
    maxEmbedChars?: number;
}
```

**Step 2: Set it in finalization**

In `indexer.ts`, the `embeddingModelInfo` object:

```typescript
const embeddingModelInfo = this.embedder
    ? {
          model: this.config.embedding?.model ?? "unknown",
          provider: this.config.embedding?.provider ?? "unknown",
          dimensions: this.embedder.dimensions,
          maxEmbedChars,
      }
    : undefined;
```

Move `maxEmbedChars` from a local variable in `embedUnembeddedChunks` to a class-level constant or config field so it's accessible in `runSync` finalization.

**Step 3: Commit**

```bash
git add src/indexer/lib/types.ts src/indexer/lib/indexer.ts
git commit -m "feat(indexer): store maxEmbedChars in index metadata"
```

---

### Task 7: Expose store stats via Indexer public API (fix verify.ts cast)

`verify.ts` uses `(indexer as unknown as { store: unknown }).store` to access private internals. Add public methods instead.

**Files:**
- Modify: `src/indexer/lib/indexer.ts` — add public `getConsistencyInfo()` method
- Modify: `src/indexer/commands/verify.ts` — use public API

**Step 1: Add public method to Indexer**

```typescript
getConsistencyInfo(): {
    pathHashCount: number;
    contentCount: number;
    embeddingCount: number;
    unembeddedCount: number;
    dbSizeBytes: number;
} {
    return {
        pathHashCount: this.store.getPathHashStore().getFileCount(),
        contentCount: this.store.getContentCount(),
        embeddingCount: this.store.getEmbeddingCount(),
        unembeddedCount: this.store.getUnembeddedCount(),
        dbSizeBytes: this.store.getStats().dbSizeBytes,
    };
}
```

**Step 2: Update verify.ts to use it**

```typescript
const indexer = await manager.getIndex(indexName);
const info = indexer.getConsistencyInfo();

p.log.info(`  ${pc.dim("Path hashes:")}  ${info.pathHashCount.toLocaleString()}`);
p.log.info(`  ${pc.dim("Content rows:")} ${info.contentCount.toLocaleString()}`);
// ... etc
```

**Step 3: Commit**

```bash
git add src/indexer/lib/indexer.ts src/indexer/commands/verify.ts
git commit -m "refactor(indexer): expose getConsistencyInfo() instead of private store cast"
```

---

### Task 8: Remove dead code — `change-detector.ts` and legacy Merkle

The `change-detector.ts` file with `buildMerkleTree`/`diffMerkleTrees` is no longer used by the indexer pipeline (replaced by PathHashStore). The `loadMerkle()` method in store.ts is deprecated.

**Files:**
- Delete: `src/indexer/lib/change-detector.ts` (if it exists)
- Modify: `src/indexer/lib/store.ts` — remove `loadMerkle()` method and its interface entry
- Clean up: Remove `deserializeMerkleTree` import if no longer used

**Step 1: Check if change-detector.ts exists and is imported anywhere**

```bash
rg "change-detector" src/indexer/
rg "loadMerkle" src/indexer/
rg "buildMerkleTree" src/indexer/
rg "diffMerkleTrees" src/indexer/
```

If nothing imports them, remove the dead code.

**Step 2: Remove deprecated loadMerkle**

In `store.ts`, remove the `loadMerkle` method from both the interface and implementation. Remove the `deserializeMerkleTree` import if it's only used by loadMerkle.

**Step 3: Commit**

```bash
git add -A
git commit -m "chore(indexer): remove dead Merkle tree code and deprecated loadMerkle"
```

---

### Task 9: DRY — extract shared progress callback pattern

The progress callback object `{ onScanProgress, onScanComplete, onChunkFile, onEmbedProgress }` is copy-pasted across `add.ts`, `rebuild.ts`, `index-cmd.ts` (3 places). Extract a shared factory.

**Files:**
- Create: `src/indexer/commands/shared.ts`
- Modify: `src/indexer/commands/add.ts`
- Modify: `src/indexer/commands/rebuild.ts`
- Modify: `src/macos/commands/mail/index-cmd.ts`

**Step 1: Create shared callback factory**

```typescript
import type { IndexerCallbacks } from "../lib/events";
import type { Spinner } from "@clack/prompts";

export function createProgressCallbacks(spinner: { message: (msg: string) => void }): IndexerCallbacks {
    return {
        onScanProgress: (payload) => {
            const pct = payload.total > 0 ? Math.round((payload.scanned / payload.total) * 100) : 0;
            spinner.message(
                `Scanning... ${payload.scanned.toLocaleString()}/${payload.total.toLocaleString()} (${pct}%)`
            );
        },
        onScanComplete: (payload) => {
            if (payload.added > 0) {
                spinner.message(`Scanned: ${payload.added.toLocaleString()} new items`);
            } else {
                spinner.message("Index is up to date");
            }
        },
        onChunkFile: (payload) => {
            spinner.message(`Chunking: ${payload.filePath.slice(-60)}`);
        },
        onEmbedProgress: (payload) => {
            const pct = Math.round((payload.completed / payload.total) * 100);
            spinner.message(
                `Embedding... ${payload.completed.toLocaleString()}/${payload.total.toLocaleString()} (${pct}%)`
            );
        },
    };
}
```

**Step 2: Use in add.ts, rebuild.ts, index-cmd.ts**

```typescript
import { createProgressCallbacks } from "./shared";

// Replace inline callbacks with:
const callbacks = createProgressCallbacks(spinner);
const indexer = await manager.addIndex(config, callbacks);
```

**Step 3: Commit**

```bash
git add src/indexer/commands/shared.ts src/indexer/commands/add.ts src/indexer/commands/rebuild.ts src/macos/commands/mail/index-cmd.ts
git commit -m "refactor(indexer): extract shared progress callback factory, DRY up 4 files"
```

---

### Task 10: Add `PRAGMA integrity_check` to verify command

The verify command checks data consistency but not SQLite DB integrity itself.

**Files:**
- Modify: `src/indexer/commands/verify.ts`

**Step 1: Add integrity check**

After the consistency checks, add:

```typescript
// SQLite integrity check
const integrityResult = db.query("PRAGMA integrity_check").get() as { integrity_check: string };

if (integrityResult.integrity_check !== "ok") {
    issues.push(`SQLite integrity check failed: ${integrityResult.integrity_check}`);
}
```

This requires access to the raw DB. Use the new `getConsistencyInfo()` approach, or add a `checkIntegrity()` method to IndexStore/Indexer.

**Step 2: Commit**

```bash
git add src/indexer/commands/verify.ts src/indexer/lib/indexer.ts
git commit -m "feat(indexer): add SQLite integrity check to verify command"
```

---

### Task 11: Deduplicate `embeddings table exists` checks in store.ts

The pattern `db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(embTable)` appears 5+ times in store.ts. Cache it.

**Files:**
- Modify: `src/indexer/lib/store.ts`

**Step 1: Cache the check at store creation**

```typescript
// After SearchEngine setup:
const embTable = `${tableName}_embeddings`;
let embTableExists = !!db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(embTable);

// In insertChunks, after creating the table:
if (embeddings && embeddings.size > 0) {
    if (!embTableExists) {
        db.run(`CREATE TABLE IF NOT EXISTS ${embTable} (...)`);
        embTableExists = true;
    }
    // ... inserts
}
```

Replace all 5 occurrences of the check with the cached `embTableExists` variable. Update the variable to `true` when the table is created in `insertChunks`.

**Step 2: Commit**

```bash
git add src/indexer/lib/store.ts
git commit -m "perf(indexer): cache embeddings table existence check in store"
```

---

### Task 12: Clean up leftover `integration_test_` indexes

Integration tests create indexes in `~/.genesis-tools/indexer/` with names like `integration_test_1742...` but never clean them up. They accumulate and show in `tools indexer verify` and `tools indexer status`.

**Files:**
- Modify: `src/indexer/lib/integration.test.ts` — add afterAll cleanup
- Modify: `src/indexer/lib/indexer.test.ts` — add afterAll cleanup

**Step 1: Add cleanup to test files**

Each test file should clean up its index directories in `afterAll` or `afterEach`:

```typescript
afterAll(async () => {
    // Clean up any test indexes from the shared config
    const { IndexerManager } = await import("./manager");
    const manager = await IndexerManager.load();
    const names = manager.getIndexNames().filter(n => n.startsWith("integration_test_") || n.startsWith("test_"));

    for (const name of names) {
        try { await manager.removeIndex(name); } catch {}
    }

    await manager.close();
});
```

**Step 2: Also add a `tools indexer cleanup-tests` or just clean existing leftovers manually**

For the existing leftover indexes, the user can run:

```bash
tools indexer verify  # See the list
# Then for each integration_test_* index:
tools indexer remove integration_test_XXXX --force
```

Or add a one-liner to remove them all:

```bash
bun -e "
const { IndexerManager } = await import('./src/indexer/lib/manager');
const m = await IndexerManager.load();
for (const n of m.getIndexNames().filter(n => n.startsWith('integration_test_') || n.startsWith('test_'))) {
    await m.removeIndex(n);
    console.log('Removed:', n);
}
await m.close();
"
```

**Step 3: Commit**

```bash
git add src/indexer/lib/integration.test.ts src/indexer/lib/indexer.test.ts
git commit -m "test(indexer): clean up leftover integration_test_ indexes in afterAll"
```

---

### Task 19: Improve `tools indexer add` interactive TUI — guide through all params

Currently `tools indexer add ./` silently picks defaults for everything (model, chunking, embedding provider) and shows no indication of what was selected. It should walk the user through key decisions interactively when in TTY mode, and always display what was chosen.

**Files:**
- Modify: `src/indexer/commands/add.ts:130-232` (the non-interactive and interactive flows)

**Step 1: After determining index type, show model selection**

When no `--model` flag is given and embedding is enabled, prompt the user to pick a model:

```typescript
// After type detection:
p.log.info(`Path: ${pc.dim(absPath)}`);
p.log.info(`Name: ${pc.bold(name)}`);
p.log.info(`Type: ${type}`);

// Model selection — interactive if no --model flag
let model = opts.model;
let provider: string | undefined;

if (opts.embed !== false && !model && process.stdout.isTTY) {
    const { getModelsForType } = await import("../lib/model-registry");
    const recommended = getModelsForType(type);

    if (recommended.length > 0) {
        const selected = await p.select({
            message: "Embedding model",
            options: [
                ...recommended.map((m) => ({
                    value: m.id,
                    label: `${m.name} (${m.dimensions}-dim, ${m.provider})`,
                    hint: m.description,
                })),
                { value: "__none__", label: "No embeddings (fulltext-only)" },
            ],
        });

        if (p.isCancel(selected)) {
            p.log.info("Cancelled");
            return;
        }

        if (selected === "__none__") {
            opts.embed = false;
        } else {
            model = selected as string;
            const found = recommended.find((m) => m.id === model);
            provider = found?.provider;
        }
    }
}

if (model) {
    const { MODEL_REGISTRY } = await import("../lib/model-registry");
    const found = MODEL_REGISTRY.find((m) => m.id === model);
    p.log.info(`Model: ${pc.bold(found?.name ?? model)} (${found?.dimensions ?? "??"}-dim, ${found?.provider ?? "unknown"})`);

    if (!provider) {
        provider = found?.provider;
    }
}
```

**Step 2: Show chunking strategy selection when non-default**

```typescript
// Chunking strategy — show what was picked
const chunking = opts.chunking ?? "auto";
p.log.info(`Chunking: ${pc.bold(chunking)}`);
```

**Step 3: Show summary before indexing starts**

```typescript
if (opts.embed === false) {
    p.log.info(`Embeddings: ${pc.dim("disabled (fulltext-only)")}`);
} else if (!model) {
    p.log.warn("No embedding model selected — will be fulltext-only");
}
```

**Step 4: Commit**

```bash
git add src/indexer/commands/add.ts
git commit -m "feat(indexer): interactive model selection and config display in 'tools indexer add'"
```

---

## Tasks from reliability-reviewer (agent 3)

### Task 13: DRY — extract shared `detectChanges` and `hashEntry` from sources

`detectChanges` is character-for-character identical in `MailSource` (mail-source.ts:127-166), `TelegramSource` (telegram-source.ts:118-157), and `FileSource` (file-source.ts:93-134). Same for `hashEntry` (SHA-256 in all 3). Extract both to `source.ts` as default implementations.

**Files:**
- Modify: `src/indexer/lib/sources/source.ts` — add `defaultDetectChanges()` and `defaultHashEntry()`
- Modify: `src/indexer/lib/sources/mail-source.ts` — use shared implementations
- Modify: `src/indexer/lib/sources/file-source.ts` — use shared implementations
- Modify: `src/indexer/lib/sources/telegram-source.ts` — use shared implementations

**Step 1: Add shared functions to source.ts**

```typescript
export function defaultDetectChanges(opts: DetectChangesOptions, hashFn: (entry: SourceEntry) => string): SourceChanges {
    const { previousHashes, currentEntries, full } = opts;

    if (!previousHashes || full) {
        return { added: currentEntries, modified: [], deleted: [], unchanged: [] };
    }

    const added: SourceEntry[] = [];
    const modified: SourceEntry[] = [];
    const unchanged: string[] = [];
    const currentIds = new Set<string>();

    for (const entry of currentEntries) {
        currentIds.add(entry.id);
        const prevHash = previousHashes.get(entry.id);

        if (!prevHash) {
            added.push(entry);
        } else if (prevHash !== hashFn(entry)) {
            modified.push(entry);
        } else {
            unchanged.push(entry.id);
        }
    }

    const deleted: string[] = [];

    for (const id of previousHashes.keys()) {
        if (!currentIds.has(id)) {
            deleted.push(id);
        }
    }

    return { added, modified, deleted, unchanged };
}

export function defaultHashEntry(entry: SourceEntry): string {
    return Bun.hash(entry.content).toString(16);
}
```

**Step 2: Use in all 3 sources**

```typescript
// In each source:
detectChanges(opts: DetectChangesOptions): SourceChanges {
    return defaultDetectChanges(opts, this.hashEntry.bind(this));
}

hashEntry(entry: SourceEntry): string {
    return defaultHashEntry(entry);
}
```

**Step 3: Commit**

```bash
git add src/indexer/lib/sources/
git commit -m "refactor(indexer): extract shared detectChanges + hashEntry, DRY 3 sources"
```

---

### Task 14: Make embedding warmup failure non-fatal

If DarwinKit embedding warmup fails twice (`indexer.ts:383-389`), the error propagates and kills the entire sync. But Phase 1 already stored chunks — they're fulltext-searchable. Embedding failure should log a warning and skip Phase 3, not crash.

**Files:**
- Modify: `src/indexer/lib/indexer.ts:375-389` (warmup) and the `embedUnembeddedChunks` call

**Step 1: Wrap embedding phase in try/catch**

In `runSync`, wrap Phase 3:

```typescript
// ── Phase 3: EMBED ───────────────────────────────────────
let embeddingsGenerated = 0;

try {
    embeddingsGenerated = await this.embedUnembeddedChunks(callbacks);
} catch (err) {
    // Embedding failure is non-fatal — chunks are still fulltext-searchable
    const msg = err instanceof Error ? err.message : String(err);
    this.emitAndDispatch("sync:error", {
        indexName: this.config.name,
        error: `Embedding failed (FTS still works): ${msg}`,
    }, callbacks);
}
```

Also move the warmup into `embedUnembeddedChunks` so the error is contained:

```typescript
// Warm up — failure here should just skip embedding
try {
    await this.embedder.embed("warmup");
} catch {
    try {
        await new Promise((r) => setTimeout(r, 500));
        await this.embedder.embed("warmup");
    } catch {
        throw new Error("Embedding model failed to initialize");
    }
}
```

**Step 2: Commit**

```bash
git add src/indexer/lib/indexer.ts
git commit -m "fix(indexer): make embedding failure non-fatal — chunks remain fulltext-searchable"
```

---

### Task 15: Add file-level advisory lock for concurrent process safety

Two CLI invocations of `tools macos mail index` simultaneously can corrupt the index. Add a lockfile.

**Files:**
- Modify: `src/indexer/lib/store.ts` — create lockfile on open, remove on close

**Step 1: Add lockfile management**

At the top of `createIndexStore`, after creating the directory:

```typescript
const lockPath = join(indexDir, "index.lock");

if (existsSync(lockPath)) {
    const pid = readFileSync(lockPath, "utf-8").trim();
    // Check if the PID is still alive
    try {
        process.kill(parseInt(pid, 10), 0); // signal 0 = check if alive
        throw new Error(
            `Index "${config.name}" is locked by another process (PID ${pid}). ` +
            `If this is stale, delete ${lockPath}`
        );
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
            // Process is dead — stale lock, safe to remove
            rmSync(lockPath);
        } else {
            throw err;
        }
    }
}

writeFileSync(lockPath, String(process.pid));
```

In the `close()` method:

```typescript
async close(): Promise<void> {
    await fts.close();
    db.close();
    try { rmSync(lockPath); } catch {}
},
```

**Step 2: Commit**

```bash
git add src/indexer/lib/store.ts
git commit -m "fix(indexer): add file-level advisory lock to prevent concurrent corruption"
```

---

### Task 16: TelegramSource — add onBatch support for crash recovery

`TelegramSource.scan()` silently ignores the `onBatch` callback, unlike MailSource and FileSource. This means Telegram indexing has no crash recovery.

**Files:**
- Modify: `src/indexer/lib/sources/telegram-source.ts`

**Step 1: Add onBatch support**

Follow the same pattern as MailSource — accumulate entries in a batch, flush when reaching batchSize:

```typescript
// After building entry:
entries.push(entry);
batch.push(entry);

if (opts?.onBatch && batch.length >= batchSize) {
    await opts.onBatch(batch);
    batch = [];
}

// After loop:
if (opts?.onBatch && batch.length > 0) {
    await opts.onBatch(batch);
}
```

**Step 2: Commit**

```bash
git add src/indexer/lib/sources/telegram-source.ts
git commit -m "feat(indexer): add onBatch crash recovery support to TelegramSource"
```

---

### Task 17: Deduplicate `emptyStats()` helper

The same `emptyStats()` function exists in both `store.ts:58-70` and `manager.ts:209-220`. Extract to `types.ts`.

**Files:**
- Modify: `src/indexer/lib/types.ts` — add `emptyStats()` export
- Modify: `src/indexer/lib/store.ts` — import from types
- Modify: `src/indexer/lib/manager.ts` — import from types

**Step 1: Move to types.ts**

```typescript
export function emptyStats(): IndexStats {
    return {
        totalFiles: 0,
        totalChunks: 0,
        totalEmbeddings: 0,
        embeddingDimensions: 0,
        dbSizeBytes: 0,
        lastSyncDurationMs: 0,
        searchCount: 0,
        avgSearchDurationMs: 0,
    };
}
```

**Step 2: Commit**

```bash
git add src/indexer/lib/types.ts src/indexer/lib/store.ts src/indexer/lib/manager.ts
git commit -m "refactor(indexer): deduplicate emptyStats() into types.ts"
```

---

### Task 18: Graceful error when Mail.app Envelope Index doesn't exist

`MailSource.create()` throws raw `SQLITE_CANTOPEN` when Mail.app has never been opened. Should show a user-friendly error.

**Files:**
- Modify: `src/indexer/lib/sources/mail-source.ts:27-32`

**Step 1: Wrap DB open in try/catch**

```typescript
static async create(): Promise<MailSource> {
    if (!existsSync(ENVELOPE_INDEX_PATH)) {
        throw new Error(
            "Mail.app Envelope Index not found. Make sure Mail.app has been opened at least once.\n" +
            `Expected: ${ENVELOPE_INDEX_PATH}`
        );
    }

    const db = new Database(ENVELOPE_INDEX_PATH, { readonly: true });
    const emlx = await EmlxBodyExtractor.create();
    return new MailSource(db, emlx);
}
```

**Step 2: Commit**

```bash
git add src/indexer/lib/sources/mail-source.ts
git commit -m "fix(mail): graceful error when Mail.app Envelope Index doesn't exist"
```

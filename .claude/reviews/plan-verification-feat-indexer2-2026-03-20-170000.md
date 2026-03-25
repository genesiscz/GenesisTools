# Plan Implementation Verification

**Date:** 2026-03-20
**Branch:** feat/indexer2

---

## Plan A: Indexer Guardrails & Date Range Filtering (7 tasks)

### Task 1: Add confirmation to `--rebuild-fulltext`

**Status: IMPLEMENTED**

**Evidence:** `src/macos/commands/mail/index-cmd.ts:71-98` -- The `--rebuild-fulltext` path checks `!opts.force`, then checks `!process.stdout.isTTY` (exits with error), then shows a `p.confirm()` prompt with chunk/embedding counts. Cancel or rejection returns early. The `--force` flag is declared at line 41 and the else-branch at line 93-95 logs "Rebuilding (--force, skipping confirmation)...".

---

### Task 2: Add confirmation to `--rebuild-embeddings`

**Status: IMPLEMENTED**

**Evidence:** `src/macos/commands/mail/index-cmd.ts:211-233` -- In `rebuildEmbeddings()`, when `embCount > 0 && !opts.force`, it checks `!process.stdout.isTTY` (exits with error), then shows a `p.confirm()` with a scope message that changes based on whether a date range is specified. The `--force` bypass is at lines 231-233.

---

### Task 3: Add confirmation to `tools indexer rebuild`

**Status: IMPLEMENTED**

**Evidence:** `src/indexer/commands/rebuild.ts:47-60` -- After resolving `targetName`, the code gets `meta` and `chunkCount`. When TTY and `chunkCount > 0`, shows a `p.confirm()` prompt asking to rebuild with chunk count. Cancellation returns early.

---

### Task 4: Add `--from` and `--to` date filtering to MailSource

**Status: IMPLEMENTED**

**Evidence:**

- `src/indexer/lib/sources/source.ts:29-31` -- `ScanOptions` interface has `fromDate?: Date` and `toDate?: Date` fields.
- `src/indexer/lib/sources/mail-source.ts:54-70` -- `scan()` builds dynamic WHERE clause conditions. When `opts?.fromDate` is set, pushes `m.date_sent >= ?` with epoch seconds. Same for `toDate` with `<=`.
- `src/indexer/lib/sources/mail-source.ts:162-179` -- `estimateTotal()` accepts optional `{ fromDate?, toDate? }` and builds the same dynamic WHERE clause for count queries.

---

### Task 5: Wire `--from`/`--to` into `tools macos mail index`

**Status: IMPLEMENTED**

**Evidence:**

- `src/macos/commands/mail/index-cmd.ts:42-43` -- CLI options `--from <date>` and `--to <date>` are declared.
- `src/macos/commands/mail/index-cmd.ts:17-30` -- `parseDate()` helper validates date strings.
- `src/macos/commands/mail/index-cmd.ts:57-58` -- Dates are parsed early in the action handler.
- `src/macos/commands/mail/index-cmd.ts:69` -- `incrementalSync` receives `{ fromDate, toDate }`.
- `src/macos/commands/mail/index-cmd.ts:310-316` -- Date range is displayed in the UI.
- `src/macos/commands/mail/index-cmd.ts:340-342` -- `indexer.sync()` receives `scanOptions: { fromDate, toDate }`.
- `src/indexer/lib/indexer.ts:15-17` -- `SyncOptions` interface has `scanOptions` with `fromDate`/`toDate`.
- `src/indexer/lib/indexer.ts:519-523` -- `runSync` passes `fromDate`/`toDate` through to `this.source.scan()`.

---

### Task 6: Scope `--rebuild-embeddings` to date range

**Status: IMPLEMENTED**

**Evidence:**

- `src/indexer/lib/store.ts:38` -- `clearEmbeddingsBySourceIds(sourceIds: string[]): void` on the interface.
- `src/indexer/lib/store.ts:398-415` -- Implementation batches DELETE queries using `source_id IN (...)` to remove only matching embeddings.
- `src/indexer/lib/indexer.ts:167-170` -- `reembedBySourceIds()` method calls `clearEmbeddingsBySourceIds` then `embedUnembeddedChunks`.
- `src/macos/commands/mail/index-cmd.ts:243-258` -- When date range is provided, scans MailSource for matching entries, extracts source IDs, and calls `indexer.reembedBySourceIds()`. Otherwise falls back to full `reembed()`.

---

### Task 7: Add `--force` flag to bypass confirmations

**Status: IMPLEMENTED**

**Evidence:**

- `src/macos/commands/mail/index-cmd.ts:41` -- `.option("--force", "Skip confirmation for destructive operations")` is declared.
- `src/macos/commands/mail/index-cmd.ts:72` -- `--rebuild-fulltext` checks `!opts.force` before prompting.
- `src/macos/commands/mail/index-cmd.ts:213` -- `--rebuild-embeddings` checks `!opts.force` before prompting.
- Both paths have an `else` block that logs "skipping confirmation" when `--force` is active.

---

## Plan B: Indexer Polish & Remaining Fixes (19 tasks)

### Task 1: Add progress callbacks to `tools indexer add`

**Status: IMPLEMENTED**

**Evidence:** `src/indexer/commands/add.ts:282` -- `manager.addIndex(config, createProgressCallbacks(spinner))` passes callbacks from the shared `createProgressCallbacks` factory. Import at line 10 from `"../lib/progress"`.

---

### Task 2: Add progress callbacks to `tools indexer rebuild`

**Status: IMPLEMENTED**

**Evidence:**

- `src/indexer/commands/rebuild.ts:65` -- `manager.rebuildIndex(targetName, createProgressCallbacks(spinner))` passes callbacks.
- `src/indexer/lib/manager.ts:156-159` -- `rebuildIndex()` accepts `callbacks?: IndexerCallbacks` and forwards to `indexer.reindex(callbacks)`.
- Import at line 6 from `"../lib/progress"`.

---

### Task 3: Cache the `source_id` column migration check

**Status: IMPLEMENTED**

**Evidence:** `src/indexer/lib/store.ts:219-232` -- Migration is performed once at store creation time (after `SearchEngine.fromDatabase()`). The code checks `PRAGMA table_info` once, and adds the `source_id` column if missing. There is no per-`insertChunks` migration check -- `insertChunks` at line 243 directly writes to `source_id` without checking.

---

### Task 4: Batch `removeChunks` -- eliminate per-item DELETE + COUNT

**Status: PARTIALLY IMPLEMENTED**

**Evidence:** `src/indexer/lib/store.ts:267-287` -- `removeChunks` does batch DELETEs using `IN (...)` with batches of 500, wrapped in a transaction. However, the plan also called for adding a `removeMany` method to `SearchEngine` (sqlite-fts5). No `removeMany` method was found in the search engine. Instead, `removeChunks` bypasses the search engine and directly runs SQL DELETEs on the content table + accesses `fts["vectorStore"]` for vector removal. This is functional but doesn't add the `removeMany` abstraction to the search engine as planned.

**Verdict:** The core goal (batch deletion with single transaction) is achieved. The `removeMany` abstraction on SearchEngine was skipped but the outcome is equivalent.

---

### Task 5: Use xxHash for `hashEntry` in sources

**Status: IMPLEMENTED**

**Evidence:**

- `src/indexer/lib/sources/source.ts:84-86` -- `defaultHashEntry()` uses `Bun.hash(entry.content).toString(16)` (xxHash64).
- `src/indexer/lib/sources/mail-source.ts:182-184` -- `hashEntry()` delegates to `defaultHashEntry(entry)`.
- `src/indexer/lib/sources/file-source.ts:143-145` -- `hashEntry()` delegates to `defaultHashEntry(entry)`.
- `src/indexer/lib/sources/telegram-source.ts:161-163` -- `hashEntry()` delegates to `defaultHashEntry(entry)`.

All three sources now use xxHash via the shared helper.

---

### Task 6: Store `maxEmbedChars` in index metadata

**Status: IMPLEMENTED**

**Evidence:**

- `src/indexer/lib/types.ts:47` -- `EmbeddingModelInfo` interface has `maxEmbedChars?: number`.
- `src/indexer/lib/indexer.ts:68` -- `const MAX_EMBED_CHARS = 500` class-level constant.
- `src/indexer/lib/indexer.ts:715-721` -- `embeddingModelInfo` object includes `maxEmbedChars: MAX_EMBED_CHARS` in the finalization block of `runSync`.

---

### Task 7: Expose store stats via Indexer public API (fix verify.ts cast)

**Status: IMPLEMENTED**

**Evidence:**

- `src/indexer/lib/indexer.ts:134-150` -- `getConsistencyInfo()` public method returns `pathHashCount`, `contentCount`, `embeddingCount`, `unembeddedCount`, `dbSizeBytes`, and `integrityCheck`.
- `src/indexer/commands/verify.ts:28` -- `indexer.getConsistencyInfo()` is called directly -- no more `(indexer as unknown as ...)` cast.
- `src/indexer/lib/store.ts:457-459` -- `getContentCount()` method exists.
- `src/indexer/lib/store.ts:462-468` -- `getEmbeddingCount()` method exists.

---

### Task 8: Remove dead code -- `change-detector.ts` and legacy Merkle

**Status: NOT IMPLEMENTED**

**Evidence:**

- `src/indexer/lib/change-detector.ts` -- **Still exists** (325 lines). The file contains `detectChanges()`, `detectGit()`, `detectMerkle()`, `detectGitMerkle()`.
- `src/indexer/lib/change-detector.test.ts` -- Still exists and imports from change-detector.
- However, no production code imports from `change-detector.ts` (only the test file does). The import `import { buildMerkleTree, diffMerkleTrees } from "./merkle"` in change-detector.ts references `merkle.ts` which is still used by `store.ts` for the migration function `deserializeMerkleTree`.
- `store.ts` line 9 still imports `deserializeMerkleTree` from `"./merkle"` -- but this is only used in `migrateFromMerkleBlob()` which is legitimate migration code (converts old merkle_tree blob to path_hashes).
- The `loadMerkle` method mentioned in the plan -- **does not exist** in `store.ts` anymore (confirmed via grep). So the `loadMerkle` removal part is done.

**Verdict:** `change-detector.ts` was NOT removed. It is dead code (no production imports), but it still exists on disk along with its test file. The `loadMerkle` method was already removed from store.ts. Partial implementation.

---

### Task 9: DRY -- extract shared progress callback pattern

**Status: IMPLEMENTED (different location than planned)**

**Evidence:**

- The plan called for `src/indexer/commands/shared.ts` but the implementation went to `src/indexer/lib/progress.ts` instead.
- `src/indexer/lib/progress.ts` -- Contains `createProgressCallbacks(spinner)` factory that returns all 4 callback types (`onScanProgress`, `onScanComplete`, `onChunkFile`, `onEmbedProgress`).
- `src/indexer/commands/add.ts:10` -- imports `createProgressCallbacks` from `"../lib/progress"`.
- `src/indexer/commands/rebuild.ts:6` -- imports `createProgressCallbacks` from `"../lib/progress"`.
- `src/macos/commands/mail/index-cmd.ts:2` -- imports `createProgressCallbacks` from `"@app/indexer/lib/progress"`.

All three consumers use the shared factory. The location differs from the plan but the DRY goal is fully achieved.

---

### Task 10: Add `PRAGMA integrity_check` to verify command

**Status: IMPLEMENTED**

**Evidence:**

- `src/indexer/lib/store.ts:46-47` -- `checkIntegrity(): string` on the IndexStore interface.
- `src/indexer/lib/store.ts:506-508` -- Implementation runs `PRAGMA integrity_check` and returns the result string.
- `src/indexer/lib/indexer.ts:148` -- `getConsistencyInfo()` includes `integrityCheck: this.store.checkIntegrity()`.
- `src/indexer/commands/verify.ts:39-41` -- Verify command checks `info.integrityCheck !== "ok"` and pushes an issue.

---

### Task 11: Deduplicate `embeddings table exists` checks in store.ts

**Status: IMPLEMENTED**

**Evidence:**

- `src/indexer/lib/store.ts:217` -- `embTableExists` is cached at store creation: `let embTableExists = !!db.query(...)`.
- Throughout the store methods, the cached `embTableExists` variable is used instead of re-querying:
  - `insertChunks` line 249: `if (!embTableExists)` -- creates table and sets `embTableExists = true`.
  - `getUnembeddedChunkIds` line 290: `if (!embTableExists)`.
  - `getUnembeddedCount` line 304: `if (!embTableExists)`.
  - `getUnembeddedChunksPage` line 318: `if (!embTableExists)`.
  - `clearEmbeddings` line 393: `if (embTableExists)`.
  - `clearEmbeddingsBySourceIds` line 399: `!embTableExists` check.
  - `getEmbeddingCount` line 463: `if (!embTableExists)`.

All occurrences use the cached variable.

---

### Task 12: Clean up leftover `integration_test_` indexes

**Status: IMPLEMENTED**

**Evidence:**

- `src/indexer/lib/integration.test.ts:53-66` -- `afterAll` block loads `IndexerManager`, filters names starting with `"integration_test_"` or `"test_"`, and removes each one.
- `src/indexer/lib/indexer.test.ts:50-64` -- `afterAll` block does the same, filtering names starting with `"test_index_"` or `"test_"`.

Both test files clean up after themselves.

---

### Task 13: DRY -- extract shared `detectChanges` and `hashEntry` from sources

**Status: PARTIALLY IMPLEMENTED**

**Evidence:**

- `src/indexer/lib/sources/source.ts:44-81` -- `defaultDetectChanges()` is extracted and exported.
- `src/indexer/lib/sources/source.ts:84-86` -- `defaultHashEntry()` is extracted and exported.
- `src/indexer/lib/sources/mail-source.ts:158-159` -- Uses `defaultDetectChanges(opts, this.hashEntry.bind(this))`.
- `src/indexer/lib/sources/telegram-source.ts:140-142` -- Uses `defaultDetectChanges(opts, this.hashEntry.bind(this))`.
- **However, `FileSource.detectChanges()` still has its own inline implementation** at `file-source.ts:100-141`. It does NOT call `defaultDetectChanges`. This is because FileSource's logic differs -- it uses `relative(this.absBaseDir, entry.id)` for path comparison instead of using `entry.id` directly. This is a legitimate difference that prevents simple delegation.

**Verdict:** MailSource and TelegramSource are DRY. FileSource retains its custom implementation due to the relative-path logic. The `defaultHashEntry` is used by all three. The `hashEntry` part is fully DRY; the `detectChanges` part is 2/3 DRY.

---

### Task 14: Make embedding warmup failure non-fatal

**Status: IMPLEMENTED**

**Evidence:**

- `src/indexer/lib/indexer.ts:683-698` -- Phase 3 (EMBED) is wrapped in `try/catch`. On failure, it emits a `sync:error` event with the message "Embedding failed (FTS still works): ..." and continues rather than rethrowing. `embeddingsGenerated` stays at 0.
- `src/indexer/lib/indexer.ts:419-425` -- Warmup has a try/catch with a single retry after 500ms delay. If both fail, the error propagates but is caught by the Phase 3 wrapper.

---

### Task 15: Add file-level advisory lock for concurrent process safety

**Status: IMPLEMENTED**

**Evidence:**

- `src/indexer/lib/store.ts:179-200` -- At store creation, checks for `index.lock` file. If found, reads PID, sends signal 0 to check if process is alive. If alive, throws error. If dead (ESRCH), removes stale lock. Then writes current PID.
- `src/indexer/lib/store.ts:518-527` -- `close()` method removes the lockfile in a try/catch.

---

### Task 16: TelegramSource -- add onBatch support for crash recovery

**Status: IMPLEMENTED**

**Evidence:** `src/indexer/lib/sources/telegram-source.ts:85-135` -- The scan loop accumulates entries in a `batch` array. At line 123, `if (opts?.onBatch && batch.length >= batchSize)`, it flushes the batch. At line 132-134, remaining items are flushed after the loop. This matches the MailSource pattern.

---

### Task 17: Deduplicate `emptyStats()` helper

**Status: IMPLEMENTED**

**Evidence:**

- `src/indexer/lib/types.ts:50-61` -- `emptyStats()` is defined and exported from types.ts.
- `src/indexer/lib/store.ts:13` -- Imports `emptyStats` from `"./types"`.
- `src/indexer/lib/manager.ts:8` -- Imports `emptyStats` from `"./types"`.
- No duplicate `emptyStats()` function definition exists in either store.ts or manager.ts (confirmed by grep).

---

### Task 18: Graceful error when Mail.app Envelope Index doesn't exist

**Status: IMPLEMENTED**

**Evidence:** `src/indexer/lib/sources/mail-source.ts:37-43` -- `MailSource.create()` checks `existsSync(ENVELOPE_INDEX_PATH)` and throws a user-friendly error: "Mail.app Envelope Index not found. Make sure Mail.app has been opened at least once." with the expected path.

---

### Task 19: Improve `tools indexer add` interactive TUI

**Status: IMPLEMENTED**

**Evidence:**

- `src/indexer/commands/add.ts:46-160` -- Full interactive flow in `runInteractiveFlow()` when no path arg is given: prompts for path, name, type, embedding enable/disable, and model selection.
- `src/indexer/commands/add.ts:206-251` -- Non-interactive path with model display: shows Path, Name, Type, then interactive model selection when no `--model` flag is given (`lines 212-240`), shows model info or "disabled" (`lines 242-249`), and shows chunking strategy (`line 251`).
- Model selection uses `getModelsForType(type)` and shows up to 5 models with dimensions, provider, and description, plus a "No embeddings" option.

---

## Summary

| Plan | Task | Status | Notes |
|------|------|--------|-------|
| **A** | 1. Confirm --rebuild-fulltext | DONE | |
| **A** | 2. Confirm --rebuild-embeddings | DONE | |
| **A** | 3. Confirm rebuild command | DONE | |
| **A** | 4. Date filtering in MailSource | DONE | |
| **A** | 5. Wire --from/--to into CLI | DONE | |
| **A** | 6. Scope rebuild-embeddings to date range | DONE | |
| **A** | 7. --force flag | DONE | |
| **B** | 1. Progress callbacks in add | DONE | |
| **B** | 2. Progress callbacks in rebuild | DONE | |
| **B** | 3. Cache source_id migration | DONE | |
| **B** | 4. Batch removeChunks | DONE | removeMany not added to SearchEngine, but batching works via direct SQL |
| **B** | 5. xxHash for hashEntry | DONE | |
| **B** | 6. Store maxEmbedChars in metadata | DONE | |
| **B** | 7. Expose getConsistencyInfo() | DONE | |
| **B** | 8. Remove dead change-detector.ts | **NOT DONE** | File still exists (325 lines). loadMerkle was removed. |
| **B** | 9. DRY progress callbacks | DONE | In `lib/progress.ts` instead of `commands/shared.ts` |
| **B** | 10. PRAGMA integrity_check | DONE | |
| **B** | 11. Cache embTable exists | DONE | |
| **B** | 12. Test cleanup afterAll | DONE | |
| **B** | 13. DRY detectChanges + hashEntry | PARTIAL | hashEntry: all 3. detectChanges: 2/3 (FileSource keeps custom impl due to relative paths) |
| **B** | 14. Non-fatal embedding warmup | DONE | |
| **B** | 15. Advisory lock | DONE | |
| **B** | 16. TelegramSource onBatch | DONE | |
| **B** | 17. Deduplicate emptyStats | DONE | |
| **B** | 18. Graceful Mail.app error | DONE | |
| **B** | 19. Interactive TUI for add | DONE | |

**Totals:**
- Plan A: 7/7 fully implemented
- Plan B: 16/19 fully implemented, 2 partially implemented, 1 not implemented
- **Overall: 23/26 fully done, 2 partial, 1 missing**

### Items Requiring Attention

1. **B8 -- change-detector.ts not removed.** The file `src/indexer/lib/change-detector.ts` (325 lines) and its test `src/indexer/lib/change-detector.test.ts` are dead code. No production code imports them. They can be safely deleted. The `deserializeMerkleTree` import in `store.ts` is from `merkle.ts` (not change-detector) and is still needed for the migration path.

2. **B13 -- FileSource.detectChanges() not DRYed.** FileSource uses relative path comparison (`relative(this.absBaseDir, entry.id)`) which makes it structurally different from the other sources that compare by `entry.id` directly. This is a valid design reason to keep a custom implementation, but it could still be DRYed with a `keyFn` parameter on `defaultDetectChanges`. Low priority.

3. **B4 -- removeMany not added to SearchEngine.** The batch delete works via direct SQL in `store.ts` rather than through a `removeMany` method on the SearchEngine abstraction. Functionally correct but slightly breaks the abstraction layer. Low priority.

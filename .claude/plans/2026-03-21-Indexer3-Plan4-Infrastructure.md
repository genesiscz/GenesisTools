# Indexer v3 — Plan 4: Infrastructure & DX

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add production-grade infrastructure: native file watching, graceful cancellation, cross-process locking, indexing status persistence with auto-resume, and code dependency graph analysis.

**Architecture:** New general-purpose utilities in src/utils/ (watcher, change detector, lock), then indexer-specific features built on top. All utilities are agnostic and reusable by other tools.

**Tech Stack:** TypeScript/Bun, @parcel/watcher (native FSEvents/inotify), proper-lockfile, @ast-grep/napi

---

## Existing infrastructure to reuse

| What | Path | Notes |
|------|------|-------|
| `PathHashStore` | `src/indexer/lib/path-hashes.ts` | SQLite-backed hash persistence. Currently does its own change detection via `getAllFiles()` + manual diff in `source.ts:defaultDetectChanges()`. Will become a thin persistence layer over the new `ChangeDetector`. |
| `defaultDetectChanges()` | `src/indexer/lib/sources/source.ts` | Inline change detection comparing `previousHashes` map vs current entries. Logic to be extracted into `ChangeDetector`. |
| `defaultHashEntry()` | `src/indexer/lib/sources/source.ts` | Uses `Bun.hash()` (xxHash64). Will become the default hash function for `ChangeDetector`. |
| `IndexStore` (advisory lock) | `src/indexer/lib/store.ts` L179-200 | PID-file based lock — no stale detection, no auto-refresh. Replaced by `proper-lockfile` in Task 3. |
| `Indexer.startWatch()` / `stopWatch()` | `src/indexer/lib/indexer.ts` L233-284 | Polling via `setInterval`. Replaced by native `@parcel/watcher` in Task 6. |
| Watch command | `src/indexer/commands/watch.ts` | Thin CLI calling `indexer.startWatch()`. Rewired in Task 6. |
| `retry()`, `debounce()`, `throttle()` | `src/utils/async.ts` | Already implemented. Watcher debounce in Task 1 can use `debounce()` from here. |
| `IndexerEventEmitter` | `src/indexer/lib/events.ts` | Typed event emitter with wildcard support. New events added in Tasks 4, 5. |
| `IndexMeta` / `IndexConfig` | `src/indexer/lib/types.ts` | Extended with `indexingStatus` in Task 5, watch strategy updated in Task 6. |
| `IndexerManager` | `src/indexer/lib/manager.ts` | Extended with `stopIndex()` in Task 4, status display in Task 5. |
| SocratiCode watcher | `.worktrees/socraticode/src/services/watcher.ts` | Reference impl for `@parcel/watcher` usage: debounce, circuit breaker, ignore filtering. |
| SocratiCode lock | `.worktrees/socraticode/src/services/lock.ts` | Reference impl for `proper-lockfile`: stale detection, auto-refresh, PID tracking. |
| SocratiCode startup | `.worktrees/socraticode/src/services/startup.ts` | Reference impl for auto-resume: detect incomplete indexes, resume or incremental update. |
| SocratiCode code-graph | `.worktrees/socraticode/src/services/code-graph.ts` | Reference impl for `@ast-grep/napi` import extraction + directed graph. |
| SocratiCode graph-imports | `.worktrees/socraticode/src/services/graph-imports.ts` | Reference impl for per-language import extraction via AST patterns. |

---

## Task 1: General-Purpose File Watcher (`src/utils/fs/watcher.ts`)

**Files:**
- Create: `src/utils/fs/watcher.ts`
- Create: `src/utils/fs/watcher.test.ts`

Install `@parcel/watcher` — a native C++ addon that uses FSEvents (macOS), inotify (Linux), and ReadDirectoryChangesW (Windows). Single subscription for an entire directory tree, zero per-file overhead.

### Steps

1. **Install dependency:**
   ```bash
   bun add @parcel/watcher
   ```

2. **Create `src/utils/fs/watcher.ts`** with the following API:

   ```typescript
   import type { AsyncSubscription, Event } from "@parcel/watcher";

   export interface WatcherEvent {
       type: "create" | "update" | "delete";
       path: string;
   }

   export interface WatcherOptions {
       /** Debounce interval — collect changes for N ms, fire once. Default: 2000 */
       debounceMs?: number;
       /** Glob patterns for directories to ignore at the OS level (e.g. "node_modules"). Default: common ignores */
       ignorePatterns?: string[];
       /** Maximum consecutive errors before circuit breaker trips. Default: 10 */
       maxErrors?: number;
       /** Custom filter — return false to ignore an event. Applied after OS-level ignores. */
       filter?: (event: WatcherEvent) => boolean;
   }

   export interface WatcherSubscription {
       /** Stop watching and release native resources */
       unsubscribe(): Promise<void>;
       /** Whether the watcher is still active */
       readonly active: boolean;
       /** Number of consecutive errors (resets on successful event) */
       readonly errorCount: number;
   }

   export type WatcherCallback = (events: WatcherEvent[]) => void | Promise<void>;

   export function createWatcher(
       dir: string,
       callback: WatcherCallback,
       opts?: WatcherOptions
   ): Promise<WatcherSubscription>;
   ```

3. **Implementation details:**
   - Resolve `dir` to absolute path via `path.resolve()`
   - Default `ignorePatterns`: `["node_modules", ".git", "dist", "build", "out", ".next", "__pycache__", ".venv", "coverage", ".cache", ".turbo", "vendor"]`
   - **Debounce:** Accumulate events into a `Map<string, WatcherEvent>` (keyed by path, latest event type wins). After `debounceMs` of quiet, fire callback with deduped events.
   - **Circuit breaker:** Count consecutive errors. On success (events delivered), reset to 0. After `maxErrors`, auto-unsubscribe and log warning. The `WatcherSubscription.active` flips to false.
   - **Event mapping:** Convert `@parcel/watcher` `Event` types to our `WatcherEvent.type`:
     - `"create"` -> `"create"`
     - `"update"` -> `"update"`
     - `"delete"` -> `"delete"`
   - **Filter:** After mapping, apply `opts.filter` if provided. Drop events that return false.
   - `unsubscribe()` clears debounce timer, calls `subscription.unsubscribe()`, sets `active = false`

4. **Export a default ignore list** so callers can extend it:
   ```typescript
   export const DEFAULT_IGNORE_PATTERNS: string[] = [...];
   ```

5. **Tests (`src/utils/fs/watcher.test.ts`):**
   - Create temp dir, start watcher, write a file, verify callback fires with `"create"` event
   - Modify the file, verify `"update"` event
   - Delete the file, verify `"delete"` event
   - Test debounce: write 5 files in quick succession, verify callback fires once with all 5
   - Test filter: set filter to reject `.tmp` files, write `foo.tmp`, verify callback NOT fired
   - Test unsubscribe: unsubscribe, write file, verify callback NOT fired
   - Use `afterEach` to clean up temp dir and unsubscribe

**Commit:** `feat(utils): add general-purpose file watcher with @parcel/watcher`

---

## Task 2: General-Purpose Change Detector (`src/utils/fs/change-detector.ts`)

**Files:**
- Create: `src/utils/fs/change-detector.ts`
- Create: `src/utils/fs/change-detector.test.ts`
- Modify: `src/indexer/lib/sources/source.ts`
- Modify: `src/indexer/lib/sources/file-source.ts`

Extract the change detection logic from `defaultDetectChanges()` into a general-purpose, stateless utility. The indexer's `PathHashStore` + `defaultDetectChanges()` currently do two things: (1) compute changes between two hash maps, (2) persist hashes in SQLite. This task separates concern (1) into a reusable utility.

### Steps

1. **Create `src/utils/fs/change-detector.ts`:**

   ```typescript
   export interface ChangeSet {
       /** Paths present in current but not in previous */
       added: string[];
       /** Paths present in both, but with different hashes */
       modified: string[];
       /** Paths present in previous but not in current */
       deleted: string[];
       /** Paths present in both with identical hashes */
       unchanged: string[];
   }

   export interface ChangeDetectorOptions {
       /** Hash function: (content) => hash string. Default: Bun.hash xxHash64 */
       hashFn?: (content: string) => string;
   }

   /**
    * Compute the changeset between two snapshots.
    *
    * @param current  - Map of path -> content (or path -> hash if preHashed=true)
    * @param previous - Map of path -> hash from last run (empty map = first run, everything is "added")
    * @param opts     - Optional hash function override
    * @returns ChangeSet with added/modified/deleted/unchanged paths
    */
   export function detectChanges(
       current: Map<string, string>,
       previous: Map<string, string>,
       opts?: ChangeDetectorOptions
   ): ChangeSet;

   /**
    * Same as detectChanges but accepts pre-hashed current entries.
    * Use when you already have hashes and don't need to re-hash content.
    */
   export function detectChangesPreHashed(
       currentHashes: Map<string, string>,
       previousHashes: Map<string, string>
   ): ChangeSet;

   /** Default hash function using Bun's xxHash64 */
   export function defaultHash(content: string): string;
   ```

2. **Implementation:**
   - `defaultHash`: `return Bun.hash(content).toString(16);` (matches existing `defaultHashEntry`)
   - `detectChanges`: iterate `current`, hash each value, compare against `previous` map. Then iterate `previous` keys to find deletions.
   - `detectChangesPreHashed`: same logic but skips hashing (both maps are already hashes)
   - Pure functions, zero side effects, zero dependencies beyond Bun.hash

3. **Create `src/utils/fs/index.ts`** barrel export:
   ```typescript
   export * from "./watcher";
   export * from "./change-detector";
   ```

4. **Refactor `src/indexer/lib/sources/source.ts`:**
   - Import `detectChangesPreHashed` from `@app/utils/fs/change-detector`
   - Rewrite `defaultDetectChanges()` to delegate to `detectChangesPreHashed()`:
     ```typescript
     export function defaultDetectChanges(
         opts: DetectChangesOptions,
         hashFn: (entry: SourceEntry) => string
     ): SourceChanges {
         const { previousHashes, currentEntries, full } = opts;

         if (!previousHashes || full) {
             return { added: currentEntries, modified: [], deleted: [], unchanged: [] };
         }

         // Build current hash map
         const currentHashMap = new Map<string, string>();
         const entryById = new Map<string, SourceEntry>();
         for (const entry of currentEntries) {
             currentHashMap.set(entry.id, hashFn(entry));
             entryById.set(entry.id, entry);
         }

         const changeSet = detectChangesPreHashed(currentHashMap, previousHashes);

         return {
             added: changeSet.added.map(id => entryById.get(id)!),
             modified: changeSet.modified.map(id => entryById.get(id)!),
             deleted: changeSet.deleted,
             unchanged: changeSet.unchanged,
         };
     }
     ```
   - This preserves the existing `SourceChanges` interface (which has `SourceEntry[]` for added/modified) while delegating the core diff logic to the general-purpose utility.

5. **Verify `FileSource.detectChanges()` still works** — it calls `defaultDetectChanges()`, so no changes needed to `file-source.ts` itself. The refactor is internal to `source.ts`.

6. **Tests (`src/utils/fs/change-detector.test.ts`):**
   - `detectChanges` with empty previous -> all added
   - `detectChanges` with identical -> all unchanged
   - `detectChanges` with mixed: some added, some modified, some deleted, some unchanged
   - `detectChangesPreHashed` with known hashes
   - `defaultHash` returns consistent results for same input
   - Custom `hashFn` override works

**Commit:** `feat(utils): add general-purpose change detector, refactor indexer to use it`

---

## Task 3: Cross-Process File Lock (`src/utils/fs/lock.ts`)

**Files:**
- Create: `src/utils/fs/lock.ts`
- Create: `src/utils/fs/lock.test.ts`
- Modify: `src/indexer/lib/store.ts` (replace PID-file lock)
- Modify: `src/utils/fs/index.ts` (add export)

Replace the hand-rolled PID-file advisory lock in `IndexStore` with `proper-lockfile`, which provides atomic locking, stale detection, and auto-refresh. Modeled after SocratiCode's `lock.ts`.

### Steps

1. **Install dependency:**
   ```bash
   bun add proper-lockfile
   bun add -d @types/proper-lockfile
   ```

2. **Create `src/utils/fs/lock.ts`:**

   ```typescript
   export interface LockOptions {
       /** Lock considered stale after this many ms. Default: 120_000 (2 min) */
       staleMs?: number;
       /** How often to refresh the lock. Default: 30_000 (30s). Must be < staleMs/2. */
       updateMs?: number;
       /** Number of retry attempts if lock is held. Default: 0 (fail immediately) */
       retries?: number;
       /** Delay between retries in ms. Default: 1000 */
       retryDelay?: number;
       /** Called if lock is compromised (another process reclaimed it) */
       onCompromised?: (err: Error) => void;
   }

   export interface LockHandle {
       /** Release the lock */
       release(): Promise<void>;
   }

   /**
    * Acquire a cross-process file lock.
    *
    * @param lockPath - Path to the file to lock. File is created if it doesn't exist.
    * @param opts - Lock configuration
    * @returns LockHandle with release() method
    * @throws Error with code "ELOCKED" if lock is held and retries exhausted
    */
   export async function acquireLock(lockPath: string, opts?: LockOptions): Promise<LockHandle>;

   /**
    * Check if a file is currently locked (by any process).
    */
   export async function isLocked(lockPath: string, opts?: Pick<LockOptions, "staleMs">): Promise<boolean>;

   /**
    * Read the PID of the process holding the lock, if still alive.
    * Returns null if lock is not held or holder process is dead.
    */
   export async function getLockHolderPid(lockPath: string): Promise<number | null>;
   ```

3. **Implementation details:**
   - Use `proper-lockfile` under the hood:
     - `acquireLock`: ensures the lock file exists (write PID), calls `lockfile.lock()` with `{ stale, update, retries, realpath: false, onCompromised }`. Returns `{ release }` wrapping the release function from proper-lockfile.
     - `isLocked`: calls `lockfile.check()` with `{ stale, realpath: false }`
     - `getLockHolderPid`: check lock, read PID from file content, verify process alive via `process.kill(pid, 0)`
   - After acquiring, write `process.pid` to the lock file for cross-process PID identification
   - `release()` is idempotent — second call is a no-op (track released state with a boolean)

4. **Replace PID-file lock in `src/indexer/lib/store.ts`:**
   - Remove L179-200 (the manual PID-file lock logic: `existsSync(lockPath)` / `readFileSync` / `process.kill(parseInt(pid))` / `writeFileSync`)
   - Replace with:
     ```typescript
     import { acquireLock, type LockHandle } from "@app/utils/fs/lock";

     // In createIndexStore:
     const lockPath = join(indexDir, "index.lock");
     let lockHandle: LockHandle;
     try {
         lockHandle = await acquireLock(lockPath, {
             staleMs: 120_000,
             updateMs: 30_000,
             retries: 0,
         });
     } catch (err) {
         if ((err as NodeJS.ErrnoException).code === "ELOCKED") {
             throw new Error(
                 `Index "${config.name}" is locked by another process. ` +
                 `If this is stale, it will auto-expire in 2 minutes.`
             );
         }
         throw err;
     }
     ```
   - In `store.close()`: call `await lockHandle.release()` instead of `rmSync(lockPath)` inside the try-catch
   - Remove the `rmSync` import if no longer needed elsewhere in the file

5. **Update `src/utils/fs/index.ts`** barrel to export lock module.

6. **Tests (`src/utils/fs/lock.test.ts`):**
   - `acquireLock` succeeds on unlocked file
   - `acquireLock` throws ELOCKED when already locked (by same test using two handles)
   - `release()` frees the lock — subsequent `acquireLock` succeeds
   - `isLocked` returns true while held, false after release
   - `release()` is idempotent (double-release doesn't throw)
   - `getLockHolderPid` returns `process.pid` while lock is held

**Commit:** `feat(utils): add cross-process file lock via proper-lockfile, replace PID-file lock in IndexStore`

---

## Task 4: Graceful Cancellation in Indexer

**Files:**
- Modify: `src/indexer/lib/indexer.ts`
- Modify: `src/indexer/lib/events.ts` (new events)
- Modify: `src/indexer/lib/manager.ts`
- Create: `src/indexer/commands/stop.ts`
- Modify: `src/indexer/index.ts` (register new command)
- Create: `src/indexer/lib/cancellation.test.ts`

Add the ability to gracefully cancel an in-progress sync. The indexer checks a cancellation flag between embedding batches, checkpoints progress, and returns partial results.

### Steps

1. **Add cancellation state to `Indexer` class** (`src/indexer/lib/indexer.ts`):
   ```typescript
   // New private fields:
   private cancellationRequested = false;

   /** Request cancellation of the current sync operation. Non-blocking. */
   requestCancellation(): void {
       this.cancellationRequested = true;
   }

   /** Check if cancellation has been requested. */
   get isCancelled(): boolean {
       return this.cancellationRequested;
   }
   ```

2. **Add cancellation check points in `embedUnembeddedChunks()`:**
   - After each page of embeddings is stored (the `while (true)` loop around L417-455), check:
     ```typescript
     if (this.cancellationRequested) {
         this.emitAndDispatch("sync:cancelled", {
             indexName: this.config.name,
             reason: "user-requested",
             embedded,
             totalToEmbed,
         }, callbacks);
         break; // Exit the embedding loop — progress is already persisted
     }
     ```
   - The embedding loop already writes to DB in transactions per page, so progress is safe.

3. **Add cancellation check in `runSync()` Phase 2** (the remaining entries processing):
   - After processing remaining entries, before starting Phase 3 (embed):
     ```typescript
     if (this.cancellationRequested) {
         // Skip embedding phase but still finalize metadata
     }
     ```

4. **Add `"sync:cancelled"` event** to `src/indexer/lib/events.ts`:
   ```typescript
   // Add to IndexerEventMap:
   "sync:cancelled": Ts & {
       indexName: string;
       reason: string;
       embedded: number;
       totalToEmbed: number;
   };
   ```

5. **Reset cancellation flag** at the start of `runSync()`:
   ```typescript
   this.cancellationRequested = false;
   ```

6. **Update `SyncStats`** to include a `cancelled` boolean:
   ```typescript
   export interface SyncStats {
       // ... existing fields ...
       cancelled?: boolean;
   }
   ```
   Set `cancelled: true` in the return value when cancellation was triggered.

7. **Add `stopIndex()` to `IndexerManager`** (`src/indexer/lib/manager.ts`):
   ```typescript
   async stopIndex(name: string): Promise<boolean> {
       const cached = this.indexers.get(name);
       if (!cached) {
           return false;
       }
       cached.requestCancellation();
       return true;
   }
   ```

8. **Create `src/indexer/commands/stop.ts`:**
   ```typescript
   export function registerStopCommand(program: Command): void {
       program
           .command("stop")
           .description("Stop an in-progress index operation")
           .argument("<name>", "Index name")
           .action(async (name: string) => {
               // This is a cross-process operation, so we need to signal via a file.
               // Write a "stop" sentinel file that the running indexer checks.
               const storage = new Storage("indexer");
               const stopFile = join(storage.getBaseDir(), name, "stop.signal");
               await Bun.write(stopFile, String(Date.now()));
               p.log.info(`Stop signal sent to "${name}". It will stop at the next checkpoint.`);
           });
   }
   ```

9. **Add signal file check in `embedUnembeddedChunks()`:**
   - In addition to the in-process `cancellationRequested` flag, also check for the `stop.signal` file:
     ```typescript
     const storage = new Storage("indexer");
     const stopFile = join(storage.getBaseDir(), this.config.name, "stop.signal");
     // Check every N pages (e.g., every 5 pages to avoid stat overhead)
     if (pageCount % 5 === 0 && existsSync(stopFile)) {
         this.cancellationRequested = true;
         rmSync(stopFile); // Consume the signal
     }
     ```
   - Note: use `git rm` for tracked files, but `stop.signal` is a runtime artifact so `rmSync` is fine here.

10. **Register the stop command** in `src/indexer/index.ts`:
    ```typescript
    import { registerStopCommand } from "./commands/stop";
    // Add: registerStopCommand(program);
    ```

11. **Tests (`src/indexer/lib/cancellation.test.ts`):**
    - Mock an indexer with slow embedding, call `requestCancellation()` after first batch, verify it stops
    - Verify `SyncStats.cancelled === true` in the returned result
    - Verify `sync:cancelled` event is emitted
    - Verify metadata is updated with partial progress (not lost)
    - Verify subsequent `sync()` resumes from where cancellation left off (unembedded chunks are still in the DB)

**Commit:** `feat(indexer): add graceful cancellation with stop command and progress checkpointing`

---

## Task 5: Indexing Status Persistence & Auto-Resume

**Files:**
- Modify: `src/indexer/lib/types.ts` (extend `IndexMeta`)
- Modify: `src/indexer/lib/indexer.ts` (set status at lifecycle points)
- Modify: `src/indexer/lib/store.ts` (status helpers)
- Modify: `src/indexer/lib/manager.ts` (auto-resume)
- Modify: `src/indexer/commands/status.ts` (display status)
- Create: `src/indexer/lib/status.test.ts`

Track the indexing lifecycle state so that interrupted indexes can be detected and resumed on next startup.

### Steps

1. **Extend `IndexMeta`** in `src/indexer/lib/types.ts`:
   ```typescript
   export interface IndexMeta {
       // ... existing fields ...
       /** Current indexing status. Persisted for crash recovery. */
       indexingStatus?: "idle" | "in-progress" | "completed" | "cancelled";
   }
   ```

2. **Set status at lifecycle points** in `src/indexer/lib/indexer.ts`:
   - **Start of `runSync()`:** Set `indexingStatus: "in-progress"`:
     ```typescript
     this.store.updateMeta({ indexingStatus: "in-progress" });
     ```
   - **End of `runSync()` (success):** Set `indexingStatus: "completed"`
   - **On cancellation:** Set `indexingStatus: "cancelled"`
   - **On error (catch block):** Set `indexingStatus: "cancelled"` (so it's detected as incomplete)

3. **Extend `updateMeta()` signature** in `src/indexer/lib/store.ts`:
   - The `updateMeta` method signature becomes:
     ```typescript
     updateMeta(updates: Partial<Pick<IndexMeta, "lastSyncAt" | "stats" | "indexEmbedding" | "searchEmbedding" | "indexingStatus">>): void;
     ```
   - In the implementation, add:
     ```typescript
     if (updates.indexingStatus !== undefined) {
         current.indexingStatus = updates.indexingStatus;
     }
     ```

4. **Add auto-resume detection** in `IndexerManager`:
   ```typescript
   /** Check for indexes that were interrupted and may need resuming */
   getInterruptedIndexes(): Array<{ name: string; meta: IndexMeta }> {
       const indexes = this.listIndexes();
       return indexes
           .filter(meta => meta.indexingStatus === "in-progress" || meta.indexingStatus === "cancelled")
           .map(meta => ({ name: meta.name, meta }));
   }

   /** Resume an interrupted index by running incremental sync */
   async resumeIndex(name: string, callbacks?: IndexerCallbacks): Promise<SyncStats> {
       const indexer = await this.getIndex(name);
       return indexer.sync(callbacks);
   }
   ```

5. **Enhance `tools indexer status`** display in `src/indexer/commands/status.ts`:
   - In the overview table, add a "Status" column:
     - `"idle"` or undefined -> dim gray text
     - `"in-progress"` -> yellow text
     - `"completed"` -> green text
     - `"cancelled"` -> red text
   - In detailed view, add the status line:
     ```typescript
     entries.push(["Status", formatIndexingStatus(meta.indexingStatus)]);
     ```
   - Add a note if status is `"in-progress"` or `"cancelled"`:
     ```
     p.log.warn("This index was interrupted. Run: tools indexer sync <name> to resume.");
     ```

6. **Add auto-resume prompt on startup** (optional enhancement):
   - In the main `tools indexer` entry point (or in the watch/sync commands), check for interrupted indexes:
     ```typescript
     const interrupted = manager.getInterruptedIndexes();
     if (interrupted.length > 0) {
         p.log.warn(`${interrupted.length} index(es) were interrupted: ${interrupted.map(i => i.name).join(", ")}`);
         p.log.info("Run: tools indexer sync to resume");
     }
     ```

7. **Tests (`src/indexer/lib/status.test.ts`):**
   - Status transitions: idle -> in-progress -> completed
   - Status on cancellation: in-progress -> cancelled
   - Status on error: in-progress -> cancelled
   - `getInterruptedIndexes()` returns correct list
   - After resume sync, status becomes "completed"

**Commit:** `feat(indexer): add indexing status persistence with auto-resume detection`

---

## Task 6: Wire Native Watcher into Indexer Watch Command

**Files:**
- Modify: `src/indexer/lib/indexer.ts` (replace polling with native watcher)
- Modify: `src/indexer/commands/watch.ts` (use native watcher, better UX)
- Modify: `src/indexer/lib/types.ts` (update watch config)
- Create: `src/indexer/lib/watch.test.ts`

Replace the `setInterval`-based polling in `Indexer.startWatch()` with native `@parcel/watcher` via the general-purpose watcher from Task 1. This gives instant file change detection instead of 5-minute polling intervals.

### Steps

1. **Update watch config** in `src/indexer/lib/types.ts`:
   ```typescript
   watch?: {
       enabled?: boolean;
       strategy?: "native" | "polling" | "git" | "merkle" | "git+merkle" | "chokidar";
       interval?: number; // Only used for "polling" strategy
       debounceMs?: number; // Debounce for native watcher. Default: 2000
   };
   ```

2. **Rewrite `Indexer.startWatch()`** in `src/indexer/lib/indexer.ts`:
   ```typescript
   import { createWatcher, type WatcherSubscription } from "@app/utils/fs/watcher";

   // Replace watchTimer with:
   private watchSubscription: WatcherSubscription | null = null;

   async startWatch(callbacks?: IndexerCallbacks): Promise<void> {
       if (this.watchSubscription?.active) {
           return;
       }

       const debounceMs = this.config.watch?.debounceMs ?? 2000;
       const strategy = this.config.watch?.strategy ?? "native";

       this.emitAndDispatch("watch:start", {
           indexName: this.config.name,
           strategy,
       }, callbacks);

       if (strategy === "polling") {
           // Keep legacy polling for non-file sources (mail, chat)
           this.startPollingWatch(callbacks);
           return;
       }

       // Native watcher for file-based indexes
       this.watchSubscription = await createWatcher(
           this.config.baseDir,
           async (events) => {
               if (this.isSyncing) return;
               this.isSyncing = true;
               try {
                   // Emit individual change events for TUI display
                   for (const event of events) {
                       this.emitAndDispatch("watch:change", {
                           indexName: this.config.name,
                           filePath: event.path,
                           event: event.type === "create" ? "add"
                               : event.type === "update" ? "modify"
                               : "delete",
                       }, callbacks);
                   }
                   await this.sync(callbacks);
               } catch {
                   // Watch sync errors are non-fatal
               } finally {
                   this.isSyncing = false;
               }
           },
           {
               debounceMs,
               maxErrors: 10,
               ignorePatterns: this.config.ignoredPaths,
               filter: (event) => {
                   // Apply suffix filter if configured
                   if (this.config.includedSuffixes?.length) {
                       const ext = event.path.split(".").pop()?.toLowerCase();
                       return this.config.includedSuffixes.some(
                           s => s.replace(/^\./, "") === ext
                       );
                   }
                   return true;
               },
           }
       );
   }
   ```

3. **Keep legacy polling** as a private method for non-file sources:
   ```typescript
   private startPollingWatch(callbacks?: IndexerCallbacks): void {
       const interval = this.config.watch?.interval ?? 300_000;
       this.watchTimer = setInterval(async () => {
           if (this.isSyncing) return;
           this.isSyncing = true;
           try {
               await this.sync(callbacks);
           } catch {
               // non-fatal
           } finally {
               this.isSyncing = false;
           }
       }, interval);
   }
   ```

4. **Update `stopWatch()`** — make it async:
   ```typescript
   async stopWatch(): Promise<void> {
       if (this.watchSubscription) {
           await this.watchSubscription.unsubscribe();
           this.watchSubscription = null;
       }
       if (this.watchTimer) {
           clearInterval(this.watchTimer);
           this.watchTimer = null;
       }
       this.emit("watch:stop", { indexName: this.config.name });
   }
   ```
   Note: `stopWatch()` changes from sync to async. Update `close()` accordingly:
   ```typescript
   async close(): Promise<void> {
       await this.stopWatch(); // was: this.stopWatch()
       // ... rest unchanged
   }
   ```

5. **Update `src/indexer/commands/watch.ts`** for better UX:
   - Show which strategy is being used (native vs polling)
   - Show "Watching N files in <dir>" after initial sync
   - Display real-time change events using the `watch:change` callback:
     ```typescript
     onWatchChange(payload) {
         const icon = payload.event === "add" ? "+" : payload.event === "modify" ? "~" : "-";
         p.log.step(`${pc.dim(icon)} ${payload.filePath}`);
     },
     ```
   - Since `startWatch()` is now async, await it

6. **Tests (`src/indexer/lib/watch.test.ts`):**
   - Integration test: create a file source index, start native watch, write a file, verify sync triggered
   - Verify `watch:change` events are emitted with correct event types
   - Verify circuit breaker: after too many errors, watch stops
   - Verify filter: ignored file extensions don't trigger sync

**Commit:** `feat(indexer): replace polling watch with native @parcel/watcher`

---

## Task 7: Code Dependency Graph

**Files:**
- Create: `src/indexer/lib/code-graph.ts`
- Create: `src/indexer/lib/graph-imports.ts`
- Create: `src/indexer/commands/graph.ts`
- Modify: `src/indexer/index.ts` (register graph command)
- Create: `src/indexer/lib/code-graph.test.ts`

Build a directed dependency graph from indexed files by extracting import statements via `@ast-grep/napi`. Persist the graph in the index metadata and expose it via a `tools indexer graph` command that outputs Mermaid diagrams.

### Steps

1. **`@ast-grep/napi` is already a dependency** (used by the AST chunker). Verify it's available:
   ```bash
   # Should already be in package.json from the chunking implementation
   bun pm ls | grep ast-grep
   ```

2. **Create `src/indexer/lib/graph-imports.ts`** — per-language import extraction:

   ```typescript
   import { Lang, parse } from "@ast-grep/napi";

   export interface ImportInfo {
       /** Raw module specifier from the source code */
       specifier: string;
       /** Whether this is a dynamic import (lazy-loaded) */
       isDynamic: boolean;
   }

   /**
    * Extract import statements from source code.
    * Supports: TypeScript/JavaScript, Python, Go.
    */
   export function extractImports(source: string, language: string): ImportInfo[];
   ```

   Language-specific extraction (referencing SocratiCode's `graph-imports.ts`):

   **TypeScript/JavaScript** (use `@ast-grep/napi` AST):
   - `import_statement` -> static imports (`import X from "Y"`)
   - `call_expression` with `require("Y")` -> CommonJS requires
   - `call_expression` with `import("Y")` -> dynamic imports (mark `isDynamic: true`)
   - `export_statement` with `from "Y"` -> re-exports

   **Python** (regex-based, no AST grammar needed):
   - `import X` -> `X`
   - `from X import Y` -> `X`
   - Support dotted names (`foo.bar` -> `foo/bar`)

   **Go** (regex-based):
   - `import "path"` -> single import
   - `import ( "path1" \n "path2" )` -> grouped imports
   - Filter out stdlib imports (no dot in path)

3. **Create `src/indexer/lib/code-graph.ts`** — graph builder:

   ```typescript
   export interface CodeGraphNode {
       /** File path (relative to index base dir) */
       path: string;
       /** Language detected */
       language: string;
       /** Number of outgoing edges (imports) */
       importCount: number;
       /** Number of incoming edges (imported by) */
       importedByCount: number;
   }

   export interface CodeGraphEdge {
       /** Importing file path */
       from: string;
       /** Imported file path (resolved) */
       to: string;
       /** Whether this is a dynamic import */
       isDynamic: boolean;
   }

   export interface CodeGraph {
       nodes: CodeGraphNode[];
       edges: CodeGraphEdge[];
       /** When the graph was last built */
       builtAt: number;
   }

   /**
    * Build a dependency graph from indexed file content.
    *
    * @param files - Map of filePath -> content
    * @param baseDir - Base directory for resolving relative imports
    * @returns CodeGraph with nodes and edges
    */
   export function buildCodeGraph(
       files: Map<string, string>,
       baseDir: string
   ): CodeGraph;

   /**
    * Generate a Mermaid diagram from a code graph.
    * For large graphs, only shows the top N most-connected nodes.
    */
   export function toMermaidDiagram(
       graph: CodeGraph,
       opts?: { maxNodes?: number; showDynamic?: boolean }
   ): string;

   /**
    * Get basic statistics about the graph.
    */
   export function getGraphStats(graph: CodeGraph): {
       totalNodes: number;
       totalEdges: number;
       avgImports: number;
       maxImporter: { path: string; count: number } | null;
       maxImported: { path: string; count: number } | null;
       orphanCount: number;
   };
   ```

4. **Import resolution** (inside `buildCodeGraph`):
   - Determine language from file extension (`.ts`/`.tsx`/`.js`/`.jsx` -> TypeScript, `.py` -> Python, `.go` -> Go)
   - For each file, extract imports via `extractImports()`
   - Resolve specifiers to actual file paths:
     - **Relative imports** (`./foo`, `../bar`): resolve against the importing file's directory, try extensions `.ts`, `.tsx`, `.js`, `.jsx`, `/index.ts`, `/index.js`
     - **Bare specifiers** (`lodash`, `@org/pkg`): skip (external packages, not in the graph)
     - **Python**: convert dotted module names to paths (`foo.bar` -> `foo/bar.py` or `foo/bar/__init__.py`)
     - **Go**: skip stdlib, resolve project-relative paths
   - Only create edges to files that exist in the `files` map
   - Build `nodes` array with `importCount` and `importedByCount` from the edges

5. **Mermaid output** (`toMermaidDiagram`):
   ```
   graph LR
       src_utils_format["utils/format.ts"]
       src_indexer_lib_store["indexer/lib/store.ts"]
       src_indexer_lib_store --> src_utils_format
   ```
   - Sanitize file paths for Mermaid node IDs (replace `/`, `.`, `-` with `_`)
   - Use short display names (relative paths)
   - For large graphs, filter to top N nodes by total connections (imports + imported-by)
   - Style dynamic imports with dashed lines: `-.->|dynamic|`

6. **Create `src/indexer/commands/graph.ts`:**

   ```typescript
   export function registerGraphCommand(program: Command): void {
       program
           .command("graph")
           .description("Show code dependency graph for an index")
           .argument("<name>", "Index name")
           .option("--format <format>", "Output format: mermaid | stats | json", "stats")
           .option("--max-nodes <n>", "Max nodes in Mermaid diagram", "30")
           .option("--file <path>", "Show dependencies for a specific file")
           .action(async (name: string, opts: { format: string; maxNodes: string; file?: string }) => {
               // 1. Load index, get all file contents from the content table
               // 2. Build graph via buildCodeGraph()
               // 3. Output based on format:
               //    - "stats": table with top importers/imported, orphans, cycles hint
               //    - "mermaid": raw Mermaid diagram text (pipe to clipboard or file)
               //    - "json": raw JSON graph structure
               // 4. If --file: filter to show only that file's imports and dependents
           });
   }
   ```

7. **Graph persistence** — store in index metadata:
   - Add `codeGraph?: CodeGraph` to `IndexMeta`
   - After a sync that modifies files, rebuild the graph (or invalidate it)
   - The `graph` command loads from metadata if available, rebuilds if stale

8. **Register the graph command** in `src/indexer/index.ts`.

9. **Add `getAllFileContents()` to `IndexStore`** for bulk content retrieval:
   ```typescript
   getAllFileContents(): Map<string, string>;
   ```
   This queries the content table and returns a map of filePath -> content for graph building.

10. **Tests (`src/indexer/lib/code-graph.test.ts`):**
    - `extractImports` for TypeScript: static, dynamic, require, re-export
    - `extractImports` for Python: `import X`, `from X import Y`
    - `extractImports` for Go: single and grouped imports
    - `buildCodeGraph` with a set of TypeScript files: verify correct nodes and edges
    - `buildCodeGraph` with unresolvable imports: verify they're silently skipped (external packages)
    - `toMermaidDiagram` output is valid Mermaid syntax
    - `getGraphStats` returns correct counts
    - `maxNodes` filtering works — large graph truncated to specified limit

**Commit:** `feat(indexer): add code dependency graph with import extraction and Mermaid output`

---

## Task 8: Benchmark After

**Files:**
- No new files — this is a measurement task

Run benchmarks to measure the improvements from this plan, focusing on watch responsiveness and operational robustness.

### Steps

1. **Watch responsiveness benchmark:**
   - Set up a file-based index on a medium project (~500 files)
   - Start native watcher via `tools indexer watch <name>`
   - Modify a file, measure time from write to sync completion
   - Compare against the old polling approach (which would be interval-based, e.g., 5 min)
   - Expected: sub-5-second response vs 5-minute polling

2. **Lock contention test:**
   - Start two `tools indexer sync` processes on the same index simultaneously
   - Verify one gets the lock, the other gets a clear error message
   - Verify the error message mentions auto-expiry (not a manual deletion instruction)

3. **Cancellation benchmark:**
   - Start a large sync (1000+ files with embeddings)
   - Send `tools indexer stop <name>` during embedding phase
   - Measure: time from stop signal to actual stop
   - Verify: subsequent `tools indexer sync` resumes without re-scanning unchanged files

4. **Auto-resume test:**
   - Start a large sync, kill the process mid-sync (Ctrl+C or SIGKILL)
   - Restart `tools indexer sync`
   - Verify: status shows "cancelled" or "in-progress", sync resumes from checkpoint
   - Measure: time saved vs full re-index

5. **Graph build time:**
   - Build code graph on a TypeScript project (~500 files)
   - Measure graph build duration
   - Verify Mermaid output renders correctly (paste into mermaid.live)

6. **Document results** in a brief summary at the end of the task. No markdown file needed — just log to stdout.

**Commit:** No commit for this task (measurement only).

---

## Summary of New Files

| File | Purpose |
|------|---------|
| `src/utils/fs/watcher.ts` | General-purpose `@parcel/watcher` wrapper |
| `src/utils/fs/watcher.test.ts` | Watcher tests |
| `src/utils/fs/change-detector.ts` | Stateless change detection utility |
| `src/utils/fs/change-detector.test.ts` | Change detector tests |
| `src/utils/fs/lock.ts` | Cross-process file locking via `proper-lockfile` |
| `src/utils/fs/lock.test.ts` | Lock tests |
| `src/utils/fs/index.ts` | Barrel export for `src/utils/fs/` |
| `src/indexer/commands/stop.ts` | `tools indexer stop <name>` CLI command |
| `src/indexer/commands/graph.ts` | `tools indexer graph <name>` CLI command |
| `src/indexer/lib/code-graph.ts` | Code dependency graph builder |
| `src/indexer/lib/graph-imports.ts` | Per-language import extraction |
| `src/indexer/lib/cancellation.test.ts` | Cancellation tests |
| `src/indexer/lib/status.test.ts` | Status persistence tests |
| `src/indexer/lib/watch.test.ts` | Native watcher integration tests |
| `src/indexer/lib/code-graph.test.ts` | Code graph tests |

## Summary of Modified Files

| File | Changes |
|------|---------|
| `src/indexer/lib/indexer.ts` | Add cancellation, native watcher, status transitions |
| `src/indexer/lib/store.ts` | Replace PID-file lock with `proper-lockfile`, add `getAllFileContents()` |
| `src/indexer/lib/types.ts` | Add `indexingStatus` to `IndexMeta`, update watch config |
| `src/indexer/lib/events.ts` | Add `sync:cancelled` event |
| `src/indexer/lib/manager.ts` | Add `stopIndex()`, `getInterruptedIndexes()`, `resumeIndex()` |
| `src/indexer/lib/sources/source.ts` | Refactor `defaultDetectChanges()` to use `ChangeDetector` |
| `src/indexer/commands/watch.ts` | Use native watcher, show real-time change events |
| `src/indexer/commands/status.ts` | Display indexing status with color coding |
| `src/indexer/index.ts` | Register `stop` and `graph` commands |

## New Dependencies

| Package | Purpose | Install |
|---------|---------|---------|
| `@parcel/watcher` | Native OS file watching (FSEvents/inotify) | `bun add @parcel/watcher` |
| `proper-lockfile` | Cross-process file locking | `bun add proper-lockfile` |
| `@types/proper-lockfile` | TypeScript types for proper-lockfile | `bun add -d @types/proper-lockfile` |

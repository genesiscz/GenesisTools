# Indexer v3 — Plan 5: Critical Safety & Correctness Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 15 critical safety and correctness issues from PR reviews -- lock safety, retry logic, embedding consistency, error handling, process lifecycle.

**Architecture:** Targeted fixes to existing files. No new features.

**Tech Stack:** TypeScript/Bun, proper-lockfile

---

## Task 1: lock.ts -- Remove no-op onCompromised (PR 116 t77 HIGH)

**Why:** The default `onCompromised: () => {}` silently swallows the error that `proper-lockfile` throws when another process reclaims the lock. This means data corruption can happen without any notification -- the process continues writing to a database it no longer owns.

**Files:**
- Modify: `src/utils/fs/lock.ts`

### Steps

1. **Read the current code** and confirm the no-op default on line 54:
   ```typescript
   // CURRENT (BROKEN) — suppresses the throw, process keeps writing
   onCompromised: opts?.onCompromised ?? (() => {}),
   ```

2. **Fix: only pass onCompromised when explicitly provided.** When omitted, `proper-lockfile` defaults to throwing, which is the correct behavior -- it crashes the process rather than silently corrupting data.

   In `src/utils/fs/lock.ts`, replace the lockfile.lock options object (lines 49-55):
   ```typescript
   // BEFORE
   const release = await lockfile.lock(lockPath, {
       stale: staleMs,
       update: updateMs,
       retries: retries > 0 ? { retries, minTimeout: retryDelay, maxTimeout: retryDelay } : 0,
       realpath: false,
       onCompromised: opts?.onCompromised ?? (() => {}),
   });
   ```
   ```typescript
   // AFTER
   const lockOpts: Parameters<typeof lockfile.lock>[1] = {
       stale: staleMs,
       update: updateMs,
       retries: retries > 0 ? { retries, minTimeout: retryDelay, maxTimeout: retryDelay } : 0,
       realpath: false,
   };

   if (opts?.onCompromised) {
       lockOpts.onCompromised = opts.onCompromised;
   }

   const release = await lockfile.lock(lockPath, lockOpts);
   ```

3. **Verify** no other callers pass `onCompromised`:
   ```bash
   rg "onCompromised" src/ --type ts
   ```
   Expected: only `lock.ts` definition + store.ts call (which does NOT pass onCompromised).

4. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "lock\.ts"
   ```
   Expected: no errors.

5. **Commit:**
   ```bash
   git add src/utils/fs/lock.ts
   git commit -m "fix(lock): remove no-op onCompromised — let proper-lockfile throw on compromise"
   ```

6. **Reply to PR thread:**
   ```bash
   tools github review respond t77 "@coderabbitai Fixed — removed silent onCompromised default. proper-lockfile now throws on compromise, preventing data corruption from continued writes after lock loss." -s pr116-20260322-173628
   ```

---

## Task 2: lock.ts -- Resolve paths to absolute (PR 116 t76)

**Why:** `proper-lockfile` uses `realpath: false`, so relative paths like `./foo/index.lock` create different lock files depending on cwd. Two processes with different working directories could both "acquire" the same logical lock without conflict.

**Files:**
- Modify: `src/utils/fs/lock.ts`

### Steps

1. **Add `resolve()` import** (already imported on line 2 via `dirname`, just add `resolve`):

   In `src/utils/fs/lock.ts`, update the import on line 2:
   ```typescript
   // BEFORE
   import { dirname } from "node:path";
   ```
   ```typescript
   // AFTER
   import { dirname, resolve } from "node:path";
   ```

2. **Resolve lockPath at the start of acquireLock.** Add as the first line of the function body (after the destructuring of options), before the `dirname()` call:

   In `src/utils/fs/lock.ts`, replace lines 31-38:
   ```typescript
   // BEFORE
   export async function acquireLock(lockPath: string, opts?: LockOptions): Promise<LockHandle> {
       const staleMs = opts?.staleMs ?? 120_000;
       const updateMs = opts?.updateMs ?? 30_000;
       const retries = opts?.retries ?? 0;
       const retryDelay = opts?.retryDelay ?? 1000;

       // Ensure parent directory exists
       const dir = dirname(lockPath);
   ```
   ```typescript
   // AFTER
   export async function acquireLock(rawLockPath: string, opts?: LockOptions): Promise<LockHandle> {
       const lockPath = resolve(rawLockPath);
       const staleMs = opts?.staleMs ?? 120_000;
       const updateMs = opts?.updateMs ?? 30_000;
       const retries = opts?.retries ?? 0;
       const retryDelay = opts?.retryDelay ?? 1000;

       // Ensure parent directory exists
       const dir = dirname(lockPath);
   ```

3. **Also resolve in `isLocked` and `getLockHolderPid`:**

   In `isLocked` (line 82), add resolve:
   ```typescript
   // BEFORE
   export async function isLocked(lockPath: string, opts?: Pick<LockOptions, "staleMs">): Promise<boolean> {
       if (!existsSync(lockPath)) {
   ```
   ```typescript
   // AFTER
   export async function isLocked(rawLockPath: string, opts?: Pick<LockOptions, "staleMs">): Promise<boolean> {
       const lockPath = resolve(rawLockPath);

       if (!existsSync(lockPath)) {
   ```

   In `getLockHolderPid` (line 101), add resolve:
   ```typescript
   // BEFORE
   export async function getLockHolderPid(lockPath: string): Promise<number | null> {
       if (!existsSync(lockPath)) {
   ```
   ```typescript
   // AFTER
   export async function getLockHolderPid(rawLockPath: string): Promise<number | null> {
       const lockPath = resolve(rawLockPath);

       if (!existsSync(lockPath)) {
   ```

4. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "lock\.ts"
   ```

5. **Commit:**
   ```bash
   git add src/utils/fs/lock.ts
   git commit -m "fix(lock): resolve paths to absolute — prevent cwd-dependent lock identity"
   ```

6. **Reply to PR thread:**
   ```bash
   tools github review respond t76 "@coderabbitai Fixed — all three public functions now resolve() the lockPath parameter. Two processes with different cwds will now correctly contend for the same lock." -s pr116-20260322-173628
   ```

---

## Task 3: store.ts -- Acquire lock BEFORE DB init (PR 116 t44)

**Why:** The current code opens the database, runs migrations, creates tables, and writes initial metadata -- all BEFORE acquiring the lock. Two concurrent processes can both start modifying the DB before either locks it.

**Files:**
- Modify: `src/indexer/lib/store.ts`

### Steps

1. **Restructure `createIndexStore()`.** Move the lock acquisition to just after `indexDir` creation, before `new Database(dbPath)`. The lock must be acquired first, then released in `close()` as before.

   In `src/indexer/lib/store.ts`, replace lines 140-207 (from `export async function createIndexStore` through the `throw err;` of the lock catch):

   ```typescript
   // BEFORE (lock at line 192, DB open at line 149)
   export async function createIndexStore(config: IndexConfig, embedder?: Embedder): Promise<IndexStore> {
       const storage = new Storage("indexer");
       const indexDir = join(storage.getBaseDir(), config.name);

       if (!existsSync(indexDir)) {
           mkdirSync(indexDir, { recursive: true });
       }

       const dbPath = join(indexDir, "index.db");
       const db = new Database(dbPath);
       db.run("PRAGMA journal_mode = WAL");
       // ... tables, pathHashStore, migration ...
       // ... then lock at line 192 ...
   ```

   ```typescript
   // AFTER (lock FIRST, then DB)
   export async function createIndexStore(config: IndexConfig, embedder?: Embedder): Promise<IndexStore> {
       const storage = new Storage("indexer");
       const indexDir = join(storage.getBaseDir(), config.name);

       if (!existsSync(indexDir)) {
           mkdirSync(indexDir, { recursive: true });
       }

       // Cross-process lock via proper-lockfile — acquire BEFORE opening DB
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

       const dbPath = join(indexDir, "index.db");
       const db = new Database(dbPath);
       db.run("PRAGMA journal_mode = WAL");
   ```

   Then remove the old lock block that was at lines 188-207 (the duplicate `const lockPath = ...` through `throw err;`).

2. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "store\.ts"
   ```

3. **Commit:**
   ```bash
   git add src/indexer/lib/store.ts
   git commit -m "fix(store): acquire lock BEFORE opening DB — prevent concurrent DB init race"
   ```

4. **Reply to PR thread:**
   ```bash
   tools github review respond t44 "@coderabbitai Fixed — lock is now acquired before Database() constructor. No DB writes can happen until the lock is held." -s pr116-20260322-173628
   ```

---

## Task 4: store.ts -- Release lock in finally (PR 116 t47)

**Why:** If `qdrantStore.flush()`, `qdrantStore.close()`, `fts.close()`, or `db.close()` throws in the current `close()` method, `lockHandle.release()` is never called. The lock stays held until it goes stale (2 minutes).

**Files:**
- Modify: `src/indexer/lib/store.ts`

### Steps

1. **Wrap the close() method body in try/finally.** The lock release MUST happen regardless of errors in other close operations.

   In `src/indexer/lib/store.ts`, replace the `close()` method (lines 612-621):
   ```typescript
   // BEFORE
   async close(): Promise<void> {
       if (qdrantStore) {
           await qdrantStore.flush();
           await qdrantStore.close();
       }

       await fts.close();
       db.close();
       await lockHandle.release();
   },
   ```
   ```typescript
   // AFTER
   async close(): Promise<void> {
       try {
           if (qdrantStore) {
               await qdrantStore.flush();
               await qdrantStore.close();
           }

           await fts.close();
           db.close();
       } finally {
           await lockHandle.release();
       }
   },
   ```

2. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "store\.ts"
   ```

3. **Commit:**
   ```bash
   git add src/indexer/lib/store.ts
   git commit -m "fix(store): release lock in finally — prevent lock leak on close() errors"
   ```

4. **Reply to PR thread:**
   ```bash
   tools github review respond t47 "@coderabbitai Fixed — lock.release() is now in a finally block. DB/Qdrant close errors no longer leak the lock." -s pr116-20260322-173628
   ```

---

## Task 5: store.ts -- Qdrant writes don't clear unembedded state (PR 116 t45)

**Why:** When using Qdrant as vector backend, `insertChunks()` writes vectors to Qdrant via `qdrantStore.storeWithText()`, but the `getUnembeddedChunkIds()` / `getUnembeddedCount()` queries check for the absence of rows in the local SQLite embeddings table. Since Qdrant writes never insert into the local table, ALL chunks appear "unembedded" forever, causing the embed pipeline to re-embed everything on every sync.

**Files:**
- Modify: `src/indexer/lib/store.ts`

### Steps

1. **When Qdrant receives vectors, also record the doc_id in the local embeddings table.** This acts as a "written" marker so unembedded queries work correctly. We store a zero-length blob to avoid wasting space on duplicate vector data.

   In `src/indexer/lib/store.ts`, in the `insertChunks` method, find the Qdrant branch (lines 291-296):
   ```typescript
   // BEFORE
   if (qdrantStore) {
       // Qdrant: store with text for hybrid search
       for (const [chunkId, vector] of embeddings) {
           const chunk = chunks.find((c) => c.id === chunkId);
           const text = chunk?.content ?? "";
           qdrantStore.storeWithText(chunkId, vector, text);
       }
   ```
   ```typescript
   // AFTER
   if (qdrantStore) {
       // Qdrant: store with text for hybrid search
       for (const [chunkId, vector] of embeddings) {
           const chunk = chunks.find((c) => c.id === chunkId);
           const text = chunk?.content ?? "";
           qdrantStore.storeWithText(chunkId, vector, text);
       }

       // Record in local embeddings table so getUnembeddedChunkIds() stays correct.
       // Uses zero-length blob since the actual vectors live in Qdrant.
       if (!embTableExists) {
           db.run(`CREATE TABLE IF NOT EXISTS ${embTable} (
               doc_id TEXT PRIMARY KEY,
               embedding BLOB NOT NULL
           )`);
           embTableExists = true;
       }

       const marker = Buffer.alloc(0);

       for (const chunkId of embeddings.keys()) {
           db.run(`INSERT OR REPLACE INTO ${embTable} (doc_id, embedding) VALUES (?, ?)`, [
               chunkId,
               marker,
           ]);
       }
   ```

2. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "store\.ts"
   ```

3. **Commit:**
   ```bash
   git add src/indexer/lib/store.ts
   git commit -m "fix(store): record Qdrant writes in local emb table — fix infinite re-embedding"
   ```

4. **Reply to PR thread:**
   ```bash
   tools github review respond t45 "@coderabbitai Fixed — Qdrant insertions now write a zero-byte marker to the local embeddings table so getUnembeddedChunkIds() stays accurate." -s pr116-20260322-173628
   ```

---

## Task 6: Embedder.ts -- Add shouldRetry predicate (PR 116 t29)

**Why:** The `retry()` wrapper retries ALL errors 3 times, including permanent failures like invalid API keys (401/403), bad model names (404), or malformed input (400). This wastes time and rate-limit budget on errors that will never succeed.

**Files:**
- Modify: `src/utils/ai/tasks/Embedder.ts`

### Steps

1. **Add a `shouldRetryEmbedding` predicate** at the top of the file (after imports, before the class):

   In `src/utils/ai/tasks/Embedder.ts`, after line 6 (`const RETRY_DELAY = ...`), add:
   ```typescript
   /** Don't retry permanent errors — only transient/rate-limit failures are worth retrying */
   function shouldRetryEmbedding(error: unknown): boolean {
       const msg = error instanceof Error ? error.message : String(error);

       // Permanent HTTP errors: bad credentials, bad model, invalid input
       if (/\b(401|403|404|400)\b/.test(msg)) {
           return false;
       }

       // Permanent provider errors
       if (/\b(invalid.api.key|unauthorized|forbidden|model.not.found)\b/i.test(msg)) {
           return false;
       }

       return true;
   }
   ```

2. **Add `shouldRetry` to all three retry() calls** in the class.

   In `embed()` method (lines 50-53):
   ```typescript
   // BEFORE
   return retry(() => this.provider.embed(text, options), {
       maxAttempts: 3,
       getDelay: RETRY_DELAY,
   });
   ```
   ```typescript
   // AFTER
   return retry(() => this.provider.embed(text, options), {
       maxAttempts: 3,
       getDelay: RETRY_DELAY,
       shouldRetry: shouldRetryEmbedding,
   });
   ```

   In `embedBatch()` native branch (lines 66-69):
   ```typescript
   // BEFORE
   return retry(() => this.provider.embedBatch!(texts, options), {
       maxAttempts: 3,
       getDelay: RETRY_DELAY,
   });
   ```
   ```typescript
   // AFTER
   return retry(() => this.provider.embedBatch!(texts, options), {
       maxAttempts: 3,
       getDelay: RETRY_DELAY,
       shouldRetry: shouldRetryEmbedding,
   });
   ```

   In `embedBatch()` fallback branch (lines 73-78):
   ```typescript
   // BEFORE
   return Promise.all(
       texts.map((t) =>
           retry(() => this.provider.embed(t, options), {
               maxAttempts: 3,
               getDelay: RETRY_DELAY,
           })
       )
   );
   ```
   ```typescript
   // AFTER
   return Promise.all(
       texts.map((t) =>
           retry(() => this.provider.embed(t, options), {
               maxAttempts: 3,
               getDelay: RETRY_DELAY,
               shouldRetry: shouldRetryEmbedding,
           })
       )
   );
   ```

3. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "Embedder\.ts"
   ```

4. **Commit:**
   ```bash
   git add src/utils/ai/tasks/Embedder.ts
   git commit -m "fix(Embedder): skip retries on permanent errors (401/403/404/400)"
   ```

5. **Reply to PR thread:**
   ```bash
   tools github review respond t29 "@coderabbitai Fixed — added shouldRetryEmbedding predicate. 401/403/404/400 and 'invalid api key'/'model not found' errors fail immediately without wasting retries." -s pr116-20260322-173628
   ```

---

## Task 7: Embedder.ts -- Bounded concurrency for fallback batch (PR 116 t74)

**Why:** When `embedBatch()` native call fails, the fallback code uses `Promise.all()` which fires ALL individual `embed()` calls concurrently. For a batch of 32 texts against a cloud API, that's 32 simultaneous HTTP requests -- likely to trigger rate limits and compound the failure.

**Files:**
- Modify: `src/utils/ai/tasks/Embedder.ts`

### Steps

1. **Replace `Promise.all()` with a sequential loop.** The fallback path is already the slow path (batch failed), so sequential is appropriate and avoids thundering herd.

   In `src/utils/ai/tasks/Embedder.ts`, replace the fallback branch in `embedBatch()` (the `return Promise.all(...)` block):
   ```typescript
   // BEFORE
   return Promise.all(
       texts.map((t) =>
           retry(() => this.provider.embed(t, options), {
               maxAttempts: 3,
               getDelay: RETRY_DELAY,
               shouldRetry: shouldRetryEmbedding,
           })
       )
   );
   ```
   ```typescript
   // AFTER — sequential to avoid thundering herd after batch failure
   const results: EmbeddingResult[] = [];

   for (const t of texts) {
       const result = await retry(() => this.provider.embed(t, options), {
           maxAttempts: 3,
           getDelay: RETRY_DELAY,
           shouldRetry: shouldRetryEmbedding,
       });
       results.push(result);
   }

   return results;
   ```

2. **Add `EmbeddingResult` to the import** (it's already imported from `../types` on line 4 -- verify):
   ```bash
   rg "import.*EmbeddingResult" src/utils/ai/tasks/Embedder.ts
   ```
   Expected: already imported on line 4.

3. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "Embedder\.ts"
   ```

4. **Commit:**
   ```bash
   git add src/utils/ai/tasks/Embedder.ts
   git commit -m "fix(Embedder): sequential fallback in embedBatch — prevent thundering herd"
   ```

5. **Reply to PR thread:**
   ```bash
   tools github review respond t74 "@coderabbitai Fixed — fallback path now processes texts sequentially instead of Promise.all(). Prevents 32 simultaneous HTTP requests when batch embed fails." -s pr116-20260322-173628
   ```

---

## Task 8: async.ts -- Fix rate-limit detection regex (PR 116 t31)

**Why:** The current `rateLimitAwareDelay()` checks `msg.includes("rate")` which matches any string containing "rate" -- like "generate", "decorate", "moderate", "separate". This produces false positives, applying the 15-second rate-limit delay to non-rate-limit errors.

**Files:**
- Modify: `src/utils/async.ts`

### Steps

1. **Replace string includes with word-boundary regex.** The detection needs to match "rate limit", "rate_limit", "rate-limit", "Rate Limit" -- but NOT "generate" or "moderate".

   In `src/utils/async.ts`, replace lines 88-91 (the rate-limit detection logic inside `rateLimitAwareDelay`):
   ```typescript
   // BEFORE
   const isRateLimit =
       msg.includes("429") || msg.includes("rate") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota");
   ```
   ```typescript
   // AFTER
   const isRateLimit =
       msg.includes("429") ||
       /\brate[_\s-]?limit/i.test(msg) ||
       msg.includes("RESOURCE_EXHAUSTED") ||
       /\bquota\b/i.test(msg);
   ```

2. **Verify**: "generate" no longer matches:
   ```bash
   bun -e "
     const msg = 'Failed to generate embedding';
     const isRateLimit = /\brate[_\s-]?limit/i.test(msg) || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || /\bquota\b/i.test(msg);
     console.log('generate matches:', isRateLimit); // false
   "
   ```

3. **Verify**: "rate limit exceeded" still matches:
   ```bash
   bun -e "
     const msg = 'rate limit exceeded';
     console.log('rate limit matches:', /\brate[_\s-]?limit/i.test(msg)); // true
   "
   ```

4. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "async\.ts"
   ```

5. **Commit:**
   ```bash
   git add src/utils/async.ts
   git commit -m "fix(async): use word-boundary regex for rate-limit detection — no more false positives"
   ```

6. **Reply to PR thread:**
   ```bash
   tools github review respond t31 "@coderabbitai Fixed — replaced includes('rate') with /\brate[_\s-]?limit/i regex. 'generate', 'moderate', etc. no longer trigger 15s rate-limit delay." -s pr116-20260322-173628
   ```

---

## Task 9: AIDarwinKitProvider.ts -- Align batch/single embedding space (PR 116 t25)

**Why:** The `embed()` method calls `this.embedText()` which uses `nlp.embedText()` (sentence embeddings from NaturalLanguage.framework). But `embedBatch()` first tries `nlp.embedContextualBatch()` (contextual embeddings -- different model, different vector space), then `nlp.embedBatch()`, then falls back to sequential `embed()`. If the contextual batch succeeds, vectors from batch and single calls live in different embedding spaces, making cosine similarity meaningless.

**Files:**
- Modify: `src/utils/ai/providers/AIDarwinKitProvider.ts`

### Steps

1. **Remove the `embedContextualBatch` attempt.** The batch path should only use `embedBatch` (same sentence-level model as `embed`), falling back to sequential.

   In `src/utils/ai/providers/AIDarwinKitProvider.ts`, replace the embedBatch try block (lines 64-84):
   ```typescript
   // BEFORE
   // Try CoreML batch endpoint first (GPU/Neural Engine accelerated)
   try {
       const nlp = await this.getNlp();

       if ("embedContextualBatch" in nlp) {
           const batchFn = nlp.embedContextualBatch as (
               texts: string[],
               lang: string
           ) => Promise<Array<{ vector: number[]; dimension: number }>>;
           return toEmbeddingResults(await batchFn(texts, language));
       }

       if ("embedBatch" in nlp) {
           const batchFn = nlp.embedBatch as (
               texts: string[],
               lang: string
           ) => Promise<Array<{ vector: number[]; dimension: number }>>;
           return toEmbeddingResults(await batchFn(texts, language));
       }
   } catch {
       // Batch endpoints not available or failed -- fall through to sequential
   }
   ```
   ```typescript
   // AFTER — only use embedBatch (same space as embed/embedText)
   try {
       const nlp = await this.getNlp();

       if ("embedBatch" in nlp) {
           const batchFn = nlp.embedBatch as (
               texts: string[],
               lang: string
           ) => Promise<Array<{ vector: number[]; dimension: number }>>;
           return toEmbeddingResults(await batchFn(texts, language));
       }
   } catch {
       // Batch endpoint not available or failed -- fall through to sequential
   }
   ```

2. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "AIDarwinKitProvider\.ts"
   ```

3. **Commit:**
   ```bash
   git add src/utils/ai/providers/AIDarwinKitProvider.ts
   git commit -m "fix(DarwinKit): remove embedContextualBatch — align batch/single to same vector space"
   ```

4. **Reply to PR thread:**
   ```bash
   tools github review respond t25 "@coderabbitai Fixed — removed embedContextualBatch path. Both embed() and embedBatch() now use the same NaturalLanguage sentence-level model, keeping vectors in the same space." -s pr116-20260322-173628
   ```

---

## Task 10: AIOllamaProvider.ts -- Detect dimensions from first response (PR 116 t27)

**Why:** `this.dimensions` is hardcoded to 768 (nomic-embed-text default) but never updated from actual response data. If the user configures a different model (e.g., `mxbai-embed-large` at 1024-dim), the reported dimensions are wrong. This breaks sqlite-vec table creation (wrong column width) and dimension mismatch assertions.

**Files:**
- Modify: `src/utils/ai/providers/AIOllamaProvider.ts`

### Steps

1. **Make `dimensions` mutable** (change from `readonly` to a private backing field with a getter):

   In `src/utils/ai/providers/AIOllamaProvider.ts`, replace the class property declaration and constructor (lines 23-35):
   ```typescript
   // BEFORE
   export class AIOllamaProvider implements AIProvider, AIEmbeddingProvider {
       readonly type = "ollama" as const;
       readonly dimensions: number;
       private baseUrl: string;
       private defaultModel: string;
       private available: boolean | null = null;

       constructor(options?: AIOllamaProviderOptions) {
           this.baseUrl = (options?.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
           this.defaultModel = options?.defaultModel ?? "nomic-embed-text";
           // Default dimensions for nomic-embed-text. Will be overridden by actual response.
           this.dimensions = 768;
       }
   ```
   ```typescript
   // AFTER
   export class AIOllamaProvider implements AIProvider, AIEmbeddingProvider {
       readonly type = "ollama" as const;
       private _dimensions: number;
       private baseUrl: string;
       private defaultModel: string;
       private available: boolean | null = null;

       constructor(options?: AIOllamaProviderOptions) {
           this.baseUrl = (options?.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
           this.defaultModel = options?.defaultModel ?? "nomic-embed-text";
           // Default dimensions for nomic-embed-text. Updated from first actual response.
           this._dimensions = 768;
       }

       get dimensions(): number {
           return this._dimensions;
       }
   ```

2. **Update `_dimensions` from the first embedBatch response.** In the `embedBatch()` method, after parsing the response (lines 139-144):

   ```typescript
   // BEFORE
   return data.embeddings.map((embedding) => {
       const vector = new Float32Array(embedding);
       return { vector, dimensions: vector.length };
   });
   ```
   ```typescript
   // AFTER
   const results = data.embeddings.map((embedding) => {
       const vector = new Float32Array(embedding);
       return { vector, dimensions: vector.length };
   });

   // Update dimensions from actual model output on first successful call
   if (results.length > 0 && results[0].dimensions !== this._dimensions) {
       this._dimensions = results[0].dimensions;
   }

   return results;
   ```

3. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "AIOllamaProvider\.ts"
   ```

4. **Commit:**
   ```bash
   git add src/utils/ai/providers/AIOllamaProvider.ts
   git commit -m "fix(Ollama): detect dimensions from first response — support non-default models"
   ```

5. **Reply to PR thread:**
   ```bash
   tools github review respond t27 "@coderabbitai Fixed — dimensions are now auto-detected from the first embedBatch response. Non-nomic models (e.g., mxbai-embed-large at 1024-dim) work correctly." -s pr116-20260322-173628
   ```

---

## Task 11: indexer.ts -- Wrong "cancelled" status on error (PR 116 t71)

**Why:** In the `catch` block of `runSync()`, errors (network failure, DB corruption, provider crash) set `indexingStatus: "cancelled"`. This is misleading -- "cancelled" implies user-initiated cancellation. When the status UI shows "cancelled", the user thinks someone stopped it intentionally, not that it crashed.

**Files:**
- Modify: `src/indexer/lib/types.ts`
- Modify: `src/indexer/lib/indexer.ts`

### Steps

1. **Add "error" to the `indexingStatus` union type** in types.ts.

   In `src/indexer/lib/types.ts`, replace line 92:
   ```typescript
   // BEFORE
   indexingStatus?: "idle" | "in-progress" | "completed" | "cancelled";
   ```
   ```typescript
   // AFTER
   indexingStatus?: "idle" | "in-progress" | "completed" | "cancelled" | "error";
   ```

2. **Change the catch block** in `indexer.ts` `runSync()` to use "error" instead of "cancelled".

   In `src/indexer/lib/indexer.ts`, replace line 904:
   ```typescript
   // BEFORE
   this.store.updateMeta({ indexingStatus: "cancelled" });
   ```
   ```typescript
   // AFTER
   this.store.updateMeta({ indexingStatus: "error" });
   ```

3. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "(indexer|types)\.ts"
   ```

4. **Commit:**
   ```bash
   git add src/indexer/lib/types.ts src/indexer/lib/indexer.ts
   git commit -m "fix(indexer): use 'error' status on sync failure — distinguish crash from cancellation"
   ```

5. **Reply to PR thread:**
   ```bash
   tools github review respond t71 "@coderabbitai Fixed — added 'error' to indexingStatus union. Sync failures now show status='error', user-initiated stops show 'cancelled'." -s pr116-20260322-173628
   ```

---

## Task 12: watcher.ts -- Event loss on callback failure (PR 116 t78)

**Why:** In `flushEvents()`, `pendingEvents` is cleared (`= new Map()`) BEFORE the callback is invoked. If the callback throws, those events are lost forever -- the files were changed, the watcher saw it, but the sync never happened and no retry is scheduled.

**Files:**
- Modify: `src/utils/fs/watcher.ts`

### Steps

1. **Move the clearing of `pendingEvents` to after the callback succeeds.** Copy the events into a local variable, only clear pendingEvents on success.

   In `src/utils/fs/watcher.ts`, replace the `flushEvents` function (lines 79-100):
   ```typescript
   // BEFORE
   const flushEvents = async () => {
       debounceTimer = null;

       if (pendingEvents.size === 0) {
           return;
       }

       const events = Array.from(pendingEvents.values());
       pendingEvents = new Map();

       try {
           await callback(events);
           consecutiveErrors = 0;
       } catch {
           consecutiveErrors++;

           if (consecutiveErrors >= maxErrors) {
               isActive = false;
               await subscription.unsubscribe();
           }
       }
   };
   ```
   ```typescript
   // AFTER — only clear events after successful callback
   const flushEvents = async () => {
       debounceTimer = null;

       if (pendingEvents.size === 0) {
           return;
       }

       // Snapshot events for this flush; keep pendingEvents intact until success
       const events = Array.from(pendingEvents.values());
       const flushedPaths = new Set(pendingEvents.keys());

       try {
           await callback(events);
           consecutiveErrors = 0;

           // Only remove events that were successfully processed.
           // New events that arrived during the callback stay in pendingEvents.
           for (const path of flushedPaths) {
               pendingEvents.delete(path);
           }
       } catch {
           consecutiveErrors++;

           if (consecutiveErrors >= maxErrors) {
               isActive = false;
               await subscription.unsubscribe();
           }
       }
   };
   ```

2. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "watcher\.ts"
   ```

3. **Commit:**
   ```bash
   git add src/utils/fs/watcher.ts
   git commit -m "fix(watcher): only clear events after successful callback — prevent event loss"
   ```

4. **Reply to PR thread:**
   ```bash
   tools github review respond t78 "@coderabbitai Fixed — pendingEvents is no longer cleared before the callback. Events survive callback failures and will be retried on the next flush." -s pr116-20260322-173628
   ```

---

## Task 13: sync.ts -- process.exit() skips finally (PR 116 t64)

**Why:** `process.exit(1)` on line 46 terminates immediately, skipping the `finally` block that calls `manager.close()`. This means the index lock is never released, the DB connection is never closed, and WAL checkpoint never runs.

**Files:**
- Modify: `src/indexer/commands/sync.ts`

### Steps

1. **Replace `process.exit(1)` with `process.exitCode = 1; return;`** so the finally block executes before the process exits.

   In `src/indexer/commands/sync.ts`, replace lines 44-46:
   ```typescript
   // BEFORE
   p.log.error(
       `No index found for "${nameOrPath}". Known indexes: ${manager.getIndexNames().join(", ")}`
   );
   process.exit(1);
   ```
   ```typescript
   // AFTER
   p.log.error(
       `No index found for "${nameOrPath}". Known indexes: ${manager.getIndexNames().join(", ")}`
   );
   process.exitCode = 1;
   return;
   ```

2. **Search for other process.exit() calls in indexer commands:**
   ```bash
   rg "process\.exit\(" src/indexer/commands/ --type ts
   ```
   Fix any other occurrences the same way (exitCode + return).

3. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "sync\.ts"
   ```

4. **Commit:**
   ```bash
   git add src/indexer/commands/sync.ts
   git commit -m "fix(sync): use process.exitCode instead of process.exit — ensure finally runs"
   ```

5. **Reply to PR thread:**
   ```bash
   tools github review respond t64 "@coderabbitai Fixed — replaced process.exit(1) with process.exitCode = 1; return. The finally block now executes, releasing the lock and closing the DB." -s pr116-20260322-173628
   ```

---

## Task 14: fts5/index.ts -- minScore incomparable across modes (PR 116 t54)

**Why:** `minScore` is applied uniformly via `results.filter(r => r.score >= minScore)` after search, but BM25 scores (typically 0.5-30+) and cosine scores (0.0-1.0) are on completely different scales. A `minScore: 0.5` keeps nearly all BM25 results but filters most cosine results. A `minScore: 5` keeps good BM25 results but filters ALL cosine results.

**Files:**
- Modify: `src/utils/search/drivers/sqlite-fts5/index.ts`

### Steps

1. **Apply mode-specific default thresholds.** When `minScore` is set, interpret it differently per mode. Add a helper function before the class definition:

   In `src/utils/search/drivers/sqlite-fts5/index.ts`, after the imports (around line 9), add:
   ```typescript
   /**
    * BM25 and cosine scores live on different scales:
    *   - BM25:   ~0.5 to 30+  (higher = more relevant)
    *   - Cosine: 0.0 to 1.0   (higher = more similar)
    *   - RRF:    0.0 to ~0.03 (reciprocal rank fusion scores)
    *
    * When a single minScore is configured, normalize it per mode.
    * A minScore of 0.3 means "30% of the scale" for each mode.
    */
   function normalizeMinScore(minScore: number, mode: string): number {
       switch (mode) {
           case "fulltext":
               // BM25 scores: treat minScore as raw BM25 threshold
               return minScore;
           case "vector":
               // Cosine: already 0-1, use as-is
               return minScore;
           case "hybrid":
               // RRF scores are tiny (1/(K+rank)), scale down
               // A minScore of 0.3 -> 0.005 in RRF space (K=60)
               return minScore * (1 / 60);
           default:
               return minScore;
       }
   }
   ```

2. **Use the normalizer in the `search()` method.** Replace the minScore filter block (lines 160-163):
   ```typescript
   // BEFORE
   if (opts.minScore !== undefined && opts.minScore > 0) {
       results = results.filter((r) => r.score >= opts.minScore!);
   }
   ```
   ```typescript
   // AFTER
   if (opts.minScore !== undefined && opts.minScore > 0) {
       const threshold = normalizeMinScore(opts.minScore, mode);
       results = results.filter((r) => r.score >= threshold);
   }
   ```

3. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "fts5/index\.ts"
   ```

4. **Commit:**
   ```bash
   git add src/utils/search/drivers/sqlite-fts5/index.ts
   git commit -m "fix(fts5): normalize minScore per search mode — prevent cross-mode filtering bugs"
   ```

5. **Reply to PR thread:**
   ```bash
   tools github review respond t54 "@coderabbitai Fixed — added normalizeMinScore() that adjusts the threshold per mode. BM25, cosine, and RRF scores are now filtered with appropriate thresholds." -s pr116-20260322-173628
   ```

---

## Task 15: sqlite-vec-loader.ts -- ensureExtensionCapableSQLite called too late (PR 116 t81)

**Why:** `ensureExtensionCapableSQLite()` calls `Database.setCustomSQLite()` which MUST happen before any `Database` instance is created. But `loadSqliteVec()` is called from `SearchEngine.initStores()`, which happens AFTER the store.ts `new Database(dbPath)` on line 149. By then it's too late -- `setCustomSQLite()` is a no-op after the first Database instance.

**Files:**
- Modify: `src/indexer/lib/store.ts`
- Modify: `src/utils/search/stores/sqlite-vec-loader.ts`

### Steps

1. **Call `ensureExtensionCapableSQLite()` in store.ts BEFORE creating the Database.** Add it right after the lock acquisition, before `new Database()`.

   In `src/indexer/lib/store.ts`, after the lock acquisition block and before `const dbPath = ...` / `const db = new Database(dbPath)`, add:
   ```typescript
   // Ensure extension-capable SQLite is loaded BEFORE creating Database instances.
   // Must happen before the first new Database() call in this process.
   if (config.storage?.vectorDriver !== "sqlite-brute" && config.storage?.vectorDriver !== "qdrant") {
       const { ensureExtensionCapableSQLite } = await import("@app/utils/search/stores/sqlite-vec-loader");
       ensureExtensionCapableSQLite();
   }

   const dbPath = join(indexDir, "index.db");
   ```

   Add the import at the top of the file is not needed since we use dynamic import.

2. **Add an early-init guard to `loadSqliteVec()`** to warn if called after Database instances exist. In `sqlite-vec-loader.ts`, replace lines 52-67:
   ```typescript
   // BEFORE
   export function loadSqliteVec(db: Database): boolean {
       if (extensionAvailable === false) {
           return false;
       }

       ensureExtensionCapableSQLite();

       try {
           const sqliteVec = require("sqlite-vec");
           sqliteVec.load(db);
           extensionAvailable = true;
           return true;
       } catch {
           extensionAvailable = false;
           return false;
       }
   }
   ```
   ```typescript
   // AFTER
   export function loadSqliteVec(db: Database): boolean {
       if (extensionAvailable === false) {
           return false;
       }

       // ensureExtensionCapableSQLite() should already have been called before
       // any Database was created. Call it here as a safety net, but it may be
       // too late if a Database instance already exists.
       if (!customSqliteAttempted) {
           ensureExtensionCapableSQLite();
       }

       try {
           const sqliteVec = require("sqlite-vec");
           sqliteVec.load(db);
           extensionAvailable = true;
           return true;
       } catch {
           extensionAvailable = false;
           return false;
       }
   }
   ```

3. **Type check:**
   ```bash
   bunx tsgo --noEmit 2>&1 | rg "(store|sqlite-vec-loader)\.ts"
   ```

4. **Commit:**
   ```bash
   git add src/indexer/lib/store.ts src/utils/search/stores/sqlite-vec-loader.ts
   git commit -m "fix(store): call ensureExtensionCapableSQLite before Database init"
   ```

5. **Reply to PR thread:**
   ```bash
   tools github review respond t81 "@coderabbitai Fixed — ensureExtensionCapableSQLite() is now called in store.ts before new Database(), ensuring setCustomSQLite() runs before any DB instance is created." -s pr116-20260322-173628
   ```

---

## Implementation Order

Tasks are ordered by dependency:

1. **Tasks 1-2** (lock.ts) -- standalone, no deps
2. **Tasks 3-5** (store.ts) -- depend on lock.ts changes being committed
3. **Tasks 6-7** (Embedder.ts) -- standalone
4. **Task 8** (async.ts) -- standalone
5. **Tasks 9-10** (providers) -- standalone
6. **Task 11** (indexer.ts) -- standalone
7. **Task 12** (watcher.ts) -- standalone
8. **Task 13** (sync.ts) -- standalone
9. **Task 14** (fts5/index.ts) -- standalone
10. **Task 15** (sqlite-vec-loader.ts + store.ts) -- do after Tasks 3-5 since store.ts is modified there too

Total: 15 commits, one per fix, each with a PR thread reply.

# Indexer Fix Plan 3: Search Quality & Robustness

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix zero-vector pollution in search, add data consistency checks, handle orphaned chunks, and improve robustness for edge cases.

**Architecture:** Targeted fixes + one new `verify` command. Each task is independent.

**Tech Stack:** TypeScript, Bun SQLite

---

### Task 1: Filter zero-magnitude vectors from search results

When embedding fails, zero vectors are stored. In cosine search they score -1 (bottom), which is fine. But in hybrid/RRF search, they can appear in results with non-zero RRF scores. Filter them out.

**Files:**
- Modify: `src/utils/search/stores/sqlite-vector-store.ts:33-53`
- Test: `src/utils/search/stores/sqlite-vector-store.test.ts`

**Step 1: Write failing test**

Add to `sqlite-vector-store.test.ts`:

```typescript
test("search excludes zero-magnitude vectors", () => {
    const store = new SqliteVectorStore(db, "test");
    // Insert a real vector
    store.upsert("doc1", new Float32Array([1, 0, 0, 0]));
    // Insert a zero vector
    store.upsert("doc2", new Float32Array([0, 0, 0, 0]));

    const query = new Float32Array([1, 0, 0, 0]);
    const results = store.search(query, 10);

    expect(results.length).toBe(1);
    expect(results[0].docId).toBe("doc1");
});
```

**Step 2: Run test to verify it fails**

```bash
bun test src/utils/search/stores/sqlite-vector-store.test.ts --timeout 60000
```

**Step 3: Add magnitude check in search**

In `sqlite-vector-store.ts`, after computing the vector from DB:

```typescript
search(queryVector: Float32Array, limit: number): VectorSearchHit[] {
    const rows = this.db.query(`SELECT doc_id, embedding FROM ${this.embTable}`).all() as Array<{
        doc_id: string;
        embedding: Buffer;
    }>;

    const scored: VectorSearchHit[] = [];

    for (const row of rows) {
        const storedVec = new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4
        );

        // Skip zero-magnitude vectors (failed embeddings)
        let magnitude = 0;
        for (let i = 0; i < storedVec.length; i++) {
            magnitude += storedVec[i] * storedVec[i];
        }
        if (magnitude === 0) continue;

        const distance = cosineDistance(queryVector, storedVec);
        scored.push({ docId: row.doc_id, score: 1 - distance });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}
```

**Step 4: Run tests**

```bash
bun test src/utils/search/stores/sqlite-vector-store.test.ts --timeout 60000
```

**Step 5: Commit**

```bash
git add src/utils/search/stores/sqlite-vector-store.ts src/utils/search/stores/sqlite-vector-store.test.ts
git commit -m "fix(search): filter zero-magnitude vectors from cosine search results"
```

---

### Task 2: Add `tools indexer verify` command for consistency checks

No code currently detects path_hashes/content/embeddings divergence. Add a `verify` command that reports inconsistencies and optionally repairs them.

**Files:**
- Create: `src/indexer/commands/verify.ts`
- Modify: `src/indexer/index.ts` — register the command
- Modify: `src/indexer/lib/store.ts` — add `getContentCount()` and `getEmbeddingCount()`

**Step 1: Add count methods to IndexStore**

In `store.ts` interface and implementation:

```typescript
// Interface
getContentCount(): number;
getEmbeddingCount(): number;

// Implementation
getContentCount(): number {
    const row = db.query(`SELECT COUNT(*) AS cnt FROM ${tableName}_content`).get() as { cnt: number };
    return row.cnt;
},

getEmbeddingCount(): number {
    const embTable = `${tableName}_embeddings`;
    const tableExists = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(embTable);
    if (!tableExists) return 0;
    const row = db.query(`SELECT COUNT(*) AS cnt FROM ${embTable}`).get() as { cnt: number };
    return row.cnt;
},
```

**Step 2: Create verify command**

Create `src/indexer/commands/verify.ts`:

```typescript
import type { IndexerManager } from "../lib/manager";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Command } from "commander";

export function registerVerifyCommand(program: Command): void {
    program
        .command("verify")
        .description("Check index consistency and report problems")
        .argument("[name]", "Index name (verifies all if omitted)")
        .option("--fix", "Attempt to repair inconsistencies")
        .action(async (name?: string, opts?: { fix?: boolean }) => {
            p.intro(pc.bgCyan(pc.white(" indexer verify ")));

            const { IndexerManager } = await import("../lib/manager");
            const manager = await IndexerManager.load();

            try {
                const names = name ? [name] : manager.getIndexNames();

                if (names.length === 0) {
                    p.log.info("No indexes found");
                    return;
                }

                for (const indexName of names) {
                    const indexer = await manager.getIndex(indexName);
                    const store = (indexer as any).store; // Access internal store
                    const pathHashStore = store.getPathHashStore();

                    const pathCount = pathHashStore.getFileCount();
                    const contentCount = store.getContentCount();
                    const embeddingCount = store.getEmbeddingCount();
                    const unembeddedCount = store.getUnembeddedCount();

                    p.log.info(`${pc.bold(indexName)}:`);
                    p.log.info(`  Path hashes:  ${pathCount.toLocaleString()}`);
                    p.log.info(`  Content rows: ${contentCount.toLocaleString()}`);
                    p.log.info(`  Embeddings:   ${embeddingCount.toLocaleString()}`);
                    p.log.info(`  Unembedded:   ${unembeddedCount.toLocaleString()}`);

                    const issues: string[] = [];

                    // Check: path_hashes << content (likely crash/bug)
                    if (pathCount > 0 && contentCount > pathCount * 2) {
                        issues.push(
                            `Content rows (${contentCount}) far exceed path hashes (${pathCount}) — ` +
                            `likely orphaned chunks from a previous crash or bug`
                        );
                    }

                    // Check: path_hashes = 0 but content > 0
                    if (pathCount === 0 && contentCount > 0) {
                        issues.push(
                            `Path hashes empty but ${contentCount} content rows exist — ` +
                            `index tracking was lost. Run --rebuild to fix`
                        );
                    }

                    // Check: embeddings > content (impossible normally)
                    if (embeddingCount > contentCount) {
                        issues.push(
                            `More embeddings (${embeddingCount}) than content rows (${contentCount}) — orphaned embeddings`
                        );
                    }

                    if (issues.length === 0) {
                        p.log.success("  No issues found");
                    } else {
                        for (const issue of issues) {
                            p.log.warn(`  ${pc.yellow("⚠")} ${issue}`);
                        }

                        if (opts?.fix) {
                            p.log.info("  Use --rebuild to fully reconstruct the index");
                        }
                    }

                    await indexer.close();
                }
            } finally {
                await manager.close();
            }

            p.outro("Done");
        });
}
```

**Step 3: Register in index.ts**

In `src/indexer/index.ts`, add:

```typescript
import { registerVerifyCommand } from "./commands/verify";
// ... in the registration block:
registerVerifyCommand(indexerProgram);
```

**Step 4: Test manually**

```bash
tools indexer verify
```

**Step 5: Commit**

```bash
git add src/indexer/commands/verify.ts src/indexer/index.ts src/indexer/lib/store.ts
git commit -m "feat(indexer): add 'tools indexer verify' for consistency checks"
```

---

### Task 3: Handle modified files leaving orphan chunks

When a file is re-chunked and produces fewer chunks than before, the old extra chunks remain in the content table as orphans. Fix: when processing modified entries, delete old chunks before inserting new ones.

**Files:**
- Modify: `src/indexer/lib/indexer.ts` — the "Process entries NOT already stored via onBatch" section (~line 575-600)

**Step 1: Before inserting new chunks for modified entries, remove old ones**

In the `remaining` processing section, for modified entries specifically:

```typescript
// Remove old chunks for modified entries before inserting new ones
const modifiedIds = changes.modified
    .filter(entry => !storedInBatch.has(entry.id))
    .map(entry => this.source instanceof FileSource
        ? resolve(this.config.baseDir, entry.id)
        : entry.id
    );

if (modifiedIds.length > 0) {
    const oldChunkIds = this.source instanceof FileSource
        ? this.store.getChunkIdsBySourcePaths(modifiedIds)
        : this.store.getChunkIdsBySourceIds(modifiedIds); // From Plan 1, Task 1

    if (oldChunkIds.length > 0) {
        await this.store.removeChunks(oldChunkIds);
    }
}
```

**Step 2: Commit**

```bash
git add src/indexer/lib/indexer.ts
git commit -m "fix(indexer): remove old chunks before re-inserting modified entries"
```

---

### Task 4: Fix `readFileSync` blocking event loop in EmlxBodyExtractor

`emlx.ts:111` uses synchronous file read in an async method. Replace with Bun's async API.

**Files:**
- Modify: `src/macos/lib/mail/emlx.ts:109-138`

**Step 1: Replace readFileSync**

```typescript
async parseEmlxFile(filePath: string): Promise<string | null> {
    try {
        const content = await Bun.file(filePath).bytes();
        // ... rest unchanged, but use Buffer.from(content) if needed
```

The `content` is already a `Uint8Array` from `Bun.file().bytes()`. The existing code after line 111 uses `content.indexOf(...)` which works on both Buffer and Uint8Array in Bun.

**Step 2: Run tests**

```bash
bun test src/macos/lib/mail/emlx.test.ts --timeout 60000
```

**Step 3: Commit**

```bash
git add src/macos/lib/mail/emlx.ts
git commit -m "fix(mail): use async Bun.file() instead of readFileSync for emlx parsing"
```

---

### Task 5: Cache dynamic import in AIDarwinKitProvider

`AIDarwinKitProvider.embedText()` does `await import("@app/utils/macos/nlp")` on every single embed call. While Bun caches modules, the async import still creates a promise and lookup each time.

**Files:**
- Modify: `src/utils/ai/providers/AIDarwinKitProvider.ts`

**Step 1: Cache the import**

```typescript
private nlpModule: typeof import("@app/utils/macos/nlp") | null = null;

private async getNlp() {
    if (!this.nlpModule) {
        this.nlpModule = await import("@app/utils/macos/nlp");
    }
    return this.nlpModule;
}

async embedText(text: string, language = "en"): Promise<{ vector: number[]; dimension: number }> {
    const { embedText } = await this.getNlp();
    return embedText(text, language);
}
```

**Step 2: Commit**

```bash
git add src/utils/ai/providers/AIDarwinKitProvider.ts
git commit -m "perf(ai): cache NLP module import in DarwinKit provider"
```

---

### Task 6: Add `removeMany()` batch delete to SearchEngine

`removeChunks` loops through IDs one-by-one, each doing DELETE + vector delete + count query. For bulk deletions (modified files, deleted entries), this is very slow.

**Files:**
- Modify: `src/utils/search/drivers/sqlite-fts5/index.ts` — add `removeMany(ids: string[])`
- Modify: `src/indexer/lib/store.ts:228-236` — use batch delete

**Step 1: Add removeMany to SearchEngine**

```typescript
async removeMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const contentTable = `${this.tableName}_content`;
    const batchSize = 500;

    const tx = this.db.transaction(() => {
        for (let i = 0; i < ids.length; i += batchSize) {
            const batch = ids.slice(i, i + batchSize);
            const placeholders = batch.map(() => "?").join(",");
            this.db.run(`DELETE FROM ${contentTable} WHERE id IN (${placeholders})`, batch);
        }
    });
    tx();

    // Also remove from vector store
    if (this.vectorStore) {
        for (const id of ids) {
            this.vectorStore.remove(id);
        }
    }

    this.docCount = this.queryCount();
}
```

**Step 2: Update store.removeChunks to use it**

```typescript
async removeChunks(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;
    await fts.removeMany(chunkIds);
},
```

**Step 3: Commit**

```bash
git add src/utils/search/drivers/sqlite-fts5/index.ts src/indexer/lib/store.ts
git commit -m "perf(search): add batch removeMany() to SearchEngine, use in store"
```

---

### Task 7: Deduplicate EmlxBodyExtractor's DB connection

`MailSource` opens the Envelope Index in its constructor. `EmlxBodyExtractor.getSummary()` lazily opens a second read-only connection to the same database. Share the connection instead.

**Files:**
- Modify: `src/indexer/lib/sources/mail-source.ts` — pass DB to EmlxBodyExtractor
- Modify: `src/macos/lib/mail/emlx.ts` — accept optional shared DB

**Step 1: Pass the shared DB**

In `mail-source.ts`, `MailSource.create()`:

```typescript
static async create(): Promise<MailSource> {
    const db = new Database(ENVELOPE_INDEX_PATH, { readonly: true });
    const emlx = new EmlxBodyExtractor(db); // Share the DB connection
    return new MailSource(db, emlx);
}
```

In `emlx.ts`, modify constructor to accept optional DB:

```typescript
constructor(private sharedDb?: Database) {}

private get summaryDb(): Database {
    if (this.sharedDb) return this.sharedDb;
    if (!this._summaryDb) {
        this._summaryDb = new Database(ENVELOPE_INDEX_PATH, { readonly: true });
    }
    return this._summaryDb;
}
```

**Step 2: Commit**

```bash
git add src/indexer/lib/sources/mail-source.ts src/macos/lib/mail/emlx.ts
git commit -m "fix(mail): share Envelope Index DB connection between MailSource and EmlxBodyExtractor"
```

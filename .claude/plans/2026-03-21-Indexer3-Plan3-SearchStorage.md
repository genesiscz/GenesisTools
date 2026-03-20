# Indexer v3 — Plan 3: Search & Storage Overhaul

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace brute-force O(n) vector search with HNSW ANN via sqlite-vec, improve RRF hybrid search quality, add min score threshold, and offer optional Qdrant backend for large-scale deployments.

**Architecture:** New `SqliteVecVectorStore` implementing existing `VectorStore` interface (drop-in replacement). New optional `QdrantVectorStore` for users who want server-grade vector search. Improved RRF with over-fetch. Configurable min score threshold.

**Tech Stack:** TypeScript/Bun, sqlite-vec (native SQLite extension), @qdrant/js-client-rest, existing VectorStore interface

---

## sqlite-vec Research Summary

**What it is:** A pure-C, zero-dependency SQLite extension by Alex Garcia (Mozilla Builders). Adds vector search via `vec0` virtual tables. MIT/Apache-2.0 dual license. Current version: v0.1.7 (2026-03-17).

**Key facts:**
- `npm install sqlite-vec` — works with `bun:sqlite`, `better-sqlite3`, `node:sqlite`
- Load via `sqliteVec.load(db)` — compatible with `bun:sqlite` Database instances
- Vectors stored in `vec0` virtual tables with shadow tables (like FTS5)
- KNN queries via `WHERE column MATCH ? ORDER BY distance LIMIT k`
- Supports `float[N]`, `int8[N]`, and `bit[N]` vector types
- Vectors passed as JSON arrays or raw `Float32Array.buffer` blobs
- **Currently brute-force only** (no HNSW yet — see GitHub issue #25), but heavily optimized C with chunked internal storage. Still significantly faster than our JS-level brute-force because it avoids JS<->SQLite row-by-row deserialization overhead
- **Performance at 100K vectors:** <75ms for dims <= 1024, ~105ms for 1536-dim, ~214ms for 3072-dim
- **Performance at 1M vectors:** Slow for float (192ms+ even at 192-dim), but bit quantization brings it to ~124ms
- Supports binary quantization (`vec_quantize_binary()`) for 32x storage reduction with ~5-10% quality loss
- Supports Matryoshka truncation (`vec_slice()` + `vec_normalize()`)
- On macOS with `bun:sqlite`, may need `Database.setCustomSQLite("/usr/local/opt/sqlite3/lib/libsqlite3.dylib")` to enable extensions

**Why use it over our current approach:**
- Current `SqliteVectorStore` loads ALL rows into JS, deserializes every blob to `Float32Array`, computes cosine distance in JS — O(n) with high constant factor
- `sqlite-vec` does the entire KNN scan in optimized C within SQLite — no row serialization overhead, SIMD-optimized distance computation
- Expected 5-20x speedup for the same brute-force approach, more with quantization
- Future HNSW support will make it O(log n) when it ships

**API pattern:**
```sql
-- Create virtual table
CREATE VIRTUAL TABLE vec_chunks USING vec0(
    chunk_id TEXT PRIMARY KEY,
    embedding float[768]
);

-- Insert (vector as JSON or blob)
INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?);

-- KNN query — MATCH + ORDER BY distance + LIMIT
SELECT chunk_id, distance
FROM vec_chunks
WHERE embedding MATCH ?
  AND k = ?
ORDER BY distance;

-- Delete
DELETE FROM vec_chunks WHERE chunk_id = ?;

-- Count
SELECT COUNT(*) FROM vec_chunks;
```

**Loading in Bun:**
```typescript
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

const db = new Database("index.db");
sqliteVec.load(db);
```

---

## Existing files to understand before starting

| File | What it does |
|------|-------------|
| `src/utils/search/stores/vector-store.ts` | `VectorStore` interface: `store(id, vector)`, `remove(id)`, `search(queryVector, limit)`, `count()` |
| `src/utils/search/stores/sqlite-vector-store.ts` | Current brute-force implementation — loads all rows, computes cosine in JS |
| `src/utils/search/stores/sqlite-vector-store.test.ts` | 5 tests: store+search, score=1 for identical, remove, count, replace |
| `src/utils/search/stores/lancedb-vector-store.ts` | LanceDB VectorStore — async with in-memory mirror, reference for adapter pattern |
| `src/utils/search/stores/index.ts` | Public re-exports of all stores |
| `src/utils/search/stores/text-store.ts` | `TextStore` interface (for reference) |
| `src/utils/search/drivers/sqlite-fts5/index.ts` | `SearchEngine` — BM25 + vector + hybrid RRF search, accepts optional `VectorStore` in config |
| `src/utils/search/drivers/sqlite-fts5/vector.ts` | Legacy `storeEmbedding()`, `vectorSearch()` — standalone functions (not used by SearchEngine anymore) |
| `src/utils/search/types.ts` | `SearchEngine<TDoc>`, `SearchOptions`, `SearchResult` interfaces |
| `src/indexer/lib/types.ts` | `IndexConfig` — `storage.driver` currently `"sqlite" \| "orama" \| "turbopuffer"` |
| `src/indexer/lib/store.ts` | `createIndexStore()` — creates `SearchEngine.fromDatabase()`, manages embeddings table directly |
| `src/utils/math.ts` | `cosineDistance(a, b)` — returns 0..2 (0 = identical) |
| `.worktrees/socraticode/src/services/qdrant.ts` | Reference: Qdrant collection creation (lines 62-104), point structure (lines 183-202), hybrid search with RRF (lines 305-355) |

---

## Task 0: Install sqlite-vec and verify it loads with bun:sqlite

**Files:**
- Modify: `package.json` (via `bun add`)
- Create: `src/utils/search/stores/sqlite-vec-store.test.ts` (smoke test only)

**Step 1: Install the package**

```bash
bun add sqlite-vec
```

**Step 2: Write a minimal smoke test**

Create `src/utils/search/stores/sqlite-vec-store.test.ts`:
```typescript
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

describe("sqlite-vec loading", () => {
    it("loads the sqlite-vec extension into bun:sqlite", async () => {
        const sqliteVec = await import("sqlite-vec");
        const db = new Database(":memory:");
        sqliteVec.load(db);

        const row = db.query("SELECT vec_version() AS version").get() as { version: string };
        expect(row.version).toBeTruthy();
        expect(typeof row.version).toBe("string");

        db.close();
    });

    it("can create a vec0 virtual table", async () => {
        const sqliteVec = await import("sqlite-vec");
        const db = new Database(":memory:");
        sqliteVec.load(db);

        db.run(`CREATE VIRTUAL TABLE test_vecs USING vec0(
            doc_id TEXT PRIMARY KEY,
            embedding float[3]
        )`);

        // Insert a vector as JSON
        db.run(
            "INSERT INTO test_vecs(doc_id, embedding) VALUES (?, ?)",
            ["a", JSON.stringify([1.0, 0.0, 0.0])]
        );

        const count = db.query("SELECT COUNT(*) AS cnt FROM test_vecs").get() as { cnt: number };
        expect(count.cnt).toBe(1);

        db.close();
    });
});
```

**Step 3: Run the smoke test**

```bash
bun test src/utils/search/stores/sqlite-vec-store.test.ts --timeout 30000
```

If macOS blocks extension loading, add `Database.setCustomSQLite("/usr/local/opt/sqlite3/lib/libsqlite3.dylib")` before creating the Database. If Homebrew sqlite3 is not installed, run `brew install sqlite3` first.

**Step 4: Commit**

```bash
git add package.json bun.lockb src/utils/search/stores/sqlite-vec-store.test.ts
git commit -m "chore: add sqlite-vec dependency and smoke test"
```

---

## Task 1: SqliteVecVectorStore — Drop-in Replacement

**Files:**
- Create: `src/utils/search/stores/sqlite-vec-store.ts`
- Modify: `src/utils/search/stores/sqlite-vec-store.test.ts` (expand from Task 0)
- Modify: `src/utils/search/stores/index.ts`

**Step 1: Write the full test suite**

Expand `src/utils/search/stores/sqlite-vec-store.test.ts` — use the same test cases as `sqlite-vector-store.test.ts` but targeting the new class:

```typescript
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SqliteVecVectorStore } from "./sqlite-vec-store";

describe("SqliteVecVectorStore", () => {
    let db: Database;

    beforeEach(async () => {
        const sqliteVec = await import("sqlite-vec");
        db = new Database(":memory:");
        sqliteVec.load(db);
    });

    afterEach(() => {
        db?.close();
    });

    it("stores and searches vectors by cosine similarity", () => {
        const store = new SqliteVecVectorStore(db, { tableName: "test", dimensions: 3 });

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));
        store.store("c", new Float32Array([0.9, 0.1, 0]));

        const results = store.search(new Float32Array([1, 0, 0]), 3);
        expect(results[0].docId).toBe("a"); // exact match
        expect(results[1].docId).toBe("c"); // close
        expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it("returns score close to 1 for identical vectors", () => {
        const store = new SqliteVecVectorStore(db, { tableName: "test", dimensions: 3 });
        store.store("a", new Float32Array([1, 0, 0]));

        const results = store.search(new Float32Array([1, 0, 0]), 1);
        // sqlite-vec returns L2 distance, we convert to cosine similarity
        // For identical normalized vectors, distance ~ 0, score ~ 1
        expect(results[0].score).toBeGreaterThan(0.95);
    });

    it("removes vectors", () => {
        const store = new SqliteVecVectorStore(db, { tableName: "test", dimensions: 3 });
        store.store("a", new Float32Array([1, 0, 0]));
        store.remove("a");

        const results = store.search(new Float32Array([1, 0, 0]), 10);
        expect(results.length).toBe(0);
    });

    it("returns count of stored vectors", () => {
        const store = new SqliteVecVectorStore(db, { tableName: "test", dimensions: 3 });
        expect(store.count()).toBe(0);

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));
        expect(store.count()).toBe(2);
    });

    it("replaces vector for existing ID", () => {
        const store = new SqliteVecVectorStore(db, { tableName: "test", dimensions: 3 });
        store.store("a", new Float32Array([1, 0, 0]));
        store.store("a", new Float32Array([0, 1, 0]));

        expect(store.count()).toBe(1);

        const results = store.search(new Float32Array([0, 1, 0]), 1);
        expect(results[0].docId).toBe("a");
        expect(results[0].score).toBeGreaterThan(0.95);
    });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/utils/search/stores/sqlite-vec-store.test.ts --timeout 30000
```

**Step 3: Implement SqliteVecVectorStore**

Create `src/utils/search/stores/sqlite-vec-store.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { VectorSearchHit, VectorStore } from "./vector-store";

export interface SqliteVecVectorStoreConfig {
    tableName: string;
    dimensions: number;
}

/**
 * VectorStore backed by sqlite-vec extension — uses vec0 virtual tables
 * for optimized brute-force KNN search entirely in C (no JS deserialization).
 *
 * Requires sqlite-vec to be loaded on the Database instance before construction:
 *   import * as sqliteVec from "sqlite-vec";
 *   sqliteVec.load(db);
 */
export class SqliteVecVectorStore implements VectorStore {
    private db: Database;
    private vecTable: string;
    private dimensions: number;

    constructor(db: Database, config: SqliteVecVectorStoreConfig) {
        this.db = db;
        this.dimensions = config.dimensions;
        this.vecTable = `${config.tableName}_vec`;

        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${this.vecTable} USING vec0(
            doc_id TEXT PRIMARY KEY,
            embedding float[${config.dimensions}]
        )`);
    }

    store(id: string, vector: Float32Array): void {
        // vec0 doesn't support INSERT OR REPLACE directly — delete first, then insert
        this.db.run(`DELETE FROM ${this.vecTable} WHERE doc_id = ?`, [id]);

        // Pass vector as raw blob (Float32Array buffer)
        const blob = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
        this.db.run(
            `INSERT INTO ${this.vecTable}(doc_id, embedding) VALUES (?, ?)`,
            [id, blob]
        );
    }

    remove(id: string): void {
        this.db.run(`DELETE FROM ${this.vecTable} WHERE doc_id = ?`, [id]);
    }

    search(queryVector: Float32Array, limit: number): VectorSearchHit[] {
        // sqlite-vec KNN query: MATCH + k constraint + ORDER BY distance
        const blob = new Uint8Array(
            queryVector.buffer,
            queryVector.byteOffset,
            queryVector.byteLength
        );

        const rows = this.db.query(`
            SELECT doc_id, distance
            FROM ${this.vecTable}
            WHERE embedding MATCH ?
              AND k = ?
            ORDER BY distance
        `).all(blob, limit) as Array<{ doc_id: string; distance: number }>;

        // sqlite-vec returns L2 distance by default for float vectors.
        // Convert to a similarity score: score = 1 / (1 + distance)
        // This gives score in (0, 1] where 1 = identical.
        return rows.map((row) => ({
            docId: row.doc_id,
            score: 1 / (1 + row.distance),
        }));
    }

    count(): number {
        const row = this.db.query(
            `SELECT COUNT(*) AS cnt FROM ${this.vecTable}`
        ).get() as { cnt: number };
        return row.cnt;
    }
}
```

**Important implementation notes:**

1. **Distance metric:** sqlite-vec `vec0` uses L2 (Euclidean) distance by default for `float[N]` columns. Our existing `SqliteVectorStore` uses cosine similarity (1 - cosineDistance). For normalized vectors (which embedding models typically produce), L2 and cosine rankings are equivalent: `L2^2 = 2 - 2*cos(theta)`. The score conversion `1 / (1 + distance)` maps L2 distance to a 0..1 range. If the vectors are NOT normalized by the embedder, we should normalize them in `store()` before inserting. Check the embedder output and add normalization if needed.

2. **Upsert:** `vec0` virtual tables may not support `INSERT OR REPLACE`. The pattern is DELETE + INSERT. Wrap in a transaction for safety if needed.

3. **Blob format:** sqlite-vec accepts vectors as JSON arrays (`'[0.1, 0.2, ...]'`) or as raw little-endian float32 blobs. Using the blob format (via `Uint8Array` view of `Float32Array.buffer`) is faster — avoids JSON serialization.

4. **Extension loading:** The caller is responsible for loading sqlite-vec on the Database instance BEFORE constructing this store. This keeps the store simple and allows the caller to handle extension loading failures gracefully.

**Step 4: Update the barrel export**

In `src/utils/search/stores/index.ts`, add:
```typescript
export type { SqliteVecVectorStoreConfig } from "./sqlite-vec-store";
export { SqliteVecVectorStore } from "./sqlite-vec-store";
```

**Step 5: Run tests**

```bash
bun test src/utils/search/stores/sqlite-vec-store.test.ts --timeout 30000
```

Expected: ALL PASS

**Step 6: Type check**

```bash
tsgo --noEmit | rg "src/utils/search"
```

**Step 7: Commit**

```bash
git add src/utils/search/stores/sqlite-vec-store.ts src/utils/search/stores/sqlite-vec-store.test.ts src/utils/search/stores/index.ts
git commit -m "feat(search): add SqliteVecVectorStore backed by sqlite-vec extension"
```

---

## Task 2: Wire SqliteVecVectorStore as Default (with Fallback)

**Files:**
- Modify: `src/indexer/lib/store.ts`
- Modify: `src/indexer/lib/types.ts`
- Modify: `src/utils/search/drivers/sqlite-fts5/index.ts`
- Create: `src/utils/search/stores/sqlite-vec-loader.ts`

**Step 1: Create extension loader utility**

Create `src/utils/search/stores/sqlite-vec-loader.ts`:

```typescript
import type { Database } from "bun:sqlite";

let extensionAvailable: boolean | null = null;

/**
 * Attempt to load sqlite-vec extension on the given Database.
 * Returns true if successful, false if the extension is unavailable.
 * Caches the availability result — if it failed once, it won't retry on
 * subsequent calls, but it WILL call sqliteVec.load() on each new Database
 * instance since extensions must be loaded per-connection.
 */
export function loadSqliteVec(db: Database): boolean {
    if (extensionAvailable === false) {
        return false;
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

/**
 * Check whether sqlite-vec is available without loading it.
 */
export function isSqliteVecAvailable(): boolean {
    if (extensionAvailable !== null) {
        return extensionAvailable;
    }

    try {
        require.resolve("sqlite-vec");
        extensionAvailable = true;
        return true;
    } catch {
        extensionAvailable = false;
        return false;
    }
}
```

**Step 2: Update IndexConfig storage options**

In `src/indexer/lib/types.ts`, update the `storage` field in `IndexConfig`:

```typescript
storage?: {
    driver?: "sqlite" | "orama" | "turbopuffer";
    /** Vector search backend. Default: "sqlite-vec" with "sqlite-brute" fallback */
    vectorDriver?: "sqlite-vec" | "sqlite-brute" | "qdrant";
    path?: string;
    turbopuffer?: { apiKey?: string; namespace?: string };
    oramaCache?: boolean;
    /** Qdrant connection config (only used when vectorDriver = "qdrant") */
    qdrant?: { url: string; apiKey?: string; collectionName?: string };
};
```

**Step 3: Add vectorDriver to SearchEngineConfig and update initStores()**

In `src/utils/search/drivers/sqlite-fts5/index.ts`:

1. Add `vectorDriver?: "sqlite-vec" | "sqlite-brute" | "qdrant"` to `SearchEngineConfig`.
2. Modify `initStores()`:

```typescript
private initStores(): void {
    if (this.config.vectorStore) {
        // Externally provided store (e.g. QdrantVectorStore)
        this.vectorStore = this.config.vectorStore;
        return;
    }

    if (!this.embedder) {
        return;
    }

    const forceDriver = this.config.vectorDriver;

    // If explicitly set to brute-force, skip sqlite-vec attempt
    if (forceDriver === "sqlite-brute") {
        this.vectorStore = new SqliteVectorStore(this.db, {
            tableName: this.config.tableName,
            dimensions: this.embedder.dimensions,
        });
        return;
    }

    // Try sqlite-vec (default or explicit)
    try {
        const { loadSqliteVec } = require("@app/utils/search/stores/sqlite-vec-loader");
        const vecLoaded = loadSqliteVec(this.db);

        if (vecLoaded) {
            const { SqliteVecVectorStore } = require("@app/utils/search/stores/sqlite-vec-store");
            this.vectorStore = new SqliteVecVectorStore(this.db, {
                tableName: this.config.tableName,
                dimensions: this.embedder.dimensions,
            });
            return;
        }

        if (forceDriver === "sqlite-vec") {
            throw new Error(
                "vectorDriver is set to 'sqlite-vec' but the sqlite-vec extension failed to load. " +
                "Install it with: bun add sqlite-vec"
            );
        }
    } catch (err) {
        if (forceDriver === "sqlite-vec") {
            throw err;
        }
        // Fall through to brute-force
    }

    // Fallback to brute-force
    this.vectorStore = new SqliteVectorStore(this.db, {
        tableName: this.config.tableName,
        dimensions: this.embedder.dimensions,
    });
}
```

**Step 4: Update createIndexStore() to pass vectorDriver**

In `src/indexer/lib/store.ts`, when constructing `SearchEngine.fromDatabase()`, pass through the config:

```typescript
const fts = SearchEngine.fromDatabase<ChunkDoc>(db, {
    tableName,
    schema: {
        textFields: ["content", "name", "filePath"],
        idField: "id",
        vectorField: "content",
    },
    embedder,
    vectorDriver: config.storage?.vectorDriver,
});
```

**Step 5: Handle existing embeddings migration**

When switching from brute-force (`_embeddings` table) to sqlite-vec (`_vec` table), existing embeddings need migration. Add a helper in `store.ts`:

```typescript
function migrateEmbeddingsToVec(db: Database, tableName: string): void {
    const embTable = `${tableName}_embeddings`;
    const vecTable = `${tableName}_vec`;

    // Check if old table has data and new table exists but is empty
    const oldExists = db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(embTable);
    const newExists = db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(vecTable);

    if (!oldExists || !newExists) {
        return;
    }

    const oldCount = (db.query(`SELECT COUNT(*) AS cnt FROM ${embTable}`).get() as { cnt: number }).cnt;
    const newCount = (db.query(`SELECT COUNT(*) AS cnt FROM ${vecTable}`).get() as { cnt: number }).cnt;

    if (oldCount === 0 || newCount > 0) {
        return;
    }

    // Migrate: read from old table, insert into vec table
    const rows = db.query(`SELECT doc_id, embedding FROM ${embTable}`).all() as Array<{
        doc_id: string;
        embedding: Buffer;
    }>;

    const tx = db.transaction(() => {
        for (const row of rows) {
            db.run(
                `INSERT INTO ${vecTable}(doc_id, embedding) VALUES (?, ?)`,
                [row.doc_id, row.embedding]
            );
        }
    });
    tx();
}
```

Call this in `createIndexStore()` after the SearchEngine is created, if sqlite-vec is active.

**Step 6: Tests**

Write tests in a new file `src/indexer/lib/store-vector-driver.test.ts` to verify:
1. Default behavior: sqlite-vec loads and is used when available
2. Explicit `vectorDriver: "sqlite-brute"` forces brute-force
3. Explicit `vectorDriver: "sqlite-vec"` throws if extension unavailable
4. Search results are equivalent between both backends

```bash
bun test src/indexer/lib/store-vector-driver.test.ts --timeout 30000
bun test src/utils/search/ --timeout 30000
```

**Step 7: Commit**

```bash
git commit -m "feat(search): wire SqliteVecVectorStore as default vector backend with brute-force fallback"
```

---

## Task 3: RRF Over-Fetch

**Files:**
- Modify: `src/utils/search/drivers/sqlite-fts5/index.ts`
- Create: `src/utils/search/drivers/sqlite-fts5/rrf.test.ts`

**Step 1: Write tests for over-fetch behavior**

Create `src/utils/search/drivers/sqlite-fts5/rrf.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchEngine } from "./index";

describe("RRF over-fetch", () => {
    let tmpDir: string;
    let db: Database;

    afterEach(() => {
        db?.close();

        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("bm25Search fetches 3x limit candidates for RRF fusion", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "rrf-"));
        const dbPath = join(tmpDir, "test.db");

        const engine = new SearchEngine({
            dbPath,
            tableName: "docs",
            schema: {
                textFields: ["content"],
                idField: "id",
            },
        });

        // Insert enough docs that over-fetch matters
        for (let i = 0; i < 50; i++) {
            engine["insertSync"]({
                id: String(i),
                content: `document about topic ${i % 10 === 0 ? "search engine optimization" : "random content"} number ${i}`,
            });
        }

        // When requesting limit=5, internal bm25Search for RRF should fetch more
        // We verify indirectly: more candidates means better ranking quality
        const results = engine.bm25Search("search engine optimization", 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results.length).toBeLessThanOrEqual(5);
    });
});
```

**Step 2: Modify rrfHybridSearch to over-fetch**

In `src/utils/search/drivers/sqlite-fts5/index.ts`, update `rrfHybridSearch()`:

Change the two hardcoded `100` values to use a dynamic `candidatePool`:

```typescript
async rrfHybridSearch(opts: {
    query: string;
    queryEmbedding?: Float32Array;
    limit: number;
    boost?: Record<string, number>;
    weights?: { text: number; vector: number };
    filters?: { sql: string; params: Array<string | number> };
}): Promise<SearchResult<TDoc>[]> {
    const K = 60;
    const textWeight = opts.weights?.text ?? 1.0;
    const vectorWeight = opts.weights?.vector ?? 1.0;

    // Over-fetch: retrieve 3x candidates per sub-query for better RRF ranking
    // (Adopted from SocratiCode's Qdrant hybrid search pattern)
    const candidatePool = Math.max(opts.limit * 3, 30);

    const bm25Results = this.bm25Search(opts.query, candidatePool, opts.boost, opts.filters);

    const vectorQuery = opts.queryEmbedding ?? opts.query;
    const vecResults = await this.cosineSearch(vectorQuery, candidatePool, opts.filters);

    // ... rest of RRF fusion is unchanged (scores map, rank merge, sort, slice) ...
```

The key change: replace the two `100` literals with `candidatePool`.

**Step 3: Run all search tests**

```bash
bun test src/utils/search/ --timeout 30000
```

Expected: ALL PASS

**Step 4: Commit**

```bash
git commit -m "feat(search): RRF over-fetch — retrieve 3x candidates per sub-query for better ranking"
```

---

## Task 4: Min Score Threshold

**Files:**
- Modify: `src/utils/search/types.ts`
- Modify: `src/utils/search/drivers/sqlite-fts5/index.ts`
- Modify: `src/indexer/lib/types.ts`
- Modify: `src/indexer/lib/store.ts`
- Create: `src/utils/search/drivers/sqlite-fts5/min-score.test.ts`

**Step 1: Write failing tests**

Create `src/utils/search/drivers/sqlite-fts5/min-score.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchEngine } from "./index";

describe("Min score threshold", () => {
    let tmpDir: string;

    afterEach(() => {
        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("filters results below minScore threshold", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "minscore-"));
        const dbPath = join(tmpDir, "test.db");

        const engine = new SearchEngine({
            dbPath,
            tableName: "docs",
            schema: {
                textFields: ["content"],
                idField: "id",
            },
        });

        engine["insertSync"]({ id: "1", content: "TypeScript programming language" });
        engine["insertSync"]({ id: "2", content: "completely unrelated gardening tips for spring" });

        const resultsNoThreshold = await engine.search({
            query: "typescript",
            mode: "fulltext",
            limit: 10,
        });

        const resultsWithThreshold = await engine.search({
            query: "typescript",
            mode: "fulltext",
            limit: 10,
            minScore: 5.0, // high threshold to filter weak matches
        });

        expect(resultsNoThreshold.length).toBeGreaterThanOrEqual(1);
        expect(resultsWithThreshold.length).toBeLessThanOrEqual(resultsNoThreshold.length);
    });

    it("defaults to no filtering when minScore is not set", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "minscore-"));
        const dbPath = join(tmpDir, "test.db");

        const engine = new SearchEngine({
            dbPath,
            tableName: "docs",
            schema: {
                textFields: ["content"],
                idField: "id",
            },
        });

        engine["insertSync"]({ id: "1", content: "hello world" });

        const results = await engine.search({
            query: "hello",
            mode: "fulltext",
            limit: 10,
        });

        // Without minScore, all results returned
        expect(results.length).toBe(1);
    });

    it("respects minScore of 0 (no filtering)", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "minscore-"));
        const dbPath = join(tmpDir, "test.db");

        const engine = new SearchEngine({
            dbPath,
            tableName: "docs",
            schema: {
                textFields: ["content"],
                idField: "id",
            },
        });

        engine["insertSync"]({ id: "1", content: "test content" });

        const results = await engine.search({
            query: "test",
            mode: "fulltext",
            limit: 10,
            minScore: 0,
        });

        expect(results.length).toBe(1);
    });
});
```

**Step 2: Add `minScore` to SearchOptions**

In `src/utils/search/types.ts`, add to `SearchOptions`:

```typescript
/** Minimum score threshold — results below this are filtered out. Default: no filtering. */
minScore?: number;
```

**Step 3: Apply threshold in SearchEngine.search()**

In `src/utils/search/drivers/sqlite-fts5/index.ts`, modify `search()`:

```typescript
async search(opts: SearchOptions): Promise<SearchResult<TDoc>[]> {
    const mode = opts.mode ?? "fulltext";
    const limit = opts.limit ?? 20;

    let results: SearchResult<TDoc>[];

    switch (mode) {
        case "fulltext":
            results = this.bm25Search(opts.query, limit, opts.boost);
            break;
        case "vector":
            results = await this.cosineSearch(opts.query, limit);
            break;
        case "hybrid":
            results = await this.hybridSearch(opts.query, limit, opts.boost, opts.hybridWeights);
            break;
        default:
            results = this.bm25Search(opts.query, limit, opts.boost);
    }

    if (opts.minScore !== undefined && opts.minScore > 0) {
        results = results.filter((r) => r.score >= opts.minScore!);
    }

    return results;
}
```

**Step 4: Add default minScore to IndexConfig**

In `src/indexer/lib/types.ts`, add to `IndexConfig`:

```typescript
// Search tuning
search?: {
    /** Minimum score threshold for search results. Default: 0 (no filtering) */
    minScore?: number;
    /** Hybrid search weights */
    hybridWeights?: { text: number; vector: number };
};
```

**Step 5: Wire into IndexStore.search()**

In `src/indexer/lib/store.ts`, update the `search` method to merge config-level minScore with per-query minScore:

```typescript
async search(opts: SearchOptions): Promise<SearchResult<ChunkRecord>[]> {
    const minScore = opts.minScore ?? config.search?.minScore;
    const results = await fts.search({ ...opts, minScore });
    return results.map((r) => ({
        doc: r.doc as unknown as ChunkRecord,
        score: r.score,
        method: r.method,
    }));
},
```

**Step 6: Run tests**

```bash
bun test src/utils/search/drivers/sqlite-fts5/min-score.test.ts --timeout 30000
bun test src/utils/search/ --timeout 30000
bun test src/indexer/ --timeout 60000
```

**Step 7: Commit**

```bash
git commit -m "feat(search): add configurable minScore threshold to filter low-quality results"
```

---

## Task 5: QdrantVectorStore (Optional Backend)

**Files:**
- Create: `src/utils/search/stores/qdrant-vector-store.ts`
- Create: `src/utils/search/stores/qdrant-vector-store.test.ts`
- Modify: `src/utils/search/stores/index.ts`

**Step 1: Install Qdrant client**

```bash
bun add @qdrant/js-client-rest
```

**Step 2: Write tests (with mock client)**

Create `src/utils/search/stores/qdrant-vector-store.test.ts`:

```typescript
import { afterEach, describe, expect, it, mock } from "bun:test";
import { QdrantVectorStore } from "./qdrant-vector-store";

// In-memory mock of Qdrant client for unit testing
function createMockQdrantClient() {
    const points = new Map<string, { id: string; vector: number[]; payload: Record<string, unknown> }>();

    return {
        getCollections: mock(async () => ({
            collections: [] as Array<{ name: string }>,
        })),
        createCollection: mock(async (_name: string, _params: unknown) => {}),
        upsert: mock(async (_collection: string, opts: {
            points: Array<{
                id: string;
                vector: Record<string, number[]>;
                payload?: Record<string, unknown>;
            }>;
        }) => {
            for (const p of opts.points) {
                const vec = p.vector["dense"] ?? Object.values(p.vector)[0];
                points.set(p.id, { id: p.id, vector: vec, payload: p.payload ?? {} });
            }
        }),
        delete: mock(async (_collection: string, opts: { points: string[] }) => {
            for (const id of opts.points) {
                points.delete(id);
            }
        }),
        search: mock(async (_collection: string, opts: {
            vector: { name: string; vector: number[] };
            limit: number;
        }) => {
            const queryVec = opts.vector.vector;
            const scored = [...points.values()].map((p) => {
                let dot = 0, normA = 0, normB = 0;
                for (let i = 0; i < queryVec.length; i++) {
                    dot += queryVec[i] * p.vector[i];
                    normA += queryVec[i] * queryVec[i];
                    normB += p.vector[i] * p.vector[i];
                }
                const denom = Math.sqrt(normA) * Math.sqrt(normB);
                const score = denom === 0 ? 0 : dot / denom;
                return { id: p.id, score, payload: p.payload };
            });
            scored.sort((a, b) => b.score - a.score);
            return scored.slice(0, opts.limit);
        }),
        count: mock(async (_collection: string) => ({
            count: points.size,
        })),
        _points: points,
    };
}

describe("QdrantVectorStore", () => {
    it("stores and searches vectors via memory mirror", async () => {
        const mockClient = createMockQdrantClient();
        const store = new QdrantVectorStore({
            collectionName: "test",
            dimensions: 3,
            client: mockClient as any,
        });

        await store.init();

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));
        store.store("c", new Float32Array([0.9, 0.1, 0]));

        // Sync search uses in-memory mirror
        const results = store.search(new Float32Array([1, 0, 0]), 3);
        expect(results[0].docId).toBe("a");
        expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it("removes vectors", async () => {
        const mockClient = createMockQdrantClient();
        const store = new QdrantVectorStore({
            collectionName: "test",
            dimensions: 3,
            client: mockClient as any,
        });

        await store.init();

        store.store("a", new Float32Array([1, 0, 0]));
        store.remove("a");

        const results = store.search(new Float32Array([1, 0, 0]), 10);
        expect(results.length).toBe(0);
    });

    it("returns count of stored vectors", async () => {
        const mockClient = createMockQdrantClient();
        const store = new QdrantVectorStore({
            collectionName: "test",
            dimensions: 3,
            client: mockClient as any,
        });

        await store.init();

        expect(store.count()).toBe(0);

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));
        expect(store.count()).toBe(2);
    });

    it("flushes pending operations to the remote client", async () => {
        const mockClient = createMockQdrantClient();
        const store = new QdrantVectorStore({
            collectionName: "test",
            dimensions: 3,
            client: mockClient as any,
        });

        await store.init();

        store.store("a", new Float32Array([1, 0, 0]));
        await store.flush();

        expect(mockClient.upsert).toHaveBeenCalled();
        expect(mockClient._points.size).toBe(1);
    });

    it("searchAsync queries the remote client after flush", async () => {
        const mockClient = createMockQdrantClient();
        const store = new QdrantVectorStore({
            collectionName: "test",
            dimensions: 3,
            client: mockClient as any,
        });

        await store.init();

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));

        const results = await store.searchAsync(new Float32Array([1, 0, 0]), 2);
        expect(results.length).toBe(2);
        expect(results[0].docId).toBe("a");
    });
});
```

**Step 3: Implement QdrantVectorStore**

Create `src/utils/search/stores/qdrant-vector-store.ts`:

```typescript
import { cosineDistance } from "@app/utils/math";
import type { VectorSearchHit, VectorStore } from "./vector-store";

interface QdrantClientLike {
    getCollections(): Promise<{ collections: Array<{ name: string }> }>;
    createCollection(name: string, params: unknown): Promise<void>;
    upsert(collection: string, opts: {
        points: Array<{
            id: string;
            vector: Record<string, unknown>;
            payload?: Record<string, unknown>;
        }>;
    }): Promise<void>;
    delete(collection: string, opts: { points: string[] }): Promise<void>;
    search(collection: string, opts: {
        vector: { name: string; vector: number[] };
        limit: number;
        with_payload?: boolean;
    }): Promise<Array<{ id: string; score: number; payload?: Record<string, unknown> }>>;
    count(collection: string): Promise<{ count: number }>;
}

export interface QdrantVectorStoreConfig {
    /** Qdrant collection name */
    collectionName: string;
    /** Vector dimensions */
    dimensions: number;
    /** Pre-constructed Qdrant client (allows caller to manage connection) */
    client?: QdrantClientLike;
    /** Qdrant server URL (used if client not provided) */
    url?: string;
    /** Qdrant API key (used if client not provided) */
    apiKey?: string;
    /** Dense vector name in the collection schema. Default: "dense" */
    vectorName?: string;
}

/**
 * VectorStore backed by Qdrant — a dedicated vector search engine.
 *
 * Like LanceDBVectorStore, this adapter maintains an in-memory mirror
 * for synchronous search (VectorStore interface is sync), while async
 * operations (upsert/delete) are queued and flushed in the background.
 *
 * For full Qdrant-native hybrid search (dense + BM25 + server-side RRF),
 * use the dedicated `searchHybridAsync()` method which bypasses the
 * VectorStore interface.
 */
export class QdrantVectorStore implements VectorStore {
    private config: QdrantVectorStoreConfig;
    private client: QdrantClientLike | null = null;
    private vectorName: string;
    private memoryIndex = new Map<string, Float32Array>();
    private pendingOps: Array<() => Promise<void>> = [];
    private flushPromise: Promise<void> | null = null;
    private closed = false;

    constructor(config: QdrantVectorStoreConfig) {
        this.config = config;
        this.vectorName = config.vectorName ?? "dense";

        if (config.client) {
            this.client = config.client;
        }
    }

    /**
     * Initialize: connect to Qdrant and ensure collection exists.
     * Must be called before store/search/remove.
     */
    async init(): Promise<void> {
        if (!this.client) {
            const { QdrantClient } = await import("@qdrant/js-client-rest");
            this.client = new QdrantClient({
                url: this.config.url ?? "http://localhost:6333",
                apiKey: this.config.apiKey,
            }) as unknown as QdrantClientLike;
        }

        await this.ensureCollection();
    }

    store(id: string, vector: Float32Array): void {
        if (this.closed) {
            return;
        }

        this.memoryIndex.set(id, new Float32Array(vector));

        this.enqueue(async () => {
            await this.client!.upsert(this.config.collectionName, {
                points: [{
                    id,
                    vector: { [this.vectorName]: Array.from(vector) },
                }],
            });
        });
    }

    /**
     * Store a vector with associated text for BM25 sparse indexing.
     * Use this instead of store() when you want hybrid search capability.
     */
    storeWithText(id: string, vector: Float32Array, text: string): void {
        if (this.closed) {
            return;
        }

        this.memoryIndex.set(id, new Float32Array(vector));

        this.enqueue(async () => {
            await this.client!.upsert(this.config.collectionName, {
                points: [{
                    id,
                    vector: {
                        [this.vectorName]: Array.from(vector),
                        bm25: { text, model: "qdrant/bm25" },
                    },
                    payload: { text },
                }],
            });
        });
    }

    remove(id: string): void {
        if (this.closed) {
            return;
        }

        this.memoryIndex.delete(id);

        this.enqueue(async () => {
            await this.client!.delete(this.config.collectionName, {
                points: [id],
            });
        });
    }

    search(queryVector: Float32Array, limit: number): VectorSearchHit[] {
        // Synchronous search using in-memory mirror
        const hits: VectorSearchHit[] = [];

        for (const [docId, storedVec] of this.memoryIndex) {
            const score = 1 - cosineDistance(queryVector, storedVec);
            hits.push({ docId, score });
        }

        hits.sort((a, b) => b.score - a.score);
        return hits.slice(0, limit);
    }

    count(): number {
        return this.memoryIndex.size;
    }

    /**
     * Async search directly against Qdrant server (HNSW ANN).
     */
    async searchAsync(queryVector: Float32Array, limit: number): Promise<VectorSearchHit[]> {
        await this.flush();

        if (!this.client) {
            return [];
        }

        const results = await this.client.search(this.config.collectionName, {
            vector: { name: this.vectorName, vector: Array.from(queryVector) },
            limit,
            with_payload: false,
        });

        return results.map((r) => ({
            docId: String(r.id),
            score: r.score,
        }));
    }

    /**
     * Qdrant-native hybrid search: dense + BM25 with server-side RRF fusion.
     * This is the highest-quality search mode when using Qdrant.
     *
     * Modeled after SocratiCode's qdrant.ts:305-355
     */
    async searchHybridAsync(opts: {
        queryVector: Float32Array;
        queryText: string;
        limit: number;
        filter?: Record<string, unknown>;
    }): Promise<VectorSearchHit[]> {
        await this.flush();

        if (!this.client) {
            return [];
        }

        const prefetchLimit = Math.max(opts.limit * 3, 30);
        const activeFilter = opts.filter ?? undefined;

        // Use Qdrant query API with prefetch + RRF fusion
        const results = await (this.client as any).query(this.config.collectionName, {
            prefetch: [
                {
                    query: Array.from(opts.queryVector),
                    using: this.vectorName,
                    limit: prefetchLimit,
                    filter: activeFilter,
                },
                {
                    query: { text: opts.queryText, model: "qdrant/bm25" },
                    using: "bm25",
                    limit: prefetchLimit,
                    filter: activeFilter,
                },
            ],
            query: { fusion: "rrf" },
            limit: opts.limit,
            with_payload: true,
            filter: activeFilter,
        });

        return results.points.map((r: { id: string; score: number }) => ({
            docId: String(r.id),
            score: r.score,
        }));
    }

    /** Wait for all pending async operations to complete. */
    async flush(): Promise<void> {
        if (this.flushPromise) {
            await this.flushPromise;
        }

        while (this.pendingOps.length > 0) {
            await this.drainQueue();
        }
    }

    async close(): Promise<void> {
        await this.flush();
        this.closed = true;
        this.client = null;
        this.memoryIndex.clear();
    }

    private async ensureCollection(): Promise<void> {
        const collections = await this.client!.getCollections();
        const exists = collections.collections.some(
            (c) => c.name === this.config.collectionName
        );

        if (!exists) {
            await this.client!.createCollection(this.config.collectionName, {
                vectors: {
                    [this.vectorName]: {
                        size: this.config.dimensions,
                        distance: "Cosine",
                    },
                },
                sparse_vectors: {
                    bm25: {
                        modifier: "idf",
                    },
                },
                optimizers_config: {
                    default_segment_number: 2,
                },
                on_disk_payload: true,
            });
        }
    }

    private enqueue(op: () => Promise<void>): void {
        this.pendingOps.push(op);
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (this.flushPromise) {
            return;
        }

        this.flushPromise = this.drainQueue().finally(() => {
            this.flushPromise = null;

            if (this.pendingOps.length > 0) {
                this.scheduleFlush();
            }
        });
    }

    private async drainQueue(): Promise<void> {
        while (this.pendingOps.length > 0) {
            const op = this.pendingOps.shift()!;

            try {
                await op();
            } catch (err) {
                console.error("[QdrantVectorStore] async operation failed:", err);
            }
        }
    }
}
```

**Step 4: Update barrel exports**

In `src/utils/search/stores/index.ts`, add:
```typescript
export type { QdrantVectorStoreConfig } from "./qdrant-vector-store";
export { QdrantVectorStore } from "./qdrant-vector-store";
```

**Step 5: Run tests**

```bash
bun test src/utils/search/stores/qdrant-vector-store.test.ts --timeout 30000
tsgo --noEmit | rg "src/utils/search"
```

**Step 6: Commit**

```bash
git add src/utils/search/stores/qdrant-vector-store.ts src/utils/search/stores/qdrant-vector-store.test.ts src/utils/search/stores/index.ts package.json bun.lockb
git commit -m "feat(search): add QdrantVectorStore with hybrid search (dense + BM25 + server-side RRF)"
```

---

## Task 6: Qdrant Hybrid Search Integration with SearchEngine

**Files:**
- Modify: `src/utils/search/drivers/sqlite-fts5/index.ts`
- Create: `src/utils/search/drivers/sqlite-fts5/qdrant-hybrid.test.ts`

**Step 1: Write tests for Qdrant hybrid path in SearchEngine**

Create `src/utils/search/drivers/sqlite-fts5/qdrant-hybrid.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchEngine } from "./index";

describe("SearchEngine with QdrantVectorStore hybrid path", () => {
    let tmpDir: string;

    afterEach(() => {
        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("uses Qdrant hybrid search when vectorStore has searchHybridAsync", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "qdrant-hybrid-"));
        const dbPath = join(tmpDir, "test.db");

        const mockVectorStore = {
            store: mock(() => {}),
            remove: mock(() => {}),
            search: mock(() => []),
            count: mock(() => 0),
            searchHybridAsync: mock(async () => [
                { docId: "1", score: 0.95 },
                { docId: "2", score: 0.80 },
            ]),
        };

        // Minimal mock embedder
        const mockEmbedder = {
            dimensions: 3,
            embed: mock(async () => ({
                vector: new Float32Array([1, 0, 0]),
                tokens: 5,
            })),
            embedBatch: mock(async () => []),
        };

        const engine = new SearchEngine({
            dbPath,
            tableName: "docs",
            schema: {
                textFields: ["content"],
                idField: "id",
                vectorField: "content",
            },
            vectorStore: mockVectorStore as any,
            embedder: mockEmbedder as any,
        });

        // Insert test docs directly into content table
        engine["insertSync"]({ id: "1", content: "TypeScript programming" });
        engine["insertSync"]({ id: "2", content: "JavaScript frameworks" });

        const results = await engine.search({
            query: "typescript",
            mode: "hybrid",
            limit: 5,
        });

        // Should have used the Qdrant hybrid path
        expect(mockVectorStore.searchHybridAsync).toHaveBeenCalled();
        expect(results.length).toBe(2);
        expect(results[0].method).toBe("rrf");
    });
});
```

**Step 2: Modify hybridSearch() to detect Qdrant**

In `src/utils/search/drivers/sqlite-fts5/index.ts`, update the private `hybridSearch()` method:

```typescript
private async hybridSearch(
    query: string,
    limit: number,
    boost?: Record<string, number>,
    weights?: { text: number; vector: number }
): Promise<SearchResult<TDoc>[]> {
    // If using Qdrant with hybrid capability, use server-side RRF
    if (
        this.vectorStore &&
        this.embedder &&
        "searchHybridAsync" in this.vectorStore
    ) {
        try {
            const queryResult = await this.embedder.embed(query);
            const qdrantStore = this.vectorStore as {
                searchHybridAsync(opts: {
                    queryVector: Float32Array;
                    queryText: string;
                    limit: number;
                }): Promise<VectorSearchHit[]>;
            };

            const hits = await qdrantStore.searchHybridAsync({
                queryVector: queryResult.vector,
                queryText: query,
                limit,
            });

            // Resolve doc IDs back to full documents from SQLite content table
            const results: SearchResult<TDoc>[] = [];

            for (const hit of hits) {
                const doc = this.db
                    .query(
                        `SELECT c.* FROM ${this.contentTableName} c WHERE c.${this.config.schema.idField} = ?`
                    )
                    .get(hit.docId) as TDoc | null;

                if (doc) {
                    results.push({ doc, score: hit.score, method: "rrf" });
                }
            }

            return results;
        } catch {
            // Qdrant hybrid failed — fall back to client-side RRF
        }
    }

    // Default: client-side RRF
    return this.rrfHybridSearch({ query, limit, boost, weights });
}
```

Import `VectorSearchHit` type at top of file if not already imported.

**Step 3: Run tests**

```bash
bun test src/utils/search/drivers/sqlite-fts5/qdrant-hybrid.test.ts --timeout 30000
bun test src/utils/search/ --timeout 30000
```

**Step 4: Commit**

```bash
git commit -m "feat(search): SearchEngine delegates to Qdrant hybrid search when available"
```

---

## Task 7: Wire Qdrant into IndexStore

**Files:**
- Modify: `src/indexer/lib/store.ts`

**Step 1: Update createIndexStore() to support Qdrant backend**

In `src/indexer/lib/store.ts`, before creating the SearchEngine, check if Qdrant is configured:

```typescript
// After embedder is resolved, before SearchEngine.fromDatabase():
let externalVectorStore: VectorStore | undefined;
let qdrantStore: QdrantVectorStore | undefined;

if (config.storage?.vectorDriver === "qdrant") {
    const qdrantConfig = config.storage.qdrant;

    if (!qdrantConfig?.url) {
        throw new Error(
            "Qdrant vectorDriver requires storage.qdrant.url to be set"
        );
    }

    const { QdrantVectorStore } = await import(
        "@app/utils/search/stores/qdrant-vector-store"
    );

    qdrantStore = new QdrantVectorStore({
        collectionName: qdrantConfig.collectionName ?? sanitizeName(config.name),
        dimensions: embedder?.dimensions ?? 768,
        url: qdrantConfig.url,
        apiKey: qdrantConfig.apiKey,
    });

    await qdrantStore.init();
    externalVectorStore = qdrantStore;
}

const fts = SearchEngine.fromDatabase<ChunkDoc>(db, {
    tableName,
    schema: {
        textFields: ["content", "name", "filePath"],
        idField: "id",
        vectorField: "content",
    },
    embedder,
    vectorStore: externalVectorStore,
    vectorDriver: externalVectorStore ? undefined : config.storage?.vectorDriver,
});
```

Add the import at top of file:
```typescript
import type { VectorStore } from "@app/utils/search/stores/vector-store";
```

**Step 2: Update insertChunks() for Qdrant text indexing**

When using `QdrantVectorStore`, `insertChunks()` should call `storeWithText()` instead of plain `store()` so Qdrant gets both the dense vector and text for BM25:

```typescript
if (embeddings && embeddings.size > 0) {
    if (qdrantStore) {
        // Qdrant: store with text for hybrid search
        for (const [chunkId, vector] of embeddings) {
            const chunk = chunks.find((c) => c.id === chunkId);
            const text = chunk?.content ?? "";
            qdrantStore.storeWithText(chunkId, vector, text);
        }
    } else if (!embTableExists) {
        // Ensure embeddings table exists for SQLite-based stores
        db.run(`CREATE TABLE IF NOT EXISTS ${embTable} (
            doc_id TEXT PRIMARY KEY,
            embedding BLOB NOT NULL
        )`);
        embTableExists = true;
    }

    if (!qdrantStore) {
        for (const [chunkId, vector] of embeddings) {
            const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
            db.run(
                `INSERT OR REPLACE INTO ${embTable} (doc_id, embedding) VALUES (?, ?)`,
                [chunkId, blob]
            );
        }
    }
}
```

**Step 3: Update close() to flush Qdrant**

In the store's `close()` method:

```typescript
async close(): Promise<void> {
    if (qdrantStore) {
        await qdrantStore.flush();
        await qdrantStore.close();
    }

    await fts.close();
    db.close();

    try {
        rmSync(lockPath);
    } catch {
        // Lock may already be removed
    }
},
```

**Step 4: Run tests**

```bash
bun test src/indexer/ --timeout 60000
tsgo --noEmit | rg "src/indexer"
```

**Step 5: Commit**

```bash
git commit -m "feat(indexer): wire Qdrant vector backend into IndexStore"
```

---

## Task 8: Benchmark Script — sqlite-vec vs Brute-Force vs Qdrant

**Files:**
- Create: `src/indexer/commands/benchmark.ts`
- Modify: `src/indexer/index.ts` (register command)

**Step 1: Implement benchmark command**

`tools indexer benchmark [--vectors 10000] [--dimensions 768] [--queries 100] [--backends sqlite-vec,sqlite-brute]`

Create `src/indexer/commands/benchmark.ts`:

```typescript
import type { Command } from "commander";
import chalk from "chalk";

interface BenchmarkResult {
    backend: string;
    insertTimeMs: number;
    searchTimeMs: number;
    searchesPerSecond: number;
    totalVectors: number;
    dimensions: number;
    memoryMB: number;
}

export function registerBenchmarkCommand(program: Command): void {
    program
        .command("benchmark")
        .description("Benchmark vector search backends")
        .option("--vectors <n>", "Number of vectors to index", "10000")
        .option("--dimensions <n>", "Vector dimensions", "768")
        .option("--queries <n>", "Number of search queries", "100")
        .option("--limit <n>", "Results per query (k)", "10")
        .option(
            "--backends <list>",
            "Comma-separated backends to benchmark",
            "sqlite-vec,sqlite-brute"
        )
        .action(async (opts) => {
            const { mkdtempSync, rmSync } = await import("node:fs");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");
            const { Database } = await import("bun:sqlite");

            const numVectors = parseInt(opts.vectors, 10);
            const dimensions = parseInt(opts.dimensions, 10);
            const numQueries = parseInt(opts.queries, 10);
            const limit = parseInt(opts.limit, 10);
            const backends = opts.backends.split(",").map((b: string) => b.trim());

            console.log(chalk.bold("\nVector Search Benchmark"));
            console.log(`  Vectors: ${numVectors.toLocaleString()}`);
            console.log(`  Dimensions: ${dimensions}`);
            console.log(`  Queries: ${numQueries}`);
            console.log(`  k (limit): ${limit}`);
            console.log(`  Backends: ${backends.join(", ")}\n`);

            // Generate random normalized vectors
            console.log("Generating random vectors...");
            const vectors = generateRandomVectors(numVectors, dimensions);
            const queryVectors = generateRandomVectors(numQueries, dimensions);

            const results: BenchmarkResult[] = [];

            for (const backend of backends) {
                console.log(chalk.cyan(`\nBenchmarking: ${backend}`));
                const tmpDir = mkdtempSync(join(tmpdir(), `bench-${backend}-`));

                try {
                    const store = await createStore(backend, tmpDir, dimensions, Database);

                    // Benchmark inserts
                    const insertStart = performance.now();

                    for (let i = 0; i < vectors.length; i++) {
                        store.store(String(i), vectors[i]);
                    }

                    const insertTimeMs = performance.now() - insertStart;

                    // Benchmark searches
                    const searchTimes: number[] = [];

                    for (const qVec of queryVectors) {
                        const searchStart = performance.now();
                        store.search(qVec, limit);
                        searchTimes.push(performance.now() - searchStart);
                    }

                    const avgSearchMs =
                        searchTimes.reduce((a, b) => a + b, 0) / searchTimes.length;
                    const memUsage = process.memoryUsage();

                    const result: BenchmarkResult = {
                        backend,
                        insertTimeMs,
                        searchTimeMs: avgSearchMs,
                        searchesPerSecond: 1000 / avgSearchMs,
                        totalVectors: vectors.length,
                        dimensions,
                        memoryMB: memUsage.heapUsed / 1024 / 1024,
                    };

                    results.push(result);

                    console.log(
                        `  Insert: ${result.insertTimeMs.toFixed(0)}ms | ` +
                        `Search avg: ${result.searchTimeMs.toFixed(2)}ms | ` +
                        `${result.searchesPerSecond.toFixed(0)} q/s`
                    );
                } catch (err) {
                    console.log(chalk.red(`  FAILED: ${err}`));
                } finally {
                    rmSync(tmpDir, { recursive: true, force: true });
                }
            }

            // Print comparison table
            printResultsTable(results);
        });
}

function generateRandomVectors(count: number, dims: number): Float32Array[] {
    const vecs: Float32Array[] = [];

    for (let i = 0; i < count; i++) {
        const vec = new Float32Array(dims);

        for (let j = 0; j < dims; j++) {
            vec[j] = Math.random() * 2 - 1;
        }

        // Normalize
        let norm = 0;

        for (let j = 0; j < dims; j++) {
            norm += vec[j] * vec[j];
        }

        norm = Math.sqrt(norm);

        if (norm > 0) {
            for (let j = 0; j < dims; j++) {
                vec[j] /= norm;
            }
        }

        vecs.push(vec);
    }

    return vecs;
}

async function createStore(
    backend: string,
    tmpDir: string,
    dimensions: number,
    DatabaseClass: typeof import("bun:sqlite").Database
): Promise<import("@app/utils/search/stores/vector-store").VectorStore> {
    const { join } = await import("node:path");
    const dbPath = join(tmpDir, "bench.db");

    switch (backend) {
        case "sqlite-brute": {
            const { SqliteVectorStore } = await import(
                "@app/utils/search/stores/sqlite-vector-store"
            );
            const db = new DatabaseClass(dbPath);
            db.run("PRAGMA journal_mode = WAL");
            return new SqliteVectorStore(db, { tableName: "bench", dimensions });
        }

        case "sqlite-vec": {
            const sqliteVec = await import("sqlite-vec");
            const db = new DatabaseClass(dbPath);
            sqliteVec.load(db);
            db.run("PRAGMA journal_mode = WAL");
            const { SqliteVecVectorStore } = await import(
                "@app/utils/search/stores/sqlite-vec-store"
            );
            return new SqliteVecVectorStore(db, { tableName: "bench", dimensions });
        }

        default:
            throw new Error(
                `Unknown backend: ${backend}. Supported: sqlite-vec, sqlite-brute`
            );
    }
}

function printResultsTable(results: BenchmarkResult[]): void {
    if (results.length === 0) {
        return;
    }

    console.log(chalk.bold("\n\nResults Summary:"));
    console.log("=".repeat(80));
    console.log(
        "Backend".padEnd(16) +
        "Insert (ms)".padStart(14) +
        "Search avg (ms)".padStart(18) +
        "Queries/sec".padStart(14) +
        "Memory (MB)".padStart(14)
    );
    console.log("-".repeat(80));

    for (const r of results) {
        console.log(
            r.backend.padEnd(16) +
            r.insertTimeMs.toFixed(0).padStart(14) +
            r.searchTimeMs.toFixed(2).padStart(18) +
            r.searchesPerSecond.toFixed(0).padStart(14) +
            r.memoryMB.toFixed(1).padStart(14)
        );
    }

    console.log("=".repeat(80));

    // Find fastest search
    const fastest = results.reduce((a, b) =>
        a.searchTimeMs < b.searchTimeMs ? a : b
    );

    console.log(
        chalk.green(
            `\nFastest search: ${fastest.backend} ` +
            `(${fastest.searchTimeMs.toFixed(2)}ms avg)`
        )
    );

    for (const r of results) {
        if (r.backend !== fastest.backend) {
            const ratio = r.searchTimeMs / fastest.searchTimeMs;
            console.log(chalk.dim(`  ${r.backend}: ${ratio.toFixed(1)}x slower`));
        }
    }
}
```

**Step 2: Register the command**

In `src/indexer/index.ts`, add:
```typescript
import { registerBenchmarkCommand } from "./commands/benchmark";
// ...
registerBenchmarkCommand(program);
```

**Step 3: Test the benchmark**

```bash
# Quick smoke test with small dataset
tools indexer benchmark --vectors 1000 --dimensions 384 --queries 50

# Full benchmark
tools indexer benchmark --vectors 10000 --dimensions 768 --queries 100

# Compare at larger scale
tools indexer benchmark --vectors 50000 --dimensions 768 --queries 50
```

**Step 4: Commit**

```bash
git commit -m "feat(indexer): add 'tools indexer benchmark' for vector search backend comparison"
```

---

## Verification

After all tasks are complete, run the full test suite:

```bash
# Type check
tsgo --noEmit | rg "src/utils/search\|src/indexer"

# All search tests
bun test src/utils/search/ --timeout 30000

# All indexer tests
bun test src/indexer/ --timeout 60000

# E2E tests (if they exist)
bun test src/e2e/indexer --timeout 120000
bun test src/e2e/search --timeout 60000

# Quick benchmark to verify everything works end-to-end
tools indexer benchmark --vectors 5000 --dimensions 384 --queries 20
```

---

## Summary of changes

| Task | What | Files |
|------|------|-------|
| 0 | Install sqlite-vec, smoke test | `package.json`, test file |
| 1 | `SqliteVecVectorStore` implementing `VectorStore` | `sqlite-vec-store.ts`, tests, `index.ts` |
| 2 | Wire as default with brute-force fallback | `store.ts`, `types.ts`, `index.ts`, `sqlite-vec-loader.ts` |
| 3 | RRF over-fetch (3x candidates) | `drivers/sqlite-fts5/index.ts` |
| 4 | Min score threshold | `types.ts`, `index.ts`, `store.ts` |
| 5 | `QdrantVectorStore` with hybrid search | `qdrant-vector-store.ts`, tests |
| 6 | Qdrant hybrid integration with SearchEngine | `drivers/sqlite-fts5/index.ts` |
| 7 | Wire Qdrant into IndexStore | `store.ts` |
| 8 | Benchmark command | `commands/benchmark.ts` |

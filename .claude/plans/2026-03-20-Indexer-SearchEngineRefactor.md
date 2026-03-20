# Indexer Search Engine Refactor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the search infrastructure to support pluggable text/vector stores, rename FTS5SearchEngine → SearchEngine, store Merkle tree in a table instead of JSON blob, and introduce the IndexerSource abstraction for pluggable data sources.

**Architecture:** SearchEngine becomes a composition of TextStore (FTS5) + optional VectorStore (SQLite brute-force now, LanceDB later). IndexerSource replaces hardcoded `scanFiles()` with pluggable sources (FileSource, MailSource, TelegramSource). Merkle tree moves from a single JSON row to a `path_hashes` table with incremental updates. Embedding model metadata is stored in IndexMeta for mismatch detection.

**Tech Stack:** Bun, bun:sqlite, @ast-grep/napi, @lancedb/lancedb (optional), @huggingface/transformers

---

## Existing files to understand before starting

| File | What it does |
|------|-------------|
| `src/utils/search/drivers/sqlite-fts5/index.ts` | Current `FTS5SearchEngine` — handles FTS5 keyword search + brute-force vector search in one class |
| `src/utils/search/drivers/sqlite-fts5/vector.ts` | `storeEmbedding()`, `removeEmbedding()`, `vectorSearch()` — brute-force cosine scan |
| `src/utils/search/drivers/sqlite-fts5/schema.ts` | FTS5 DDL helpers + sync triggers |
| `src/utils/search/types.ts` | `SearchEngine<TDoc>`, `SearchOptions`, `SearchResult` interfaces |
| `src/utils/search/index.ts` | Public re-exports |
| `src/indexer/lib/store.ts` | `createIndexStore()` — wraps FTS5SearchEngine with metadata tables |
| `src/indexer/lib/indexer.ts` | `Indexer` class — scan → chunk → embed → store pipeline, `scanFiles()` hardcoded |
| `src/indexer/lib/merkle.ts` | `buildMerkleTree()`, `diffMerkleTrees()`, `serializeMerkleTree()` |
| `src/indexer/lib/change-detector.ts` | `detectChanges()` with git/merkle/git+merkle strategies |
| `src/indexer/lib/types.ts` | `IndexConfig`, `IndexMeta`, `ChunkRecord`, `MerkleNode` |
| `src/indexer/lib/events.ts` | `IndexerEventEmitter`, `IndexerEventMap`, `IndexerCallbacks` |
| `src/telegram/lib/TelegramHistoryStore.ts` | Uses `FTS5SearchEngine.fromDatabase()` — must keep working after rename |
| `src/utils/ai/tasks/Embedder.ts` | `Embedder.create()` with provider fallback |
| `src/utils/ai/providers/AILocalProvider.ts:206` | HuggingFace `feature-extraction` pipeline, hardcoded `Xenova/all-MiniLM-L6-v2` |

---

## Task 1: Rename FTS5SearchEngine → SearchEngine

**Files:**
- Modify: `src/utils/search/drivers/sqlite-fts5/index.ts`
- Modify: `src/utils/search/index.ts`
- Modify: `src/utils/search/drivers/sqlite-fts5/index.test.ts`
- Modify: `src/indexer/lib/store.ts`
- Modify: `src/indexer/lib/store-embedder.test.ts`
- Modify: `src/telegram/lib/TelegramHistoryStore.ts`
- Modify: `src/e2e/search-full-flow.e2e.test.ts`
- Modify: `src/e2e/search.e2e.test.ts`

**Step 1: Rename the class and all references**

In `src/utils/search/drivers/sqlite-fts5/index.ts`:
- Rename `FTS5SearchEngine` → `SearchEngine`
- Rename `FTS5SearchEngineConfig` → `SearchEngineConfig`
- Keep `FTS5TableOverrides` as-is (it's FTS5-specific)

In `src/utils/search/index.ts`:
```typescript
export { SearchEngine } from "./drivers/sqlite-fts5";
export type { SearchEngineConfig, FTS5TableOverrides } from "./drivers/sqlite-fts5";
// Backward compat alias
export { SearchEngine as FTS5SearchEngine } from "./drivers/sqlite-fts5";
```

**Step 2: Update all imports across the codebase**

Use `grep -rn "FTS5SearchEngine" src/` to find all references. Update each file's import to use `SearchEngine`. The backward-compat alias ensures nothing breaks if we miss one.

Key files:
- `src/indexer/lib/store.ts` — `import { SearchEngine } from "@app/utils/search"`
- `src/telegram/lib/TelegramHistoryStore.ts` — `import { SearchEngine } from "@app/utils/search"`
- All test files

**Step 3: Run tests and type check**

```bash
tsgo --noEmit | grep "src/"
bun test src/utils/search/ src/indexer/ src/telegram/ src/e2e/search --timeout 60000
```

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor(search): rename FTS5SearchEngine → SearchEngine"
```

---

## Task 2: Extract TextStore and VectorStore interfaces

**Files:**
- Create: `src/utils/search/stores/text-store.ts`
- Create: `src/utils/search/stores/vector-store.ts`
- Create: `src/utils/search/stores/sqlite-text-store.ts`
- Create: `src/utils/search/stores/sqlite-vector-store.ts`
- Create: `src/utils/search/stores/index.ts`
- Modify: `src/utils/search/index.ts`

**Step 1: Write failing tests**

Create `src/utils/search/stores/sqlite-text-store.test.ts`:
```typescript
import { describe, expect, it, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTextStore } from "./sqlite-text-store";

describe("SqliteTextStore", () => {
    let tmpDir: string;
    let db: Database;
    let store: SqliteTextStore;

    afterEach(() => {
        db?.close();
        if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("inserts and searches documents via BM25", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "text-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");
        store = new SqliteTextStore(db, {
            tableName: "docs",
            fields: ["title", "body"],
        });

        store.insert("1", { title: "Authentication", body: "Login with username and password" });
        store.insert("2", { title: "Database", body: "PostgreSQL connection pooling" });

        const results = store.search("authentication login", 10);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].docId).toBe("1");
        expect(results[0].score).toBeGreaterThan(0);
    });

    it("removes documents", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "text-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");
        store = new SqliteTextStore(db, {
            tableName: "docs",
            fields: ["title", "body"],
        });

        store.insert("1", { title: "Test", body: "Content" });
        store.remove("1");

        const results = store.search("test", 10);
        expect(results.length).toBe(0);
    });

    it("supports field boost weights", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "text-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");
        store = new SqliteTextStore(db, {
            tableName: "docs",
            fields: ["title", "body"],
        });

        store.insert("1", { title: "search", body: "unrelated content here" });
        store.insert("2", { title: "unrelated", body: "search appears in body only" });

        const results = store.search("search", 10, { title: 5.0, body: 1.0 });
        expect(results[0].docId).toBe("1"); // title boost wins
    });
});
```

Create `src/utils/search/stores/sqlite-vector-store.test.ts`:
```typescript
import { describe, expect, it, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVectorStore } from "./sqlite-vector-store";

describe("SqliteVectorStore", () => {
    let tmpDir: string;
    let db: Database;

    afterEach(() => {
        db?.close();
        if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("stores and searches vectors by cosine distance", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "vec-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");

        const store = new SqliteVectorStore(db, { tableName: "test", dimensions: 3 });

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));
        store.store("c", new Float32Array([0.9, 0.1, 0]));

        const results = store.search(new Float32Array([1, 0, 0]), 3);
        expect(results[0].docId).toBe("a"); // exact match
        expect(results[1].docId).toBe("c"); // close
        expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it("removes vectors", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "vec-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");

        const store = new SqliteVectorStore(db, { tableName: "test", dimensions: 3 });
        store.store("a", new Float32Array([1, 0, 0]));
        store.remove("a");

        const results = store.search(new Float32Array([1, 0, 0]), 10);
        expect(results.length).toBe(0);
    });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/utils/search/stores/ --timeout 30000
```
Expected: FAIL — modules don't exist yet.

**Step 3: Implement the interfaces and stores**

`src/utils/search/stores/text-store.ts`:
```typescript
export interface TextSearchHit {
    docId: string;
    score: number;
}

export interface TextStore {
    insert(id: string, fields: Record<string, string>): void;
    remove(id: string): void;
    search(query: string, limit: number, boost?: Record<string, number>): TextSearchHit[];
    count(): number;
}
```

`src/utils/search/stores/vector-store.ts`:
```typescript
export interface VectorSearchHit {
    docId: string;
    score: number; // cosine similarity (1 = identical, 0 = orthogonal)
}

export interface VectorStore {
    store(id: string, vector: Float32Array): void;
    remove(id: string): void;
    search(queryVector: Float32Array, limit: number): VectorSearchHit[];
    count(): number;
}
```

`src/utils/search/stores/sqlite-text-store.ts`:
Extract the BM25 search logic from `SearchEngine.bm25Search()` into this class. Uses FTS5 virtual table + content table + sync triggers (reuse `schema.ts`).

`src/utils/search/stores/sqlite-vector-store.ts`:
Extract from `vector.ts`. Brute-force cosine scan over `_embeddings` table. Return `score = 1 - distance` (similarity, not distance).

`src/utils/search/stores/index.ts`:
```typescript
export type { TextStore, TextSearchHit } from "./text-store";
export type { VectorStore, VectorSearchHit } from "./vector-store";
export { SqliteTextStore } from "./sqlite-text-store";
export { SqliteVectorStore } from "./sqlite-vector-store";
```

**Step 4: Run tests**

```bash
bun test src/utils/search/stores/ --timeout 30000
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/utils/search/stores/
git commit -m "feat(search): extract TextStore and VectorStore interfaces with SQLite implementations"
```

---

## Task 3: Refactor SearchEngine to compose TextStore + VectorStore

**Files:**
- Modify: `src/utils/search/drivers/sqlite-fts5/index.ts`
- Modify: `src/utils/search/drivers/sqlite-fts5/index.test.ts`

**Step 1: Refactor SearchEngine internals**

The public API stays identical. Internally, `SearchEngine` now delegates:
- `bm25Search()` → `this.textStore.search()`
- `cosineSearch()` → `this.vectorStore.search()`
- `rrfHybridSearch()` → both + RRF merge
- `insert()` → `this.textStore.insert()` + optional `this.vectorStore.store()`
- `remove()` → both stores

Constructor creates both stores from the same `Database` instance.

Key: `SearchEngine` accepts an optional `VectorStore` in its config. If not provided AND no embedder, vector/hybrid search throws the existing error. If a `VectorStore` is provided, it's used directly.

**Step 2: Run all existing tests**

```bash
bun test src/utils/search/ src/indexer/ src/e2e/search --timeout 60000
```
Expected: ALL PASS — refactoring should not change behavior.

**Step 3: Commit**

```bash
git commit -m "refactor(search): SearchEngine now composes TextStore + VectorStore internally"
```

---

## Task 4: Merkle tree storage — JSON blob → path_hashes table

**Files:**
- Create: `src/indexer/lib/path-hashes.ts`
- Create: `src/indexer/lib/path-hashes.test.ts`
- Modify: `src/indexer/lib/store.ts` — replace `merkle_tree` table with `path_hashes`
- Modify: `src/indexer/lib/merkle.ts` — add `buildFromPathHashes()`, `updatePathHashes()`

**Step 1: Write failing tests**

`src/indexer/lib/path-hashes.test.ts`:
```typescript
import { describe, expect, it, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathHashStore } from "./path-hashes";

describe("PathHashStore", () => {
    let tmpDir: string;
    let db: Database;

    afterEach(() => {
        db?.close();
        if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("stores and retrieves file hashes", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        store.upsert("src/main.ts", "abc123", true);
        store.upsert("src/", "def456", false);

        const hash = store.getHash("src/main.ts");
        expect(hash).toBe("abc123");
    });

    it("updates only changed paths on sync", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        // Initial state: 3 files
        store.upsert("a.ts", "h1", true);
        store.upsert("b.ts", "h2", true);
        store.upsert("c.ts", "h3", true);

        // Only a.ts changed
        store.upsert("a.ts", "h1-changed", true);

        expect(store.getHash("a.ts")).toBe("h1-changed");
        expect(store.getHash("b.ts")).toBe("h2"); // unchanged
        expect(store.getHash("c.ts")).toBe("h3"); // unchanged
    });

    it("removes deleted paths", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        store.upsert("a.ts", "h1", true);
        store.remove("a.ts");

        expect(store.getHash("a.ts")).toBeNull();
    });

    it("gets all file hashes for Merkle comparison", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        store.upsert("src/a.ts", "h1", true);
        store.upsert("src/b.ts", "h2", true);
        store.upsert("lib/c.ts", "h3", true);

        const all = store.getAllFiles();
        expect(all.size).toBe(3);
        expect(all.get("src/a.ts")).toBe("h1");
    });

    it("bulk sync updates/inserts/deletes efficiently", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        store.upsert("a.ts", "h1", true);
        store.upsert("b.ts", "h2", true);

        // Sync: a.ts changed, b.ts deleted, c.ts added
        store.bulkSync([
            { path: "a.ts", hash: "h1-new", isFile: true },
            { path: "c.ts", hash: "h3", isFile: true },
        ]);

        expect(store.getHash("a.ts")).toBe("h1-new");
        expect(store.getHash("b.ts")).toBeNull(); // deleted
        expect(store.getHash("c.ts")).toBe("h3"); // added
    });
});
```

**Step 2: Implement PathHashStore**

`src/indexer/lib/path-hashes.ts`:
```typescript
import type { Database } from "bun:sqlite";

export class PathHashStore {
    private db: Database;

    constructor(db: Database) {
        this.db = db;
        this.db.run(`CREATE TABLE IF NOT EXISTS path_hashes (
            path TEXT PRIMARY KEY,
            hash TEXT NOT NULL,
            is_file INTEGER NOT NULL DEFAULT 1
        )`);
    }

    upsert(path: string, hash: string, isFile: boolean): void {
        this.db.run(
            "INSERT OR REPLACE INTO path_hashes (path, hash, is_file) VALUES (?, ?, ?)",
            [path, hash, isFile ? 1 : 0]
        );
    }

    remove(path: string): void {
        this.db.run("DELETE FROM path_hashes WHERE path = ?", [path]);
    }

    getHash(path: string): string | null {
        const row = this.db.query("SELECT hash FROM path_hashes WHERE path = ?").get(path) as { hash: string } | null;
        return row?.hash ?? null;
    }

    getAllFiles(): Map<string, string> {
        const rows = this.db.query("SELECT path, hash FROM path_hashes WHERE is_file = 1").all() as Array<{ path: string; hash: string }>;
        const map = new Map<string, string>();
        for (const row of rows) {
            map.set(row.path, row.hash);
        }
        return map;
    }

    bulkSync(current: Array<{ path: string; hash: string; isFile: boolean }>): void {
        const currentPaths = new Set(current.map((c) => c.path));
        const tx = this.db.transaction(() => {
            // Delete paths no longer present
            const existing = this.db.query("SELECT path FROM path_hashes").all() as Array<{ path: string }>;
            for (const row of existing) {
                if (!currentPaths.has(row.path)) {
                    this.remove(row.path);
                }
            }
            // Upsert current
            for (const entry of current) {
                this.upsert(entry.path, entry.hash, entry.isFile);
            }
        });
        tx();
    }
}
```

**Step 3: Update store.ts to use PathHashStore instead of merkle_tree table**

Replace `saveMerkle()` / `loadMerkle()` with `getPathHashStore()` that returns the `PathHashStore` instance. The Indexer's `runSync()` uses `PathHashStore.getAllFiles()` to get previous state and `PathHashStore.bulkSync()` to update.

Remove the `merkle_tree` table creation from `createIndexStore()`.

**Step 4: Update Indexer.runSync() to use PathHashStore**

Instead of:
```typescript
const previousMerkle = await this.store.loadMerkle();
// ... later ...
await this.store.saveMerkle(merkleTree);
```

Use:
```typescript
const previousHashes = this.store.getPathHashStore().getAllFiles();
// ... build current hashes from chunks ...
// ... diff using buildMerkleTree + diffMerkleTrees (computed, not stored) ...
this.store.getPathHashStore().bulkSync(currentPathEntries);
```

The Merkle tree is COMPUTED for diffing but not stored as a blob. Only the leaf hashes (path → hash) are persisted.

**Step 5: Run all tests**

```bash
bun test src/indexer/ --timeout 60000
```
Expected: ALL PASS

**Step 6: Commit**

```bash
git commit -m "refactor(indexer): store Merkle hashes in path_hashes table instead of JSON blob"
```

---

## Task 5: IndexerSource abstraction

**Files:**
- Create: `src/indexer/lib/sources/source.ts`
- Create: `src/indexer/lib/sources/file-source.ts`
- Create: `src/indexer/lib/sources/file-source.test.ts`
- Create: `src/indexer/lib/sources/index.ts`
- Modify: `src/indexer/lib/indexer.ts` — extract `scanFiles()` into `FileSource`, accept `IndexerSource` in config

**Step 1: Define the IndexerSource interface**

`src/indexer/lib/sources/source.ts`:
```typescript
export interface SourceEntry {
    /** Unique identifier — file path for files, rowid for mail, message_id for chat */
    id: string;
    /** Text content to chunk and embed */
    content: string;
    /** Display path for search results */
    path: string;
    /** Optional metadata for filtering */
    metadata?: Record<string, unknown>;
}

export interface SourceChanges {
    added: SourceEntry[];
    modified: SourceEntry[];
    deleted: string[];
    unchanged: string[];
}

export interface ScanOptions {
    onProgress?: (current: number, total: number) => void;
    limit?: number;
}

export interface DetectChangesOptions {
    /** Previous hashes from PathHashStore, or null for first sync */
    previousHashes: Map<string, string> | null;
    /** Current entries from scan() */
    currentEntries: SourceEntry[];
    /** Whether to force full reindex (ignore previous state) */
    full?: boolean;
}

export interface IndexerSource {
    /** Scan for all indexable content */
    scan(opts?: ScanOptions): Promise<SourceEntry[]>;

    /** Determine what changed since last sync */
    detectChanges(opts: DetectChangesOptions): SourceChanges;

    /** Estimate total items for progress display (optional) */
    estimateTotal?(): Promise<number>;

    /** Compute a content hash for a source entry (for Merkle/change detection) */
    hashEntry(entry: SourceEntry): string;
}
```

**Step 2: Implement FileSource**

`src/indexer/lib/sources/file-source.ts`:

Extract `scanFiles()`, `walkDirectory()`, `checkIsGitRepo()`, `getGitTrackedFiles()` from `indexer.ts` into this class:

```typescript
export class FileSource implements IndexerSource {
    constructor(private opts: {
        baseDir: string;
        respectGitIgnore?: boolean;
        includedSuffixes?: string[];
        ignoredPaths?: string[];
    }) {}

    async scan(opts?: ScanOptions): Promise<SourceEntry[]> {
        // Existing scanFiles() logic moved here
        // Call opts.onProgress if provided
    }

    detectChanges(opts: DetectChangesOptions): SourceChanges {
        // Compare entry hashes against previousHashes
        // Uses SHA-256 of content (same as chunk id)
    }

    hashEntry(entry: SourceEntry): string {
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(entry.content);
        return hasher.digest("hex");
    }

    async estimateTotal(): Promise<number> {
        // Quick count without reading content
    }
}
```

**Step 3: Update Indexer to accept IndexerSource**

In `IndexConfig`, add:
```typescript
/** Custom data source (default: FileSource from baseDir) */
source?: IndexerSource;
```

In `Indexer.create()`:
```typescript
const source = config.source ?? new FileSource({
    baseDir: config.baseDir,
    respectGitIgnore: config.respectGitIgnore,
    includedSuffixes: config.includedSuffixes,
    ignoredPaths: config.ignoredPaths,
});
```

In `Indexer.runSync()`, replace `scanFiles()` call with `this.source.scan()`.

**Step 4: Write tests for FileSource**

Test that `FileSource.scan()` returns the same results as the old `scanFiles()` function. Test `detectChanges()` with added/modified/deleted scenarios.

**Step 5: Run all tests**

```bash
bun test src/indexer/ --timeout 60000
```

**Step 6: Commit**

```bash
git commit -m "refactor(indexer): extract FileSource from hardcoded scanFiles(), add IndexerSource interface"
```

---

## Task 6: Embedding model metadata in IndexMeta

**Files:**
- Modify: `src/indexer/lib/types.ts`
- Modify: `src/indexer/lib/store.ts`
- Modify: `src/indexer/lib/indexer.ts`
- Create: `src/indexer/lib/model-registry.ts`

**Step 1: Add model metadata to types**

In `IndexMeta.stats`, add:
```typescript
export interface EmbeddingModelInfo {
    model: string;        // "CodeRankEmbed", "Xenova/all-MiniLM-L6-v2"
    provider: string;     // "local-hf", "darwinkit", "cloud"
    dimensions: number;   // 768, 384, 512
}

export interface IndexMeta {
    // ... existing fields ...
    indexEmbedding?: EmbeddingModelInfo;   // model used for indexing
    searchEmbedding?: EmbeddingModelInfo;  // model used for queries (usually same)
}
```

**Step 2: Create model registry**

`src/indexer/lib/model-registry.ts`:
```typescript
export interface ModelInfo {
    id: string;
    name: string;
    params: string;
    dimensions: number;
    ramGB: number;
    speed: "fast" | "medium" | "slow";
    license: string;
    provider: "local-hf" | "cloud" | "darwinkit";
    bestFor: string[];     // ["code", "mail", "general"]
    description: string;
    installCmd?: string;
}

export const MODEL_REGISTRY: ModelInfo[] = [
    {
        id: "jinaai/jina-embeddings-v3",
        name: "Jina Embeddings v3",
        params: "572M",
        dimensions: 1024,
        ramGB: 2.5,
        speed: "fast",
        license: "Apache-2.0",
        provider: "local-hf",
        bestFor: ["code", "general", "mail"],
        description: "Strong all-rounder. Code + natural language. Matryoshka dimensions.",
    },
    {
        id: "jinaai/CodeRankEmbed",
        name: "CodeRankEmbed",
        params: "137M",
        dimensions: 768,
        ramGB: 1.5,
        speed: "fast",
        license: "MIT",
        provider: "local-hf",
        bestFor: ["code"],
        description: "Smallest self-hostable code model. Fast CPU/MPS inference.",
    },
    {
        id: "nomic-ai/nomic-embed-code-v1",
        name: "Nomic Embed Code",
        params: "137M",
        dimensions: 768,
        ramGB: 1.5,
        speed: "fast",
        license: "Apache-2.0",
        provider: "local-hf",
        bestFor: ["code"],
        description: "Used by Tabby. Good code search quality.",
    },
    {
        id: "nvidia/NV-EmbedCode-7b-v1",
        name: "NV-EmbedCode 7B",
        params: "7.1B",
        dimensions: 4096,
        ramGB: 15,
        speed: "slow",
        license: "Apache-2.0",
        provider: "local-hf",
        bestFor: ["code"],
        description: "Highest recall. Given a bug, find which files to edit. Needs GPU/M4 Pro Max.",
    },
    {
        id: "voyage-code-3",
        name: "VoyageCode3",
        params: "API",
        dimensions: 1024,
        ramGB: 0,
        speed: "medium",
        license: "Proprietary",
        provider: "cloud",
        bestFor: ["code"],
        description: "Highest quality code embeddings. Requires VOYAGE_API_KEY.",
    },
    {
        id: "text-embedding-3-small",
        name: "OpenAI Embed 3 Small",
        params: "API",
        dimensions: 1536,
        ramGB: 0,
        speed: "fast",
        license: "Proprietary",
        provider: "cloud",
        bestFor: ["general", "mail"],
        description: "General-purpose. Requires OPENAI_API_KEY.",
    },
    {
        id: "darwinkit",
        name: "DarwinKit NL",
        params: "built-in",
        dimensions: 512,
        ramGB: 0,
        speed: "fast",
        license: "macOS",
        provider: "darwinkit",
        bestFor: ["general", "mail"],
        description: "macOS on-device. General-purpose, not code-trained. Free.",
    },
    {
        id: "Xenova/all-MiniLM-L6-v2",
        name: "MiniLM L6 v2",
        params: "22M",
        dimensions: 384,
        ramGB: 0.1,
        speed: "fast",
        license: "Apache-2.0",
        provider: "local-hf",
        bestFor: ["general"],
        description: "Tiny general-purpose model. NOT trained on code.",
    },
];

export function getModelsForType(type: "code" | "files" | "mail" | "chat"): ModelInfo[] {
    const category = type === "code" ? "code" : type === "mail" ? "mail" : "general";
    // Sort: models best for this type first, then others
    return [...MODEL_REGISTRY].sort((a, b) => {
        const aMatch = a.bestFor.includes(category) ? 0 : 1;
        const bMatch = b.bestFor.includes(category) ? 0 : 1;
        return aMatch - bMatch;
    });
}

export function formatModelTable(models: ModelInfo[]): string {
    // Format as table for CLI display
    // Columns: Name, Params, Dims, RAM, Speed, License, Best For
}
```

**Step 3: Validate model at search time**

In `Indexer.search()`, before searching, check:
```typescript
const meta = this.store.getMeta();
if (meta.indexEmbedding && this.embedder) {
    if (meta.indexEmbedding.dimensions !== this.embedder.dimensions) {
        throw new Error(
            `Index "${this.name}" was built with ${meta.indexEmbedding.model} (${meta.indexEmbedding.dimensions}-dim).\n` +
            `Current model has ${this.embedder.dimensions} dimensions — incompatible.\n` +
            `Run: tools indexer rebuild ${this.name} --model ${meta.indexEmbedding.model}`
        );
    }
}
```

**Step 4: Store model info during sync**

In `Indexer.runSync()`, after embedding:
```typescript
this.store.updateMeta({
    indexEmbedding: {
        model: this.config.embedding?.model ?? "unknown",
        provider: this.config.embedding?.provider ?? "unknown",
        dimensions: this.embedder?.dimensions ?? 0,
    },
});
```

**Step 5: No default model — error with guidance**

In `Indexer.create()`, when `embeddingEnabled` and no model specified:
```typescript
if (embeddingEnabled && !config.embedding?.model) {
    const models = getModelsForType(config.type ?? "files");
    throw new EmbeddingSetupError(
        "No embedding model specified",
        undefined,
        models  // pass models for display in error message
    );
}
```

Update `EmbeddingSetupError` to accept and display the model registry filtered by type.

**Step 6: Run tests, commit**

```bash
bun test src/indexer/ --timeout 60000
git commit -m "feat(indexer): add model registry with per-type recommendations, store model metadata in IndexMeta"
```

---

## Task 7: `tools indexer models` CLI command

**Files:**
- Create: `src/indexer/commands/models.ts`
- Modify: `src/indexer/index.ts`

**Step 1: Implement models command**

```
tools indexer models                    # list all models with recommendations
tools indexer models --type code        # filter for code models
tools indexer models download <id>      # pre-download a model
```

Uses `MODEL_REGISTRY` from Task 6. The `download` subcommand triggers HuggingFace pipeline download via `AILocalProvider.getPipeline("feature-extraction", modelId)`.

Show download status with `@clack/prompts` spinner. Show which models are already downloaded by checking if the model cache exists (HuggingFace stores in `~/.cache/huggingface/hub/`).

**Step 2: Register in index.ts, commit**

```bash
git commit -m "feat(indexer): add 'tools indexer models' command with download support"
```

---

## Task 8: `tools indexer add` interactive flow

**Files:**
- Modify: `src/indexer/commands/add.ts`

**Step 1: Rewrite add command**

Syntax: `tools indexer add [name] [options]`

If no `name` given AND TTY: interactive flow via `@clack/prompts`:
1. `p.text({ message: "Index name" })` — suggest basename of cwd
2. `p.text({ message: "Path to index" })` — default to cwd
3. `p.select({ message: "Index type" })` — code/files/mail/chat, auto-detected default
4. `p.select({ message: "Embedding model" })` — show top 3 for the type, explain each
5. Summary + confirm

If `name` given with flags: non-interactive, validate all required flags.

Non-TTY without `--model`: error with `suggestCommand()` showing the full command.

Remove `--provider` flag. The model ID determines the provider automatically via `MODEL_REGISTRY`.

**Step 2: Run E2E tests, commit**

```bash
bun test src/e2e/indexer.e2e.test.ts --timeout 120000
git commit -m "feat(indexer): interactive add flow with model selection"
```

---

## Task 9: Prepare LanceDB VectorStore (optional dependency)

**Files:**
- Create: `src/utils/search/stores/lancedb-vector-store.ts`
- Create: `src/utils/search/stores/lancedb-vector-store.test.ts`

**Step 1: Install LanceDB**

```bash
bun add @lancedb/lancedb
```

**Step 2: Implement LanceDBVectorStore**

```typescript
import type { VectorStore, VectorSearchHit } from "./vector-store";

export class LanceDBVectorStore implements VectorStore {
    private db: LanceDBConnection;
    private table: LanceDBTable;

    constructor(opts: { path: string; tableName: string; dimensions: number }) {
        // Opens/creates LanceDB database at path
        // Creates table with schema: { id: string, vector: Float32Array }
    }

    store(id: string, vector: Float32Array): void { ... }
    remove(id: string): void { ... }
    search(queryVector: Float32Array, limit: number): VectorSearchHit[] { ... }
    count(): number { ... }
}
```

LanceDB uses IVF-PQ indexing for approximate nearest neighbor — much faster than brute-force for >10K vectors.

**Step 3: Add to SearchEngine config**

In `SearchEngineConfig`, add:
```typescript
vectorStore?: VectorStore;  // override default SQLite brute-force
```

When provided, `SearchEngine` uses it instead of creating `SqliteVectorStore` internally.

**Step 4: Add to IndexConfig**

```typescript
storage?: {
    driver?: "sqlite" | "lancedb";
    path?: string;
}
```

When `driver: "lancedb"`, `createIndexStore()` creates a `LanceDBVectorStore` and passes it to `SearchEngine`.

**Step 5: Tests, commit**

```bash
bun test src/utils/search/stores/lancedb --timeout 30000
git commit -m "feat(search): add LanceDB VectorStore for scalable ANN search"
```

---

## Verification

```bash
# Type check all changed files
tsgo --noEmit | grep "src/utils/search\|src/indexer"

# All search tests
bun test src/utils/search/ --timeout 30000

# All indexer tests
bun test src/indexer/ --timeout 60000

# E2E tests
bun test src/e2e/indexer.e2e.test.ts --timeout 120000
bun test src/e2e/search --timeout 60000

# Telegram still works
bun test src/telegram/ --timeout 30000
```

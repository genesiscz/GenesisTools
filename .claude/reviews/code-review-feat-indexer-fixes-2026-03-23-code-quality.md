# Code Review Report -- Code Quality

**Date:** 2026-03-23 01:37:32
**Branch:** feat/indexer-fixes
**Focus:** Redundant state, parameter sprawl, copy-paste, leaky abstractions, stringly-typed code, dead code
**Reviewed Files:** 24 .ts files

## Summary

This diff is a solid deduplication and cleanup pass. Key themes: extracting `xxhash()` and `estimateTokens()` into shared utils, consolidating AST language maps into `ast-languages.ts`, replacing copy-pasted async queue / batched-SQL logic with reusable abstractions, and improving search with auto-detect mode, score filtering, and batch lookups. Overall quality is good. Findings below are structural: redundant state that could be derived, near-duplicate code blocks, and one stale-cache risk.

---

## Findings

### 1. `EXT_TO_DYNAMIC_LANG` is a strict subset of `EXT_TO_LANGUAGE_NAME` -- redundant state

**File:** `src/indexer/lib/ast-languages.ts:61-82`
**Severity:** MED

`EXT_TO_DYNAMIC_LANG` contains exactly the entries from `EXT_TO_LANGUAGE_NAME` whose keys are NOT in `EXT_TO_LANG` (i.e., languages not built into ast-grep). The two maps are maintained in parallel by hand. Adding a new dynamic language requires updating both, and there is no compile-time or runtime check that they stay in sync.

```typescript
60: /** Extension -> dynamic language string identifier */
61: export const EXT_TO_DYNAMIC_LANG: Record<string, string> = {
62:     ".py": "python",
63:     ".pyw": "python",
64:     ".pyi": "python",
65:     ".go": "go",
66:     ".rs": "rust",
```

**Fix:** Derive it:

```typescript
export const EXT_TO_DYNAMIC_LANG: Record<string, string> = Object.fromEntries(
    Object.entries(EXT_TO_LANGUAGE_NAME).filter(([ext]) => !(ext in EXT_TO_LANG))
);
```

---

### 2. `LANGUAGE_EXTENSIONS` is the manually-written inverse of `EXT_TO_LANGUAGE_NAME` -- already inconsistent

**File:** `src/indexer/lib/ast-languages.ts:85-100`
**Severity:** MED

The comment says "inverse of EXT_TO_LANGUAGE_NAME", but it is hand-maintained and already diverges:

- `EXT_TO_LANGUAGE_NAME` maps `.mts`/`.cts` to `"typescript"`, but `LANGUAGE_EXTENSIONS.typescript` does not include `.mts` or `.cts`.
- `EXT_TO_LANGUAGE_NAME` maps `.pyw`/`.pyi` to `"python"`, but `LANGUAGE_EXTENSIONS.python` only lists `[".py"]`.

```typescript
84: /** Language name -> known extensions (inverse of EXT_TO_LANGUAGE_NAME) */
85: export const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
86:     typescript: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
87:     // missing: ".mts", ".cts"
88:     python: [".py"],
89:     // missing: ".pyw", ".pyi"
```

**Fix:** Derive it programmatically so it cannot drift:

```typescript
export const LANGUAGE_EXTENSIONS: Record<string, string[]> = (() => {
    const result: Record<string, string[]> = {};
    for (const [ext, lang] of Object.entries(EXT_TO_LANGUAGE_NAME)) {
        (result[lang] ??= []).push(ext);
    }
    return result;
})();
```

If `code-graph.ts` needs `tsx` to alias `typescript` extensions, add that as a separate one-liner.

---

### 3. Mode auto-detection logic duplicated between CLI search and MCP search

**File:** `src/indexer/commands/search.ts:38-41` and `src/indexer/mcp/tools/search.ts:48-57`
**Severity:** MED

The CLI introduced a `detectMode(indexer)` helper. The MCP tool handler inlines the same logic instead of calling it. If the heuristic changes (e.g., minimum embedding threshold), only one location gets updated.

CLI version:
```typescript
38: function detectMode(indexer: Indexer): SearchMode {
39:     const info = indexer.getConsistencyInfo();
40:     return info.embeddingCount > 0 ? "hybrid" : "fulltext";
41: }
```

MCP version (inlined):
```typescript
54:                 const first = await manager.getIndex(names[0]);
55:                 const info = first.getConsistencyInfo();
56:                 mode = info.embeddingCount > 0 ? "hybrid" : "fulltext";
```

**Fix:** Move `detectMode` to a shared location (e.g., export from `indexer.ts` or a small `search-utils.ts`) and import it in both consumers.

---

### 4. `searchIndexes` returns `effectiveMode` that always equals its `mode` input -- redundant return field

**File:** `src/indexer/commands/search.ts:65,81`
**Severity:** MED

`searchIndexes()` returns `{ results, effectiveMode }` where `effectiveMode` is unconditionally set to the `mode` parameter on line 81. The function never changes mode internally. The actual mutation happens in the caller (line 150), which overwrites `effectiveMode` after a fallback search. The return type misleads -- it suggests the function might select a different mode, but it never does.

```typescript
65: ): Promise<{ results: ...; effectiveMode: SearchMode }> {
...
81:     return { results: allResults, effectiveMode: mode };
```

**Fix:** Return only the results array. Track `effectiveMode` as a local `let` in the caller, initialized to `mode`:

```typescript
let effectiveMode = mode;
const allResults = await searchIndexes(manager, names, query, mode, fetchLimit);
```

---

### 5. Provider hint formatting duplicated with slight variation in `add.ts`

**File:** `src/indexer/commands/add.ts:155` and `src/indexer/commands/add.ts:266`
**Severity:** MED

Two call sites build model-selection labels with the same ternary chain, but with inconsistent formatting -- the interactive flow uses `" (GPU)"` with parens, the CLI flow uses `" GPU"` without parens. This looks accidental and any new provider tag must be updated in both.

Interactive flow (line 155):
```typescript
hint: `${m.dimensions}-dim, ${m.provider}${m.provider === "ollama" ? " (GPU)" : m.provider === "coreml" ? " (GPU/ANE)" : ""} — ${m.description}`,
```

CLI flow (line 266):
```typescript
label: `${m.name} (${m.dimensions}-dim, ${m.provider}${m.provider === "ollama" ? " GPU" : m.provider === "coreml" ? " GPU/ANE" : ""})`,
```

**Fix:** Extract a helper:

```typescript
function providerTag(provider: string): string {
    if (provider === "ollama") return " (GPU)";
    if (provider === "coreml") return " (GPU/ANE)";
    return "";
}
```

---

### 6. Magic number 500 in `removeMany` not using shared `SQL_BATCH_SIZE`

**File:** `src/utils/search/stores/sqlite-vec-store.ts:52-56`
**Severity:** MED

`SqliteVecVectorStore.removeMany()` hard-codes `500` while `store.ts` defines `const SQL_BATCH_SIZE = 500` and the `runBatchedQuery` utility. This duplicates both the constant and the batching pattern.

```typescript
52:         for (let i = 0; i < ids.length; i += 500) {
53:             const batch = ids.slice(i, i + 500);
54:             const placeholders = batch.map(() => "?").join(",");
55:             this.db.run(`DELETE FROM ${this.vecTable} WHERE doc_id IN (${placeholders})`, batch);
```

**Fix:** Extract `SQL_BATCH_SIZE` to a shared constant (e.g., `src/utils/search/constants.ts`) and import it. Optionally also reuse `runBatchedQuery` if exported.

---

### 7. `cachedMeta` not invalidated on data-mutating operations -- stale stats risk

**File:** `src/indexer/lib/store.ts:300,568`
**Severity:** MED

`cachedMeta` is set on `getMeta()` and `updateMeta()`, but never cleared when `insertChunks`, `removeChunks`, or `clearEmbeddings` change the underlying data. Since `IndexMeta.stats` reflects DB state, the sequence `getMeta()` -> `insertChunks(100)` -> `getStats()` (which reads `cachedMeta` at line 568) returns stale `totalFiles`/`totalEmbeddings`.

```typescript
299: // Cached parsed meta
300: let cachedMeta: IndexMeta | null = null;
...
568: const meta = cachedMeta ?? readMeta(db, config, createdAt);
```

**Fix:** Set `cachedMeta = null` inside `insertChunks`, `removeChunks`, and `clearEmbeddings`. Any operation that changes what `readMeta` would return should invalidate the cache.

---

### 8. `searchEmbedding` field on `IndexMeta` is dead code

**File:** `src/indexer/lib/types.ts:92`
**Severity:** LOW

The field is annotated `@todo Not yet populated -- reserved for separate search-time embedding model`. No code writes to or reads from it. It adds noise to the type and to the serialized JSON in the database.

```typescript
92:     /** @todo Not yet populated -- reserved for separate search-time embedding model */
93:     searchEmbedding?: EmbeddingModelInfo;
```

**Fix:** If this is a future feature, track it in an issue rather than a dead field in the schema. Remove it until it is actually needed.

---

### 9. `runBatchedQuery` used for DELETEs with awkward `return []`

**File:** `src/indexer/lib/store.ts:397-402`
**Severity:** LOW

`runBatchedQuery` is generic over `TResult[]`, but when used for DELETE operations the `queryFn` must return `[]` to satisfy the signature. The function was designed for SELECTs. This is a minor ergonomics issue, not a bug.

```typescript
397:                     runBatchedQuery({
398:                         ids: chunkIds,
399:                         queryFn: (placeholders, batch) => {
400:                             db.run(`DELETE FROM ...`);
401:                             return [];
402:                         },
403:                     });
```

**Fix (optional):** Add a `runBatchedExec` variant for void operations, or accept `return []` as an acceptable pattern for a small internal utility.

---

## Positive Observations

- Excellent deduplication: `AsyncOpQueue` extraction removes identical queue implementations from LanceDB and Qdrant stores.
- `bruteForceVectorSearch` extraction eliminates the same search loop from two vector store classes.
- `xxhash()` wrapper gives a single callsite for `Bun.hash(x).toString(16)` -- good for consistency and swappability.
- `runBatchedQuery` replaces 5 copy-pasted batch loops in `store.ts`.
- Batch lookup in `vectorSearch` (single `IN(...)` query instead of N+1 per-hit SELECTs) is a meaningful perf win.
- `docCount++`/`docCount--` replacing `queryCount()` on insert/remove eliminates unnecessary `SELECT COUNT(*)`.
- `getFilteredFilePaths()` in `FileSource` cleanly eliminates the scan/estimateTotal code duplication.
- `ModelInfo` -> `TranscriptionModelInfo` rename avoids naming collision with the indexer's own `ModelInfo`.
- The `removeMany` optional method on `VectorStore` is a clean interface extension -- callers check for its existence before using it.

## Statistics
- Files reviewed: 24 (TypeScript only)
- HIGH issues: 0
- MED issues: 7
- LOW issues: 2

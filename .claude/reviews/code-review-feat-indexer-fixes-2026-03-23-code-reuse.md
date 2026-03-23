# Code Reuse Review Report

**Date:** 2026-03-23
**Branch:** feat/indexer-fixes
**Scope:** Code reuse / DRY analysis of the diff

## Summary

The diff is overall **very good on code reuse**. The primary purpose of many changes is exactly to deduplicate: extracting `xxhash()` into `src/utils/hash.ts`, extracting `estimateTokens()` from `ChatEngine` into `src/utils/tokens.ts`, centralizing AST language mappings into `ast-languages.ts`, extracting `AsyncOpQueue` into `src/utils/async.ts`, and extracting `bruteForceVectorSearch` into `vector-store.ts`. These are all clean consolidations.

Two findings remain where the consolidation was not carried through to the end.

## Important Issues

### Issue 1: Duplicated "auto-detect search mode" logic between CLI and MCP

**File:** `src/indexer/commands/search.ts:38-40` and `src/indexer/mcp/tools/search.ts:50-57`
**Severity:** MED

**Problem:**
The CLI defines `detectMode(indexer)` as a reusable function, but the MCP handler inlines the exact same logic instead of calling it. Both resolve to `info.embeddingCount > 0 ? "hybrid" : "fulltext"`. If the detection heuristic changes (e.g., requiring a minimum embedding count, or checking model compatibility), two call sites must be updated independently.

**Code in CLI (search.ts):**
```typescript
38: function detectMode(indexer: Indexer): SearchMode {
39:     const info = indexer.getConsistencyInfo();
40:     return info.embeddingCount > 0 ? "hybrid" : "fulltext";
41: }
```

**Code in MCP (mcp/tools/search.ts):**
```typescript
54:                 const first = await manager.getIndex(names[0]);
55:                 const info = first.getConsistencyInfo();
56:                 mode = info.embeddingCount > 0 ? "hybrid" : "fulltext";
```

**Recommendation:**
Move `detectMode` to a shared location (e.g., `src/indexer/lib/indexer.ts` as a method on `Indexer`, or a standalone helper in `src/indexer/lib/`) and import it from both the CLI and MCP search handlers. Since `SearchMode` is already defined in `src/utils/search/types.ts` as a union literal, the helper could live alongside it.

### Issue 2: `removeMany` in `sqlite-vec-store.ts` hand-rolls the same batching as `runBatchedQuery` in `store.ts`

**File:** `src/utils/search/stores/sqlite-vec-store.ts:47-57` and `src/indexer/lib/store.ts:83-97`
**Severity:** MED

**Problem:**
`SqliteVecVectorStore.removeMany()` uses an inline `for` loop with hardcoded batch size `500`, building `IN(?,?,...)` placeholders manually. This is the exact same pattern that `runBatchedQuery` in `store.ts` was created to replace. The batch size constant `SQL_BATCH_SIZE` is also defined only in `store.ts` rather than being shared.

**Code in sqlite-vec-store.ts:**
```typescript
47:     removeMany(ids: string[]): void {
48:         if (ids.length === 0) {
49:             return;
50:         }
51:
52:         for (let i = 0; i < ids.length; i += 500) {
53:             const batch = ids.slice(i, i + 500);
54:             const placeholders = batch.map(() => "?").join(",");
55:             this.db.run(`DELETE FROM ${this.vecTable} WHERE doc_id IN (${placeholders})`, batch);
56:         }
57:     }
```

**Recommendation:**
Either (a) move `runBatchedQuery` + `SQL_BATCH_SIZE` from `src/indexer/lib/store.ts` to a shared location like `src/utils/search/` so `sqlite-vec-store.ts` can import it, or (b) at minimum extract the `500` into the same `SQL_BATCH_SIZE` constant. Option (a) is cleaner since the pattern is likely to appear in any new store implementation.

## Minor Issues

### Issue 3: Provider hint suffix string duplicated in two `p.select` calls within `add.ts`

**File:** `src/indexer/commands/add.ts:155` and `src/indexer/commands/add.ts:266`
**Severity:** LOW

**Problem:**
The ternary chain `m.provider === "ollama" ? " (GPU)" : m.provider === "coreml" ? " (GPU/ANE)" : ""` appears in both the interactive flow and the CLI argument flow. The two instances are slightly different in formatting (one uses parenthesized "(GPU)", the other bare "GPU"), which looks like an inconsistency rather than intentional variation.

**Code at line 155:**
```typescript
hint: `${m.dimensions}-dim, ${m.provider}${m.provider === "ollama" ? " (GPU)" : m.provider === "coreml" ? " (GPU/ANE)" : ""} — ${m.description}`,
```

**Code at line 266:**
```typescript
label: `${m.name} (${m.dimensions}-dim, ${m.provider}${m.provider === "ollama" ? " GPU" : m.provider === "coreml" ? " GPU/ANE" : ""})`,
```

**Recommendation:**
Extract a small helper like `providerSuffix(provider: string): string` and use it in both places. This also ensures the formatting stays consistent.

## Positive Observations

- **`src/utils/hash.ts`**: Excellent extraction. All `Bun.hash(x).toString(16)` call sites across the codebase now go through a single `xxhash()` function. If the hash function ever changes, there is exactly one place to update.
- **`src/utils/tokens.ts` reuse**: `ChatEngine.estimateTokens` was correctly replaced with the existing shared utility. The chunker's inline `estimateTokens` was also removed in favor of the shared import.
- **`src/indexer/lib/ast-languages.ts`**: The language mapping tables and `ensureDynamicLanguages()` were deduplicated from three files (`chunker.ts`, `code-graph.ts`, `graph-imports.ts`) into a single shared module. Clean consolidation.
- **`AsyncOpQueue` extraction**: The identical queue/drain/flush pattern from both `LanceDBVectorStore` and `QdrantVectorStore` was extracted into `src/utils/async.ts`. Exactly the right abstraction level.
- **`bruteForceVectorSearch` extraction**: The identical in-memory cosine search from `LanceDBVectorStore` and `QdrantVectorStore` was extracted into `vector-store.ts`. Good reuse.
- **`runBatchedQuery` in `store.ts`**: The repeated `for-i+=500` / `placeholders` / `IN(?)` pattern was consolidated into a generic helper within the store. Applied to 5 call sites.
- **`truncatePreview` now delegates to `truncateText`**: The search command's preview truncation now uses the shared `@app/utils/string` utility instead of its own inline implementation.
- **`detectChanges` now delegates to `detectChangesPreHashed`**: Avoided maintaining two parallel implementations of the same diffing logic.

## Statistics

- Files reviewed: 25 (TS files only from diff)
- Critical issues: 0
- Important issues: 2 (MED)
- Minor issues: 1 (LOW)

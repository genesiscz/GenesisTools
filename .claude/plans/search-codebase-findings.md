# Search Patterns in GenesisTools -- Codebase Analysis & External Solutions

> Explored on 2026-03-19 | Scope: all `src/` tools, `src/utils/`, darwinkit, macOS search capabilities, external TypeScript search libraries

## Summary

GenesisTools has **six distinct search systems** spread across tools, each built ad-hoc with no shared search infrastructure. The most sophisticated is the Telegram tool's FTS5 + vector hybrid search with Reciprocal Rank Fusion. The mail tool combines SQLite LIKE queries + JXA body search + DarwinKit semantic re-ranking. There is no shared indexing, caching, or search optimization layer. The `@genesiscz/darwinkit` package provides Apple NaturalLanguage embeddings (512-dim) usable as a local, free vector source. Three external libraries (Orama, MiniSearch, FlexSearch) could unify search, with Orama being the strongest candidate for hybrid full-text + vector search.

---

## Part 1: Current Search Implementations

### 1.1 Fuzzy Matching Utilities (`src/utils/`)

Two files provide complementary low-level matching:

| File | Functions | Use Case |
|------|-----------|----------|
| `src/utils/string.ts:73-127` | `matchGlob()`, `fuzzyMatch()`, `fuzzyFind()` | Character-by-character subsequence matching, glob patterns |
| `src/utils/fuzzy-match.ts:1-177` | `levenshteinDistance()`, `similarityScore()`, `wordSimilarity()`, `fuzzyMatchBest()` | Time-range fuzzy matching for Timely/Clarity correlation |

**`string.ts` fuzzy algorithm** (line 83-110): Exact match (score 0) > prefix (1) > substring (2) > subsequence (3+gaps). Returns -1 for no match.

**`fuzzy-match.ts` algorithm** (line 152-176): Weighted score = `timeOverlap * 0.7 + wordSimilarity * 0.3`. Uses Jaccard index on tokenized words.

Neither is reusable for general-purpose search -- they are purpose-built for specific tools.

### 1.2 Interactive Search Prompts (`src/utils/prompts/clack/`)

Two custom TUI components for filtering lists:

| File | Component | Filter Method |
|------|-----------|---------------|
| `search-select.ts` | Single-select with search | `label.toLowerCase().includes(query)` |
| `search-multiselect.ts` | Multi-select with search | Same `includes()` filter |

Both use simple case-insensitive substring matching on `item.label` and `String(item.value)`. No fuzzy matching, no ranking.

### 1.3 Apple Mail Search (3-phase pipeline)

**Location**: `src/macos/commands/mail/search.ts`, `src/macos/lib/mail/sqlite.ts`, `src/macos/lib/mail/jxa.ts`

The most complex search pipeline in the codebase:

```
Phase 1: SQLite Envelope Index     Phase 2: JXA Body Search     Phase 3: DarwinKit Semantic Ranking
     (LIKE on metadata)              (osascript Mail.app)           (cosine distance re-rank)
           |                              |                              |
     subject, sender,               content().indexOf()           rankBySimilarity(query, items)
     attachment name                 batches of 50                 maxDistance: 1.2
           |                              |                              |
           v                              v                              v
     MailMessageRow[]               Set<rowid>                    reordered MailMessage[]
```

**Phase 1** (`sqlite.ts:82-149`): SQL LIKE with `%query%` pattern on subjects, addresses, and attachment names. Supports filters: date range, mailbox, receiver. Max 200 results.

**Phase 2** (`jxa.ts:51-116`): Runs JXA scripts via `osascript` to search Mail.app body content. Iterates accounts/mailboxes matching by subject. Slow (60s timeout per batch of 50).

**Phase 3** (`search.ts:127-165`): Uses `@genesiscz/darwinkit` NLP to compute cosine distance between query and `[subject, senderName, senderAddress]`. Filters by maxDistance (default 1.2). Optional via `--no-semantic`.

**Key limitation**: No full-text index on email bodies. The Envelope Index SQLite database (`~/Library/Mail/V*/MailData/Envelope Index`) has no FTS tables. Body search requires JXA round-trips.

### 1.4 Telegram History Search (FTS5 + Vector Hybrid)

**Location**: `src/telegram/lib/TelegramHistoryStore.ts`

The most advanced search in the codebase:

**FTS5 keyword search** (line 299-357):
```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
    text, content=messages, content_rowid=rowid, tokenize='unicode61'
);
-- Triggers auto-sync FTS on INSERT/UPDATE/DELETE
```

**Vector search** (line 359-418): Stores 512-dim embeddings as BLOBs in `embeddings` table. Brute-force cosine similarity scan in TypeScript using `cosineDistance()` from `src/utils/math.ts`. No ANN index.

**Hybrid search** (line 421-462): Reciprocal Rank Fusion (RRF) with k=60:
```
RRF_score = sum(1.0 / (60 + rank_in_fts + 1), 1.0 / (60 + rank_in_vector + 1))
```
Gets top 100 from each, merges by document ID, sorts by combined score.

**Embedding source**: `@genesiscz/darwinkit` via `embedText()` -- 512-dim Apple NaturalLanguage embeddings. Supports only: en, es, fr, de, it, pt, zh-Hans.

### 1.5 Azure DevOps Search

**Location**: `src/azure-devops/lib/work-item-search.ts`, `src/azure-devops/commands/history-search.ts`

Two modes:
- **WIQL server-side** (line 45-47): `[System.Title] CONTAINS 'query'` via Azure DevOps REST API
- **Local cache scan** (`history-search.ts`): Iterates cached JSON files, filters by assignee/state/date/time

No local full-text index. Relies on server-side WIQL or brute-force file scanning.

### 1.6 Claude History Search

**Location**: `src/claude/lib/history/search.ts`, `src/claude/lib/history/cache.ts`

- SQLite cache (`index.db`) stores session metadata (title, project, date, model, tokens)
- `searchConversations()` can use cached metadata for "summaryOnly" searches
- Full content search requires parsing JSONL files -- no FTS index
- File discovery via glob patterns on `~/.claude/projects/*/sessions/`

### 1.7 Voice Memos Search

**Location**: `src/utils/macos/voice-memos.ts:438-458`

Simple `toLowerCase().includes()` on memo title + transcript text. Loads all memos, iterates, extracts transcript on-demand. No index.

### 1.8 MCP Ripgrep Server

**Location**: `src/mcp-ripgrep/index.ts`

Wraps `rg` binary as an MCP tool. Tools: `search`, `advanced-search`, `count-matches`, `list-files`, `list-file-types`. Not a search index -- just a subprocess wrapper.

---

## Part 2: DarwinKit NLP Capabilities (Already Available)

`@genesiscz/darwinkit` provides significant search-relevant capabilities via Apple's NaturalLanguage framework:

| Capability | Function | Details |
|------------|----------|---------|
| Embeddings | `embedText(text, lang, type)` | 512-dim vectors, word or sentence level |
| Distance | `textDistance(text1, text2)` | Cosine distance 0-2 |
| Ranking | `rankBySimilarity(query, items)` | Batch semantic ranking |
| Keywords | `getKeywords(text, max)` | Noun/verb/adjective extraction with lemmas |
| NER | `extractEntities(text)` | Person, organization, place |
| Lemmatization | `lemmatize(text)` | Root form of each word |
| Clustering | `clusterBySimilarity(items)` | Greedy single-linkage O(n^2) |
| Dedup | `deduplicateTexts(items)` | Semantic deduplication O(n^2) |
| Language detection | `detectLanguage(text)` | BCP-47 code + confidence |
| Relevance scoring | `scoreRelevance(query, text)` | 0-1 similarity score |

**Key advantage**: Zero-cost, on-device, no API keys. 512-dim embeddings are compact.

**Limitation**: Only 7 languages supported (en, es, fr, de, it, pt, zh-Hans). Brute-force O(n^2) for ranking/clustering -- fine for <200 items.

---

## Part 3: External TypeScript Search Libraries

### 3.1 Orama (`@orama/orama`)

**Best fit for GenesisTools.** Full-text + vector + hybrid in one package.

| Attribute | Value |
|-----------|-------|
| Size | ~2KB min+gzip (core), ~45KB full |
| License | Apache 2.0 |
| Dependencies | Zero |
| Runtime | Node.js, Bun, Deno, Browser |
| Persistence | `@orama/plugin-data-persistence` (JSON or binary format) |

**Schema definition**:
```typescript
import { create, insert, search } from "@orama/orama";

const db = create({
  schema: {
    subject: "string",
    sender: "string",
    body: "string",
    dateSent: "number",
    embedding: "vector[512]",  // DarwinKit 512-dim
    tags: "string[]",
  },
});
```

**Full-text search**:
```typescript
const results = search(db, { term: "budget review" });
```

**Vector search**:
```typescript
search(db, {
  mode: "vector",
  vector: { value: embedding, property: "embedding" },
  similarity: 0.85,
});
```

**Hybrid search** (weighted linear combination):
```typescript
search(db, {
  term: "budget review",
  mode: "hybrid",
  vector: { value: embedding, property: "embedding" },
  hybridWeights: { text: 0.6, vector: 0.4 },
});
```

**Persistence**:
```typescript
import { persist, restore } from "@orama/plugin-data-persistence";
const snapshot = await persist(db, "json");
// Save to file: await Bun.write("index.json", snapshot);
const restored = await restore("json", snapshot);
```

**Pros**: Native hybrid search, schema-based, typed, BM25 ranking, faceting, typo tolerance, 30-language stemming.
**Cons**: Larger than MiniSearch; persistence plugin is separate package; no built-in ANN for vector search (linear scan like Telegram).

### 3.2 MiniSearch (`minisearch`)

Lightest option. Full-text only (no vector search).

| Attribute | Value |
|-----------|-------|
| Size | <5KB min+gzip |
| License | MIT |
| Dependencies | Zero |
| Runtime | Any JS runtime |
| Persistence | `JSON.stringify(miniSearch)` / `MiniSearch.loadJSON()` |

```typescript
import MiniSearch from "minisearch";

const ms = new MiniSearch({
  fields: ["subject", "sender", "body"],
  storeFields: ["subject", "sender"],
});

ms.addAll(documents);
const results = ms.search("budget", { fuzzy: 0.2, prefix: true });
```

**Serialization**:
```typescript
const json = JSON.stringify(ms);
const restored = MiniSearch.loadJSON(json, { fields: ["subject", "sender", "body"] });
```

**Pros**: Tiny, fast, fuzzy search, prefix matching, field boosting, auto-suggestions, serializable.
**Cons**: No vector/hybrid search. Would need custom code to combine with DarwinKit embeddings (like the Telegram tool's RRF approach).

### 3.3 FlexSearch (`flexsearch`)

Fastest raw full-text search. No vector support.

| Attribute | Value |
|-----------|-------|
| Size | 4.5KB (light) to 16.3KB (full bundle) |
| License | Apache 2.0 |
| Dependencies | Zero |
| Runtime | Node.js, Browser, Bun |
| Persistence | IndexedDB, Redis, SQLite, PostgreSQL, MongoDB, ClickHouse |

```typescript
import { Document } from "flexsearch";

const doc = new Document({
  document: { id: "id", index: ["subject", "body"] },
});

doc.add({ id: 1, subject: "Budget Review", body: "Q4 financial..." });
const results = doc.search("budget");
```

**Pros**: Claimed 1M+ ops/sec, phonetic transformations, CJK/Arabic/Cyrillic support, built-in persistence to multiple backends.
**Cons**: No vector search, no hybrid search. TypeScript types are weak. API is less ergonomic than Orama/MiniSearch. Documentation is sometimes incomplete.

### 3.4 Comparison Matrix

| Feature | Orama | MiniSearch | FlexSearch | SQLite FTS5 (current) |
|---------|-------|-----------|------------|----------------------|
| Full-text search | BM25 | TF-IDF | Custom | BM25 |
| Fuzzy/typo tolerance | Yes (built-in) | Yes (configurable) | Yes (phonetic) | No |
| Vector search | Yes (linear scan) | No | No | No |
| Hybrid search | Yes (weighted fusion) | No | No | Manual (Telegram RRF) |
| Schema definition | Yes (typed) | Fields array | Document config | SQL DDL |
| Persistence | JSON/binary plugin | JSON.stringify | Multi-backend | Built-in |
| Bundle size | ~2KB core | ~5KB | 4.5-16KB | 0 (Bun built-in) |
| Stemming | 30 languages | Custom function | Built-in | unicode61 tokenizer |
| Faceting | Yes | No | No | Manual SQL |
| Bun compatible | Yes | Yes | Yes | Native |

---

## Part 4: macOS Search Capabilities

### 4.1 Spotlight / mdfind

**Status**: Limited for email search since macOS Big Sur.

- Apple migrated Mail indexing from Spotlight to **Core Spotlight** -- `mdfind` no longer reliably indexes email content
- `.emlx` Spotlight importer was removed in Big Sur
- `mdfind "kMDItemContentType == 'com.apple.mail.emlx'"` may not return results on modern macOS
- Can still search file metadata, not email-specific fields

**Verdict**: Not viable for email search. The existing SQLite Envelope Index approach in the mail tool is the correct path.

### 4.2 Apple Mail's SQLite Database

**Current approach** (already implemented in `src/macos/lib/mail/sqlite.ts`):

- Opens `~/Library/Mail/V*/MailData/Envelope Index` directly in readonly mode
- Tables: `messages`, `subjects`, `addresses`, `recipients`, `attachments`, `mailboxes`
- **No FTS tables** in the Envelope Index -- only LIKE queries are possible on metadata
- Body content lives in `.emlx` files on disk, not in the SQLite DB
- Requires Full Disk Access

**Potential improvement**: Build a local FTS5 index from the Envelope Index metadata. Index subjects + sender names + attachment names into a separate SQLite database with FTS5. This would replace LIKE queries with proper full-text search.

### 4.3 DarwinKit / `@genesiscz/darwinkit`

This is a custom package (not the Go-based progrium/darwinkit). It wraps Apple's on-device ML frameworks:

- **NaturalLanguage.framework**: Embeddings, sentiment, NER, POS tagging, lemmatization
- **Vision.framework**: OCR
- **LocalAuthentication.framework**: Touch ID / biometric auth
- **FileProvider/iCloud**: File management

Currently does NOT expose:
- `NSMetadataQuery` (Spotlight queries)
- `CoreSpotlight` (indexing/searching)
- Core Data search

Adding `NSMetadataQuery` to DarwinKit would enable programmatic Spotlight search from Bun, but given Apple's migration away from Spotlight for Mail, this has limited value for email search specifically.

---

## Part 5: Synthesis & Recommendations

### Where a Shared Search Layer Would Help

1. **Mail search**: Replace LIKE queries + JXA body scan with a proper FTS index
2. **Claude history**: Replace JSONL parsing with indexed search
3. **Voice memos**: Replace brute-force `includes()` with indexed search
4. **Azure DevOps local cache**: Replace file-scanning with indexed search
5. **Interactive prompts**: Replace `includes()` with fuzzy-ranked results

### Recommended Architecture

```
                        +-------------------+
                        |  @orama/orama     |
                        | (full-text+vector)|
                        +--------+----------+
                                 |
              +------------------+------------------+
              |                  |                   |
    +-------- v--------+ +------v------+ +----------v---------+
    | Mail Index        | | Claude Hist | | Telegram (keep FTS5)|
    | subject+sender+   | | title+body  | | Already has hybrid  |
    | body (from .emlx) | | +embedding  | | FTS5+vector+RRF     |
    | +512-dim embedding| |             | |                     |
    +-------------------+ +-------------+ +--------------------+
              |                  |
              v                  v
    @genesiscz/darwinkit    DarwinKit embeddings
    (512-dim embeddings)    (free, on-device)
```

**Why Orama over MiniSearch/FlexSearch**:
- Built-in hybrid search avoids reimplementing RRF
- Schema-based matches the typed codebase style
- Persistence plugin supports JSON serialization
- Vector field type natively stores DarwinKit 512-dim embeddings
- BM25 ranking + typo tolerance + 30-language stemming

**Why keep Telegram's FTS5**:
- Already mature and working
- FTS5 is zero-dependency (Bun built-in)
- The hybrid RRF implementation is solid
- Migration would add risk for no gain

### Potential New Utility

`src/utils/search.ts` -- a thin wrapper providing:
- `createSearchIndex(schema)` -- Orama instance creation
- `persistIndex(index, path)` / `loadIndex(path)` -- file-based persistence
- `hybridSearch(index, query, embedding?)` -- unified API
- `embedQuery(query)` -- DarwinKit embedding generation

This would standardize search across tools while keeping tool-specific persistence strategies.

---

## File Map

| File | Role |
|------|------|
| `src/utils/string.ts:73-127` | `matchGlob()`, `fuzzyMatch()`, `fuzzyFind()` -- character subsequence matching |
| `src/utils/fuzzy-match.ts` | Levenshtein, Jaccard, time-range fuzzy matching for Timely/Clarity |
| `src/utils/math.ts:9` | `cosineDistance()` for Float32Array vectors |
| `src/utils/prompts/clack/search-select.ts` | Interactive search-select TUI component |
| `src/utils/prompts/clack/search-multiselect.ts` | Interactive search-multiselect TUI component |
| `src/utils/macos/nlp.ts` | DarwinKit NLP wrappers: embed, distance, similarity, keywords, NER |
| `src/utils/macos/text-analysis.ts` | Higher-level: rankBySimilarity, clustering, dedup, batch sentiment |
| `src/utils/macos/darwinkit.ts` | Singleton DarwinKit instance management |
| `src/utils/storage/storage.ts` | Cache/config storage with TTL, but no search indexing |
| `src/utils/database.ts` | BaseDatabase class with WAL, pruning (no FTS) |
| `src/macos/lib/mail/sqlite.ts` | Mail Envelope Index reader -- LIKE queries on metadata |
| `src/macos/lib/mail/jxa.ts` | JXA body search via osascript |
| `src/macos/commands/mail/search.ts` | 3-phase search pipeline: SQLite + JXA + semantic ranking |
| `src/telegram/lib/TelegramHistoryStore.ts` | FTS5 + vector embeddings + hybrid RRF search |
| `src/azure-devops/lib/work-item-search.ts` | WIQL-based work item search |
| `src/azure-devops/commands/history-search.ts` | Local cache scan + WIQL search modes |
| `src/claude/lib/history/search.ts` | Claude conversation search (glob + JSONL parsing) |
| `src/claude/lib/history/cache.ts` | SQLite metadata cache for Claude history (no FTS) |
| `src/utils/macos/voice-memos.ts:438-458` | Brute-force `includes()` search on memos |
| `src/mcp-ripgrep/index.ts` | MCP server wrapping `rg` binary |

## Open Questions

1. **Orama Bun stability**: Orama claims Bun support but no specific Bun test suite is visible. Should test with `bun add @orama/orama` and verify all features work.
2. **Embedding storage format**: Orama stores vectors internally. Would need to verify it accepts Float32Array or if conversion to `number[]` is needed.
3. **Index size**: For large email databases (100K+ messages), need to benchmark Orama's memory usage with 512-dim vectors.
4. **Incremental indexing**: Orama supports `insert()` / `remove()` but does the persistence plugin support incremental saves, or is it full-snapshot only?
5. **Could DarwinKit add CoreSpotlight support?** This would let us register searchable items with the system Spotlight index, making GenesisTools content searchable from Spotlight itself.

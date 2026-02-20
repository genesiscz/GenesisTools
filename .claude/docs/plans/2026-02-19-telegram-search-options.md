# Telegram Conversation Search — Technology Options

> Research findings for semantic and full-text search in the Telegram conversation history feature.

## Context

- **Runtime:** Bun + TypeScript, macOS only
- **Existing deps:** `better-sqlite3` already in project
- **Scale:** < 100K messages per conversation
- **Embeddings available:** `embedText()` via DarwinKit NaturalLanguage bridge → 512-dimensional float vectors

## Key Limitation: macOS NLEmbedding Language Support

NLEmbedding only supports **7 languages**: en, es, fr, de, it, pt, zh-Hans.

**Czech and Slovak are NOT supported** for embeddings. `detectLanguage()` works for 60+ languages (including Czech), but embedding/semantic similarity is limited to the 7 above. Semantic search will fall back to keyword-only for unsupported languages.

---

## Options Evaluated

### 1. SQLite FTS5 (full-text keyword search)

- **Built-in** to SQLite on macOS — zero installation, zero deps
- BM25 ranking, stemming (`porter`), prefix search (`hello*`), phrase/boolean queries
- `highlight()` and `snippet()` auxiliary functions
- Trigram tokenizer for substring matching (not edit-distance fuzzy)
- **Performance:** Sub-millisecond at < 100K messages
- **External content tables:** FTS index can reference existing table (avoids data duplication)

**Verdict:** Excellent for the keyword-search half. Use as baseline.

### 2. sqlite-vec (vector similarity search) — RECOMMENDED

Successor to deprecated `sqlite-vss`. Single C file, no FAISS dependency.

- `vec0` virtual tables with `float[512]` columns
- KNN query: `WHERE embedding MATCH ? AND k = 20`
- Distance functions: `vec_distance_cosine()`, `vec_distance_l2()`
- Binary quantization: 32× storage reduction, ~10× speedup, 5-10% accuracy loss

**Performance at our scale (from author's benchmarks, M1 Mac mini):**
- 100K vectors × 768 dims (float): under 75ms brute-force KNN
- 100K vectors × 512 dims (float): well under 75ms
- 100K vectors × 512 dims (bit-quantized): ~10-15ms

**Hybrid search with FTS5:** Proven pattern — CTE join via Reciprocal Rank Fusion (RRF). Three strategies:
1. Keyword-first (FTS5 results, then vector)
2. RRF (results in both are ranked higher)
3. Re-rank by semantics (FTS5 candidates → cosine distance reorder)

**Installation:**
```bash
bun add sqlite-vec
```

```typescript
import * as sqliteVec from "sqlite-vec";
import Database from "better-sqlite3";

const db = new Database("messages.db");
sqliteVec.load(db); // Works with better-sqlite3, no custom SQLite needed
```

**macOS caveat:** `bun:sqlite` uses system SQLite which blocks extensions. Using `better-sqlite3` (already in deps) sidesteps this entirely.

**Verdict:** Perfect complement to FTS5. Single `.db` file, in-process, instant cold start.

### 3. ManticoreSearch — NOT RECOMMENDED

- External server daemon (`searchd`) via Homebrew
- Requires `manticore-columnar-lib` for KNN vector search
- ~40 MB RAM at idle, client-server architecture via HTTP
- Replication unavailable on macOS
- TypeScript client: `manticoresoftware/manticoresearch-typescript`

**Verdict:** Wrong model for a local CLI tool. Designed for production web services at scale. The daemon requirement, installation complexity, and operational overhead make it unsuitable.

### 4. Orama (pure TypeScript, in-memory)

- Full-text + vector + hybrid search, pure TypeScript, zero native deps
- **Killer feature:** Levenshtein-based fuzzy typo tolerance (FTS5 lacks this)
- Works in any JS runtime (browser, Node, Deno, Bun)

**Problems at our scale:**
- **Memory:** At 100K messages with 512-dim embeddings: **~400-700 MB heap**
- **Cold start:** Full index deserialization on every CLI invocation
- **Persistence ceiling:** ~512 MB file size limit (Node buffer limitation)

**Verdict:** Good for long-running servers, poor for CLI tools with cold starts.

### 5. Brute-force cosine in TypeScript (DIY)

Store embeddings as SQLite BLOBs, compute cosine similarity in TypeScript.

**Performance:**
- 100K × 512 dims in plain TypeScript: ~30-75ms per query (no SIMD)
- FTS5 pre-filter to ~1K candidates → cosine rerank: ~5ms

**Best pattern:** Use FTS5 to get candidate set, then apply cosine similarity only to those candidates. At 1K vectors × 512 dims, even naive JS math completes in < 5ms.

**Verdict:** Legitimate minimal starting point before adding sqlite-vec. Zero new deps.

---

## Recommendation: FTS5 + sqlite-vec

1. **Single `.db` file**, opened by `better-sqlite3`, in-process, instant cold start
2. **True hybrid search:** FTS5 keyword results + sqlite-vec vector results joined via RRF
3. **Our `embedText()` fits exactly:** 512-dim floats → `vec0(embedding float[512])`
4. **Zero friction:** `better-sqlite3` already in deps, `bun add sqlite-vec` + one `load()` call
5. **Performance:** BM25 queries sub-ms, KNN queries < 75ms at 100K scale

**Fallback for unsupported languages (Czech/Slovak):** Fall back to FTS5-only keyword search. The hybrid pipeline gracefully handles missing embeddings.

---

## Schema Design

```sql
CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender_id TEXT,
    text TEXT,
    media_desc TEXT,
    is_outgoing INTEGER NOT NULL,
    date_unix INTEGER NOT NULL,
    date_iso TEXT NOT NULL
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
    text,
    content=messages,
    content_rowid=id,
    tokenize='unicode61'
);

CREATE VIRTUAL TABLE messages_vec USING vec0(
    message_id INTEGER PRIMARY KEY,
    embedding float[512]
);

CREATE TABLE sync_state (
    chat_id TEXT PRIMARY KEY,
    last_synced_id INTEGER NOT NULL,
    last_synced_at TEXT NOT NULL
);
```

## Hybrid Search Query (Reciprocal Rank Fusion)

```sql
WITH fts_results AS (
    SELECT rowid, rank FROM messages_fts WHERE text MATCH ? ORDER BY rank LIMIT 100
),
vec_results AS (
    SELECT message_id, distance FROM messages_vec WHERE embedding MATCH ? AND k = 100
),
combined AS (
    SELECT COALESCE(f.rowid, v.message_id) AS id,
           COALESCE(1.0 / (60 + f.rrf_rank), 0) + COALESCE(1.0 / (60 + v.rrf_rank), 0) AS score
    FROM (SELECT rowid, ROW_NUMBER() OVER () AS rrf_rank FROM fts_results) f
    FULL OUTER JOIN (SELECT message_id, ROW_NUMBER() OVER () AS rrf_rank FROM vec_results) v
    ON f.rowid = v.message_id
)
SELECT m.* FROM combined c JOIN messages m ON m.id = c.id ORDER BY c.score DESC LIMIT 20;
```

## Existing Utilities (src/utils/macos/)

| Function | Source | Use |
|----------|--------|-----|
| `embedText(text, language?, type?)` | nlp.ts | Generate 512-dim vectors for messages |
| `detectLanguage(text)` | nlp.ts | Check if language supports embedding |
| `scoreRelevance(query, text)` | nlp.ts | Alternative: pairwise scoring for small sets |
| `rankBySimilarity(query, items)` | text-analysis.ts | Alternative: rank items (O(n²), ~200 items max) |

## New Dependencies for Phase 2

```bash
bun add sqlite-vec
# Ships pre-compiled for macOS arm64/x64 — no compilation needed
```

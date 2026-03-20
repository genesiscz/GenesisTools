# Plan: CLI Tooling Enhancements — debugging-master, macos mail, search layer

## Context

Three tools need significant improvements to support a key use case: **automated email monitoring via cron** (checking for important/new emails at 12, 18, 22h and notifying via Telegram). This requires:
- Better mail output (columns, formats, missing fields)
- A mail monitor command with seen-ID tracking
- A shared search layer for future semantic/NL search across tools
- debugging-master session management fixes (stale threshold, deletion, multi-tail)

**Branch:** single feature branch (`feat/tooling-enhancements`)

---

## Part 1: debugging-master Enhancements

### 1A. New `delete-session` command

**File:** `src/debugging-master/commands/delete-session.ts` (new)

```
tools debugging-master delete-session [names...]   # delete named sessions (parseVariadic)
tools debugging-master delete-session --inactive    # delete sessions inactive >24h
tools debugging-master delete-session --all         # delete everything
```

- Register in `src/debugging-master/index.ts`
- Use `parseVariadic` from `src/utils/cli/variadic.ts` for `[names...]`
- Always confirm via `@clack/prompts confirm()` in TTY, refuse in non-TTY without `--force`
- Delete both `.jsonl` + `.meta.json` files
- Clear `config.recentSession` if the deleted session was the recent one
- Add `deleteSession(name)` method to `SessionManager` (`src/debugging-master/core/session-manager.ts`)
- Add `getInactiveSessions(thresholdMs)` method to `SessionManager`
- Use `git rm` pattern: safe deletion reporting which sessions were removed

**Inactive threshold:** 24 hours (separate from the active threshold for tail)

### 1B. Fix `tail` session resolution + multi-session support

**Files to modify:**
- `src/debugging-master/commands/tail.ts`
- `src/debugging-master/core/session-manager.ts`

**Changes to `resolveSession()`:**
1. Change `ACTIVE_THRESHOLD_MS` from `60 * 60 * 1000` (1h) to `2 * 60 * 60 * 1000` (2h)
2. When no `--session` flag and multiple active sessions found:
   - **TTY mode** (`process.stdout.isTTY`): Use `@clack/prompts` `multiselect()` to let user pick one or more sessions
   - **Non-TTY mode**: Print sessions list (same format as `sessions` command) + `suggestCommand()` for each, then exit with error
3. When no `--session` flag and zero active sessions found:
   - **TTY mode**: Show all sessions in a `multiselect()` (not just active ones)
   - **Non-TTY**: Same as current error but with sessions list

**New: `resolveSessionInteractive()` method** on SessionManager that handles the TTY/non-TTY branching. Returns `string[]` (one or more session names).

**Multi-session tailing:**
- Accept `--session first,second` via `parseVariadic()`
- Change tail command from single-session to multi-session
- Watch multiple JSONL files simultaneously (one `fs.watch()` per file)
- Prefix each output line with session name when tailing >1 session (e.g. `[session1] #42 ...`)
- Merge existing entries chronologically by `ts` before displaying last N

**Reuse:**
- `parseVariadic` from `src/utils/cli/variadic.ts`
- `formatTable` from `src/utils/table.ts` for sessions list in non-TTY
- `suggestCommand` from `src/utils/cli/executor.ts`
- `@clack/prompts` multiselect (already a dependency)

### 1C. Implementation order
1. Add `deleteSession()` + `getInactiveSessions()` to SessionManager
2. Add `resolveSessionInteractive()` to SessionManager
3. Create `delete-session` command + register
4. Refactor `tail` to use `resolveSessionInteractive()` + multi-file watching

---

## Part 2: `tools macos mail list` Enhancements

### 2A. Centralized column definitions

**File:** `src/macos/lib/mail/columns.ts` (new)

```typescript
export const MAIL_COLUMNS = {
    date:        { label: "Date",        get: (m: MailMessage) => formatRelativeTime(m.dateSent, { compact: true }) },
    from:        { label: "From",        get: (m: MailMessage) => m.senderName || m.senderAddress },
    fromEmail:   { label: "From Email",  get: (m: MailMessage) => m.senderAddress },
    to:          { label: "To",          get: (m: MailMessage) => formatRecipients(m, "to") },
    toEmail:     { label: "To Email",    get: (m: MailMessage) => formatRecipientEmails(m, "to") },
    cc:          { label: "CC",          get: (m: MailMessage) => formatRecipients(m, "cc") },
    subject:     { label: "Subject",     get: (m: MailMessage) => truncate(m.subject, 60) },
    mailbox:     { label: "Mailbox",     get: (m: MailMessage) => m.mailbox },
    account:     { label: "Account",     get: (m: MailMessage) => m.account },
    read:        { label: "Read",        get: (m: MailMessage) => m.read ? "yes" : "no" },
    flagged:     { label: "Flagged",     get: (m: MailMessage) => m.flagged ? "yes" : "" },
    size:        { label: "Size",        get: (m: MailMessage) => formatBytes(m.size) },
    attachments: { label: "Attachments", get: (m: MailMessage) => m.attachments.length > 0 ? String(m.attachments.length) : "" },
    body:        { label: "Body Match",  get: (m: MailMessage) => m.bodyMatchesQuery ? "yes" : "" },
    relevance:   { label: "Relevance",   get: (m: MailMessage) => m.semanticScore !== undefined ? (1 - m.semanticScore / 2).toFixed(2) : "" },
} as const;

export type MailColumnKey = keyof typeof MAIL_COLUMNS;
export const DEFAULT_LIST_COLUMNS: MailColumnKey[] = ["date", "from", "subject", "attachments"];
export const ALL_COLUMN_KEYS = Object.keys(MAIL_COLUMNS) as MailColumnKey[];
```

This enum is used in commander help text, `--columns` validation, and the interactive picker.

### 2B. `--columns` flag with interactive selection

**File:** `src/macos/commands/mail/list.ts` (modify)

```
tools macos mail list --columns                       # TTY: clack multiselect picker
tools macos mail list --columns date,from,to,subject  # explicit columns
tools macos mail list --columns date,fromEmail,toEmail,subject,read,size
```

- Use `parseVariadic()` for the value
- If `--columns` present with no value (Commander: `--columns` as boolean-like): show `@clack/prompts multiselect()` with all `MAIL_COLUMNS` keys
- Commander help shows available columns: `--columns [cols]  Columns to show (${ALL_COLUMN_KEYS.join(",")})`
- Validate column names against `ALL_COLUMN_KEYS`, error on unknown

### 2C. `--format json|toon|table` flag

**File:** `src/macos/commands/mail/list.ts` (modify)

```
tools macos mail list --format json    # raw JSON array
tools macos mail list --format toon    # pipe through tools json internally
tools macos mail list --format table   # default, current behavior
```

- **json**: `JSON.stringify()` the MailMessage[] array (with selected columns if `--columns`)
- **toon**: Same as json but pipe through `tools json` (or import the TOON formatter directly if available)
- **table**: Current `formatResultsTable()` behavior but using column definitions from `columns.ts`

### 2D. Enrich list query with recipients

**File:** `src/macos/commands/mail/list.ts` (modify)

Current `listMessages()` doesn't fetch recipients. Need to call `getRecipients(rowids)` (already exists in `sqlite.ts:220`) when to/toEmail/cc columns are requested.

Lazy enrichment: only call `getRecipients()` if any recipient column is in the selected columns.

### 2E. Refactor `formatResultsTable()`

**File:** `src/macos/lib/mail/format.ts` (modify)

Replace the hardcoded column logic with a generic renderer using `MAIL_COLUMNS`:

```typescript
export function formatResultsTable(messages: MailMessage[], columns: MailColumnKey[]): string {
    const headers = columns.map(k => MAIL_COLUMNS[k].label);
    const rows = messages.map(msg => columns.map(k => MAIL_COLUMNS[k].get(msg)));
    return formatTable(rows, headers, { maxColWidth: 60 });
}
```

Also update `search.ts` to use the same column system.

### 2F. Add `--format` and `--columns` to `search` command too

For consistency, apply the same `--format` and `--columns` flags to `tools macos mail search`.

---

## Part 3: Mail Monitor Command

### 3A. New `monitor` command

**File:** `src/macos/commands/mail/monitor.ts` (new)

```
tools macos mail monitor [--limit 200] [--notify-telegram] [--rules <path>] [--dry-run]
```

**Seen-ID tracking:**
- SQLite database at `~/.genesis-tools/macos-mail/seen.db` (via `Storage`)
- Table: `seen_messages (rowid INTEGER PRIMARY KEY, first_seen_at INTEGER)`
- On each run: fetch latest N messages, diff against seen, report new ones
- Mark all fetched as seen after processing

**Rule-based filtering:**
- Default rules (hardcoded, can be overridden by `--rules` JSON file):
  - Sender pattern match: "Tekies", "DNAI" (non-newsletter heuristic: no "unsubscribe" in subject)
  - Content keywords: "payment required", "payment due", "invoice"
  - Personal detection: messages where user is the only recipient (not a mailing list)
  - Priority: flagged messages always included
- Rules format:
```typescript
interface MonitorRule {
    name: string;
    match: {
        senderContains?: string[];      // OR match on sender name/email
        subjectContains?: string[];     // OR match on subject
        subjectNotContains?: string[];  // exclude (e.g. "newsletter", "unsubscribe")
        isPersonal?: boolean;           // only-recipient heuristic
        isFlagged?: boolean;
    };
}
```

**Output:**
- Console: summary of new important emails (count + table)
- `--notify-telegram`: Send formatted message via existing Telegram bot integration
  - Need to identify how to send a message programmatically — check `src/telegram/` for send capabilities
  - If no direct send API exists, use `sayy` command as fallback for macOS notification

**Also add `--since-last-check` to `list`:**
- Reuses the same `seen.db` to determine the last-seen high-water mark
- Shows only messages newer than last check
- Updates the seen table after displaying

### 3B. Cron setup guidance

The monitor command is designed to be cron-friendly:
```bash
# CronCreate will handle this:
tools macos mail monitor --limit 200 --notify-telegram
```

Non-TTY safe: no interactive prompts, exits cleanly, JSON-parseable output.

---

## Part 4: Shared Search Layer (`src/utils/search/`)

### 4A. Architecture

Inspired by the FTS5 vs Orama demo pattern. Driver-based with a unified interface:

```
src/utils/search/
├── index.ts                    # public API re-exports
├── types.ts                    # SearchEngine interface, SearchResult, SearchOptions
├── drivers/
│   ├── orama/
│   │   ├── index.ts            # OramaSearchEngine implements SearchEngine
│   │   └── persistence.ts      # JSON/binary file persistence
│   └── sqlite-fts5/
│       ├── index.ts            # FTS5SearchEngine implements SearchEngine
│       ├── schema.ts           # FTS5 table creation helpers
│       └── vector.ts           # Vector storage + cosine similarity (from Telegram)
└── embeddings.ts               # DarwinKit embedding wrapper (shared across drivers)
```

### 4B. Core interface (`types.ts`)

```typescript
export interface SearchEngine<TDoc extends Record<string, unknown> = Record<string, unknown>> {
    insert(doc: TDoc): Promise<void>;
    insertMany(docs: TDoc[]): Promise<void>;
    remove(id: string | number): Promise<void>;

    search(opts: SearchOptions): Promise<SearchResult<TDoc>[]>;

    persist?(): Promise<void>;     // optional: save index to disk
    close?(): Promise<void>;       // optional: cleanup resources

    readonly count: number;
}

export interface SearchOptions {
    query: string;
    mode?: "fulltext" | "vector" | "hybrid";
    limit?: number;
    fields?: string[];             // which fields to search
    boost?: Record<string, number>; // field boost weights
    hybridWeights?: { text: number; vector: number };
    filters?: Record<string, unknown>; // field-level filters
}

export interface SearchResult<TDoc> {
    doc: TDoc;
    score: number;
    method: "bm25" | "cosine" | "rrf";
}
```

### 4C. SQLite FTS5 driver (`drivers/sqlite-fts5/`)

Refactored from `src/telegram/lib/TelegramHistoryStore.ts` (lines 299-462):

- **`index.ts`**: `FTS5SearchEngine` class
  - Constructor takes `{ dbPath, schema: { textFields, vectorField? }, tableName }`
  - Creates FTS5 virtual table + triggers for content sync
  - `search()` dispatches to BM25, vector, or hybrid based on `mode`

- **`vector.ts`**: Extracted from Telegram's vector search
  - `storeEmbedding(db, table, docId, vector: Float32Array)`
  - `vectorSearch(db, table, queryVec, limit)` — brute-force cosine scan
  - `cosineDistance(a, b)` — reuse existing `src/utils/math.ts:9`

- **`schema.ts`**: FTS5 DDL generation
  - `createFTS5Table(db, tableName, fields, tokenizer?)`
  - `createEmbeddingTable(db, tableName, dimensions)`
  - Auto-creates sync triggers (INSERT/UPDATE/DELETE)

### 4D. Orama driver (`drivers/orama/`)

Wraps `@orama/orama` (need to `bun add @orama/orama @orama/plugin-data-persistence`):

- **`index.ts`**: `OramaSearchEngine` class
  - Constructor takes `{ schema, persistPath? }`
  - Maps GenesisTools `SearchOptions` to Orama's `search()` API
  - Auto-loads from persist path if exists

- **`persistence.ts`**:
  - `persistToFile(db, path)` — uses `@orama/plugin-data-persistence` JSON format
  - `restoreFromFile(path, schema)` — restore from JSON

### 4E. Embeddings → use `src/utils/ai/tasks/Embedder.ts` (see Part 5)

The search layer does NOT own embeddings. Instead, `src/utils/search/` imports from the AI embedder abstraction (Part 5). The search drivers accept pre-computed `Float32Array` vectors — they don't generate embeddings themselves.

### 4F. Migration plan for Telegram

After the shared layer is built:
1. Refactor `TelegramHistoryStore` to use `FTS5SearchEngine` from `src/utils/search/drivers/sqlite-fts5/`
2. Keep Telegram's existing DB schema (don't migrate data)
3. The FTS5 driver wraps the same SQL patterns, so the migration is mostly import swaps
4. Telegram's RRF hybrid search becomes the default hybrid mode in the driver

**Scope for this PR:** Build the shared layer + migrate Telegram. Other tools (mail, claude-history, voice-memos) can adopt incrementally in follow-up PRs.

---

## Part 5: AI Embedder Abstraction (`src/utils/ai/tasks/Embedder.ts`)

The existing AI provider system already declares `"embed"` as an `AITask` and has the config/provider resolution infrastructure. We need to:

### 5A. Add `AIEmbeddingProvider` interface

**File:** `src/utils/ai/types.ts` (modify — add alongside existing `AITranscriptionProvider` etc.)

```typescript
export interface EmbeddingResult {
    vector: Float32Array;
    dimensions: number;
}

export interface EmbedOptions {
    language?: string;
    model?: string;
}

export interface AIEmbeddingProvider extends AIProvider {
    embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult>;
    readonly dimensions: number;  // 512 for darwinkit, 384 for MiniLM, 1536 for OpenAI
}
```

### 5B. Add `embed` support to `AILocalProvider`

**File:** `src/utils/ai/providers/AILocalProvider.ts` (modify)

- Add `"embed"` to `SUPPORTED_TASKS`
- Implement `AIEmbeddingProvider` interface
- Use HuggingFace `feature-extraction` pipeline with `Xenova/all-MiniLM-L6-v2` (384-dim, ~25MB)
- `getPipeline("feature-extraction", model)` → returns `Float32Array`
- `dimensions = 384`

```typescript
async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
    const model = options?.model ?? "Xenova/all-MiniLM-L6-v2";
    const pipe = await this.getPipeline("feature-extraction", model);
    const result = await pipe(text, { pooling: "mean", normalize: true });
    // result.data is Float32Array of shape [1, 384]
    return { vector: new Float32Array(result.data), dimensions: 384 };
}
```

### 5C. Add `embed` support to `AICloudProvider`

**File:** `src/utils/ai/providers/AICloudProvider.ts` (modify)

- Add `"embed"` to `SUPPORTED_TASKS`
- Implement `AIEmbeddingProvider` interface
- Use OpenAI `text-embedding-3-small` (1536-dim) via `@ai-sdk/openai` or direct API
- `dimensions = 1536`

```typescript
async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
    const model = options?.model ?? "text-embedding-3-small";
    // Use OpenAI embeddings API
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI();
    const result = await openai.embedding(model).doEmbed({ values: [text] });
    const vec = new Float32Array(result.embeddings[0]);
    return { vector: vec, dimensions: vec.length };
}
```

### 5D. Update `AIDarwinKitProvider`

**File:** `src/utils/ai/providers/AIDarwinKitProvider.ts` (modify)

- Already supports `"embed"` and has `embedText()` which calls `src/utils/macos/nlp.ts` → `@genesiscz/darwinkit`
- Conform to `AIEmbeddingProvider` interface:
  - Add `dimensions = 512` property
  - Rename/adapt `embedText()` → `embed()` returning `EmbeddingResult` (convert `number[]` → `Float32Array`)
- The driver layer (`AIDarwinKitProvider`) is the right place — it already `import("@app/utils/macos/nlp")` internally, so the `macos/nlp` wrappers are reused as-is

### 5E. Create `Embedder` task class

**File:** `src/utils/ai/tasks/Embedder.ts` (new)

Follows the exact pattern of `Transcriber.ts`:

```typescript
export class Embedder {
    private provider: AIEmbeddingProvider;

    private constructor(provider: AIEmbeddingProvider) {
        this.provider = provider;
    }

    static async create(options?: { provider?: string; model?: string }): Promise<Embedder> {
        const config = await AIConfig.load();
        if (options?.provider) {
            config.set("embed", { provider: options.provider as AIProviderType, model: options.model });
        }
        const provider = await getProviderForTask("embed", config);
        return new Embedder(provider as AIEmbeddingProvider);
    }

    get dimensions(): number {
        return this.provider.dimensions;
    }

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        return this.provider.embed(text, options);
    }

    async embedMany(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
        return Promise.all(texts.map(t => this.provider.embed(t, options)));
    }

    dispose(): void {
        this.provider.dispose?.();
    }
}
```

### 5F. Register in `AI` facade

**File:** `src/utils/ai/index.ts` (modify)

Add `Embedder` to the `AI` object:

```typescript
export const AI = {
    Embedder,
    // ... existing Transcriber, Translator, Summarizer

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        const e = await Embedder.create();
        try { return await e.embed(text, options); }
        finally { e.dispose(); }
    },
};
```

### 5G. How search layer uses it

`src/utils/search/` drivers that need embeddings accept `Embedder` as a constructor option:

```typescript
// In search driver constructor:
const engine = new FTS5SearchEngine({
    dbPath: "...",
    schema: { textFields: ["subject", "body"], vectorField: "embedding" },
    embedder: await Embedder.create(),  // auto-selects darwinkit → local-hf → cloud
});
```

**Fallback chain** (from `AIConfig` defaults + `getProviderForTask`):
1. **macOS**: darwinkit (512-dim, free, instant, on-device)
2. **Non-macOS / darwinkit unavailable**: local-hf with `all-MiniLM-L6-v2` (384-dim, ~25MB download)
3. **Neither available**: cloud via OpenAI (1536-dim, needs API key)

**Dimension handling**: Search drivers store the dimension count alongside vectors. When an embedding dimension changes (e.g. switching from darwinkit to local-hf), the driver rebuilds the vector index.

---

## Part 6: Implementation Order

### Phase A: Foundation (no dependencies between tasks)
1. **`src/macos/lib/mail/columns.ts`** — column definitions
2. **`src/utils/search/types.ts`** — search interfaces
3. **`SessionManager` new methods** — `deleteSession()`, `getInactiveSessions()`, `resolveSessionInteractive()`
4. **`AIEmbeddingProvider` interface** — add to `src/utils/ai/types.ts`

### Phase B: Embedder + Commands (depends on A)
5. **`Embedder` task class** — `src/utils/ai/tasks/Embedder.ts`
6. **Add `embed` to providers** — DarwinKit (conform interface), Local-HF (feature-extraction), Cloud (OpenAI)
7. **Register in `AI` facade** — `src/utils/ai/index.ts`
8. **`delete-session` command** — register in index.ts
9. **`tail` refactor** — multi-session + interactive resolution
10. **`list` enhancements** — --columns, --format, recipient enrichment
11. **`formatResultsTable` refactor** — use column definitions

### Phase C: Search layer (can parallel with B.8-11)
12. **`src/utils/search/drivers/sqlite-fts5/`** — extract from Telegram, uses Embedder
13. **`src/utils/search/drivers/orama/`** — Orama wrapper, uses Embedder
14. **`src/utils/search/index.ts`** — public API

### Phase D: Monitor + migration (depends on B + C)
15. **`mail monitor` command** — seen.db + rules + telegram notify
16. **`list --since-last-check`** — reuse seen.db
17. **Telegram migration** — swap to shared FTS5 driver
18. **`search` command** — add --columns, --format consistency

---

## Files to Create
| File | Purpose |
|------|---------|
| `src/utils/ai/tasks/Embedder.ts` | Embedder task class (darwinkit → local-hf → cloud) |
| `src/debugging-master/commands/delete-session.ts` | Delete session command |
| `src/macos/lib/mail/columns.ts` | Centralized column definitions |
| `src/macos/commands/mail/monitor.ts` | Mail monitor command |
| `src/utils/search/index.ts` | Search layer public API |
| `src/utils/search/types.ts` | SearchEngine interface + types |
| `src/utils/search/drivers/orama/index.ts` | Orama driver |
| `src/utils/search/drivers/orama/persistence.ts` | Orama file persistence |
| `src/utils/search/drivers/sqlite-fts5/index.ts` | FTS5 driver |
| `src/utils/search/drivers/sqlite-fts5/schema.ts` | FTS5 DDL helpers |
| `src/utils/search/drivers/sqlite-fts5/vector.ts` | Vector storage + cosine |

## Files to Modify
| File | Changes |
|------|---------|
| `src/utils/ai/types.ts` | Add `AIEmbeddingProvider`, `EmbeddingResult`, `EmbedOptions` |
| `src/utils/ai/index.ts` | Export Embedder, add `AI.embed()` convenience |
| `src/utils/ai/providers/AIDarwinKitProvider.ts` | Conform to `AIEmbeddingProvider` (add `dimensions`, return `Float32Array`) |
| `src/utils/ai/providers/AILocalProvider.ts` | Add `embed` to SUPPORTED_TASKS, implement via HF `feature-extraction` pipeline |
| `src/utils/ai/providers/AICloudProvider.ts` | Add `embed` to SUPPORTED_TASKS, implement via OpenAI embeddings API |
| `src/debugging-master/index.ts` | Register delete-session command |
| `src/debugging-master/core/session-manager.ts` | Add deleteSession(), getInactiveSessions(), resolveSessionInteractive(), change ACTIVE_THRESHOLD to 2h |
| `src/debugging-master/commands/tail.ts` | Multi-session support, parseVariadic, interactive resolution |
| `src/macos/commands/mail/index.ts` | Register monitor command |
| `src/macos/commands/mail/list.ts` | Add --columns, --format, recipient enrichment |
| `src/macos/commands/mail/search.ts` | Add --columns, --format for consistency |
| `src/macos/lib/mail/format.ts` | Refactor formatResultsTable to use column defs |
| `src/telegram/lib/TelegramHistoryStore.ts` | Migrate to shared FTS5 driver |

## Key Reuse
| Existing | Where used |
|----------|-----------|
| `AIConfig` @ `src/utils/ai/AIConfig.ts` | Embedder provider resolution (default: darwinkit) |
| `getProviderForTask()` @ `src/utils/ai/providers/index.ts` | Auto-fallback: darwinkit → local-hf → cloud |
| `@huggingface/transformers` pipeline | Local-HF embed via `feature-extraction` task |
| `@ai-sdk/openai` | Cloud embed via OpenAI embeddings API |
| `parseVariadic()` @ `src/utils/cli/variadic.ts` | delete-session names, tail --session, --columns |
| `suggestCommand()` @ `src/utils/cli/executor.ts` | non-TTY session suggestions |
| `formatTable()` @ `src/utils/table.ts` | sessions list, mail table output |
| `@clack/prompts` multiselect | session picker, column picker |
| `cosineDistance()` @ `src/utils/math.ts` | FTS5 vector driver |
| `Storage` @ `src/utils/storage/storage.ts` | seen.db for mail monitor |
| `getRecipients()` @ `src/macos/lib/mail/sqlite.ts` | list recipient enrichment |

---

## Verification

### debugging-master
```bash
# Delete session
tools debugging-master delete-session my-session        # named
tools debugging-master delete-session --inactive         # >24h
tools debugging-master delete-session --all --force      # all

# Tail with session picker (TTY)
tools debugging-master tail                              # shows multiselect if multiple
tools debugging-master tail --session sess1,sess2        # multi-tail

# Sessions list
tools debugging-master sessions                          # verify active threshold = 2h
```

### macos mail
```bash
# Columns
tools macos mail list --columns                          # interactive picker
tools macos mail list --columns date,from,toEmail,subject,read
tools macos mail list --format json --limit 5
tools macos mail list --format json --limit 5 | tools json

# Monitor
tools macos mail monitor --limit 200 --dry-run           # show what would be flagged
tools macos mail monitor --limit 200 --notify-telegram   # full run

# Search with new flags
tools macos mail search "invoice" --format json --columns date,from,subject
```

### Embedder
```bash
# Verify darwinkit embedder (macOS)
bun -e "const { AI } = require('./src/utils/ai'); const r = await AI.embed('hello world'); console.log(r.dimensions, r.vector.slice(0,5))"

# Verify provider fallback chain
# On macOS: should pick darwinkit (512-dim)
# On Linux/CI: should fall back to local-hf (384-dim) or cloud (1536-dim)
```

### Search layer
```bash
# Verify Telegram still works after migration
# (existing Telegram search tests should pass)

# Verify Orama driver
# Write a small test script that creates an OramaSearchEngine, inserts docs, searches
```

### TypeScript
```bash
tsgo --noEmit | rg "src/(debugging-master|macos|utils/(search|ai)|telegram)"
```

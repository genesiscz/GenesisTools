# Indexer Guardrails & Date Range Filtering

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add confirmation prompts to all destructive indexer operations, ensure index isolation, and add `--from`/`--to` date range filtering for mail indexing and re-embedding.

**Architecture:** Guardrails are confirmation prompts (`@clack/prompts confirm`) before any data-destroying action. Date filtering adds WHERE clauses to MailSource SQL queries and scopes rebuild-embeddings to only re-embed chunks in the date range. Each index is already isolated by directory (`~/.config/indexer/<name>/index.db`), but we verify and harden this.

**Tech Stack:** TypeScript, Bun, commander, @clack/prompts, SQLite

---

## Context: Current State of Destructive Operations

| Operation | What it destroys | Has confirmation? |
|-----------|-----------------|-------------------|
| `tools indexer remove <name>` | Entire index directory | Yes (--force or prompt) |
| `tools indexer rebuild <name>` | Drops+recreates all data | **NO** |
| `tools macos mail index --rebuild-fulltext` | Entire mail index | **NO** |
| `tools macos mail index --rebuild-embeddings` | All embeddings (281K+) | **NO** |
| `IndexerManager.removeIndex()` | Directory + config | Only CLI guards it |
| `IndexStore.clearEmbeddings()` | All embedding rows | No guard at all |

Each index has its own SQLite DB in `~/.config/indexer/<name>/index.db` with tables prefixed by sanitized name. `removeIndex` uses `rmSync(indexDir, { recursive: true })` scoped to the index's directory. **Index isolation is correct** — operations cannot cross indexes. But the lack of confirmation on rebuild operations is dangerous.

---

### Task 1: Add confirmation to `--rebuild-fulltext`

**Files:**
- Modify: `src/macos/commands/mail/index-cmd.ts:38-45`

**Step 1: Add confirmation prompt before removeIndex**

In the action handler, before the `manager.removeIndex(MAIL_INDEX_NAME)` call, add:

```typescript
if (exists && opts.rebuildFulltext) {
    if (!process.stdout.isTTY) {
        p.log.error("--rebuild-fulltext is destructive. Use in interactive mode or add --force.");
        process.exit(1);
    }

    const meta = manager.listIndexes().find(m => m.name === MAIL_INDEX_NAME);
    const chunkCount = meta?.stats.totalChunks ?? 0;
    const embCount = meta?.stats.totalEmbeddings ?? 0;

    const confirmed = await p.confirm({
        message: `This will delete the entire mail index (${chunkCount.toLocaleString()} chunks, ${embCount.toLocaleString()} embeddings) and rebuild from scratch. Continue?`,
    });

    if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Cancelled");
        p.outro("Aborted");
        return;
    }

    p.log.info("Rebuilding mail index from scratch...");
    await manager.removeIndex(MAIL_INDEX_NAME);
}
```

Also add `--force` flag to skip confirmation:

```typescript
.option("--force", "Skip confirmation for destructive operations")
```

**Step 2: Run test**

```bash
tsgo --noEmit | rg "src/macos"
```

**Step 3: Commit**

```bash
git add src/macos/commands/mail/index-cmd.ts
git commit -m "fix(mail): add confirmation prompt for --rebuild-fulltext"
```

---

### Task 2: Add confirmation to `--rebuild-embeddings`

**Files:**
- Modify: `src/macos/commands/mail/index-cmd.ts` — `rebuildEmbeddings()` function

**Step 1: Add confirmation before clearEmbeddings**

In `rebuildEmbeddings()`, after showing the index state, add:

```typescript
if (!process.stdout.isTTY) {
    p.log.error("--rebuild-embeddings is destructive. Use in interactive mode or add --force.");
    process.exit(1);
}

const embCount = meta.stats.totalEmbeddings;

if (embCount > 0) {
    const confirmed = await p.confirm({
        message: `This will drop ${embCount.toLocaleString()} embeddings and re-generate them. Continue?`,
    });

    if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Cancelled");
        p.outro("Aborted");
        return;
    }
}
```

Accept `opts.force` to bypass (from Task 1's `--force` flag).

**Step 2: Commit**

```bash
git add src/macos/commands/mail/index-cmd.ts
git commit -m "fix(mail): add confirmation prompt for --rebuild-embeddings"
```

---

### Task 3: Add confirmation to `tools indexer rebuild`

**Files:**
- Modify: `src/indexer/commands/rebuild.ts:44-49`

**Step 1: Add confirmation after index selection**

After `targetName` is determined, before `manager.rebuildIndex()`:

```typescript
const metas = manager.listIndexes();
const meta = metas.find(m => m.name === targetName);
const chunkCount = meta?.stats.totalChunks ?? 0;

if (process.stdout.isTTY && chunkCount > 0) {
    const confirmed = await p.confirm({
        message: `Rebuild "${targetName}" (${chunkCount.toLocaleString()} chunks)? This will re-scan all source files.`,
    });

    if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Cancelled");
        return;
    }
}
```

**Step 2: Commit**

```bash
git add src/indexer/commands/rebuild.ts
git commit -m "fix(indexer): add confirmation prompt for rebuild command"
```

---

### Task 4: Add `--from` and `--to` date filtering to MailSource

**Files:**
- Modify: `src/indexer/lib/sources/source.ts` — add `fromDate`/`toDate` to ScanOptions
- Modify: `src/indexer/lib/sources/mail-source.ts` — filter SQL by date_sent
- Test: `src/indexer/lib/sources/mail-source.test.ts`

**Step 1: Add date options to ScanOptions**

In `source.ts`:

```typescript
export interface ScanOptions {
    onProgress?: (current: number, total: number) => void;
    limit?: number;
    sinceId?: string;
    onBatch?: (entries: SourceEntry[]) => Promise<void>;
    batchSize?: number;
    /** Only include entries on or after this date */
    fromDate?: Date;
    /** Only include entries on or before this date */
    toDate?: Date;
}
```

**Step 2: Update MailSource.scan() to filter by date**

In `mail-source.ts`, modify the WHERE clause builder:

```typescript
async scan(opts?: ScanOptions): Promise<SourceEntry[]> {
    const limit = opts?.limit ?? 1_000_000;
    const sinceRowid = opts?.sinceId ? parseInt(opts.sinceId, 10) : 0;

    const conditions: string[] = ["m.deleted = 0"];
    const params: (number | string)[] = [];

    if (sinceRowid > 0) {
        conditions.push("m.ROWID > ?");
        params.push(sinceRowid);
    }

    if (opts?.fromDate) {
        conditions.push("m.date_sent >= ?");
        params.push(Math.floor(opts.fromDate.getTime() / 1000));
    }

    if (opts?.toDate) {
        conditions.push("m.date_sent <= ?");
        params.push(Math.floor(opts.toDate.getTime() / 1000));
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;
    params.push(limit);

    // Also update the count query to use same conditions
    const countConditions = [...conditions]; // without limit
    const countParams = params.slice(0, -1); // without limit
    const countQuery = `SELECT COUNT(*) AS cnt FROM messages m WHERE ${countConditions.join(" AND ")}`;
    const totalRow = this.db.query(countQuery).get(...countParams) as { cnt: number };
    const total = Math.min(totalRow.cnt, limit);

    const rows = this.db.query(`
        SELECT m.ROWID AS rowid, s.subject, a.address AS senderAddress,
               a.comment AS senderName, m.date_sent AS dateSent,
               m.date_received AS dateReceived, mb.url AS mailboxUrl,
               m.read, m.flagged, m.size
        FROM messages m
        LEFT JOIN subjects s ON m.subject = s.ROWID
        LEFT JOIN addresses a ON m.sender = a.ROWID
        LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
        ${whereClause}
        ORDER BY m.ROWID ASC
        LIMIT ?
    `).all(...params) as MailRow[];

    // ... rest unchanged
```

Also update `estimateTotal()` to accept an optional date range for accurate progress display:

```typescript
async estimateTotal(opts?: { fromDate?: Date; toDate?: Date }): Promise<number> {
    const conditions: string[] = ["deleted = 0"];
    const params: number[] = [];

    if (opts?.fromDate) {
        conditions.push("date_sent >= ?");
        params.push(Math.floor(opts.fromDate.getTime() / 1000));
    }

    if (opts?.toDate) {
        conditions.push("date_sent <= ?");
        params.push(Math.floor(opts.toDate.getTime() / 1000));
    }

    const row = this.db.query(
        `SELECT COUNT(*) AS cnt FROM messages WHERE ${conditions.join(" AND ")}`
    ).get(...params) as { cnt: number };
    return row.cnt;
}
```

**Step 3: Run tests**

```bash
bun test src/indexer/lib/sources/mail-source.test.ts --timeout 60000
```

**Step 4: Commit**

```bash
git add src/indexer/lib/sources/source.ts src/indexer/lib/sources/mail-source.ts
git commit -m "feat(mail): add fromDate/toDate filtering to MailSource scan"
```

---

### Task 5: Wire `--from`/`--to` into `tools macos mail index`

**Files:**
- Modify: `src/macos/commands/mail/index-cmd.ts` — add CLI flags and pass to scan

**Step 1: Add CLI options**

```typescript
.option("--from <date>", "Only index emails from this date (YYYY-MM-DD)")
.option("--to <date>", "Only index emails up to this date (YYYY-MM-DD)")
```

Add to opts type:

```typescript
opts: {
    model?: string;
    limit?: number;
    embed?: boolean;
    rebuildFulltext?: boolean;
    rebuildEmbeddings?: boolean;
    force?: boolean;
    from?: string;
    to?: string;
}
```

**Step 2: Parse dates and pass through**

Create a helper at the top of the file:

```typescript
function parseDate(str: string | undefined, label: string): Date | undefined {
    if (!str) return undefined;
    const d = new Date(str);

    if (Number.isNaN(d.getTime())) {
        p.log.error(`Invalid ${label} date: "${str}". Use YYYY-MM-DD format.`);
        process.exit(1);
    }

    return d;
}
```

In the action, parse early:

```typescript
const fromDate = parseDate(opts.from, "--from");
const toDate = parseDate(opts.to, "--to");
```

Pass `fromDate`/`toDate` to `incrementalSync`, `createAndSync`, and `rebuildEmbeddings`.

**Step 3: Update incrementalSync to use date range**

In `incrementalSync`, pass dates to the scan options:

```typescript
const stats = await indexer.sync({
    scanOptions: { fromDate, toDate },
    // ... existing callbacks
});
```

This requires updating `Indexer.sync()` and `runSync()` to accept and forward `scanOptions`. In `indexer.ts`:

```typescript
async sync(callbacks?: IndexerCallbacks & { scanOptions?: { fromDate?: Date; toDate?: Date } }): Promise<SyncStats> {
    return this.runSync({ mode: "incremental", callbacks, scanOptions: callbacks?.scanOptions });
}
```

Then in `runSync`, pass `fromDate`/`toDate` to `this.source.scan(...)`:

```typescript
const sourceEntries = await this.source.scan({
    sinceId,
    batchSize: 500,
    fromDate: opts.scanOptions?.fromDate,
    toDate: opts.scanOptions?.toDate,
    onBatch: async (batch) => { ... },
    onProgress: (current, total) => { ... },
});
```

**Step 4: Show date range in UI**

When `--from` or `--to` is specified, display it:

```typescript
if (fromDate || toDate) {
    const range = [
        fromDate ? fromDate.toISOString().slice(0, 10) : "beginning",
        toDate ? toDate.toISOString().slice(0, 10) : "now",
    ];
    p.log.info(`  ${pc.dim("Date range:")} ${range[0]} → ${range[1]}`);
}
```

**Step 5: Commit**

```bash
git add src/macos/commands/mail/index-cmd.ts src/indexer/lib/indexer.ts
git commit -m "feat(mail): add --from/--to date range flags for mail indexing"
```

---

### Task 6: Scope `--rebuild-embeddings` to date range

When `--rebuild-embeddings --from 2025-01-01 --to 2025-12-31` is used, only re-embed chunks whose source entry (email) falls in that date range. Don't touch embeddings outside the range.

**Files:**
- Modify: `src/indexer/lib/indexer.ts` — add `reembedRange()` method
- Modify: `src/indexer/lib/store.ts` — add `clearEmbeddingsByDateRange()` or `clearEmbeddingsBySourceIds()`
- Modify: `src/macos/commands/mail/index-cmd.ts` — wire date range into rebuildEmbeddings

**Step 1: Add clearEmbeddingsBySourceIds to store**

In `store.ts` interface and implementation:

```typescript
// Interface
clearEmbeddingsBySourceIds(sourceIds: string[]): void;

// Implementation
clearEmbeddingsBySourceIds(sourceIds: string[]): void {
    const embTable = `${tableName}_embeddings`;
    const contentTable = `${tableName}_content`;
    const tableExists = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(embTable) as { name: string } | null;

    if (!tableExists) return;

    const batchSize = 500;
    const tx = db.transaction(() => {
        for (let i = 0; i < sourceIds.length; i += batchSize) {
            const batch = sourceIds.slice(i, i + batchSize);
            const placeholders = batch.map(() => "?").join(",");
            // Delete embeddings for chunks that belong to these source IDs
            db.run(
                `DELETE FROM ${embTable} WHERE doc_id IN (SELECT id FROM ${contentTable} WHERE source_id IN (${placeholders}))`,
                batch
            );
        }
    });
    tx();
},
```

**Step 2: Add reembedRange to Indexer**

```typescript
/** Drop embeddings for specific source IDs and re-embed their chunks. */
async reembedBySourceIds(sourceIds: string[], callbacks?: IndexerCallbacks): Promise<number> {
    this.store.clearEmbeddingsBySourceIds(sourceIds);
    return this.embedUnembeddedChunks(callbacks);
}
```

**Step 3: Update rebuildEmbeddings in index-cmd.ts**

When `fromDate` or `toDate` is provided:

```typescript
if (fromDate || toDate) {
    // Scan for entries in the date range to get their source IDs
    const mailSource = await MailSource.create();
    const entries = await mailSource.scan({ fromDate, toDate });
    mailSource.dispose();

    const sourceIds = entries.map(e => e.id);
    p.log.info(`  ${pc.dim("Scoped to:")} ${sourceIds.length.toLocaleString()} emails in date range`);

    const embedded = await indexer.reembedBySourceIds(sourceIds, { onEmbedProgress: ... });
} else {
    // Full re-embed (existing behavior)
    const embedded = await indexer.reembed({ onEmbedProgress: ... });
}
```

**Step 4: Commit**

```bash
git add src/indexer/lib/indexer.ts src/indexer/lib/store.ts src/macos/commands/mail/index-cmd.ts
git commit -m "feat(mail): scope --rebuild-embeddings to --from/--to date range"
```

---

### Task 7: Add `--force` flag to bypass confirmations

**Files:**
- Modify: `src/macos/commands/mail/index-cmd.ts`

**Step 1: Wire --force through**

The `--force` flag was declared in Task 1. Now make it bypass the confirmation prompts:

```typescript
if (!opts.force) {
    // ... show confirmation prompt
} else {
    p.log.info("Rebuilding (--force, skipping confirmation)...");
}
```

Apply this pattern to both `--rebuild-fulltext` and `--rebuild-embeddings` confirmation blocks.

**Step 2: Commit**

```bash
git add src/macos/commands/mail/index-cmd.ts
git commit -m "feat(mail): --force flag bypasses rebuild confirmation prompts"
```

# Mail Index — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `tools macos mail index` for incremental email indexing with body extraction via emlx files, and integrate with `tools macos mail search` for automatic indexed search with `--dumb` fallback.

**Architecture:** MailSource (IndexerSource implementation) scans Apple Mail's Envelope Index SQLite for metadata and reads `.emlx`/`.partial.emlx` files for body text using a tiered L1 summaries → L2 emlx approach. Bodies are chunked as messages (1 email = 1 chunk), embedded, and stored in the shared SearchEngine. Mail search auto-indexes incrementally when an index exists, prompts to create one when it doesn't, and falls back to `--dumb` (current real-time search) when refused.

**Tech Stack:** Bun, bun:sqlite, mailparser (MIME parsing), @clack/prompts, SearchEngine + Embedder from shared layers

**Depends on:** Plan `2026-03-20-Indexer-SearchEngineRefactor.md` — needs IndexerSource interface, SearchEngine rename, model registry

---

## Existing files to understand before starting

| File | What it does |
|------|-------------|
| `src/macos/lib/mail/sqlite.ts` | Opens Envelope Index read-only, `searchMessages()`, `listMessages()`, `getAttachments()`, `getRecipients()` |
| `src/macos/lib/mail/types.ts` | `MailMessage`, `MailMessageRow`, `SearchOptions`, `MailAttachment`, `MailRecipient` |
| `src/macos/lib/mail/constants.ts` | `ENVELOPE_INDEX_PATH`, `parseMailboxUrl()`, `normalizeMailboxName()` |
| `src/macos/lib/mail/jxa.ts` | JXA body extraction — `searchBodies()`, `getMessageBody()` (slow, requires Mail.app) |
| `src/macos/lib/mail/transform.ts` | `rowToMessage()` — converts SQLite row to MailMessage |
| `src/macos/commands/mail/search.ts` | Current search command — SQLite metadata + JXA body + Embedder semantic rerank |
| `src/macos/commands/mail/list.ts` | List command with `--columns`, `--format` |
| `src/macos/commands/mail/index.ts` | Mail command registry (search, list, download) |
| `src/indexer/lib/sources/source.ts` | `IndexerSource` interface (from refactor plan) |
| `src/indexer/lib/indexer.ts` | `Indexer` class with `sync()`, `search()` |
| `src/indexer/lib/manager.ts` | `IndexerManager` — multi-index registry |
| `.claude/plans/mail-body-extraction-research.md` | Research on emlx body extraction methods |

---

## Task 1: Install mailparser and create EmlxBodyExtractor

**Files:**
- Create: `src/macos/lib/mail/emlx.ts`
- Create: `src/macos/lib/mail/emlx.test.ts`

**Step 1: Install mailparser**

```bash
bun add mailparser @types/mailparser
```

**Step 2: Write failing tests**

`src/macos/lib/mail/emlx.test.ts`:
```typescript
import { describe, expect, it, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EmlxBodyExtractor } from "./emlx";

const MAIL_DIR = join(homedir(), "Library/Mail/V10");
const isDarwin = process.platform === "darwin";
const hasMailDir = isDarwin && existsSync(MAIL_DIR);

describe.skipIf(!hasMailDir)("EmlxBodyExtractor", () => {
    let extractor: EmlxBodyExtractor;

    beforeAll(async () => {
        extractor = await EmlxBodyExtractor.create();
    });

    it("builds emlx path index on create", () => {
        // Should have scanned Messages/ directories
        expect(extractor.indexedCount).toBeGreaterThan(0);
    });

    it("getSummary returns body from summaries table for cached messages", () => {
        // Not all messages have summaries, but the method shouldn't throw
        const result = extractor.getSummary(1);
        // Result is string | null
        expect(result === null || typeof result === "string").toBe(true);
    });

    it("getBody returns body text for a known message", async () => {
        // Get any real rowid from the database
        const { getDatabase } = await import("./sqlite");
        const db = getDatabase();
        const row = db.query("SELECT ROWID FROM messages WHERE deleted = 0 LIMIT 1").get() as { ROWID: number } | null;

        if (!row) {
            return; // No messages to test
        }

        const body = await extractor.getBody(row.ROWID);
        // May be null if emlx file doesn't exist, but shouldn't throw
        expect(body === null || typeof body === "string").toBe(true);
    });

    it("getBodies returns bodies for multiple rowids", async () => {
        const { getDatabase } = await import("./sqlite");
        const db = getDatabase();
        const rows = db.query("SELECT ROWID FROM messages WHERE deleted = 0 LIMIT 5").all() as Array<{ ROWID: number }>;
        const rowids = rows.map((r) => r.ROWID);

        const bodies = await extractor.getBodies(rowids);
        expect(bodies.size).toBeLessThanOrEqual(rowids.length);
        // All values should be strings
        for (const body of bodies.values()) {
            expect(typeof body).toBe("string");
        }
    });

    it("parseEmlxFile extracts text body from MIME content", async () => {
        // Find any emlx file
        const path = extractor.getEmlxPath(1);
        if (!path) {
            return; // Skip if no path found
        }

        const body = await extractor.parseEmlxFile(path);
        expect(body === null || typeof body === "string").toBe(true);
    });
});
```

**Step 3: Implement EmlxBodyExtractor**

`src/macos/lib/mail/emlx.ts`:

```typescript
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import { ENVELOPE_INDEX_PATH } from "./constants";

const MAIL_V10_DIR = join(homedir(), "Library/Mail/V10");

export class EmlxBodyExtractor {
    /** Map<rowid, absolute path to .emlx or .partial.emlx> */
    private pathIndex: Map<number, string>;
    /** Envelope Index DB for summaries table */
    private summaryDb: Database | null = null;

    private constructor(pathIndex: Map<number, string>) {
        this.pathIndex = pathIndex;
    }

    /**
     * Create extractor by scanning all Messages/ directories.
     * Takes ~0.7s for ~4000 directories, builds Map<rowid, path>.
     */
    static async create(): Promise<EmlxBodyExtractor> {
        const pathIndex = new Map<number, string>();
        const startMs = performance.now();

        // Walk all Messages/ directories under ~/Library/Mail/V10/
        function scanDir(dir: string): void {
            let entries: ReturnType<typeof readdirSync>;

            try {
                entries = readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const name = String(entry.name);
                const fullPath = join(dir, name);

                if (entry.isDirectory()) {
                    scanDir(fullPath);
                } else if (name.endsWith(".emlx") || name.endsWith(".partial.emlx")) {
                    // Extract rowid from filename: "12345.emlx" or "12345.partial.emlx"
                    const match = name.match(/^(\d+)\./);

                    if (match) {
                        const rowid = parseInt(match[1], 10);
                        // Prefer .emlx over .partial.emlx
                        if (!pathIndex.has(rowid) || name.endsWith(".emlx")) {
                            pathIndex.set(rowid, fullPath);
                        }
                    }
                }
            }
        }

        scanDir(MAIL_V10_DIR);
        const elapsed = performance.now() - startMs;
        logger.debug(`EmlxBodyExtractor: indexed ${pathIndex.size} messages in ${elapsed.toFixed(0)}ms`);

        return new EmlxBodyExtractor(pathIndex);
    }

    get indexedCount(): number {
        return this.pathIndex.size;
    }

    getEmlxPath(rowid: number): string | null {
        return this.pathIndex.get(rowid) ?? null;
    }

    /**
     * L1: Try summaries table in Envelope Index (instant, ~20% hit rate)
     */
    getSummary(rowid: number): string | null {
        if (!this.summaryDb) {
            try {
                this.summaryDb = new Database(ENVELOPE_INDEX_PATH, { readonly: true });
            } catch {
                return null;
            }
        }

        const row = this.summaryDb.query(
            "SELECT sum.summary FROM messages m JOIN summaries sum ON m.summary = sum.ROWID WHERE m.ROWID = ?"
        ).get(rowid) as { summary: string } | null;

        if (row?.summary && row.summary.length > 0) {
            return row.summary;
        }

        return null;
    }

    /**
     * L2: Parse .emlx / .partial.emlx file directly (~42 msgs/sec with mailparser)
     */
    async parseEmlxFile(filePath: string): Promise<string | null> {
        try {
            const content = readFileSync(filePath);
            const newlineIdx = content.indexOf(10); // '\n'

            if (newlineIdx < 0) {
                return null;
            }

            // First line is byte count of MIME content
            let mimeContent: Buffer;
            const firstLine = content.slice(0, newlineIdx).toString().trim();
            const byteCount = parseInt(firstLine, 10);

            if (!isNaN(byteCount) && byteCount > 0) {
                mimeContent = content.slice(newlineIdx + 1, newlineIdx + 1 + byteCount);
            } else {
                // Fallback: read everything after first line
                mimeContent = content.slice(newlineIdx + 1);
            }

            const { simpleParser } = await import("mailparser");
            const parsed = await simpleParser(mimeContent);

            return parsed.text ?? null;
        } catch (err) {
            logger.debug(`Failed to parse emlx ${filePath}: ${err}`);
            return null;
        }
    }

    /**
     * Get body for a single message. L1 summaries → L2 emlx.
     */
    async getBody(rowid: number): Promise<string | null> {
        // L1: Try summaries table first
        const summary = this.getSummary(rowid);

        if (summary) {
            return summary;
        }

        // L2: Direct emlx file reading
        const emlxPath = this.pathIndex.get(rowid);

        if (!emlxPath) {
            return null;
        }

        return this.parseEmlxFile(emlxPath);
    }

    /**
     * Get bodies for multiple messages. Uses L1 batch + L2 for misses.
     */
    async getBodies(rowids: number[]): Promise<Map<number, string>> {
        const result = new Map<number, string>();
        const l2Needed: number[] = [];

        // L1: Batch check summaries
        for (const rowid of rowids) {
            const summary = this.getSummary(rowid);

            if (summary) {
                result.set(rowid, summary);
            } else {
                l2Needed.push(rowid);
            }
        }

        // L2: Parse emlx files for misses
        for (const rowid of l2Needed) {
            const body = await this.getBody(rowid);

            if (body) {
                result.set(rowid, body);
            }
        }

        return result;
    }

    dispose(): void {
        this.summaryDb?.close();
        this.summaryDb = null;
    }
}
```

**Step 4: Run tests**

```bash
bun test src/macos/lib/mail/emlx.test.ts --timeout 30000
```

**Step 5: Commit**

```bash
git add src/macos/lib/mail/emlx.ts src/macos/lib/mail/emlx.test.ts bun.lock package.json
git commit -m "feat(mail): add EmlxBodyExtractor with L1 summaries + L2 emlx parsing"
```

---

## Task 2: Create MailSource (IndexerSource for email)

**Files:**
- Create: `src/indexer/lib/sources/mail-source.ts`
- Create: `src/indexer/lib/sources/mail-source.test.ts`
- Modify: `src/indexer/lib/sources/index.ts`

**Depends on:** Task 5 from Refactor plan (IndexerSource interface), Task 1 above (EmlxBodyExtractor)

**Step 1: Write failing tests**

`src/indexer/lib/sources/mail-source.test.ts`:
```typescript
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MailSource } from "./mail-source";

const isDarwin = process.platform === "darwin";
const ENVELOPE = join(homedir(), "Library/Mail/V10/MailData/Envelope Index");
const hasMailDb = isDarwin && existsSync(ENVELOPE);

describe.skipIf(!hasMailDb)("MailSource", () => {
    it("scan returns SourceEntry array with mail content", async () => {
        const source = await MailSource.create();

        try {
            const entries = await source.scan({ limit: 10 });

            expect(entries.length).toBeGreaterThan(0);
            expect(entries.length).toBeLessThanOrEqual(10);

            const first = entries[0];
            expect(first.id).toBeDefined();
            expect(first.content.length).toBeGreaterThan(0);
            expect(first.path).toBeDefined(); // e.g., "INBOX/Subject line"
        } finally {
            source.dispose();
        }
    }, { timeout: 30_000 });

    it("scan calls onProgress callback", async () => {
        const source = await MailSource.create();
        let progressCalled = false;

        try {
            await source.scan({
                limit: 5,
                onProgress: (current, total) => {
                    progressCalled = true;
                    expect(current).toBeLessThanOrEqual(total);
                },
            });

            expect(progressCalled).toBe(true);
        } finally {
            source.dispose();
        }
    }, { timeout: 30_000 });

    it("estimateTotal returns message count", async () => {
        const source = await MailSource.create();

        try {
            const total = await source.estimateTotal();
            expect(total).toBeGreaterThan(0);
        } finally {
            source.dispose();
        }
    }, { timeout: 30_000 });

    it("detectChanges identifies new messages via watermark", async () => {
        const source = await MailSource.create();

        try {
            const entries = await source.scan({ limit: 5 });

            // First sync: everything is new
            const changes1 = source.detectChanges({
                previousHashes: null,
                currentEntries: entries,
            });

            expect(changes1.added.length).toBe(entries.length);
            expect(changes1.unchanged.length).toBe(0);

            // Second sync: nothing changed
            const hashes = new Map<string, string>();
            for (const entry of entries) {
                hashes.set(entry.id, source.hashEntry(entry));
            }

            const changes2 = source.detectChanges({
                previousHashes: hashes,
                currentEntries: entries,
            });

            expect(changes2.added.length).toBe(0);
            expect(changes2.unchanged.length).toBe(entries.length);
        } finally {
            source.dispose();
        }
    }, { timeout: 30_000 });

    it("entry content includes subject, sender, and body", async () => {
        const source = await MailSource.create();

        try {
            const entries = await source.scan({ limit: 1 });

            if (entries.length > 0) {
                const content = entries[0].content;
                // Content should have structured format
                expect(content).toContain("Subject:");
                expect(content).toContain("From:");
            }
        } finally {
            source.dispose();
        }
    }, { timeout: 30_000 });
});
```

**Step 2: Implement MailSource**

`src/indexer/lib/sources/mail-source.ts`:
```typescript
import { Database } from "bun:sqlite";
import { ENVELOPE_INDEX_PATH, normalizeMailboxName, parseMailboxUrl } from "@app/macos/lib/mail/constants";
import { EmlxBodyExtractor } from "@app/macos/lib/mail/emlx";
import type { DetectChangesOptions, IndexerSource, ScanOptions, SourceChanges, SourceEntry } from "./source";

interface MailRow {
    rowid: number;
    subject: string;
    senderAddress: string;
    senderName: string;
    dateSent: number;
    dateReceived: number;
    mailboxUrl: string;
    read: number;
    flagged: number;
    size: number;
}

export class MailSource implements IndexerSource {
    private db: Database;
    private emlx: EmlxBodyExtractor;

    private constructor(db: Database, emlx: EmlxBodyExtractor) {
        this.db = db;
        this.emlx = emlx;
    }

    static async create(): Promise<MailSource> {
        const db = new Database(ENVELOPE_INDEX_PATH, { readonly: true });
        const emlx = await EmlxBodyExtractor.create();
        return new MailSource(db, emlx);
    }

    async scan(opts?: ScanOptions): Promise<SourceEntry[]> {
        const limit = opts?.limit ?? 100_000;

        // Get total for progress
        const totalRow = this.db.query(
            "SELECT COUNT(*) AS cnt FROM messages WHERE deleted = 0"
        ).get() as { cnt: number };
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
            WHERE m.deleted = 0
            ORDER BY m.date_received DESC
            LIMIT ?
        `).all(limit) as MailRow[];

        const entries: SourceEntry[] = [];
        const rowids = rows.map((r) => r.rowid);

        // Batch fetch bodies
        const bodies = await this.emlx.getBodies(rowids);

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const body = bodies.get(row.rowid) ?? "";
            const { mailbox } = parseMailboxUrl(row.mailboxUrl ?? "");
            const normalizedMailbox = normalizeMailboxName(mailbox);

            const content = [
                `Subject: ${row.subject ?? "(no subject)"}`,
                `From: ${row.senderName ?? ""} <${row.senderAddress ?? ""}>`,
                `Date: ${new Date(row.dateSent * 1000).toISOString()}`,
                `Mailbox: ${normalizedMailbox}`,
                "",
                body,
            ].join("\n");

            entries.push({
                id: String(row.rowid),
                content,
                path: `${normalizedMailbox}/${row.subject ?? "(no subject)"}`,
                metadata: {
                    rowid: row.rowid,
                    senderAddress: row.senderAddress,
                    senderName: row.senderName,
                    dateSent: row.dateSent,
                    dateReceived: row.dateReceived,
                    mailbox: normalizedMailbox,
                    read: row.read === 1,
                    flagged: row.flagged === 1,
                    size: row.size,
                    hasBody: body.length > 0,
                },
            });

            if (opts?.onProgress) {
                opts.onProgress(i + 1, total);
            }
        }

        return entries;
    }

    detectChanges(opts: DetectChangesOptions): SourceChanges {
        const { previousHashes, currentEntries, full } = opts;

        if (!previousHashes || full) {
            // First sync or full reindex: everything is new
            return {
                added: currentEntries,
                modified: [],
                deleted: [],
                unchanged: [],
            };
        }

        const added: SourceEntry[] = [];
        const modified: SourceEntry[] = [];
        const unchanged: string[] = [];
        const currentIds = new Set<string>();

        for (const entry of currentEntries) {
            currentIds.add(entry.id);
            const prevHash = previousHashes.get(entry.id);

            if (!prevHash) {
                added.push(entry);
            } else if (prevHash !== this.hashEntry(entry)) {
                modified.push(entry);
            } else {
                unchanged.push(entry.id);
            }
        }

        // Deleted: in previous but not in current
        const deleted: string[] = [];
        for (const id of previousHashes.keys()) {
            if (!currentIds.has(id)) {
                deleted.push(id);
            }
        }

        return { added, modified, deleted, unchanged };
    }

    async estimateTotal(): Promise<number> {
        const row = this.db.query(
            "SELECT COUNT(*) AS cnt FROM messages WHERE deleted = 0"
        ).get() as { cnt: number };
        return row.cnt;
    }

    hashEntry(entry: SourceEntry): string {
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(entry.content);
        return hasher.digest("hex");
    }

    dispose(): void {
        this.db.close();
        this.emlx.dispose();
    }
}
```

**Step 3: Export from sources/index.ts**

```typescript
export { MailSource } from "./mail-source";
```

**Step 4: Run tests, commit**

```bash
bun test src/indexer/lib/sources/mail-source.test.ts --timeout 60000
git commit -m "feat(indexer): add MailSource — IndexerSource for Apple Mail with emlx body extraction"
```

---

## Task 3: `tools macos mail index` command

**Files:**
- Create: `src/macos/commands/mail/index-cmd.ts` (not `index.ts` — that's the command registry)
- Modify: `src/macos/commands/mail/index.ts` — register the new command

**Step 1: Implement the index command**

```
tools macos mail index [options]
  --model <name>     Embedding model (required first time, remembered after)
  --limit <n>        Max messages to index (default: all)
  --no-embed         Fulltext only, no semantic search
  --rebuild          Force full reindex
```

Implementation:
1. Check if "macos-mail" index exists in IndexerManager
2. If exists: run incremental sync, show progress
3. If not: prompt for model (with type-appropriate recommendations), create index, sync
4. Show stats: indexed messages, chunks, DB size, body coverage, time taken

Progress display:
```
Scanning...     12,345 / 213,744 messages (5.8%)
Bodies (L1)...  42,100 / 213,744 from summaries (19.7%)
Bodies (L2)...  171,644 / 213,744 from emlx files (80.3%)
Embedding...    50,000 / 213,744 chunks (23.4%)  [DarwinKit NL 512-dim]
Storing...      done

Index: macos-mail | 213,744 messages | 198.2 MB | DarwinKit NL (512-dim)
  Bodies found: 198,412 / 213,744 (92.8%)
  Last sync: just now
  Search: tools macos mail search "your query"
```

**Step 2: Register in mail command index**

In `src/macos/commands/mail/index.ts`:
```typescript
import { registerIndexCommand } from "./index-cmd";
// ...
registerIndexCommand(mail);
```

**Step 3: Tests + commit**

```bash
bun test src/e2e/macos-mail.e2e.test.ts --timeout 120000
git commit -m "feat(mail): add 'tools macos mail index' command with incremental sync"
```

---

## Task 4: Integrate indexed search into `tools macos mail search`

**Files:**
- Modify: `src/macos/commands/mail/search.ts`

**Step 1: Add auto-index detection and --dumb flag**

At the top of the search action:

```typescript
.option("--dumb", "Skip index, use legacy real-time search")
```

Search flow:
```typescript
async (query, options) => {
    if (options.dumb) {
        return legacySearch(query, options); // current behavior, extracted
    }

    const manager = await IndexerManager.load();
    const indexNames = manager.getIndexNames();
    const hasMailIndex = indexNames.includes("macos-mail");

    if (hasMailIndex) {
        // Auto incremental sync (fast — check watermark, index new messages)
        const indexer = await manager.getIndex("macos-mail");
        const spinner = p.spinner();

        // Quick sync — only new messages since last index
        const stats = await indexer.sync();
        if (stats.chunksAdded > 0) {
            p.log.info(`Indexed ${stats.chunksAdded} new messages`);
        }

        // Search the index
        const results = await indexer.search(query, {
            mode: options.mode ?? "hybrid",
            limit: options.limit,
        });

        // Display results using existing formatResultsTable
        displayIndexedResults(results, options);
        await manager.close();
        return;
    }

    // No index exists
    if (process.stdout.isTTY) {
        const models = getModelsForType("mail");
        const topModels = models.slice(0, 3);

        const choice = await p.select({
            message: "No mail index found. Index now for faster search?",
            options: [
                ...topModels.map((m) => ({
                    value: m.id,
                    label: `${m.name} (${m.dimensions}-dim, ${m.ramGB > 0 ? m.ramGB + "GB RAM" : "free"})`,
                    hint: m.description,
                })),
                { value: "no-embed", label: "Fulltext only (no semantic, instant)", hint: "BM25 keyword search" },
                { value: "dumb", label: "Skip indexing, use legacy search", hint: "Current slow method" },
            ],
        });

        if (p.isCancel(choice) || choice === "dumb") {
            return legacySearch(query, options);
        }

        // Run indexing then search
        // ... create index with chosen model, sync, search ...
    } else {
        // Non-TTY: fall back to legacy
        return legacySearch(query, options);
    }
}
```

**Step 2: Extract current search logic into legacySearch()**

Move the entire current search action body (SQLite metadata → JXA body → Embedder rerank) into a `legacySearch()` function in the same file.

**Step 3: Display indexed results**

Use the existing `formatResultsTable()` from `src/macos/lib/mail/format.ts` with columns from `src/macos/lib/mail/columns.ts`. Map `SearchResult<ChunkRecord>` back to a display format.

**Step 4: Tests + commit**

```bash
# E2E: verify --dumb flag works
bun test src/e2e/macos-mail.e2e.test.ts --timeout 120000
git commit -m "feat(mail): integrate indexed search with auto-index prompt and --dumb fallback"
```

---

## Task 5: TelegramSource (IndexerSource for Telegram)

**Files:**
- Create: `src/indexer/lib/sources/telegram-source.ts`
- Create: `src/indexer/lib/sources/telegram-source.test.ts`
- Modify: `src/indexer/lib/sources/index.ts`

**Step 1: Implement TelegramSource**

Similar to MailSource but reads from the existing Telegram SQLite database. Each message = one `SourceEntry`.

The existing `TelegramHistoryStore` already uses `SearchEngine.fromDatabase()`. `TelegramSource` doesn't replace it — it provides a way to register Telegram chat history as an indexer index for cross-source search via `tools indexer search`.

```typescript
export class TelegramSource implements IndexerSource {
    static async create(dbPath: string): Promise<TelegramSource>;

    async scan(opts?: ScanOptions): Promise<SourceEntry[]>;
    detectChanges(opts: DetectChangesOptions): SourceChanges;
    hashEntry(entry: SourceEntry): string;
}
```

**Step 2: Export and test**

```bash
bun test src/indexer/lib/sources/telegram-source.test.ts --timeout 30000
git commit -m "feat(indexer): add TelegramSource for chat history indexing"
```

---

## Task 6: E2E Tests

**Files:**
- Create: `src/e2e/mail-index.e2e.test.ts`
- Modify: `src/e2e/macos-mail.e2e.test.ts`

**Tests:**

1. `tools macos mail index --help` — exits 0, shows options
2. `tools macos mail search --help` — shows `--dumb` flag
3. `tools macos mail search "test" --dumb` — uses legacy path, exits 0
4. Full flow (skipIf !darwin):
   - `tools macos mail index --no-embed --limit 100` — indexes 100 messages
   - `tools indexer status` — shows "macos-mail" index
   - `tools macos mail search "test"` — uses index automatically
   - `tools indexer remove macos-mail --force` — cleanup

**Commit:**

```bash
git commit -m "test(mail): add e2e tests for mail index and indexed search"
```

---

## Verification

```bash
# Type check
tsgo --noEmit | grep "src/macos\|src/indexer"

# Mail lib tests
bun test src/macos/lib/mail/ --timeout 60000

# Indexer source tests
bun test src/indexer/lib/sources/ --timeout 60000

# E2E
bun test src/e2e/mail-index.e2e.test.ts --timeout 120000
bun test src/e2e/macos-mail.e2e.test.ts --timeout 120000

# Verify indexer still works
bun test src/indexer/ --timeout 60000

# Smoke test
tools macos mail index --no-embed --limit 50
tools macos mail search "invoice"
tools macos mail search "invoice" --dumb
tools indexer status
```

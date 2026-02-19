# Telegram Conversation History — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `tools telegram history` subcommands to download, search, export, and analyze Telegram conversation history. Messages are stored in a local SQLite database with FTS5 full-text search and sqlite-vec 512-dimensional vector embeddings for semantic search.

**Architecture:** `TelegramHistoryStore` class wraps `better-sqlite3` + `sqlite-vec`. Downloads use the existing `TGClient.getMessages()` async generator with incremental sync. Embeddings come from `embedText()` via DarwinKit NaturalLanguage framework (macOS only, 7 languages). Four new Commander subcommands under `tools telegram history ...`.

**Tech Stack:** `better-sqlite3` + `sqlite-vec` for FTS5 + vector search, Commander subcommands, @clack/prompts for interactive UI, DarwinKit NLP for embeddings/language detection.

---

## Context

Phase 1 (already implemented) created `tools telegram` with `configure`, `listen`, and `contacts` commands. The following Phase 2 hooks are already in place:

- `TGClient.getMessages(userId, options)` — async generator over `Api.Message` with limit/offsetDate/minId/maxId
- `TGClient.getMessageCount(userId)` — total message count for progress bars
- `TelegramMessage.toJSON()` → `SerializedMessage { id, senderId, text, mediaDescription, isOutgoing, date, dateUnix }`
- `TelegramToolConfig` uses `Storage("telegram")` → `~/.genesis-tools/telegram/`
- `better-sqlite3` and `@types/better-sqlite3` already in deps
- `embedText(text, language?, type?)` from `@app/utils/macos/nlp` → 512-dim vectors
- `detectLanguage(text)` from `@app/utils/macos/nlp` → BCP-47 language code + confidence

## File Structure

```
src/telegram/
├── index.ts                              # MODIFY: register history command group
├── commands/
│   ├── history.ts                        # NEW: Commander group + download/search/export/stats subcommands
│   ├── configure.ts                      # existing
│   ├── contacts.ts                       # existing
│   └── listen.ts                         # existing
├── lib/
│   ├── TelegramHistoryStore.ts           # NEW: SQLite store with FTS5 + sqlite-vec
│   ├── TGClient.ts                       # existing (has getMessages/getMessageCount)
│   ├── TelegramMessage.ts               # existing (has toJSON/SerializedMessage)
│   ├── TelegramToolConfig.ts            # existing
│   ├── TelegramContact.ts               # existing
│   ├── types.ts                          # MODIFY: add history-related types
│   ├── handler.ts                        # existing
│   └── actions/                          # existing
```

## Critical Reference Files

Read these files before implementing (already in the codebase):

- `src/telegram/lib/TGClient.ts` — `getMessages()` async generator, `getMessageCount()`, `fromConfig()`, `connect()`
- `src/telegram/lib/TelegramMessage.ts` — `TelegramMessage` class, `toJSON()`, `SerializedMessage` interface
- `src/telegram/lib/TelegramToolConfig.ts` — `TelegramToolConfig` class, `load()`, `getContacts()`, `hasValidSession()`
- `src/telegram/lib/types.ts` — `ContactConfig` interface, `DEFAULTS` object
- `src/telegram/commands/listen.ts` — pattern for connecting client and checking auth
- `src/telegram/commands/contacts.ts` — pattern for @clack/prompts UI in commands
- `src/telegram/index.ts` — Commander program registration pattern
- `src/utils/macos/nlp.ts` — `embedText()`, `detectLanguage()` signatures
- `src/utils/macos/types.ts` — `EmbedResult { vector, dimension }`, `LanguageResult { language, confidence }`
- `src/utils/format.ts` — `formatNumber()`, `formatDuration()`, `formatRelativeTime()`
- `src/utils/table.ts` — `formatTable(rows, headers, options)`
- `src/utils/storage/storage.ts` — `Storage` class, `getBaseDir()`

## Code Style Rules (MUST FOLLOW)

- No one-line if statements — always use block form with braces
- Empty line before `if` (unless preceded by variable used by that if)
- Empty line after closing `}` (unless else/catch/finally/another `}`)
- No `as any` — use proper type narrowing
- Runtime: Bun (use Bun.spawn, Bun.write, etc.)
- Use `@app/...` import aliases (maps to `./src/*`)
- Use `bunx tsgo --noEmit` for type checking (not `tsc`)
- Use `bun add` for packages (not `npm install`)
- Use `bunx` instead of `npx`
- No file-path comments as first line of files
- No obvious comments that restate what the code says

---

## Task 1: Install sqlite-vec + Create TelegramHistoryStore

**Files:**
- Modify: `package.json` — add `sqlite-vec` dependency
- Create: `src/telegram/lib/TelegramHistoryStore.ts` — SQLite store class
- Modify: `src/telegram/lib/types.ts` — add history-related types

### Step 1: Install sqlite-vec

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools/.worktrees/feat-telegram
bun add sqlite-vec
```

### Step 2: Verify sqlite-vec works with better-sqlite3

```bash
bun -e "
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
const db = new Database(':memory:');
sqliteVec.load(db);
const version = db.prepare('SELECT vec_version()').pluck().get();
console.log('sqlite-vec version:', version);
db.close();
"
```

Expected output: `sqlite-vec version: v0.x.x`

If the import fails, try:
```typescript
import Database from "better-sqlite3";
import sqliteVec from "sqlite-vec";
```

**IMPORTANT:** Note whichever import style works (named `* as sqliteVec` or default `sqliteVec`) and use it consistently in the store class.

### Step 3: Add history types to `src/telegram/lib/types.ts`

Add the following types at the end of the existing file (after the `DEFAULTS` object). Do NOT remove any existing code.

```typescript
// ── History Types (Phase 2) ─────────────────────────────────────────

export interface MessageRow {
	id: number;
	chat_id: string;
	sender_id: string | null;
	text: string | null;
	media_desc: string | null;
	is_outgoing: number;
	date_unix: number;
	date_iso: string;
}

export interface SyncStateRow {
	chat_id: string;
	last_synced_id: number;
	last_synced_at: string;
}

export interface SearchOptions {
	since?: Date;
	until?: Date;
	limit?: number;
}

export interface SearchResult {
	message: MessageRow;
	rank?: number;
	distance?: number;
	score?: number;
}

export interface ChatStats {
	chatId: string;
	displayName?: string;
	totalMessages: number;
	outgoingMessages: number;
	incomingMessages: number;
	firstMessageDate: string | null;
	lastMessageDate: string | null;
	embeddedMessages: number;
}

/** Languages supported by macOS NLEmbedding */
export const EMBEDDING_LANGUAGES = new Set(["en", "es", "fr", "de", "it", "pt", "zh"]);
```

### Step 4: Create `src/telegram/lib/TelegramHistoryStore.ts`

```typescript
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import logger from "@app/logger";
import type {
	MessageRow,
	SyncStateRow,
	SearchOptions,
	SearchResult,
	ChatStats,
} from "./types";
import type { SerializedMessage } from "./TelegramMessage";

const DB_PATH = join(homedir(), ".genesis-tools", "telegram", "history.db");

export class TelegramHistoryStore {
	private db: BetterSqlite3.Database | null = null;

	open(dbPath: string = DB_PATH): void {
		if (this.db) {
			return;
		}

		const dir = dirname(dbPath);

		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		this.db = new Database(dbPath);
		sqliteVec.load(this.db);

		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");

		this.initSchema();
		logger.debug("TelegramHistoryStore opened");
	}

	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
			logger.debug("TelegramHistoryStore closed");
		}
	}

	private getDb(): BetterSqlite3.Database {
		if (!this.db) {
			throw new Error("TelegramHistoryStore not opened. Call open() first.");
		}

		return this.db;
	}

	private initSchema(): void {
		const db = this.getDb();

		db.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER NOT NULL,
				chat_id TEXT NOT NULL,
				sender_id TEXT,
				text TEXT,
				media_desc TEXT,
				is_outgoing INTEGER NOT NULL,
				date_unix INTEGER NOT NULL,
				date_iso TEXT NOT NULL,
				PRIMARY KEY (chat_id, id)
			);

			CREATE INDEX IF NOT EXISTS idx_messages_chat_date
				ON messages(chat_id, date_unix);

			CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
				text,
				content=messages,
				content_rowid=rowid,
				tokenize='unicode61'
			);

			CREATE TABLE IF NOT EXISTS sync_state (
				chat_id TEXT PRIMARY KEY,
				last_synced_id INTEGER NOT NULL,
				last_synced_at TEXT NOT NULL
			);
		`);

		// FTS5 external content triggers — only create if they don't exist.
		// We use TRY since CREATE TRIGGER IF NOT EXISTS doesn't exist in all SQLite versions.
		try {
			db.exec(`
				CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
					INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
				END;
			`);
		} catch {
			// trigger already exists
		}

		try {
			db.exec(`
				CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
					INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
				END;
			`);
		} catch {
			// trigger already exists
		}

		try {
			db.exec(`
				CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
					INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
					INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
				END;
			`);
		} catch {
			// trigger already exists
		}

		// sqlite-vec virtual table for embeddings
		try {
			db.exec(`
				CREATE VIRTUAL TABLE IF NOT EXISTS messages_vec USING vec0(
					message_rowid INTEGER PRIMARY KEY,
					embedding float[512]
				);
			`);
		} catch (err) {
			logger.warn(`Could not create messages_vec table: ${err}`);
		}
	}

	// ── Insert ────────────────────────────────────────────────────────

	insertMessages(chatId: string, messages: SerializedMessage[]): number {
		const db = this.getDb();
		let inserted = 0;

		const insertStmt = db.prepare(`
			INSERT OR IGNORE INTO messages (id, chat_id, sender_id, text, media_desc, is_outgoing, date_unix, date_iso)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);

		const insertMany = db.transaction((msgs: SerializedMessage[]) => {
			for (const msg of msgs) {
				const result = insertStmt.run(
					msg.id,
					chatId,
					msg.senderId ?? null,
					msg.text || null,
					msg.mediaDescription ?? null,
					msg.isOutgoing ? 1 : 0,
					msg.dateUnix,
					msg.date,
				);

				if (result.changes > 0) {
					inserted++;
				}
			}
		});

		insertMany(messages);
		return inserted;
	}

	// ── Embeddings ────────────────────────────────────────────────────

	getUnembeddedMessages(chatId: string, limit = 500): MessageRow[] {
		const db = this.getDb();

		return db.prepare(`
			SELECT m.*
			FROM messages m
			LEFT JOIN messages_vec v ON v.message_rowid = m.rowid
			WHERE m.chat_id = ?
				AND m.text IS NOT NULL
				AND m.text != ''
				AND v.message_rowid IS NULL
			ORDER BY m.date_unix ASC
			LIMIT ?
		`).all(chatId, limit) as MessageRow[];
	}

	insertEmbedding(chatId: string, messageId: number, embedding: Float32Array): void {
		const db = this.getDb();

		// Get the rowid for this message
		const row = db.prepare(
			"SELECT rowid FROM messages WHERE chat_id = ? AND id = ?"
		).get(chatId, messageId) as { rowid: number } | undefined;

		if (!row) {
			return;
		}

		db.prepare(
			"INSERT OR REPLACE INTO messages_vec (message_rowid, embedding) VALUES (?, ?)"
		).run(row.rowid, Buffer.from(embedding.buffer));
	}

	getEmbeddedCount(chatId: string): number {
		const db = this.getDb();

		const row = db.prepare(`
			SELECT COUNT(*) AS cnt
			FROM messages_vec v
			JOIN messages m ON m.rowid = v.message_rowid
			WHERE m.chat_id = ?
		`).get(chatId) as { cnt: number };

		return row.cnt;
	}

	// ── Search ────────────────────────────────────────────────────────

	search(chatId: string, query: string, options: SearchOptions = {}): SearchResult[] {
		const db = this.getDb();
		const params: (string | number)[] = [];

		let dateFilter = "";

		if (options.since) {
			dateFilter += " AND m.date_unix >= ?";
			params.push(Math.floor(options.since.getTime() / 1000));
		}

		if (options.until) {
			dateFilter += " AND m.date_unix <= ?";
			params.push(Math.floor(options.until.getTime() / 1000));
		}

		const limit = options.limit ?? 20;

		// FTS5 query — escape special characters for safety
		const ftsQuery = query
			.replace(/['"]/g, "")
			.split(/\s+/)
			.filter(Boolean)
			.map((word) => `"${word}"`)
			.join(" ");

		if (!ftsQuery) {
			return [];
		}

		const sql = `
			SELECT m.*, fts.rank
			FROM messages_fts fts
			JOIN messages m ON m.rowid = fts.rowid
			WHERE messages_fts MATCH ?
				AND m.chat_id = ?
				${dateFilter}
			ORDER BY fts.rank
			LIMIT ?
		`;

		const rows = db.prepare(sql).all(ftsQuery, chatId, ...params, limit) as Array<MessageRow & { rank: number }>;

		return rows.map((row) => ({
			message: {
				id: row.id,
				chat_id: row.chat_id,
				sender_id: row.sender_id,
				text: row.text,
				media_desc: row.media_desc,
				is_outgoing: row.is_outgoing,
				date_unix: row.date_unix,
				date_iso: row.date_iso,
			},
			rank: row.rank,
		}));
	}

	semanticSearch(chatId: string, queryEmbedding: Float32Array, options: SearchOptions = {}): SearchResult[] {
		const db = this.getDb();
		const limit = options.limit ?? 20;

		// KNN search via sqlite-vec
		// We fetch more than needed so we can apply date filters in the outer query
		const knnLimit = Math.min(limit * 5, 200);

		let dateFilter = "";
		const dateParams: number[] = [];

		if (options.since) {
			dateFilter += " AND m.date_unix >= ?";
			dateParams.push(Math.floor(options.since.getTime() / 1000));
		}

		if (options.until) {
			dateFilter += " AND m.date_unix <= ?";
			dateParams.push(Math.floor(options.until.getTime() / 1000));
		}

		const sql = `
			SELECT m.*, v.distance
			FROM messages_vec v
			JOIN messages m ON m.rowid = v.message_rowid
			WHERE v.embedding MATCH ?
				AND k = ?
				AND m.chat_id = ?
				${dateFilter}
			ORDER BY v.distance ASC
			LIMIT ?
		`;

		const embeddingBuffer = Buffer.from(queryEmbedding.buffer);

		const rows = db.prepare(sql).all(
			embeddingBuffer,
			knnLimit,
			chatId,
			...dateParams,
			limit,
		) as Array<MessageRow & { distance: number }>;

		return rows.map((row) => ({
			message: {
				id: row.id,
				chat_id: row.chat_id,
				sender_id: row.sender_id,
				text: row.text,
				media_desc: row.media_desc,
				is_outgoing: row.is_outgoing,
				date_unix: row.date_unix,
				date_iso: row.date_iso,
			},
			distance: row.distance,
		}));
	}

	hybridSearch(
		chatId: string,
		query: string,
		queryEmbedding: Float32Array,
		options: SearchOptions = {},
	): SearchResult[] {
		const ftsResults = this.search(chatId, query, { ...options, limit: 100 });
		const vecResults = this.semanticSearch(chatId, queryEmbedding, { ...options, limit: 100 });

		// Reciprocal Rank Fusion (k=60)
		const K = 60;
		const scores = new Map<number, { score: number; row: MessageRow }>();

		for (let i = 0; i < ftsResults.length; i++) {
			const r = ftsResults[i];
			const rrfScore = 1.0 / (K + i + 1);
			const existing = scores.get(r.message.id);

			if (existing) {
				existing.score += rrfScore;
			} else {
				scores.set(r.message.id, { score: rrfScore, row: r.message });
			}
		}

		for (let i = 0; i < vecResults.length; i++) {
			const r = vecResults[i];
			const rrfScore = 1.0 / (K + i + 1);
			const existing = scores.get(r.message.id);

			if (existing) {
				existing.score += rrfScore;
			} else {
				scores.set(r.message.id, { score: rrfScore, row: r.message });
			}
		}

		const limit = options.limit ?? 20;

		return [...scores.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((entry) => ({
				message: entry.row,
				score: entry.score,
			}));
	}

	// ── Date Range Queries ────────────────────────────────────────────

	getByDateRange(chatId: string, since?: Date, until?: Date, limit?: number): MessageRow[] {
		const db = this.getDb();
		const params: (string | number)[] = [chatId];
		let dateFilter = "";

		if (since) {
			dateFilter += " AND date_unix >= ?";
			params.push(Math.floor(since.getTime() / 1000));
		}

		if (until) {
			dateFilter += " AND date_unix <= ?";
			params.push(Math.floor(until.getTime() / 1000));
		}

		const limitClause = limit ? " LIMIT ?" : "";

		if (limit) {
			params.push(limit);
		}

		return db.prepare(`
			SELECT * FROM messages
			WHERE chat_id = ? ${dateFilter}
			ORDER BY date_unix ASC
			${limitClause}
		`).all(...params) as MessageRow[];
	}

	// ── Sync State ────────────────────────────────────────────────────

	getLastSyncedId(chatId: string): number | null {
		const db = this.getDb();
		const row = db.prepare(
			"SELECT last_synced_id FROM sync_state WHERE chat_id = ?"
		).get(chatId) as SyncStateRow | undefined;

		return row?.last_synced_id ?? null;
	}

	setLastSyncedId(chatId: string, messageId: number): void {
		const db = this.getDb();

		db.prepare(`
			INSERT INTO sync_state (chat_id, last_synced_id, last_synced_at)
			VALUES (?, ?, datetime('now'))
			ON CONFLICT(chat_id) DO UPDATE SET
				last_synced_id = excluded.last_synced_id,
				last_synced_at = excluded.last_synced_at
		`).run(chatId, messageId);
	}

	// ── Stats ─────────────────────────────────────────────────────────

	getStats(chatId?: string): ChatStats[] {
		const db = this.getDb();

		if (chatId) {
			const row = db.prepare(`
				SELECT
					chat_id,
					COUNT(*) AS total_messages,
					SUM(CASE WHEN is_outgoing = 1 THEN 1 ELSE 0 END) AS outgoing_messages,
					SUM(CASE WHEN is_outgoing = 0 THEN 1 ELSE 0 END) AS incoming_messages,
					MIN(date_iso) AS first_message_date,
					MAX(date_iso) AS last_message_date
				FROM messages
				WHERE chat_id = ?
				GROUP BY chat_id
			`).get(chatId) as {
				chat_id: string;
				total_messages: number;
				outgoing_messages: number;
				incoming_messages: number;
				first_message_date: string | null;
				last_message_date: string | null;
			} | undefined;

			if (!row) {
				return [];
			}

			const embeddedCount = this.getEmbeddedCount(chatId);

			return [{
				chatId: row.chat_id,
				totalMessages: row.total_messages,
				outgoingMessages: row.outgoing_messages,
				incomingMessages: row.incoming_messages,
				firstMessageDate: row.first_message_date,
				lastMessageDate: row.last_message_date,
				embeddedMessages: embeddedCount,
			}];
		}

		const rows = db.prepare(`
			SELECT
				chat_id,
				COUNT(*) AS total_messages,
				SUM(CASE WHEN is_outgoing = 1 THEN 1 ELSE 0 END) AS outgoing_messages,
				SUM(CASE WHEN is_outgoing = 0 THEN 1 ELSE 0 END) AS incoming_messages,
				MIN(date_iso) AS first_message_date,
				MAX(date_iso) AS last_message_date
			FROM messages
			GROUP BY chat_id
			ORDER BY total_messages DESC
		`).all() as Array<{
			chat_id: string;
			total_messages: number;
			outgoing_messages: number;
			incoming_messages: number;
			first_message_date: string | null;
			last_message_date: string | null;
		}>;

		return rows.map((row) => ({
			chatId: row.chat_id,
			totalMessages: row.total_messages,
			outgoingMessages: row.outgoing_messages,
			incomingMessages: row.incoming_messages,
			firstMessageDate: row.first_message_date,
			lastMessageDate: row.last_message_date,
			embeddedMessages: this.getEmbeddedCount(row.chat_id),
		}));
	}

	getTotalMessageCount(): number {
		const db = this.getDb();
		const row = db.prepare("SELECT COUNT(*) AS cnt FROM messages").get() as { cnt: number };
		return row.cnt;
	}
}
```

### Step 5: Verify type checking

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools/.worktrees/feat-telegram
bunx tsgo --noEmit 2>&1 | rg "src/telegram/"
```

Expected: No errors in `src/telegram/` files. If `better-sqlite3` import types fail, check that `@types/better-sqlite3` is installed (it is — already in deps).

**IMPORTANT:** If `sqliteVec.load(db)` has a type mismatch between `better-sqlite3` Database and what `sqlite-vec` expects, use a type assertion: `sqliteVec.load(db as unknown as Parameters<typeof sqliteVec.load>[0])`. But try the direct call first — it usually works.

### Verification

1. Type check passes (`bunx tsgo --noEmit`)
2. Smoke test the store:

```bash
bun -e "
import { TelegramHistoryStore } from './src/telegram/lib/TelegramHistoryStore';

const store = new TelegramHistoryStore();
store.open(':memory:');

// Insert a test message
store.insertMessages('test-chat', [{
  id: 1,
  senderId: '12345',
  text: 'Hello world, this is a test message',
  mediaDescription: undefined,
  isOutgoing: false,
  date: '2025-01-15T10:30:00.000Z',
  dateUnix: 1736936400,
}]);

// FTS search
const results = store.search('test-chat', 'hello');
console.log('FTS results:', results.length);
console.log('First result text:', results[0]?.message.text);

// Stats
const stats = store.getStats('test-chat');
console.log('Stats:', JSON.stringify(stats[0]));

store.close();
console.log('Store smoke test passed!');
"
```

*(No commit yet — will commit together with Task 2)*

---

## Task 2: Add Download Command with Incremental Sync + Progress

**Files:**
- Create: `src/telegram/commands/history.ts` — Commander group with download subcommand
- Modify: `src/telegram/index.ts` — register history command group

### Step 1: Create `src/telegram/commands/history.ts`

This file contains all four history subcommands. Start with the download command; the other commands will be added in later tasks.

```typescript
import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import logger from "@app/logger";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import { TelegramMessage } from "../lib/TelegramMessage";
import type { SerializedMessage } from "../lib/TelegramMessage";
import { TelegramHistoryStore } from "../lib/TelegramHistoryStore";
import type { ContactConfig, MessageRow, SearchResult, ChatStats } from "../lib/types";
import { EMBEDDING_LANGUAGES } from "../lib/types";
import { formatNumber, formatRelativeTime } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import { embedText, detectLanguage } from "@app/utils/macos/nlp";
import type { EmbedResult } from "@app/utils/macos/types";

// ── Helpers ───────────────────────────────────────────────────────────

function parseDate(value: string): Date {
	const d = new Date(value);

	if (Number.isNaN(d.getTime())) {
		throw new Error(`Invalid date: ${value}`);
	}

	return d;
}

async function ensureClient(config: TelegramToolConfig): Promise<TGClient | null> {
	if (!config.hasValidSession()) {
		p.log.error("Not configured. Run: tools telegram configure");
		return null;
	}

	const client = TGClient.fromConfig(config);
	const authorized = await client.connect();

	if (!authorized) {
		p.log.error("Session expired. Run: tools telegram configure");
		return null;
	}

	return client;
}

function resolveContact(
	contacts: ContactConfig[],
	nameOrId: string,
): ContactConfig | undefined {
	const lower = nameOrId.toLowerCase();

	return contacts.find(
		(c) =>
			c.userId === nameOrId ||
			c.displayName.toLowerCase() === lower ||
			c.username?.toLowerCase() === lower ||
			c.username?.toLowerCase() === lower.replace(/^@/, ""),
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Download Command ──────────────────────────────────────────────────

function registerDownloadCommand(history: Command): void {
	history
		.command("download [contact]")
		.description("Download conversation history to local SQLite database")
		.option("--since <date>", "Start date (YYYY-MM-DD)")
		.option("--until <date>", "End date (YYYY-MM-DD)")
		.option("--limit <n>", "Max messages to download", parseInt)
		.option("--all", "Download all configured contacts")
		.action(async (contactName: string | undefined, opts: {
			since?: string;
			until?: string;
			limit?: number;
			all?: boolean;
		}) => {
			p.intro(pc.bgMagenta(pc.white(" telegram history download ")));

			const config = new TelegramToolConfig();
			const data = await config.load();

			if (!data) {
				p.log.error("Not configured. Run: tools telegram configure");
				return;
			}

			const contacts = data.contacts;

			if (contacts.length === 0) {
				p.log.warn("No contacts configured. Run: tools telegram configure");
				return;
			}

			// Determine which contacts to download
			let targetContacts: ContactConfig[];

			if (opts.all) {
				targetContacts = contacts;
			} else if (contactName) {
				const found = resolveContact(contacts, contactName);

				if (!found) {
					p.log.error(
						`Contact "${contactName}" not found. Available: ${contacts.map((c) => c.displayName).join(", ")}`,
					);
					return;
				}

				targetContacts = [found];
			} else {
				// Interactive selection
				const selected = await p.select({
					message: "Which contact to download?",
					options: [
						...contacts.map((c) => ({
							value: c.userId,
							label: c.displayName,
							hint: c.username ? `@${c.username}` : undefined,
						})),
						{ value: "__all__", label: "All contacts" },
					],
				});

				if (p.isCancel(selected)) {
					return;
				}

				if (selected === "__all__") {
					targetContacts = contacts;
				} else {
					const found = contacts.find((c) => c.userId === selected);

					if (!found) {
						return;
					}

					targetContacts = [found];
				}
			}

			// Connect to Telegram
			const spinner = p.spinner();
			spinner.start("Connecting to Telegram...");

			const client = await ensureClient(config);

			if (!client) {
				spinner.stop("Connection failed");
				return;
			}

			spinner.stop("Connected");

			// Open store
			const store = new TelegramHistoryStore();
			store.open();

			const since = opts.since ? parseDate(opts.since) : undefined;
			const until = opts.until ? parseDate(opts.until) : undefined;

			try {
				for (const contact of targetContacts) {
					await downloadContact(client, store, contact, {
						since,
						until,
						limit: opts.limit,
					});
				}
			} finally {
				store.close();
				await client.disconnect();
			}

			p.outro("Download complete.");
		});
}

async function downloadContact(
	client: TGClient,
	store: TelegramHistoryStore,
	contact: ContactConfig,
	options: { since?: Date; until?: Date; limit?: number },
): Promise<void> {
	p.log.step(pc.bold(contact.displayName));

	const spinner = p.spinner();
	spinner.start("Counting messages...");

	let totalEstimate: number;

	try {
		totalEstimate = await client.getMessageCount(contact.userId);
	} catch {
		spinner.stop("Could not count messages");
		totalEstimate = 0;
	}

	// Check for incremental sync
	const lastSyncedId = store.getLastSyncedId(contact.userId);
	const isIncremental = lastSyncedId !== null && !options.since;

	if (isIncremental) {
		spinner.stop(`Found ${formatNumber(totalEstimate)} total messages (incremental sync from #${lastSyncedId})`);
	} else {
		spinner.stop(`Found ${formatNumber(totalEstimate)} total messages`);
	}

	const iterOptions: {
		limit?: number;
		offsetDate?: number;
		minId?: number;
		maxId?: number;
	} = {};

	if (options.limit) {
		iterOptions.limit = options.limit;
	}

	if (options.since) {
		iterOptions.offsetDate = Math.floor(options.since.getTime() / 1000);
	}

	if (options.until) {
		// GramJS uses offsetDate as "messages before this date"
		iterOptions.offsetDate = Math.floor(options.until.getTime() / 1000);
	}

	if (isIncremental && lastSyncedId !== null) {
		iterOptions.minId = lastSyncedId;
	}

	const progressSpinner = p.spinner();
	progressSpinner.start("Downloading messages...");

	const batch: SerializedMessage[] = [];
	let downloaded = 0;
	let inserted = 0;
	let highestId = lastSyncedId ?? 0;
	let retryCount = 0;
	const BATCH_SIZE = 100;
	const MAX_RETRIES = 5;

	try {
		for await (const apiMessage of client.getMessages(contact.userId, iterOptions)) {
			const msg = new TelegramMessage(apiMessage);

			// Apply since filter (getMessages with offsetDate may not be exact)
			if (options.since && msg.date < options.since) {
				continue;
			}

			if (options.until && msg.date > options.until) {
				continue;
			}

			batch.push(msg.toJSON());
			downloaded++;

			if (msg.id > highestId) {
				highestId = msg.id;
			}

			if (batch.length >= BATCH_SIZE) {
				const batchInserted = store.insertMessages(contact.userId, batch);
				inserted += batchInserted;
				batch.length = 0;
				retryCount = 0;

				progressSpinner.message(
					`Downloaded ${formatNumber(downloaded)} messages (${formatNumber(inserted)} new)`,
				);
			}
		}
	} catch (err) {
		const errorStr = String(err);

		// Handle Telegram FloodWait errors
		if (errorStr.includes("FLOOD_WAIT") || errorStr.includes("FloodWait")) {
			const waitMatch = errorStr.match(/(\d+)/);
			const waitSeconds = waitMatch ? parseInt(waitMatch[1], 10) : 30;
			retryCount++;

			if (retryCount <= MAX_RETRIES) {
				const backoff = waitSeconds * Math.pow(2, retryCount - 1);
				progressSpinner.message(
					`Rate limited — waiting ${backoff}s (retry ${retryCount}/${MAX_RETRIES})`,
				);
				await sleep(backoff * 1000);
			} else {
				progressSpinner.stop(`Rate limited after ${MAX_RETRIES} retries`);
				p.log.warn("Stopped due to persistent rate limiting. Run again later to resume.");
			}
		} else {
			progressSpinner.stop("Error during download");
			p.log.error(`Download error: ${errorStr}`);
		}
	}

	// Flush remaining batch
	if (batch.length > 0) {
		const batchInserted = store.insertMessages(contact.userId, batch);
		inserted += batchInserted;
	}

	// Update sync state
	if (highestId > 0) {
		store.setLastSyncedId(contact.userId, highestId);
	}

	progressSpinner.stop(
		`${pc.green(formatNumber(downloaded))} downloaded, ${pc.green(formatNumber(inserted))} new messages stored`,
	);
}

// ── Export (placeholder — implemented in Task 5) ──────────────────────

export function registerHistoryCommand(program: Command): void {
	const history = program
		.command("history")
		.description("Download, search, and export conversation history");

	registerDownloadCommand(history);
	// registerSearchCommand(history);  — Task 4
	// registerExportCommand(history);  — Task 5
	// registerStatsCommand(history);   — Task 5
}
```

### Step 2: Register history command in `src/telegram/index.ts`

Replace the entire file content with:

```typescript
import { Command } from "commander";
import { handleReadmeFlag } from "@app/utils/readme";
import { registerConfigureCommand } from "./commands/configure";
import { registerListenCommand } from "./commands/listen";
import { registerContactsCommand } from "./commands/contacts";
import { registerHistoryCommand } from "./commands/history";

handleReadmeFlag(import.meta.url);

const program = new Command();
program
	.name("telegram")
	.description("Telegram MTProto user client — listen for messages and auto-respond")
	.version("1.0.0")
	.showHelpAfterError(true);

registerConfigureCommand(program);
registerListenCommand(program);
registerContactsCommand(program);
registerHistoryCommand(program);

program.parseAsync();
```

### Step 3: Verify type checking

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools/.worktrees/feat-telegram
bunx tsgo --noEmit 2>&1 | rg "src/telegram/"
```

Expected: No errors.

### Step 4: Test download help text

```bash
bun run src/telegram/index.ts history download --help
```

Expected: Shows usage with `[contact]`, `--since`, `--until`, `--limit`, `--all` options.

### Verification

1. Type check passes
2. `tools telegram history --help` shows the `download` subcommand
3. `tools telegram history download --help` shows all options

**Commit:**

```bash
git add \
  package.json \
  bun.lock \
  src/telegram/lib/TelegramHistoryStore.ts \
  src/telegram/lib/types.ts \
  src/telegram/commands/history.ts \
  src/telegram/index.ts

git commit -m "$(cat <<'EOF'
feat(telegram): add history download with SQLite + FTS5 + sqlite-vec

Phase 2 of the Telegram tool. Adds TelegramHistoryStore backed by
better-sqlite3 with FTS5 full-text search and sqlite-vec for vector
embeddings. Download command supports incremental sync, date range
filtering, progress display, and FloodWait error handling.
EOF
)"
```

---

## Task 3: Add Embedding Pipeline (Batch Embed After Download)

**Files:**
- Modify: `src/telegram/commands/history.ts` — add embed subcommand, wire into download

### Step 1: Add embed logic to `src/telegram/commands/history.ts`

Add the following function after the `downloadContact` function and before the `registerHistoryCommand` function:

```typescript
// ── Embed Command ─────────────────────────────────────────────────────

async function embedMessages(
	store: TelegramHistoryStore,
	chatId: string,
	displayName: string,
): Promise<{ embedded: number; skipped: number }> {
	let embedded = 0;
	let skipped = 0;
	const BATCH_SIZE = 50;

	while (true) {
		const unembedded = store.getUnembeddedMessages(chatId, BATCH_SIZE);

		if (unembedded.length === 0) {
			break;
		}

		for (const msg of unembedded) {
			if (!msg.text || msg.text.trim().length < 3) {
				skipped++;
				continue;
			}

			try {
				const langResult = await detectLanguage(msg.text);

				if (!EMBEDDING_LANGUAGES.has(langResult.language)) {
					skipped++;
					continue;
				}

				const result: EmbedResult = await embedText(msg.text, langResult.language, "sentence");
				const embedding = new Float32Array(result.vector);
				store.insertEmbedding(chatId, msg.id, embedding);
				embedded++;
			} catch (err) {
				logger.debug(`Embedding failed for message ${msg.id}: ${err}`);
				skipped++;
			}
		}
	}

	return { embedded, skipped };
}

function registerEmbedCommand(history: Command): void {
	history
		.command("embed [contact]")
		.description("Generate semantic embeddings for downloaded messages")
		.option("--all", "Embed all contacts")
		.action(async (contactName: string | undefined, opts: { all?: boolean }) => {
			p.intro(pc.bgMagenta(pc.white(" telegram history embed ")));

			const config = new TelegramToolConfig();
			const data = await config.load();

			if (!data) {
				p.log.error("Not configured. Run: tools telegram configure");
				return;
			}

			const contacts = data.contacts;

			if (contacts.length === 0) {
				p.log.warn("No contacts configured.");
				return;
			}

			let targetContacts: ContactConfig[];

			if (opts.all) {
				targetContacts = contacts;
			} else if (contactName) {
				const found = resolveContact(contacts, contactName);

				if (!found) {
					p.log.error(
						`Contact "${contactName}" not found. Available: ${contacts.map((c) => c.displayName).join(", ")}`,
					);
					return;
				}

				targetContacts = [found];
			} else {
				const selected = await p.select({
					message: "Which contact to embed?",
					options: [
						...contacts.map((c) => ({
							value: c.userId,
							label: c.displayName,
						})),
						{ value: "__all__", label: "All contacts" },
					],
				});

				if (p.isCancel(selected)) {
					return;
				}

				if (selected === "__all__") {
					targetContacts = contacts;
				} else {
					const found = contacts.find((c) => c.userId === selected);

					if (!found) {
						return;
					}

					targetContacts = [found];
				}
			}

			const store = new TelegramHistoryStore();
			store.open();

			try {
				for (const contact of targetContacts) {
					p.log.step(pc.bold(contact.displayName));

					const spinner = p.spinner();
					spinner.start("Generating embeddings...");

					const { embedded, skipped } = await embedMessages(
						store,
						contact.userId,
						contact.displayName,
					);

					const total = store.getEmbeddedCount(contact.userId);

					spinner.stop(
						`${pc.green(String(embedded))} new embeddings, ${skipped} skipped (${formatNumber(total)} total embedded)`,
					);
				}
			} finally {
				store.close();
			}

			p.outro("Embedding complete.");
		});
}
```

### Step 2: Wire embed into download (auto-embed option)

Modify the `registerDownloadCommand` function's `.action()`. After the `for (const contact of targetContacts)` loop and before `store.close()`, add:

```typescript
			// Auto-embed after download
			const shouldEmbed = await p.confirm({
				message: "Generate semantic embeddings for new messages?",
				initialValue: true,
			});

			if (!p.isCancel(shouldEmbed) && shouldEmbed) {
				for (const contact of targetContacts) {
					const embedSpinner = p.spinner();
					embedSpinner.start(`Embedding ${contact.displayName}...`);

					const { embedded, skipped } = await embedMessages(
						store,
						contact.userId,
						contact.displayName,
					);

					embedSpinner.stop(
						`${pc.green(String(embedded))} embeddings generated, ${skipped} skipped`,
					);
				}
			}
```

### Step 3: Register embed command

In the `registerHistoryCommand` function, add:

```typescript
	registerEmbedCommand(history);
```

So it becomes:

```typescript
export function registerHistoryCommand(program: Command): void {
	const history = program
		.command("history")
		.description("Download, search, and export conversation history");

	registerDownloadCommand(history);
	registerEmbedCommand(history);
	// registerSearchCommand(history);  — Task 4
	// registerExportCommand(history);  — Task 5
	// registerStatsCommand(history);   — Task 5
}
```

### Verification

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools/.worktrees/feat-telegram
bunx tsgo --noEmit 2>&1 | rg "src/telegram/"
```

Expected: No errors.

```bash
bun run src/telegram/index.ts history embed --help
```

Expected: Shows usage with `[contact]` and `--all` options.

*(No commit yet — will commit together with Task 4)*

---

## Task 4: Add Search Command (Keyword, Semantic, Hybrid)

**Files:**
- Modify: `src/telegram/commands/history.ts` — add search subcommand

### Step 1: Add search command to `src/telegram/commands/history.ts`

Add the following function after `registerEmbedCommand` and before `registerHistoryCommand`:

```typescript
// ── Search Command ────────────────────────────────────────────────────

function formatSearchResult(result: SearchResult, contactName: string): string {
	const msg = result.message;
	const date = new Date(msg.date_unix * 1000);
	const dateStr = date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
	const direction = msg.is_outgoing ? pc.blue("You") : pc.cyan(contactName);
	const text = msg.text || msg.media_desc || "(no text)";
	const preview = text.length > 120 ? `${text.slice(0, 120)}...` : text;

	let scoreLabel = "";

	if (result.score !== undefined) {
		scoreLabel = pc.dim(` [score: ${result.score.toFixed(4)}]`);
	} else if (result.distance !== undefined) {
		scoreLabel = pc.dim(` [dist: ${result.distance.toFixed(4)}]`);
	} else if (result.rank !== undefined) {
		scoreLabel = pc.dim(` [rank: ${result.rank.toFixed(2)}]`);
	}

	return `${pc.dim(dateStr)} ${direction}: ${preview}${scoreLabel}`;
}

function registerSearchCommand(history: Command): void {
	history
		.command("search <contact> <query>")
		.description("Search conversation history (keyword, semantic, or hybrid)")
		.option("--since <date>", "Start date (YYYY-MM-DD)")
		.option("--until <date>", "End date (YYYY-MM-DD)")
		.option("--semantic", "Use semantic (vector) search instead of keyword")
		.option("--hybrid", "Use hybrid search (keyword + semantic combined)")
		.option("--limit <n>", "Max results (default: 20)", parseInt)
		.action(async (
			contactName: string,
			query: string,
			opts: {
				since?: string;
				until?: string;
				semantic?: boolean;
				hybrid?: boolean;
				limit?: number;
			},
		) => {
			p.intro(pc.bgMagenta(pc.white(" telegram history search ")));

			const config = new TelegramToolConfig();
			const data = await config.load();

			if (!data) {
				p.log.error("Not configured. Run: tools telegram configure");
				return;
			}

			const contact = resolveContact(data.contacts, contactName);

			if (!contact) {
				p.log.error(
					`Contact "${contactName}" not found. Available: ${data.contacts.map((c) => c.displayName).join(", ")}`,
				);
				return;
			}

			const store = new TelegramHistoryStore();
			store.open();

			const searchOpts = {
				since: opts.since ? parseDate(opts.since) : undefined,
				until: opts.until ? parseDate(opts.until) : undefined,
				limit: opts.limit ?? 20,
			};

			let results: SearchResult[];

			try {
				if (opts.semantic || opts.hybrid) {
					// Generate query embedding
					const spinner = p.spinner();
					spinner.start("Generating query embedding...");

					let queryEmbedding: Float32Array;

					try {
						const langResult = await detectLanguage(query);
						const lang = EMBEDDING_LANGUAGES.has(langResult.language)
							? langResult.language
							: "en";
						const embedResult = await embedText(query, lang, "sentence");
						queryEmbedding = new Float32Array(embedResult.vector);
						spinner.stop("Query embedded");
					} catch (err) {
						spinner.stop("Embedding failed — falling back to keyword search");
						p.log.warn(`Could not embed query: ${err}`);
						results = store.search(contact.userId, query, searchOpts);

						displayResults(results, contact.displayName);
						store.close();
						return;
					}

					if (opts.hybrid) {
						results = store.hybridSearch(
							contact.userId,
							query,
							queryEmbedding,
							searchOpts,
						);
					} else {
						results = store.semanticSearch(
							contact.userId,
							queryEmbedding,
							searchOpts,
						);
					}
				} else {
					results = store.search(contact.userId, query, searchOpts);
				}

				displayResults(results, contact.displayName);
			} finally {
				store.close();
			}

			p.outro(`${results.length} result(s) found.`);
		});
}

function displayResults(results: SearchResult[], contactName: string): void {
	if (results.length === 0) {
		p.log.warn("No results found.");
		return;
	}

	for (const result of results) {
		p.log.info(formatSearchResult(result, contactName));
	}
}
```

### Step 2: Register search command

In `registerHistoryCommand`, replace the search comment:

```typescript
export function registerHistoryCommand(program: Command): void {
	const history = program
		.command("history")
		.description("Download, search, and export conversation history");

	registerDownloadCommand(history);
	registerEmbedCommand(history);
	registerSearchCommand(history);
	// registerExportCommand(history);  — Task 5
	// registerStatsCommand(history);   — Task 5
}
```

### Verification

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools/.worktrees/feat-telegram
bunx tsgo --noEmit 2>&1 | rg "src/telegram/"
```

Expected: No errors.

```bash
bun run src/telegram/index.ts history search --help
```

Expected: Shows usage with `<contact>`, `<query>`, `--since`, `--until`, `--semantic`, `--hybrid`, `--limit`.

**Commit:**

```bash
git add \
  src/telegram/commands/history.ts

git commit -m "$(cat <<'EOF'
feat(telegram): add embed and search commands with hybrid FTS5+vector search

Embedding pipeline uses macOS NLEmbedding (512-dim vectors) with
language detection to skip unsupported languages (Czech, Slovak, etc.).
Search supports keyword (FTS5 BM25), semantic (sqlite-vec KNN), and
hybrid (Reciprocal Rank Fusion) modes.
EOF
)"
```

---

## Task 5: Add Export + Stats Commands

**Files:**
- Modify: `src/telegram/commands/history.ts` — add export and stats subcommands

### Step 1: Add export command

Add the following function after `registerSearchCommand` and before `registerHistoryCommand`:

```typescript
// ── Export Command ────────────────────────────────────────────────────

function registerExportCommand(history: Command): void {
	history
		.command("export <contact>")
		.description("Export conversation to file (JSON, CSV, or plain text)")
		.requiredOption("--format <fmt>", "Output format: json, csv, or txt")
		.option("--since <date>", "Start date (YYYY-MM-DD)")
		.option("--until <date>", "End date (YYYY-MM-DD)")
		.option("-o, --output <path>", "Output file path (default: stdout)")
		.action(async (
			contactName: string,
			opts: {
				format: string;
				since?: string;
				until?: string;
				output?: string;
			},
		) => {
			const validFormats = ["json", "csv", "txt"];

			if (!validFormats.includes(opts.format)) {
				p.log.error(`Invalid format "${opts.format}". Use: ${validFormats.join(", ")}`);
				return;
			}

			const config = new TelegramToolConfig();
			const data = await config.load();

			if (!data) {
				p.log.error("Not configured. Run: tools telegram configure");
				return;
			}

			const contact = resolveContact(data.contacts, contactName);

			if (!contact) {
				p.log.error(
					`Contact "${contactName}" not found. Available: ${data.contacts.map((c) => c.displayName).join(", ")}`,
				);
				return;
			}

			const store = new TelegramHistoryStore();
			store.open();

			const since = opts.since ? parseDate(opts.since) : undefined;
			const until = opts.until ? parseDate(opts.until) : undefined;

			const messages = store.getByDateRange(contact.userId, since, until);
			store.close();

			if (messages.length === 0) {
				p.log.warn("No messages found in the specified range.");
				return;
			}

			let output: string;

			switch (opts.format) {
				case "json":
					output = JSON.stringify(messages, null, 2);
					break;

				case "csv": {
					const header = "id,date,sender,direction,text,media";
					const rows = messages.map((m) => {
						const direction = m.is_outgoing ? "sent" : "received";
						const text = (m.text ?? "").replace(/"/g, '""').replace(/\n/g, "\\n");
						const media = (m.media_desc ?? "").replace(/"/g, '""');
						return `${m.id},"${m.date_iso}","${m.sender_id ?? ""}","${direction}","${text}","${media}"`;
					});
					output = [header, ...rows].join("\n");
					break;
				}

				case "txt": {
					const lines = messages.map((m) => {
						const date = new Date(m.date_unix * 1000);
						const dateStr = date.toLocaleString("en-US", {
							year: "numeric",
							month: "short",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
						});
						const direction = m.is_outgoing ? "You" : contact.displayName;
						const text = m.text || m.media_desc || "(no content)";
						return `[${dateStr}] ${direction}: ${text}`;
					});
					output = lines.join("\n");
					break;
				}

				default:
					return;
			}

			if (opts.output) {
				await Bun.write(opts.output, output);
				p.log.success(`Exported ${formatNumber(messages.length)} messages to ${opts.output}`);
			} else {
				console.log(output);
			}
		});
}
```

### Step 2: Add stats command

Add the following function after `registerExportCommand`:

```typescript
// ── Stats Command ─────────────────────────────────────────────────────

function registerStatsCommand(history: Command): void {
	history
		.command("stats [contact]")
		.description("Show statistics about downloaded conversations")
		.action(async (contactName: string | undefined) => {
			p.intro(pc.bgMagenta(pc.white(" telegram history stats ")));

			const config = new TelegramToolConfig();
			const data = await config.load();

			if (!data) {
				p.log.error("Not configured. Run: tools telegram configure");
				return;
			}

			const store = new TelegramHistoryStore();
			store.open();

			try {
				if (contactName) {
					const contact = resolveContact(data.contacts, contactName);

					if (!contact) {
						p.log.error(
							`Contact "${contactName}" not found. Available: ${data.contacts.map((c) => c.displayName).join(", ")}`,
						);
						return;
					}

					const stats = store.getStats(contact.userId);

					if (stats.length === 0) {
						p.log.warn(`No messages downloaded for ${contact.displayName}. Run: tools telegram history download`);
						return;
					}

					const s = stats[0];
					p.log.info(
						`${pc.bold(contact.displayName)}\n` +
						`  Total messages:    ${formatNumber(s.totalMessages)}\n` +
						`  Sent:              ${formatNumber(s.outgoingMessages)}\n` +
						`  Received:          ${formatNumber(s.incomingMessages)}\n` +
						`  Embedded:          ${formatNumber(s.embeddedMessages)}\n` +
						`  First message:     ${s.firstMessageDate ?? "—"}\n` +
						`  Last message:      ${s.lastMessageDate ?? "—"}`,
					);
				} else {
					const allStats = store.getStats();

					if (allStats.length === 0) {
						p.log.warn("No messages downloaded yet. Run: tools telegram history download");
						return;
					}

					// Map chat IDs to display names
					const contactMap = new Map<string, string>();

					for (const c of data.contacts) {
						contactMap.set(c.userId, c.displayName);
					}

					const rows = allStats.map((s) => [
						contactMap.get(s.chatId) ?? s.chatId,
						formatNumber(s.totalMessages),
						formatNumber(s.incomingMessages),
						formatNumber(s.outgoingMessages),
						formatNumber(s.embeddedMessages),
						s.firstMessageDate?.slice(0, 10) ?? "—",
						s.lastMessageDate?.slice(0, 10) ?? "—",
					]);

					const totalMessages = allStats.reduce((sum, s) => sum + s.totalMessages, 0);
					const totalEmbedded = allStats.reduce((sum, s) => sum + s.embeddedMessages, 0);

					console.log();
					console.log(formatTable(
						rows,
						["Contact", "Total", "In", "Out", "Embedded", "First", "Last"],
						{ alignRight: [1, 2, 3, 4] },
					));
					console.log();

					p.log.info(
						`${pc.bold("Summary")}: ${formatNumber(totalMessages)} messages across ${allStats.length} contact(s), ` +
						`${formatNumber(totalEmbedded)} embedded`,
					);
				}
			} finally {
				store.close();
			}

			p.outro("Done.");
		});
}
```

### Step 3: Register export and stats commands

Update `registerHistoryCommand` to register all commands:

```typescript
export function registerHistoryCommand(program: Command): void {
	const history = program
		.command("history")
		.description("Download, search, and export conversation history");

	registerDownloadCommand(history);
	registerEmbedCommand(history);
	registerSearchCommand(history);
	registerExportCommand(history);
	registerStatsCommand(history);
}
```

### Verification

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools/.worktrees/feat-telegram
bunx tsgo --noEmit 2>&1 | rg "src/telegram/"
```

Expected: No errors.

```bash
bun run src/telegram/index.ts history --help
```

Expected output should list all five subcommands: `download`, `embed`, `search`, `export`, `stats`.

```bash
bun run src/telegram/index.ts history export --help
bun run src/telegram/index.ts history stats --help
```

Expected: Each shows its options.

**Commit:**

```bash
git add \
  src/telegram/commands/history.ts

git commit -m "$(cat <<'EOF'
feat(telegram): add export and stats commands for conversation history

Export supports JSON, CSV, and plain text formats with date range
filtering and stdout/file output. Stats shows per-contact and
aggregate message counts, date ranges, and embedding coverage.
EOF
)"
```

---

## Task 6: End-to-End Verification

**Files:** None (verification only)

### Step 1: Type check entire project

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools/.worktrees/feat-telegram
bunx tsgo --noEmit 2>&1 | rg "src/telegram/"
```

Expected: No errors.

### Step 2: Verify all help texts

```bash
bun run src/telegram/index.ts --help
bun run src/telegram/index.ts history --help
bun run src/telegram/index.ts history download --help
bun run src/telegram/index.ts history embed --help
bun run src/telegram/index.ts history search --help
bun run src/telegram/index.ts history export --help
bun run src/telegram/index.ts history stats --help
```

### Step 3: Smoke test store (in-memory)

```bash
bun -e "
import { TelegramHistoryStore } from './src/telegram/lib/TelegramHistoryStore';
import { embedText, detectLanguage } from './src/utils/macos/nlp';

const store = new TelegramHistoryStore();
store.open(':memory:');

// Insert test messages
const messages = [
  { id: 1, senderId: '100', text: 'Hey, how are you doing today?', mediaDescription: undefined, isOutgoing: false, date: '2025-06-01T10:00:00Z', dateUnix: 1748775600 },
  { id: 2, senderId: undefined, text: 'I am doing great, thanks for asking!', mediaDescription: undefined, isOutgoing: true, date: '2025-06-01T10:01:00Z', dateUnix: 1748775660 },
  { id: 3, senderId: '100', text: 'Want to grab lunch at the Italian place?', mediaDescription: undefined, isOutgoing: false, date: '2025-06-01T10:02:00Z', dateUnix: 1748775720 },
  { id: 4, senderId: undefined, text: 'Sure, let me check the menu first', mediaDescription: undefined, isOutgoing: true, date: '2025-06-01T10:03:00Z', dateUnix: 1748775780 },
  { id: 5, senderId: '100', text: 'They have amazing pasta and pizza', mediaDescription: undefined, isOutgoing: false, date: '2025-06-01T10:04:00Z', dateUnix: 1748775840 },
];

const inserted = store.insertMessages('chat-100', messages);
console.log('Inserted:', inserted);

// FTS search
const ftsResults = store.search('chat-100', 'lunch');
console.log('FTS results for \"lunch\":', ftsResults.length);
console.log('  ->', ftsResults[0]?.message.text);

// Generate embedding for one message
const lang = await detectLanguage('Want to grab lunch at the Italian place?');
console.log('Language:', lang.language, 'confidence:', lang.confidence);

const embed = await embedText('Want to grab lunch at the Italian place?', lang.language, 'sentence');
console.log('Embedding dims:', embed.vector.length);

// Insert embedding
const embedding = new Float32Array(embed.vector);
store.insertEmbedding('chat-100', 3, embedding);
console.log('Embedded count:', store.getEmbeddedCount('chat-100'));

// Semantic search
const queryEmbed = await embedText('restaurant food dining', 'en', 'sentence');
const vecResults = store.semanticSearch('chat-100', new Float32Array(queryEmbed.vector), { limit: 3 });
console.log('Semantic results for \"restaurant food dining\":', vecResults.length);
for (const r of vecResults) {
  console.log('  ->', r.message.text, '(dist:', r.distance?.toFixed(4), ')');
}

// Stats
const stats = store.getStats('chat-100');
console.log('Stats:', JSON.stringify(stats[0], null, 2));

// Sync state
store.setLastSyncedId('chat-100', 5);
console.log('Last synced ID:', store.getLastSyncedId('chat-100'));

// Export
const exported = store.getByDateRange('chat-100');
console.log('Exported messages:', exported.length);

store.close();
console.log('\\nAll smoke tests passed!');
"
```

**IMPORTANT:** If the smoke test fails on `semanticSearch` with a sqlite-vec error about the `MATCH` operator or column binding, the KNN query syntax may need adjustment. The sqlite-vec `vec0` tables require:
- The embedding buffer to be passed as `Buffer.from(float32Array.buffer)`
- The `k` parameter may need to be in the WHERE clause as `AND k = ?`

If the query fails, try adjusting `TelegramHistoryStore.semanticSearch()` to use this alternative pattern:
```typescript
const sql = `
    SELECT m.*, v.distance
    FROM messages_vec v
    JOIN messages m ON m.rowid = v.message_rowid
    WHERE v.embedding MATCH ? AND k = ?
    AND m.chat_id = ?
    ${dateFilter}
    LIMIT ?
`;
```

### Step 4: Verify file structure

```bash
find /Users/Martin/Tresors/Projects/GenesisTools/.worktrees/feat-telegram/src/telegram -type f | sort
```

Expected files:
```
src/telegram/commands/configure.ts
src/telegram/commands/contacts.ts
src/telegram/commands/history.ts
src/telegram/commands/listen.ts
src/telegram/index.ts
src/telegram/lib/TGClient.ts
src/telegram/lib/TelegramContact.ts
src/telegram/lib/TelegramHistoryStore.ts
src/telegram/lib/TelegramMessage.ts
src/telegram/lib/TelegramToolConfig.ts
src/telegram/lib/actions/ask.ts
src/telegram/lib/actions/index.ts
src/telegram/lib/actions/notify.ts
src/telegram/lib/actions/say.ts
src/telegram/lib/handler.ts
src/telegram/lib/types.ts
```

### Step 5: Lint check (if biome is configured)

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools/.worktrees/feat-telegram
bunx biome check src/telegram/ 2>&1 | head -30
```

Fix any lint issues that arise.

### Final Commit (if any fixes were needed)

```bash
git add src/telegram/

git commit -m "$(cat <<'EOF'
fix(telegram): address lint and type issues in history commands
EOF
)"
```

---

## Summary

| Task | Description | Files | Commit |
|------|-------------|-------|--------|
| 1 | Install sqlite-vec, create TelegramHistoryStore, add types | `package.json`, `TelegramHistoryStore.ts`, `types.ts` | Combined with Task 2 |
| 2 | Download command with incremental sync + progress | `history.ts`, `index.ts` | **Commit 1** |
| 3 | Embedding pipeline (batch embed + embed command) | `history.ts` | Combined with Task 4 |
| 4 | Search command (keyword, semantic, hybrid) | `history.ts` | **Commit 2** |
| 5 | Export + stats commands | `history.ts` | **Commit 3** |
| 6 | End-to-end verification + lint fixes | — | **Commit 4** (if needed) |

Total: 3-4 commits.

## Quick Reference: Key APIs

| API | Import | Returns |
|-----|--------|---------|
| `embedText(text, lang, "sentence")` | `@app/utils/macos/nlp` | `{ vector: number[], dimension: 512 }` |
| `detectLanguage(text)` | `@app/utils/macos/nlp` | `{ language: string, confidence: number }` |
| `TGClient.getMessages(userId, opts)` | `../lib/TGClient` | `AsyncGenerator<Api.Message>` |
| `TGClient.getMessageCount(userId)` | `../lib/TGClient` | `Promise<number>` |
| `TelegramMessage.toJSON()` | `../lib/TelegramMessage` | `SerializedMessage` |
| `formatNumber(n)` | `@app/utils/format` | `string` (1.2K, 3.5M, etc.) |
| `formatTable(rows, headers, opts)` | `@app/utils/table` | `string` |

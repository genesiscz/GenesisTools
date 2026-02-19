import { Database } from "bun:sqlite";
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
	private db: Database | null = null;

	open(dbPath: string = DB_PATH): void {
		if (this.db) {
			return;
		}

		const dir = dirname(dbPath);

		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		this.db = new Database(dbPath);
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run("PRAGMA foreign_keys = ON");

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

	private getDb(): Database {
		if (!this.db) {
			throw new Error("TelegramHistoryStore not opened. Call open() first.");
		}

		return this.db;
	}

	private initSchema(): void {
		const db = this.getDb();

		db.run(`
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
			)
		`);

		db.run(`
			CREATE INDEX IF NOT EXISTS idx_messages_chat_date
				ON messages(chat_id, date_unix)
		`);

		db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
				text,
				content=messages,
				content_rowid=rowid,
				tokenize='unicode61'
			)
		`);

		db.run(`
			CREATE TABLE IF NOT EXISTS sync_state (
				chat_id TEXT PRIMARY KEY,
				last_synced_id INTEGER NOT NULL,
				last_synced_at TEXT NOT NULL
			)
		`);

		// Embeddings stored as BLOBs (bun:sqlite doesn't support sqlite-vec extensions)
		db.run(`
			CREATE TABLE IF NOT EXISTS embeddings (
				message_rowid INTEGER PRIMARY KEY,
				embedding BLOB NOT NULL
			)
		`);

		// FTS5 external content triggers
		try {
			db.run(`
				CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
					INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
				END
			`);
		} catch {
			// trigger already exists
		}

		try {
			db.run(`
				CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
					INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
				END
			`);
		} catch {
			// trigger already exists
		}

		try {
			db.run(`
				CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
					INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
					INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
				END
			`);
		} catch {
			// trigger already exists
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

		const insertMany = db.transaction(() => {
			for (const msg of messages) {
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

		insertMany();
		return inserted;
	}

	// ── Embeddings ────────────────────────────────────────────────────

	getUnembeddedMessages(chatId: string, limit = 500): MessageRow[] {
		const db = this.getDb();

		return db.query(`
			SELECT m.*
			FROM messages m
			LEFT JOIN embeddings e ON e.message_rowid = m.rowid
			WHERE m.chat_id = ?
				AND m.text IS NOT NULL
				AND m.text != ''
				AND e.message_rowid IS NULL
			ORDER BY m.date_unix ASC
			LIMIT ?
		`).all(chatId, limit) as MessageRow[];
	}

	insertEmbedding(chatId: string, messageId: number, embedding: Float32Array): void {
		const db = this.getDb();

		const row = db.query(
			"SELECT rowid FROM messages WHERE chat_id = ? AND id = ?"
		).get(chatId, messageId) as { rowid: number } | null;

		if (!row) {
			return;
		}

		db.run(
			"INSERT OR REPLACE INTO embeddings (message_rowid, embedding) VALUES (?, ?)",
			[row.rowid, Buffer.from(embedding.buffer)],
		);
	}

	getEmbeddedCount(chatId: string): number {
		const db = this.getDb();

		const row = db.query(`
			SELECT COUNT(*) AS cnt
			FROM embeddings e
			JOIN messages m ON m.rowid = e.message_rowid
			WHERE m.chat_id = ?
		`).get(chatId) as { cnt: number };

		return row.cnt;
	}

	// ── Search ────────────────────────────────────────────────────────

	search(chatId: string, query: string, options: SearchOptions = {}): SearchResult[] {
		const db = this.getDb();

		// FTS5 query — wrap each word in quotes for safe matching
		const ftsQuery = query
			.replace(/['"]/g, "")
			.split(/\s+/)
			.filter(Boolean)
			.map((word) => `"${word}"`)
			.join(" ");

		if (!ftsQuery) {
			return [];
		}

		const limit = options.limit ?? 20;

		let dateFilter = "";
		const params: (string | number)[] = [ftsQuery, chatId];

		if (options.since) {
			dateFilter += " AND m.date_unix >= ?";
			params.push(Math.floor(options.since.getTime() / 1000));
		}

		if (options.until) {
			dateFilter += " AND m.date_unix <= ?";
			params.push(Math.floor(options.until.getTime() / 1000));
		}

		params.push(limit);

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

		const rows = db.query(sql).all(...params) as Array<MessageRow & { rank: number }>;

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

		let dateFilter = "";
		const params: (string | number)[] = [chatId];

		if (options.since) {
			dateFilter += " AND m.date_unix >= ?";
			params.push(Math.floor(options.since.getTime() / 1000));
		}

		if (options.until) {
			dateFilter += " AND m.date_unix <= ?";
			params.push(Math.floor(options.until.getTime() / 1000));
		}

		// Fetch all embedded messages for this chat (with date filter)
		const sql = `
			SELECT m.*, e.embedding
			FROM embeddings e
			JOIN messages m ON m.rowid = e.message_rowid
			WHERE m.chat_id = ?
				${dateFilter}
		`;

		const rows = db.query(sql).all(...params) as Array<MessageRow & { embedding: Buffer }>;

		// Brute-force cosine similarity in TypeScript
		const scored: Array<{ message: MessageRow; distance: number }> = [];

		for (const row of rows) {
			const storedVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
			const distance = cosineDistance(queryEmbedding, storedVec);

			scored.push({
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
				distance,
			});
		}

		scored.sort((a, b) => a.distance - b.distance);

		return scored.slice(0, limit).map((entry) => ({
			message: entry.message,
			distance: entry.distance,
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

		return db.query(`
			SELECT * FROM messages
			WHERE chat_id = ? ${dateFilter}
			ORDER BY date_unix ASC
			${limitClause}
		`).all(...params) as MessageRow[];
	}

	// ── Sync State ────────────────────────────────────────────────────

	getLastSyncedId(chatId: string): number | null {
		const db = this.getDb();
		const row = db.query(
			"SELECT last_synced_id FROM sync_state WHERE chat_id = ?"
		).get(chatId) as SyncStateRow | null;

		return row?.last_synced_id ?? null;
	}

	setLastSyncedId(chatId: string, messageId: number): void {
		const db = this.getDb();

		db.run(`
			INSERT INTO sync_state (chat_id, last_synced_id, last_synced_at)
			VALUES (?, ?, datetime('now'))
			ON CONFLICT(chat_id) DO UPDATE SET
				last_synced_id = excluded.last_synced_id,
				last_synced_at = excluded.last_synced_at
		`, [chatId, messageId]);
	}

	// ── Stats ─────────────────────────────────────────────────────────

	getStats(chatId?: string): ChatStats[] {
		const db = this.getDb();

		if (chatId) {
			const row = db.query(`
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
			} | null;

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

		const rows = db.query(`
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
		const row = db.query("SELECT COUNT(*) AS cnt FROM messages").get() as { cnt: number };
		return row.cnt;
	}
}

// ── Cosine Distance ──────────────────────────────────────────────────

function cosineDistance(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const denom = Math.sqrt(normA) * Math.sqrt(normB);

	if (denom === 0) {
		return 2;
	}

	return 1 - dot / denom;
}

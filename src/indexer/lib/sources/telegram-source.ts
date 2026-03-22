import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    type DetectChangesOptions,
    defaultDetectChanges,
    defaultHashEntry,
    type IndexerSource,
    type ScanOptions,
    type SourceChanges,
    type SourceEntry,
} from "./source";

const DEFAULT_DB_PATH = join(homedir(), ".genesis-tools", "telegram", "history.db");

interface TelegramMessageRow {
    rowid: number;
    id: number;
    chat_id: string;
    sender_id: string | null;
    text: string | null;
    media_desc: string | null;
    is_outgoing: number;
    date_unix: number;
    date_iso: string;
    chat_title: string | null;
}

export interface TelegramSourceOptions {
    dbPath?: string;
    /** Only index specific chat IDs (default: all chats) */
    chatIds?: string[];
}

export class TelegramSource implements IndexerSource {
    private db: Database;
    private chatIds?: string[];

    private constructor(db: Database, chatIds?: string[]) {
        this.db = db;
        this.chatIds = chatIds;
    }

    static create(opts?: TelegramSourceOptions): TelegramSource {
        const dbPath = opts?.dbPath ?? DEFAULT_DB_PATH;

        if (!existsSync(dbPath)) {
            throw new Error(`Telegram history database not found at ${dbPath}. Run 'tools telegram sync' first.`);
        }

        let db: Database;

        try {
            db = new Database(dbPath, { readonly: true });
        } catch (err) {
            throw new Error(
                `Failed to open Telegram database at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`
            );
        }

        return new TelegramSource(db, opts?.chatIds);
    }

    async scan(opts?: ScanOptions): Promise<SourceEntry[]> {
        const limit = opts?.limit ?? 1_000_000;

        let chatFilter = "";
        const params: Array<string | number> = [];

        if (this.chatIds && this.chatIds.length > 0) {
            const placeholders = this.chatIds.map(() => "?").join(", ");
            chatFilter = `AND m.chat_id IN (${placeholders})`;
            params.push(...this.chatIds);
        }

        params.push(limit);

        const rows = this.db
            .query(`
            SELECT m.rowid, m.id, m.chat_id, m.sender_id, m.text, m.media_desc,
                   m.is_outgoing, m.date_unix, m.date_iso,
                   c.title AS chat_title
            FROM messages m
            LEFT JOIN chats c ON m.chat_id = c.chat_id
            WHERE m.text IS NOT NULL AND m.text != '' ${chatFilter}
            ORDER BY m.date_unix DESC
            LIMIT ?
        `)
            .all(...params) as TelegramMessageRow[];

        const total = rows.length;
        const entries: SourceEntry[] = [];
        const batchSize = opts?.batchSize ?? 500;
        let batch: SourceEntry[] = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const direction = row.is_outgoing ? "sent" : "received";
            const chatTitle = row.chat_title ?? row.chat_id;

            const content = [
                `Chat: ${chatTitle}`,
                `Date: ${row.date_iso}`,
                `Direction: ${direction}`,
                row.media_desc ? `Media: ${row.media_desc}` : null,
                "",
                row.text,
            ]
                .filter((line) => line !== null)
                .join("\n");

            const entry: SourceEntry = {
                id: `${row.chat_id}:${row.id}`,
                content,
                path: `${chatTitle}/${row.date_iso}`,
                metadata: {
                    rowid: row.rowid,
                    messageId: row.id,
                    chatId: row.chat_id,
                    chatTitle,
                    senderId: row.sender_id,
                    isOutgoing: row.is_outgoing === 1,
                    dateUnix: row.date_unix,
                    hasMedia: !!row.media_desc,
                },
            };

            entries.push(entry);
            batch.push(entry);

            if (opts?.onBatch && batch.length >= batchSize) {
                await opts.onBatch(batch);
                batch = [];
            }

            if (opts?.onProgress) {
                opts.onProgress(i + 1, total);
            }
        }

        if (opts?.onBatch && batch.length > 0) {
            await opts.onBatch(batch);
        }

        return entries;
    }

    detectChanges(opts: DetectChangesOptions): SourceChanges {
        return defaultDetectChanges(opts, this.hashEntry.bind(this));
    }

    async estimateTotal(): Promise<number> {
        let chatFilter = "";
        const params: Array<string | number> = [];

        if (this.chatIds && this.chatIds.length > 0) {
            const placeholders = this.chatIds.map(() => "?").join(", ");
            chatFilter = `AND chat_id IN (${placeholders})`;
            params.push(...this.chatIds);
        }

        const row = this.db
            .query(`SELECT COUNT(*) AS cnt FROM messages WHERE text IS NOT NULL AND text != '' ${chatFilter}`)
            .get(...params) as { cnt: number };

        return row.cnt;
    }

    hashEntry(entry: SourceEntry): string {
        return defaultHashEntry(entry);
    }

    dispose(): void {
        this.db.close();
    }
}

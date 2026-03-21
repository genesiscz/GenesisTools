import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { ENVELOPE_INDEX_PATH, normalizeMailboxName, parseMailboxUrl } from "@app/macos/lib/mail/constants";
import { EmlxBodyExtractor } from "@app/macos/lib/mail/emlx";
import {
    type DetectChangesOptions,
    defaultDetectChanges,
    defaultHashEntry,
    type IndexerSource,
    type ScanOptions,
    type SourceChanges,
    type SourceEntry,
} from "./source";

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
        if (!existsSync(ENVELOPE_INDEX_PATH)) {
            throw new Error(
                "Mail.app Envelope Index not found. Make sure Mail.app has been opened at least once.\n" +
                    `Expected: ${ENVELOPE_INDEX_PATH}`
            );
        }

        const db = new Database(ENVELOPE_INDEX_PATH, { readonly: true });
        const emlx = await EmlxBodyExtractor.create();
        return new MailSource(db, emlx);
    }

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

        const countParams = [...params];
        const countQuery = `SELECT COUNT(*) AS cnt FROM messages m ${whereClause}`;
        const totalRow = this.db.query(countQuery).get(...countParams) as { cnt: number };
        const total = Math.min(totalRow.cnt, limit);

        params.push(limit);

        const rows = this.db
            .query(
                `
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
        `
            )
            .all(...params) as MailRow[];

        const entries: SourceEntry[] = [];
        const batchSize = opts?.batchSize ?? 500;
        let batch: SourceEntry[] = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const body = (await this.emlx.getBody(row.rowid)) ?? "";
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

            const entry: SourceEntry = {
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
            };

            entries.push(entry);
            batch.push(entry);

            // Flush batch so progress survives cancellation
            if (opts?.onBatch && batch.length >= batchSize) {
                await opts.onBatch(batch);
                batch = [];
            }

            if (opts?.onProgress && (i % 100 === 0 || i === rows.length - 1)) {
                opts.onProgress(i + 1, total);
            }
        }

        // Flush remaining batch
        if (opts?.onBatch && batch.length > 0) {
            await opts.onBatch(batch);
        }

        return entries;
    }

    detectChanges(opts: DetectChangesOptions): SourceChanges {
        return defaultDetectChanges(opts, this.hashEntry.bind(this));
    }

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

        const row = this.db
            .query(`SELECT COUNT(*) AS cnt FROM messages WHERE ${conditions.join(" AND ")}`)
            .get(...params) as { cnt: number };
        return row.cnt;
    }

    hashEntry(entry: SourceEntry): string {
        return defaultHashEntry(entry);
    }

    dispose(): void {
        this.db.close();
        this.emlx.dispose();
    }
}

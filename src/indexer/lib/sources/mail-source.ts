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

        const totalRow = this.db.query("SELECT COUNT(*) AS cnt FROM messages WHERE deleted = 0").get() as {
            cnt: number;
        };
        const total = Math.min(totalRow.cnt, limit);

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
            WHERE m.deleted = 0
            ORDER BY m.date_received DESC
            LIMIT ?
        `
            )
            .all(limit) as MailRow[];

        const rowids = rows.map((r) => r.rowid);
        const bodies = await this.emlx.getBodies(rowids);

        const entries: SourceEntry[] = [];

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

        const deleted: string[] = [];

        for (const id of previousHashes.keys()) {
            if (!currentIds.has(id)) {
                deleted.push(id);
            }
        }

        return { added, modified, deleted, unchanged };
    }

    async estimateTotal(): Promise<number> {
        const row = this.db.query("SELECT COUNT(*) AS cnt FROM messages WHERE deleted = 0").get() as { cnt: number };
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

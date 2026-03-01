import { ClaudeDatabase } from "@app/utils/claude/database";

export interface UsageSnapshot {
    id: number;
    timestamp: string;
    accountName: string;
    bucket: string;
    utilization: number;
    resetsAt: string | null;
}

interface SnapshotRow {
    id: number;
    timestamp: string;
    account_name: string;
    bucket: string;
    utilization: number;
    resets_at: string | null;
}

export class UsageHistoryDb {
    private claudeDb: ClaudeDatabase;

    constructor(dbPath?: string) {
        this.claudeDb = dbPath ? new ClaudeDatabase(dbPath) : ClaudeDatabase.getInstance();
        this.ensureSchema();
    }

    private ensureSchema(): void {
        this.claudeDb.getDb().exec(`
            CREATE TABLE IF NOT EXISTS usage_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                account_name TEXT NOT NULL,
                bucket TEXT NOT NULL,
                utilization REAL NOT NULL,
                resets_at TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_snapshots_time
                ON usage_snapshots(timestamp);
            CREATE INDEX IF NOT EXISTS idx_snapshots_account_bucket
                ON usage_snapshots(account_name, bucket);
            CREATE INDEX IF NOT EXISTS idx_snapshots_lookup
                ON usage_snapshots(account_name, bucket, timestamp);
        `);
    }

    recordSnapshot(
        accountName: string,
        bucket: string,
        utilization: number,
        timestamp: string,
        resetsAt?: string | null
    ): number {
        const stmt = this.claudeDb.getDb().prepare(`
            INSERT INTO usage_snapshots (timestamp, account_name, bucket, utilization, resets_at)
            VALUES (?, ?, ?, ?, ?)
        `);
        const result = stmt.run(timestamp, accountName, bucket, utilization, resetsAt ?? null);
        return Number(result.lastInsertRowid);
    }

    recordIfChanged(accountName: string, bucket: string, utilization: number, resetsAt: string | null): boolean {
        const latest = this.getLatest(accountName, bucket);
        if (latest && latest.utilization === utilization) {
            return false;
        }

        this.recordSnapshot(accountName, bucket, utilization, new Date().toISOString(), resetsAt);
        return true;
    }

    getLatest(accountName: string, bucket: string): UsageSnapshot | null {
        const stmt = this.claudeDb.getDb().prepare(`
            SELECT id, timestamp, account_name, bucket, utilization, resets_at
            FROM usage_snapshots
            WHERE account_name = ? AND bucket = ?
            ORDER BY timestamp DESC
            LIMIT 1
        `);
        const row = stmt.get(accountName, bucket) as SnapshotRow | null;

        if (!row) {
            return null;
        }

        return this.mapRow(row);
    }

    getSnapshots(accountName: string, bucket: string, lastMinutes: number): UsageSnapshot[] {
        const cutoff = new Date(Date.now() - lastMinutes * 60_000).toISOString();
        const stmt = this.claudeDb.getDb().prepare(`
            SELECT id, timestamp, account_name, bucket, utilization, resets_at
            FROM usage_snapshots
            WHERE account_name = ? AND bucket = ?
              AND timestamp >= ?
            ORDER BY timestamp ASC
        `);
        const rows = stmt.all(accountName, bucket, cutoff) as SnapshotRow[];
        return rows.map((row) => this.mapRow(row));
    }

    getAllAccountBuckets(): Array<{ accountName: string; bucket: string }> {
        const stmt = this.claudeDb.getDb().prepare(`
            SELECT DISTINCT account_name, bucket
            FROM usage_snapshots
            ORDER BY account_name, bucket
        `);
        const rows = stmt.all() as Array<{ account_name: string; bucket: string }>;
        return rows.map((r) => ({ accountName: r.account_name, bucket: r.bucket }));
    }

    pruneOlderThan(days: number): number {
        return this.claudeDb.pruneTable("usage_snapshots", "timestamp", days);
    }

    close(): void {
        this.claudeDb.close();
    }

    private mapRow(row: SnapshotRow): UsageSnapshot {
        return {
            id: row.id,
            timestamp: row.timestamp,
            accountName: row.account_name,
            bucket: row.bucket,
            utilization: row.utilization,
            resetsAt: row.resets_at,
        };
    }
}

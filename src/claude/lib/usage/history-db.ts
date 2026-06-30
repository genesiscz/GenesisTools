import { ClaudeDatabase } from "@app/utils/claude/database";

export interface UsageSnapshot {
    id: number;
    timestamp: string;
    accountName: string;
    bucket: string;
    utilization: number;
    resetsAt: string | null;
    severity: string | null;
    scopeModel: string | null;
}

export interface SnapshotV2Extras {
    resetsAt: string | null;
    severity: string | null;
    scopeModel: string | null;
}

export interface SpendInput {
    used_minor: number;
    used_currency: string;
    used_exponent: number;
    limit_minor: number | null;
    limit_exponent: number | null;
    percent: number;
    severity: string;
    enabled: boolean;
    cap_minor: number | null;
    cap_currency: string | null;
}

export interface SpendSnapshot extends SpendInput {
    id: number;
    timestamp: string;
    accountName: string;
}

interface SnapshotRow {
    id: number;
    timestamp: string;
    account_name: string;
    bucket: string;
    utilization: number;
    resets_at: string | null;
    severity: string | null;
    scope_model: string | null;
}

interface SpendRow {
    id: number;
    timestamp: string;
    account_name: string;
    used_minor: number;
    used_currency: string;
    used_exponent: number;
    limit_minor: number | null;
    limit_exponent: number | null;
    percent: number;
    severity: string;
    enabled: number;
    cap_minor: number | null;
    cap_currency: string | null;
}

export class UsageHistoryDb {
    private claudeDb: ClaudeDatabase;

    constructor(dbPath?: string) {
        this.claudeDb = dbPath ? new ClaudeDatabase(dbPath) : ClaudeDatabase.getInstance();
        this.ensureSchema();
    }

    private ensureSchema(): void {
        const db = this.claudeDb.getDb();

        db.exec(`
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
            CREATE TABLE IF NOT EXISTS spend_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                account_name TEXT NOT NULL,
                used_minor INTEGER NOT NULL,
                used_currency TEXT NOT NULL,
                used_exponent INTEGER NOT NULL,
                limit_minor INTEGER,
                limit_exponent INTEGER,
                percent REAL NOT NULL,
                severity TEXT NOT NULL,
                enabled INTEGER NOT NULL,
                cap_minor INTEGER,
                cap_currency TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_spend_lookup
                ON spend_snapshots(account_name, timestamp);
        `);

        // SQLite has no ADD COLUMN IF NOT EXISTS — guard with PRAGMA table_info.
        const cols = db.prepare("PRAGMA table_info(usage_snapshots)").all() as Array<{ name: string }>;
        const have = new Set(cols.map((c) => c.name));

        if (!have.has("severity")) {
            db.exec("ALTER TABLE usage_snapshots ADD COLUMN severity TEXT");
        }

        if (!have.has("scope_model")) {
            db.exec("ALTER TABLE usage_snapshots ADD COLUMN scope_model TEXT");
        }
    }

    recordSnapshot(
        accountName: string,
        bucket: string,
        utilization: number,
        timestamp: string,
        resetsAt?: string | null
    ): number {
        return this.recordSnapshotV2(accountName, bucket, utilization, timestamp, {
            resetsAt: resetsAt ?? null,
            severity: null,
            scopeModel: null,
        });
    }

    recordSnapshotV2(
        accountName: string,
        bucket: string,
        utilization: number,
        timestamp: string,
        extras: SnapshotV2Extras
    ): number {
        const stmt = this.claudeDb.getDb().prepare(`
            INSERT INTO usage_snapshots
                (timestamp, account_name, bucket, utilization, resets_at, severity, scope_model)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
            timestamp,
            accountName,
            bucket,
            utilization,
            extras.resetsAt,
            extras.severity,
            extras.scopeModel
        );

        return Number(result.lastInsertRowid);
    }

    recordIfChanged(accountName: string, bucket: string, utilization: number, resetsAt: string | null): boolean {
        return this.recordIfChangedV2(accountName, bucket, utilization, {
            resetsAt,
            severity: null,
            scopeModel: null,
        });
    }

    recordIfChangedV2(accountName: string, bucket: string, utilization: number, extras: SnapshotV2Extras): boolean {
        const latest = this.getLatest(accountName, bucket);

        if (
            latest &&
            latest.utilization === utilization &&
            latest.severity === extras.severity &&
            latest.resetsAt === extras.resetsAt
        ) {
            return false;
        }

        this.recordSnapshotV2(accountName, bucket, utilization, new Date().toISOString(), extras);
        return true;
    }

    getLatest(accountName: string, bucket: string): UsageSnapshot | null {
        const stmt = this.claudeDb.getDb().prepare(`
            SELECT id, timestamp, account_name, bucket, utilization, resets_at, severity, scope_model
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
            SELECT id, timestamp, account_name, bucket, utilization, resets_at, severity, scope_model
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
        const usagePruned = this.claudeDb.pruneTable("usage_snapshots", "timestamp", days);
        const spendPruned = this.claudeDb.pruneTable("spend_snapshots", "timestamp", days);

        return usagePruned + spendPruned;
    }

    recordSpendIfChanged(accountName: string, spend: SpendInput): boolean {
        const latest = this.getLatestSpend(accountName);

        if (
            latest &&
            latest.used_minor === spend.used_minor &&
            latest.used_currency === spend.used_currency &&
            latest.used_exponent === spend.used_exponent &&
            latest.percent === spend.percent &&
            latest.severity === spend.severity &&
            latest.enabled === spend.enabled &&
            latest.limit_minor === spend.limit_minor &&
            latest.limit_exponent === spend.limit_exponent &&
            latest.cap_minor === spend.cap_minor &&
            latest.cap_currency === spend.cap_currency
        ) {
            return false;
        }

        const stmt = this.claudeDb.getDb().prepare(`
            INSERT INTO spend_snapshots
                (timestamp, account_name, used_minor, used_currency, used_exponent,
                 limit_minor, limit_exponent, percent, severity, enabled, cap_minor, cap_currency)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            new Date().toISOString(),
            accountName,
            spend.used_minor,
            spend.used_currency,
            spend.used_exponent,
            spend.limit_minor,
            spend.limit_exponent,
            spend.percent,
            spend.severity,
            spend.enabled ? 1 : 0,
            spend.cap_minor,
            spend.cap_currency
        );

        return true;
    }

    getLatestSpend(accountName: string): SpendSnapshot | null {
        const stmt = this.claudeDb.getDb().prepare(`
            SELECT id, timestamp, account_name, used_minor, used_currency, used_exponent,
                   limit_minor, limit_exponent, percent, severity, enabled, cap_minor, cap_currency
            FROM spend_snapshots
            WHERE account_name = ?
            ORDER BY timestamp DESC
            LIMIT 1
        `);
        const row = stmt.get(accountName) as SpendRow | null;

        if (!row) {
            return null;
        }

        return {
            id: row.id,
            timestamp: row.timestamp,
            accountName: row.account_name,
            used_minor: row.used_minor,
            used_currency: row.used_currency,
            used_exponent: row.used_exponent,
            limit_minor: row.limit_minor,
            limit_exponent: row.limit_exponent,
            percent: row.percent,
            severity: row.severity,
            enabled: row.enabled === 1,
            cap_minor: row.cap_minor,
            cap_currency: row.cap_currency,
        };
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
            severity: row.severity,
            scopeModel: row.scope_model,
        };
    }
}

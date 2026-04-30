import { Database as BunDatabase } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import logger from "@app/logger";
import { nowUtcIso, parseSqliteOrIsoDate } from "@app/utils/sql-time";

export { nowUtcIso, parseSqliteOrIsoDate, SQL_NOW_UTC } from "@app/utils/sql-time";

const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Base class for tools that historically held a raw `bun:sqlite` handle.
 *
 * **Prefer `createKyselyClient` for new code.** This class remains for adapters
 * that haven't migrated yet (FTS5 drivers, dynamic-column subsystems) and for
 * legacy `pruneTable` ergonomics.
 */
export abstract class BaseDatabase {
    protected db: BunDatabase;

    constructor(dbPath: string) {
        const dbDir = dirname(dbPath);

        if (!existsSync(dbDir)) {
            mkdirSync(dbDir, { recursive: true });
        }

        this.db = new BunDatabase(dbPath);
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA busy_timeout = 5000;");
        this.initSchema();
    }

    protected abstract initSchema(): void;

    getDb(): BunDatabase {
        return this.db;
    }

    close(): void {
        this.db.close();
    }

    static nowUtcIso(): string {
        return nowUtcIso();
    }

    static parseDate(value: string | null | undefined): Date | null {
        return parseSqliteOrIsoDate(value);
    }

    pruneTable(table: string, timestampColumn: string, days: number): number {
        if (!VALID_IDENTIFIER.test(table) || !VALID_IDENTIFIER.test(timestampColumn)) {
            throw new Error(`Invalid SQL identifier: table=${table}, column=${timestampColumn}`);
        }

        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const stmt = this.db.prepare(`DELETE FROM ${table} WHERE ${timestampColumn} < ?`);
        const result = stmt.run(cutoff);
        const deleted = result.changes;

        if (deleted > 0) {
            logger.debug(`Pruned ${deleted} rows from ${table} older than ${days} days`);
        }

        return deleted;
    }
}

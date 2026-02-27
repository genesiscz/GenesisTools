import { Database as BunDatabase } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import logger from "@app/logger";

export abstract class BaseDatabase {
    protected db: BunDatabase;

    constructor(dbPath: string) {
        const dbDir = dirname(dbPath);
        if (!existsSync(dbDir)) {
            mkdirSync(dbDir, { recursive: true });
        }

        this.db = new BunDatabase(dbPath);
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.initSchema();
    }

    protected abstract initSchema(): void;

    /** Expose raw database for modules that need to add tables */
    getDb(): BunDatabase {
        return this.db;
    }

    close(): void {
        this.db.close();
    }

    pruneTable(table: string, timestampColumn: string, days: number): number {
        const stmt = this.db.prepare(
            `DELETE FROM ${table} WHERE ${timestampColumn} < datetime('now', '-' || ? || ' days')`
        );
        const result = stmt.run(days);
        const deleted = result.changes;

        if (deleted > 0) {
            logger.debug(`Pruned ${deleted} rows from ${table} older than ${days} days`);
        }

        return deleted;
    }
}

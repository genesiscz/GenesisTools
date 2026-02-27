import { Database as BunDatabase } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import logger from "@app/logger";

const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

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
        if (!VALID_IDENTIFIER.test(table) || !VALID_IDENTIFIER.test(timestampColumn)) {
            throw new Error(`Invalid SQL identifier: table=${table}, column=${timestampColumn}`);
        }

        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const stmt = this.db.prepare(
            `DELETE FROM ${table} WHERE ${timestampColumn} < ?`
        );
        const result = stmt.run(cutoff);
        const deleted = result.changes;

        if (deleted > 0) {
            logger.debug(`Pruned ${deleted} rows from ${table} older than ${days} days`);
        }

        return deleted;
    }
}

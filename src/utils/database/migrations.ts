import type { Database } from "bun:sqlite";
import { logger } from "@genesiscz/utils/logger";

export interface Migration {
    id: string;
    description: string;
    /** Optional override; default checks the _migrations table. */
    isApplied?(db: Database, ctx: MigrationContext): boolean;
    apply(db: Database, ctx: MigrationContext): void;
}

export interface MigrationContext {
    /** Identifier the migration uses to scope DDL (e.g. table prefix). */
    tableName: string;
}

const MIGRATIONS_TABLE = "_migrations";

function ensureTable(db: Database): void {
    db.run(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
            id TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL,
            ms INTEGER NOT NULL
        )`
    );
}

function isAppliedDefault(db: Database, id: string): boolean {
    const row = db.query(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`).get(id) as { id: string } | null;
    return row !== null;
}

export function getPendingMigrations(db: Database, migrations: Migration[], ctx: MigrationContext): Migration[] {
    ensureTable(db);

    return migrations.filter((m) => {
        if (m.isApplied) {
            return !m.isApplied(db, ctx);
        }

        return !isAppliedDefault(db, `${ctx.tableName}:${m.id}`);
    });
}

export function runMigrations(
    db: Database,
    migrations: Migration[],
    ctx: MigrationContext
): { applied: string[]; skipped: string[] } {
    ensureTable(db);

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const m of migrations) {
        const scopedId = `${ctx.tableName}:${m.id}`;
        const isApplied = () => (m.isApplied ? m.isApplied(db, ctx) : isAppliedDefault(db, scopedId));

        if (isApplied()) {
            skipped.push(m.id);
            continue;
        }

        const start = performance.now();
        // IMMEDIATE, not a bare BEGIN. A deferred transaction takes its read
        // snapshot on the first read and then fails with SQLITE_BUSY_SNAPSHOT the
        // moment it upgrades to a write, if any other connection committed in
        // between — and SQLite does NOT call the busy handler for that upgrade, so
        // `busy_timeout` cannot absorb it. Four processes open this store (the
        // 30s daemon, the TUI, the dev-dashboard, the ai-proxy) and each migrates
        // on a read-write open, so that race is a normal Tuesday here.
        db.run("BEGIN IMMEDIATE");

        try {
            // Re-check now that the write lock is ours. The check above is
            // unsynchronised: two processes both answered "not applied", and the
            // loser re-ran DDL the winner had already committed, which surfaces as
            // a hard `duplicate column name` on an ordinary start.
            if (isApplied()) {
                db.run("ROLLBACK");
                skipped.push(m.id);
                continue;
            }

            m.apply(db, ctx);
            const ms = Math.round(performance.now() - start);
            db.run(`INSERT OR REPLACE INTO ${MIGRATIONS_TABLE} (id, applied_at, ms) VALUES (?, ?, ?)`, [
                scopedId,
                Date.now(),
                ms,
            ]);
            db.run("COMMIT");
            logger.info(`[migrate] applied ${m.id} on ${ctx.tableName} in ${ms}ms`);
            applied.push(m.id);
        } catch (err) {
            try {
                db.run("ROLLBACK");
            } catch (rollbackErr) {
                // Expected when SQLite already rolled the transaction back after a
                // DDL failure. Logged rather than dropped, so a rollback that fails
                // for any OTHER reason is not invisible.
                logger.debug({ err: rollbackErr, migration: scopedId }, "[migrate] rollback after a failed migration");
            }

            throw err;
        }
    }

    return { applied, skipped };
}

/** Adapter for code paths that hold a `MacDatabase`-style class. */
export class Migrator {
    constructor(
        private readonly db: Database,
        private readonly migrations: Migration[],
        private readonly ctx: MigrationContext
    ) {}

    run(): { applied: string[]; skipped: string[] } {
        return runMigrations(this.db, this.migrations, this.ctx);
    }

    pending(): Migration[] {
        return getPendingMigrations(this.db, this.migrations, this.ctx);
    }
}

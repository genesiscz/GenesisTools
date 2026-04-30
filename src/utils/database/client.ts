import { Database as BunDatabase } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import logger from "@app/logger";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "./dialect";
import { type Migration, type MigrationContext, runMigrations } from "./migrations";
import { applyPragmas, type Pragmas } from "./pragmas";

export interface DatabaseClient<DB> {
    /** Typed Kysely query builder. */
    readonly kysely: Kysely<DB>;
    /** Underlying bun:sqlite handle for FTS5 virtual tables, sqlite-vec, ATTACH, PRAGMA. */
    readonly raw: BunDatabase;
    /** Path the database is opened from. */
    readonly path: string;
    close(): void;
}

export interface CreateKyselyClientOptions<DB> {
    path: string;
    /** DDL run on every open via `IF NOT EXISTS`. Use for fresh-install bootstrap. */
    bootstrap?: string[];
    /** FTS5/trigger DDL or one-off data fixes via the existing migrations framework. */
    migrations?: Migration[];
    /**
     * Migration scope identifier. **Strongly recommended when `migrations` is set** —
     * the path-derived fallback changes if the database file moves, which would cause
     * applied migrations to re-run on the new path. Pin this to a stable string
     * (e.g. the tool name) so migration history is portable.
     */
    migrationContext?: MigrationContext;
    pragmas?: Pragmas;
    /** Open in read-only mode (system databases). */
    readonly?: boolean;
    /** Hook to load extensions (e.g. sqlite-vec) before pragmas/bootstrap run. */
    onOpen?: (db: BunDatabase) => void;
    /** Optional schema-typed reference; only used to anchor the DB type parameter. */
    _schema?: DB;
}

export function createKyselyClient<DB>(opts: CreateKyselyClientOptions<DB>): DatabaseClient<DB> {
    const { path, bootstrap, migrations, migrationContext, pragmas, readonly = false, onOpen } = opts;

    if (!readonly) {
        const dir = dirname(path);

        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }

    const raw = new BunDatabase(path, readonly ? { readonly: true } : undefined);
    onOpen?.(raw);
    applyPragmas(raw, pragmas, readonly);

    if (!readonly && bootstrap && bootstrap.length > 0) {
        for (const ddl of bootstrap) {
            raw.exec(ddl);
        }
    }

    if (!readonly && migrations && migrations.length > 0) {
        let ctx: MigrationContext;

        if (migrationContext) {
            ctx = migrationContext;
        } else {
            ctx = { tableName: deriveScope(path) };
            logger.debug(
                `[db] migrationContext not provided for ${path} — derived "${ctx.tableName}". ` +
                    `Pin an explicit migrationContext to keep migration history stable across path changes.`,
            );
        }

        runMigrations(raw, migrations, ctx);
    }

    const kysely = new Kysely<DB>({
        dialect: new BunSqliteDialect({ database: raw }),
    });

    logger.debug(`[db] opened ${path}${readonly ? " (readonly)" : ""}`);

    return {
        kysely,
        raw,
        path,
        close() {
            // Don't call kysely.destroy() — it would race with raw.close() to close
            // the same handle. Our BunSqliteDriver.destroy() does exactly raw.close().
            // Closing raw directly is safe and synchronous.
            raw.close();
        },
    };
}

function deriveScope(path: string): string {
    return path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { logger } from "@app/logger";
import { BunSqliteDialect } from "@app/utils/database";
import { type Migration, Migrator } from "@app/utils/database/migrations";
import { MacOS } from "@app/utils/macos/MacOS";
import { detectTerminalApp } from "@app/utils/terminal";
import { Kysely } from "kysely";

/**
 * Base class for readonly macOS SQLite databases with lazy connection
 * and automatic cleanup on process exit.
 *
 * Subclasses can use either:
 *   - `getDb()` for raw bun:sqlite (legacy / FTS5 / introspection)
 *   - `getKysely<DB>()` for typed Kysely queries against the schema interface
 */
export abstract class MacDatabase {
    private db: Database | null = null;
    private kysely: Kysely<unknown> | null = null;
    protected readonly migrations: Migration[] = [];
    protected readonly migrationTableName?: string;

    constructor() {
        process.on("exit", () => this.close());
    }

    protected abstract readonly dbPath: string;
    protected abstract readonly dbLabel: string;
    protected abstract readonly notFoundMessage: string;

    /** Subclasses can override to register UDFs / set extra pragmas after the DB opens. */
    protected onDbOpened?(db: Database): void;

    getMigrator(): Migrator {
        const tableName = this.migrationTableName ?? this.dbLabel.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
        return new Migrator(this.getDb(), this.migrations, { tableName });
    }

    protected getDb(): Database {
        if (this.db) {
            return this.db;
        }

        if (!existsSync(this.dbPath)) {
            throw new Error(`${this.dbLabel} not found at: ${this.dbPath}\n${this.notFoundMessage}`);
        }

        logger.debug(`Opening ${this.dbLabel} at ${this.dbPath} (readonly)`);

        try {
            this.db = new Database(this.dbPath, { readonly: true });
            // Live macOS DBs (Mail Envelope, Messages, etc.) get written by their owning app
            // concurrently; without busy_timeout the readonly connection throws SQLITE_BUSY
            // on the first contended page.
            this.db.exec("PRAGMA busy_timeout = 5000");
            this.onDbOpened?.(this.db);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // macOS TCC denies the open() syscall with EPERM, which bun:sqlite surfaces as
            // SQLITE_CANTOPEN ("unable to open database file") with no mention of EPERM. The
            // file existence was already verified above, so a failed open here is almost
            // always a Full Disk Access denial against the responsible process.
            if (
                message.includes("authorization denied") ||
                message.includes("not authorized") ||
                message.includes("EPERM") ||
                message.includes("unable to open database file") ||
                message.includes("SQLITE_CANTOPEN")
            ) {
                const termApp = detectTerminalApp();
                // Only surface the GUI pane interactively — a launchd/cron daemon must not
                // pop System Settings on every scheduled run.
                if (process.stdout.isTTY) {
                    MacOS.settings.openFullDiskAccess();
                }

                throw new Error(
                    [
                        `Full Disk Access is required to read the ${this.dbLabel}.`,
                        `Grant it in System Settings → Privacy & Security → Full Disk Access, add "${termApp}" (or the binary running this command), then restart it.`,
                        "If you recently upgraded a runtime (nvm/brew/bun), the new binary lives at a new path and must be re-granted — old grants don't transfer.",
                    ].join("\n")
                );
            }

            throw err;
        }

        return this.db;
    }

    protected getKysely<DB>(): Kysely<DB> {
        if (!this.kysely) {
            this.kysely = new Kysely<unknown>({
                dialect: new BunSqliteDialect({ database: this.getDb() }),
            });
        }

        return this.kysely as Kysely<DB>;
    }

    close(): void {
        if (this.kysely) {
            this.kysely.destroy().catch(() => {});
            this.kysely = null;
        }

        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

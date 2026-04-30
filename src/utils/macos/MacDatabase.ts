import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import logger from "@app/logger";
import { type Migration, Migrator } from "@app/utils/database/migrations";
import { MacOS } from "@app/utils/macos/MacOS";
import { detectTerminalApp } from "@app/utils/terminal";

/**
 * Base class for readonly macOS SQLite databases with lazy connection
 * and automatic cleanup on process exit.
 */
export abstract class MacDatabase {
    private db: Database | null = null;
    protected readonly migrations: Migration[] = [];
    protected readonly migrationTableName?: string;

    constructor() {
        process.on("exit", () => this.close());
    }

    protected abstract readonly dbPath: string;
    protected abstract readonly dbLabel: string;
    protected abstract readonly notFoundMessage: string;

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
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            if (
                message.includes("authorization denied") ||
                message.includes("not authorized") ||
                message.includes("EPERM")
            ) {
                const termApp = detectTerminalApp();
                MacOS.settings.openFullDiskAccess();

                throw new Error(
                    [
                        `Full Disk Access is required to read the ${this.dbLabel}.`,
                        "Opening System Settings → Privacy & Security → Full Disk Access...",
                        `Add "${termApp}" to the list, then restart your terminal.`,
                    ].join("\n")
                );
            }

            throw err;
        }

        return this.db;
    }

    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

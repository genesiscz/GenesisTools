import type { Database } from "bun:sqlite";
import { HistoryDatabase, openHistoryReadOnly } from "./database";
import { initializeCompactHistorySchema } from "./migrations";
import { type HistoryProvider, resolveHistoryProvider } from "./provider";
import { HistoryService } from "./service";
import { HistoryStatisticsRepository } from "./statistics-repository";
import { HistorySyncRepository } from "./sync-repository";

/** Writable history operations share the canonical connection and provider registry. */
function buildHistoryService(provider: HistoryProvider, db: Database, roots?: string[]): HistoryService {
    return new HistoryService({
        providerId: provider.id,
        reader: provider.reader,
        repository: new HistorySyncRepository(db),
        statistics: new HistoryStatisticsRepository(db),
        roots: roots ?? provider.reader.roots(),
    });
}

export function openHistoryService(options: {
    provider: string;
    roots?: string[];
    database?: Database;
}): HistoryService {
    const provider = resolveHistoryProvider(options.provider);
    const db = options.database ?? HistoryDatabase.getInstance().getDb();
    initializeCompactHistorySchema(db);

    return buildHistoryService(provider, db, options.roots);
}

/**
 * Read-only inspection of whatever is already indexed: no schema initialization, no discovery, no
 * database creation and no SQL writes. The cmux livelock rescue runs while the machine is wedged,
 * so it must never open a write transaction on the shared history database or walk tens of
 * thousands of source files.
 *
 * It is not literally write-free on disk: the index is a WAL database, so a read-only open
 * materialises `index.db-wal` and `index.db-shm`. Those are ordinary sidecars that any clean close
 * removes, and nothing in the database itself changes.
 *
 * Returns undefined when there is no database to read yet.
 */
export function openHistoryCached(options: {
    provider: string;
    roots?: string[];
    database?: Database;
}): { service: HistoryService; close: () => void } | undefined {
    const provider = resolveHistoryProvider(options.provider);
    const borrowed = options.database;
    const db = borrowed ?? openHistoryReadOnly();

    if (!db) {
        return undefined;
    }

    return {
        service: buildHistoryService(provider, db, options.roots),
        close: () => {
            if (!borrowed) {
                db.close();
            }
        },
    };
}

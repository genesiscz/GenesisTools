import { Database } from "bun:sqlite";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { HistoryDatabase, openHistoryReadOnly } from "./database";
import { fileListingFreshness } from "./listing-freshness";
import { initializeCompactHistorySchema } from "./migrations";
import { type HistoryProvider, resolveHistoryProvider } from "./provider";
import { HistoryService } from "./service";
import { HistoryStatisticsRepository } from "./statistics-repository";
import { HistorySyncRepository } from "./sync-repository";
import type { AgentSearchFilters } from "./types";

const log = logger.child({ component: "history/open-service" });

/**
 * Writable history operations share the canonical connection and provider registry. The refresh
 * marker belongs to the default index only: a refresh of another database (a caller's own, an
 * in-memory one) stamping it would let a poller of the real index skip a refresh it never had.
 */
function buildHistoryService(
    provider: HistoryProvider,
    db: Database,
    { roots, defaultIndex }: { roots?: string[]; defaultIndex: boolean }
): HistoryService {
    return new HistoryService({
        providerId: provider.id,
        reader: provider.reader,
        repository: new HistorySyncRepository(db),
        statistics: new HistoryStatisticsRepository(db),
        roots: roots ?? provider.reader.roots(),
        ...(defaultIndex ? { freshness: fileListingFreshness() } : {}),
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

    return buildHistoryService(provider, db, { roots: options.roots, defaultIndex: !options.database });
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
        service: buildHistoryService(provider, db, { roots: options.roots, defaultIndex: !borrowed }),
        close: () => {
            if (!borrowed) {
                db.close();
            }
        },
    };
}

/**
 * The listing catalog of one provider. `refresh: false` lists through a read-only connection: no schema
 * initialization, no migration, no discovery and no database creation. With nothing indexed yet, or an index
 * it cannot read (one that still needs a migration lacks columns the listing reads), it lists an empty
 * in-memory index (the second with a warning), so the answer has the usual shape and nothing is written. A diagnostic (`tools hub rules test`) lists this way; every
 * other caller refreshes as before.
 */
export async function catalogHistory(options: {
    provider: string;
    roots?: string[];
    filters?: AgentSearchFilters;
    maxDiscoveryAgeMs?: number;
    refresh?: boolean;
}): ReturnType<HistoryService["catalog"]> {
    const { provider, roots, filters = {}, maxDiscoveryAgeMs } = options;

    if (options.refresh !== false) {
        return openHistoryService({ provider, roots }).catalog(filters, { maxDiscoveryAgeMs });
    }

    const db = openHistoryReadOnly();

    if (db) {
        try {
            const service = buildHistoryService(resolveHistoryProvider(provider), db, { roots, defaultIndex: true });
            return await service.catalog(filters, { refresh: false });
        } catch (error) {
            log.warn(
                { error, provider },
                `[history] a read-only listing could not read the index (it may still need a migration); it lists nothing and leaves the index alone (an ordinary listing, such as ${toolCommand("claude history")}, migrates it)`
            );
        } finally {
            db.close();
        }
    }

    const empty = emptyHistory(provider, roots);

    try {
        return await empty.service.catalog(filters, { refresh: false });
    } finally {
        empty.close();
    }
}

function emptyHistory(provider: string, roots?: string[]): { service: HistoryService; close: () => void } {
    const db = new Database(":memory:");
    initializeCompactHistorySchema(db);
    return {
        service: buildHistoryService(resolveHistoryProvider(provider), db, { roots, defaultIndex: false }),
        close: () => db.close(),
    };
}

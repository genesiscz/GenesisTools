import { constants, Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";

const prof = profiler.scope("database-snapshot");
const MAX_STORES = 2;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const IDLE_MS = 60_000;
const snapshots = new Map<string, { signature: string; db: Database; usedAt: number }>();

function signature(path: string): string {
    return [path, `${path}-wal`]
        .map((file, index) => {
            const stat = statSync(file, { bigint: true, throwIfNoEntry: false });
            return stat && (index === 0 || stat.size > 0n)
                ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`
                : "missing";
        })
        .join("|");
}

function closeSnapshot(path: string): void {
    snapshots.get(path)?.db.close();
    snapshots.delete(path);
}

export function clearDatabaseReadSnapshots(): void {
    for (const path of snapshots.keys()) {
        closeSnapshot(path);
    }
}

/** Schema changes and derived-index catch-up run on a transient copy, never the durable store. */
export function withDatabaseReadSnapshot<T>({
    path: input,
    initialize,
    read,
}: {
    path: string;
    initialize: (db: Database) => void;
    read: (db: Database) => T;
}): T {
    const path = resolve(input);
    const now = Date.now();
    for (const [key, entry] of snapshots) {
        if (now - entry.usedAt > IDLE_MS) {
            closeSnapshot(key);
        }
    }
    const current = signature(path);
    let entry = snapshots.get(path);
    if (entry && entry.signature !== current) {
        closeSnapshot(path);
        entry = undefined;
    }

    if (!entry) {
        const copy = prof.measure("clone", () => {
            for (let attempt = 0; attempt < 3; attempt++) {
                const before = signature(path);
                if (!statSync(path, { throwIfNoEntry: false })) {
                    return { db: new Database(":memory:"), signature: before };
                }

                const wal = statSync(`${path}-wal`, { throwIfNoEntry: false });
                // A checkpointed store needs no WAL coordination or sidecar creation.
                const sourcePath = wal && wal.size > 0 ? path : `${pathToFileURL(path).href}?immutable=1`;
                const source = new Database(sourcePath, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
                let bytes: Buffer;
                try {
                    bytes = source.serialize();
                } finally {
                    source.close();
                }

                if (signature(path) !== before) {
                    logger.debug({ path, attempt }, "Store changed while copying the read snapshot");
                    continue;
                }

                // SQLite's serialized image retains WAL version bytes. Its in-memory copy has no WAL file.
                bytes[18] = 1;
                bytes[19] = 1;
                return { db: Database.deserialize(bytes), signature: before };
            }

            throw new Error("The store kept changing while taking a read snapshot; retry the refresh");
        });
        while (snapshots.size >= MAX_STORES) {
            const oldest = [...snapshots].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
            closeSnapshot(oldest[0]);
        }
        entry = { ...copy, usedAt: now };
        snapshots.set(path, entry);
        logger.debug({ path }, "Opened transient read snapshot");
    }
    entry.usedAt = now;
    try {
        initialize(entry.db);
        return read(entry.db);
    } catch (error) {
        closeSnapshot(path);
        throw error;
    } finally {
        if (snapshots.get(path) === entry) {
            const pages = entry.db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
            const pageSize = entry.db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;
            if (pages * pageSize > MAX_STORE_BYTES) {
                closeSnapshot(path);
            }
        }
    }
}

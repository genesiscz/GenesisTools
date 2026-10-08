import { constants, Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";

const prof = profiler.scope("database-snapshot");
const MAX_STORES = 2;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const IDLE_MS = 60_000;
const snapshots = new Map<string, { signature: string; db: Database; usedAt: number; file?: string }>();

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

function removeCopy(file: string): void {
    for (const part of [file, `${file}-wal`, `${file}-shm`]) {
        try {
            unlinkSync(part);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                logger.warn({ error, file: part }, "Read snapshot copy not removed");
            }
        }
    }
}

function closeSnapshot(path: string): void {
    const entry = snapshots.get(path);
    entry?.db.close();
    snapshots.delete(path);
    if (entry?.file) {
        removeCopy(entry.file);
    }
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
    maxMemoryBytes = MAX_STORE_BYTES,
}: {
    path: string;
    initialize: (db: Database) => void;
    read: (db: Database) => T;
    /** A store larger than this on disk is copied to a temporary file instead of into memory (tests lower it). */
    maxMemoryBytes?: number;
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
                // serialize() and deserialize() each hold the whole store in memory. A store past the limit is
                // copied to a temporary file instead, so its size never decides the process's memory.
                const onDisk = (statSync(path, { throwIfNoEntry: false })?.size ?? 0) + (wal?.size ?? 0);
                const file = onDisk > maxMemoryBytes ? join(tmpdir(), `read-snapshot-${randomUUID()}.sqlite`) : null;
                let bytes: Buffer | null = null;
                try {
                    if (file) {
                        source.run("VACUUM INTO ?", [file]);
                    } else {
                        bytes = source.serialize();
                    }
                } catch (error) {
                    if (file) {
                        removeCopy(file);
                    }

                    throw error;
                } finally {
                    source.close();
                }

                if (signature(path) !== before) {
                    logger.debug({ path, attempt }, "Store changed while copying the read snapshot");
                    if (file) {
                        removeCopy(file);
                    }

                    continue;
                }

                if (file) {
                    logger.debug({ path, file, bytes: onDisk }, "Read snapshot copied to a temporary file");
                    return { db: new Database(file), signature: before, file };
                }

                if (!bytes) {
                    throw new Error("The read snapshot produced no image");
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
        // A copy past the limit is not kept: an in-memory one would hold that memory, and a file one is removed now
        // rather than left in the temporary folder until the next call's idle sweep.
        if (snapshots.get(path) === entry) {
            const pages = entry.db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
            const pageSize = entry.db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;
            if (pages * pageSize > maxMemoryBytes) {
                closeSnapshot(path);
            }
        }
    }
}

import type { Database } from "bun:sqlite";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { logger } from "@genesiscz/utils/logger";

/**
 * Fires `onChange` when ANOTHER connection commits to a bun:sqlite database.
 *
 * Cross-process wake for a SQLite-backed queue without polling the table: `fs.watch` on the
 * database directory sees the `-wal` (or main file) change on every commit, and
 * `PRAGMA data_version` filters out this connection's own commits, which do not bump it.
 * The watcher is debounced, so a burst of commits produces one wake.
 *
 * Returns a stop function. An in-memory database has nothing to watch and returns a no-op;
 * callers keep a slow fallback poll for that case and for the rare dropped fs event.
 */
export function watchSqliteChanges(db: Database, onChange: () => void, opts: { debounceMs?: number } = {}): () => void {
    const filename = db.filename;

    if (!filename || filename === ":memory:" || filename.startsWith("file::memory:")) {
        return () => {};
    }

    const dir = dirname(filename);
    const base = basename(filename);
    const interesting = new Set([base, `${base}-wal`, `${base}-journal`]);

    if (!existsSync(dir)) {
        logger.debug({ dir }, "sqlite wake: directory missing, not watching");
        return () => {};
    }

    let lastVersion = readDataVersion(db);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watcher: FSWatcher;

    const check = () => {
        timer = null;
        const version = readDataVersion(db);

        if (version === null || version === lastVersion) {
            return;
        }

        lastVersion = version;
        onChange();
    };

    try {
        watcher = watch(dir, (_event, changed) => {
            if (changed && !interesting.has(changed.toString())) {
                return;
            }

            if (timer) {
                return;
            }

            timer = setTimeout(check, opts.debounceMs ?? 25);
            timer.unref();
        });
        watcher.unref();
    } catch (error) {
        logger.debug({ err: error, dir }, "sqlite wake: fs.watch failed, relying on the fallback poll");
        return () => {};
    }

    watcher.on("error", (error) => {
        logger.debug({ err: error, dir }, "sqlite wake: watcher error, relying on the fallback poll");
    });

    return () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }

        watcher.close();
    };
}

/** Bumps whenever another connection commits; unchanged by this connection's own commits. */
export function readDataVersion(db: Database): number | null {
    try {
        const row = db.query<{ data_version: number | bigint }, []>("PRAGMA data_version").get();

        if (!row) {
            return null;
        }

        return typeof row.data_version === "bigint" ? Number(row.data_version) : row.data_version;
    } catch (error) {
        logger.debug({ err: error }, "sqlite wake: PRAGMA data_version failed");
        return null;
    }
}

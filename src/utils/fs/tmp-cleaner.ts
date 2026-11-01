import { lstatSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";

/**
 * macOS runs `/usr/libexec/tmp_cleaner` every day (launchd `com.apple.tmp_cleaner`: at midnight, and on a wake after a
 * missed run). In /tmp it deletes every regular file whose access, modification and change times are ALL older than
 * this many days, then every empty folder whose modification time is. A rename keeps the times of everything inside a
 * moved folder, so a tree moved into /tmp to wait (a `tools rm` aside or trash batch) can go at the next run.
 */
export const TMP_CLEANER_DAYS = 3;

/** A file read in the last 12 hours is left alone: the cleaner cannot take it for 2.5 more days. */
const FRESH_MS = 12 * 60 * 60_000;

export interface TmpCleanerRefresh {
    /** Regular files whose access time was set to now (modification time kept, change time now). */
    files: number;
    /** Regular files read in the last 12 hours, left as they were. */
    fresh: number;
    /** Empty folders whose times were set to now: the cleaner removes an empty folder by its modification time. */
    emptyDirs: number;
    /** Entries that could not be read or changed; a path that vanished during the walk is not counted. */
    failed: number;
}

/**
 * Keeps the tree at `root` out of macOS tmp_cleaner's reach for {@link TMP_CLEANER_DAYS} days: every regular file
 * gets access time now with its modification time kept, which also sets its change time to now, and an empty folder
 * gets both times now. A file read in the last 12 hours is skipped. Symlinks, sockets and FIFOs stay untouched (the
 * cleaner deletes regular files and empty folders only). Metadata only: no file content is read. Never throws.
 */
export function keepFromTmpCleaner(root: string, now = new Date()): TmpCleanerRefresh {
    const result: TmpCleanerRefresh = { files: 0, fresh: 0, emptyDirs: 0, failed: 0 };
    const seconds = now.getTime() / 1000;
    const dirs: string[] = [];
    let firstError: unknown = null;

    const attempt = (step: () => void): void => {
        try {
            step();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return;
            }

            result.failed++;
            firstError ??= error;
        }
    };

    const visit = (path: string): void => {
        const stat = lstatSync(path);

        if (stat.isDirectory()) {
            dirs.push(path);
            return;
        }

        if (!stat.isFile()) {
            return;
        }

        if (now.getTime() - stat.atimeMs < FRESH_MS) {
            result.fresh++;
            return;
        }

        utimesSync(path, seconds, stat.mtimeMs / 1000);
        result.files++;
    };

    attempt(() => visit(root));

    while (dirs.length > 0) {
        const dir = dirs.pop() ?? "";

        attempt(() => {
            const entries = readdirSync(dir, { withFileTypes: true });

            if (entries.length === 0) {
                utimesSync(dir, seconds, seconds);
                result.emptyDirs++;
                return;
            }

            for (const entry of entries) {
                const path = join(dir, entry.name);

                if (entry.isDirectory()) {
                    dirs.push(path);
                } else if (!entry.isSymbolicLink()) {
                    attempt(() => visit(path));
                }
            }
        });
    }

    if (result.failed > 0) {
        logger.warn({ root, ...result, error: firstError }, "tmp-cleaner: some entries kept their old times");
    }

    return result;
}

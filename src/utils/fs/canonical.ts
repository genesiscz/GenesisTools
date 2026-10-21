import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { logger } from "@genesiscz/utils/logger";

/**
 * True for the errors a path lookup gives when the path is simply not there (ENOENT, ENOTDIR).
 * Callers that expect missing paths skip logging these: the hub's roster refresh hit them about
 * 70,000 times a day, and each debug line with its stack made the day log grow by 120 MB.
 */
export function isMissingPathError(err: unknown): boolean {
    const code = err instanceof Error && "code" in err ? err.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Absolute, symlink-free form of a directory path. A path that does not exist
 * cannot be realpath'd, so it is returned resolved but uncanonicalized.
 * Shared because several tools key state by directory and must agree on the
 * spelling (macOS hands out both `/var/...` and `/private/var/...`).
 */
export function canonicalDir(dir: string): string {
    const abs = resolve(dir);

    if (!existsSync(abs)) {
        return abs;
    }

    try {
        return realpathSync(abs);
    } catch (err) {
        logger.debug({ err, dir: abs }, "canonicalDir: realpath failed, using the resolved path");

        return abs;
    }
}

/**
 * Canonical key for a file, including a missing leaf beneath an existing parent.
 * Resolving the parent keeps a deleted file's key stable through directory symlinks.
 * If the parent is unavailable too, returns the absolute unresolved spelling.
 */
export function canonicalPath(path: string): string {
    const abs = resolve(path);
    try {
        return realpathSync(abs);
    } catch (err) {
        if (!isMissingPathError(err)) {
            logger.debug({ err, path: abs }, "canonicalPath: realpath failed, resolving the parent");
        }

        return join(canonicalDir(dirname(abs)), basename(abs));
    }
}

/**
 * True when `child` is `root` itself or sits underneath it, compared on the
 * CANONICAL form of both. `path.resolve` does not follow symlinks, so a string
 * prefix check alone approves a symlink inside `root` that points outside it.
 */
export function isInsideDir(root: string, child: string): boolean {
    const realRoot = canonicalDir(root);
    const realChild = canonicalDir(child);

    return realChild === realRoot || realChild.startsWith(realRoot + sep);
}

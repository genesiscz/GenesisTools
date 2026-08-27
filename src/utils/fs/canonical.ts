import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { logger } from "@genesiscz/utils/logger";

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
 * True when `child` is `root` itself or sits underneath it, compared on the
 * CANONICAL form of both. `path.resolve` does not follow symlinks, so a string
 * prefix check alone approves a symlink inside `root` that points outside it.
 */
export function isInsideDir(root: string, child: string): boolean {
    const realRoot = canonicalDir(root);
    const realChild = canonicalDir(child);

    return realChild === realRoot || realChild.startsWith(realRoot + sep);
}

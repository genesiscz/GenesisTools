import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

/**
 * The JSON file a resumable git operation keeps in the git COMMON dir, so every worktree of the
 * clone sees the same operation (`rebase-cascade`, `rebranch apply`). An unreadable file reads as
 * no operation, with a warning in the log, unless `strict` is set: then it throws, because a caller
 * that starts a new operation on "no operation" would overwrite the only record of the old one.
 */
export function readStateFile<T>(path: string, options: { strict?: boolean } = {}): T | null {
    if (!existsSync(path)) {
        return null;
    }

    try {
        return SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as T;
    } catch (err) {
        if (options.strict) {
            throw new Error(
                `${path} is unreadable (${err instanceof Error ? err.message : String(err)}); it is the only record of the operation in progress. Repair or delete it by hand`,
                { cause: err }
            );
        }

        logger.warn({ err, path }, "git: unreadable operation state file");
        return null;
    }
}

/** Replaces the file through a temp file and a rename, so an interrupted write never leaves it truncated. */
export function writeStateFile(path: string, value: unknown): void {
    atomicWriteFileSync(path, `${SafeJSON.stringify(value, null, 2)}\n`);
}

export function removeStateFile(path: string): void {
    if (existsSync(path)) {
        unlinkSync(path);
    }
}

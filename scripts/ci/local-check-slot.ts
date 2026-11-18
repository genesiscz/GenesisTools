import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { spawnWithDeadline } from "./spawn-deadline";

/**
 * The lock file every linked worktree of one repository shares. A `git clone --shared` copy has a Git directory of its
 * own, so it takes the one its object alternates point into: the babysit integration gates run in such a snapshot, and
 * without this every snapshot ran its heavy checks beside the worktrees' pushes.
 */
export function heavyCheckLockPath(cwd?: string): string {
    const common = spawnWithDeadline(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
    if (common.exitCode !== 0 || !common.stdout.toString().trim()) {
        throw new Error(`Cannot locate the shared Git directory: ${common.stderr.toString().trim()}`);
    }

    return join(sharedCloneRoot(realpathSync(common.stdout.toString().trim())), "genesis-heavy-check.lock");
}

/**
 * The repository at the end of a chain of shared clones. `git clone --shared` records the source's own objects folder,
 * so a clone of a clone (A, then B from A, then C from B) points C at B, while B waits in A's slot. Each hop is
 * followed until a repository without alternates, and a loop stops at the first folder seen twice.
 */
function sharedCloneRoot(gitDir: string): string {
    const seen = new Set<string>([gitDir]);
    let current = gitDir;

    for (let next = sharedCloneOrigin(current); next !== null && !seen.has(next); next = sharedCloneOrigin(current)) {
        seen.add(next);
        current = next;
    }

    return current;
}

/** The Git directory a `git clone --shared` copy borrows its objects from, or null for an ordinary repository. */
function sharedCloneOrigin(gitDir: string): string | null {
    const alternates = join(gitDir, "objects", "info", "alternates");

    if (!existsSync(alternates)) {
        return null;
    }

    const first = readFileSync(alternates, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("#"));

    if (!first) {
        return null;
    }

    const objects = isAbsolute(first) ? first : resolve(gitDir, "objects", first);

    if (basename(objects) !== "objects" || !existsSync(objects)) {
        return null;
    }

    return dirname(realpathSync(objects));
}

/** Linked worktrees share this slot; their passing results and incremental files remain separate. */
export async function withLocalCheckSlot<T>(run: () => Promise<T>): Promise<T> {
    return withFileLock(heavyCheckLockPath(), run, 15 * 60_000);
}

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { StatusEntry } from "@genesiscz/utils/git/porcelain";
import type { DiffConfig } from "../config";
import { gitOut, isDeleted, isUntrackedDirectory, statusEntries } from "../git";

export interface ChangedFile {
    path: string;
    untracked: boolean;
    deleted: boolean;
    root: string;
}

function touchedSince(path: string, since: number): boolean {
    try {
        return statSync(path).mtimeMs >= since;
    } catch {
        // A path that cannot be stat'ed did not change within the window by any measure we
        // have. A deleted one never reaches here: it is admitted before this filter, because
        // mtime cannot gate a file that is gone.
        return false;
    }
}

/**
 * git collapses a wholly-untracked directory into one `? scratch/` entry, and appending to a
 * file inside it does not change the directory's mtime, so the edit is invisible unless the
 * entry is expanded. `-uall` globally is banned in this repo for memory reasons, so only the
 * directories that actually appear get expanded.
 */
export interface ChangedSource {
    /** The status this call already read, so the post phase does not spawn `git status` twice. */
    entries: StatusEntry[];
    /** Repo-relative paths a commit made DURING the command, which status no longer reports. */
    committed: string[];
}

export function changedFiles(root: string, since: number, config: DiffConfig, source?: ChangedSource): ChangedFile[] {
    const entries: ChangedFile[] = [];

    // A file the command edited AND COMMITTED is clean by the time the post phase looks, so
    // `git status` does not mention it at all. Measured 2026-09-21: an edit alone rendered,
    // the same edit followed by `git commit` in the same call rendered nothing.
    for (const name of source?.committed ?? []) {
        entries.push({ path: resolve(root, name), untracked: false, deleted: !existsSync(resolve(root, name)), root });
    }

    for (const entry of source?.entries ?? statusEntries(root)) {
        const untracked = entry.kind === "untracked";
        const deleted = isDeleted(entry);

        if (isUntrackedDirectory(entry)) {
            const listed = gitOut(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", entry.path])
                .split("\0")
                .filter((name) => name.length > 0)
                .slice(0, config.untrackedExpansionCap);

            for (const name of listed) {
                entries.push({ path: resolve(root, name), untracked: true, deleted: false, root });
            }

            continue;
        }

        entries.push({ path: resolve(root, entry.path), untracked, deleted, root });
    }

    const seen = new Set<string>();

    // A file the command committed AND then edited again appears in BOTH lists above, and
    // rendered twice in one call. The committed entry is kept: it is the one that knows the
    // path is tracked.
    return entries.filter((entry) => {
        if (seen.has(entry.path)) {
            return false;
        }

        seen.add(entry.path);

        return entry.deleted || touchedSince(entry.path, since);
    });
}

import { statSync } from "node:fs";
import { resolve } from "node:path";
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
export function changedFiles(root: string, since: number, config: DiffConfig): ChangedFile[] {
    const entries: ChangedFile[] = [];

    for (const entry of statusEntries(root)) {
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

    return entries.filter((entry) => entry.deleted || touchedSince(entry.path, since));
}

import { lstatSync } from "node:fs";
import { join } from "node:path";
import { committedChanges, type FileChange, uncommittedChanges } from "@app/git/lib/changes";
import { createGit } from "@genesiscz/utils/git";
import { logger } from "@genesiscz/utils/logger";

const log = logger.scoped("git-changes").log;

function mtimeUnder(root: string): (path: string) => Date | null {
    return (path) => {
        try {
            return lstatSync(join(root, path)).mtime;
        } catch (err) {
            log.debug({ err, path }, "no mtime for path");
            return null;
        }
    };
}

export async function readUncommittedChanges({ cwd, now }: { cwd?: string; now: Date }): Promise<FileChange[]> {
    const git = createGit({ cwd });
    const [root, status] = await Promise.all([git.getRepoRoot(), git.status({ untracked: "all" })]);
    log.debug({ root, entries: status.entries.length }, "read uncommitted status");

    return uncommittedChanges(status.entries, mtimeUnder(root), now);
}

export async function readCommittedChanges({ cwd, commits }: { cwd?: string; commits: number }): Promise<FileChange[]> {
    const git = createGit({ cwd });
    const [history, changes] = await Promise.all([
        git.log({ range: "HEAD", limit: commits }),
        git.rawChanges({ range: "HEAD", renames: true, limit: commits }),
    ]);
    log.debug({ commits: history.length, changes: changes.length }, "read committed changes");

    return committedChanges(history, changes);
}

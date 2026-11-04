import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * The text of a meeting's context file as the meeting saw it. A wiki page that was edited or deleted after the meeting
 * no longer holds the lines that were read aloud, so a file in a git repository is read at the last commit before the
 * meeting ended whenever the file on disk changed after it (or is gone). A file outside git is read as it is.
 */
export interface ContextFileText {
    text: string;
    /** `disk`: the file as it is; `git`: the commit before the meeting's end, because the file changed or is gone. */
    from: "disk" | "git";
    commit?: string;
    /** Why this text may not be what the meeting saw. */
    warning?: string;
}

function git(cwd: string, args: string[]): string | undefined {
    const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return run.exitCode === 0 ? run.stdout.toString() : undefined;
}

/** The nearest existing folder at or above `path`: a deleted file's folder may be gone too. */
function existingFolder(path: string): string | undefined {
    let folder = dirname(path);

    while (!existsSync(folder)) {
        const parent = dirname(folder);

        if (parent === folder) {
            return undefined;
        }

        folder = parent;
    }

    return folder;
}

/** The file's text at the last commit at or before `at`, with that commit; undefined outside git or with no commit. */
function textAtCommitBefore(path: string, at: Date): { text: string; commit: string } | undefined {
    const folder = existingFolder(path);
    const root = folder ? git(folder, ["rev-parse", "--show-toplevel"])?.trim() : undefined;

    if (!folder || !root) {
        return undefined;
    }

    // git prints the real path of the root (/private/var on macOS for /var): resolve the folder the same way.
    const file = relative(root, join(realpathSync(folder), relative(folder, path)));
    const commit = git(root, ["rev-list", "-1", `--before=${at.toISOString()}`, "HEAD", "--", file])?.trim();

    if (!commit) {
        return undefined;
    }

    const text = git(root, ["show", `${commit}:${file}`]);
    return text === undefined ? undefined : { text, commit: commit.slice(0, 10) };
}

/** Reads a context file as of the meeting's end (`at`); undefined when it is gone and no commit holds it. */
export function contextFileText(path: string, at: Date | undefined): ContextFileText | undefined {
    const onDisk = existsSync(path);

    if (onDisk && (!at || statSync(path).mtime <= at)) {
        return { text: readFileSync(path, "utf8"), from: "disk" };
    }

    const committed = at ? textAtCommitBefore(path, at) : undefined;

    if (committed) {
        return { ...committed, from: "git" };
    }

    if (onDisk) {
        return {
            text: readFileSync(path, "utf8"),
            from: "disk",
            warning: `${path} changed after the meeting and no commit holds the earlier text; its line numbers may have moved`,
        };
    }

    return undefined;
}

/** The meeting's end, else its start: the moment its context files are read at. */
export function contextMoment(record: { start?: string; end?: string }): Date | undefined {
    const iso = record.end ?? record.start;
    return iso ? new Date(iso) : undefined;
}

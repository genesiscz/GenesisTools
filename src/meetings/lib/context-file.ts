import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseLsTreeZ } from "@genesiscz/utils/git/porcelain";
import type { MeetingContext, MeetingRecord } from "@genesiscz/utils/meetings/record";

/**
 * The text of a meeting's context file as the meeting saw it. A wiki page that was edited or deleted after the meeting
 * no longer holds the lines that were read aloud, so a file in a git repository is read at the last commit before the
 * meeting ended whenever the file on disk changed after it (or is gone). A file outside git is read as it is.
 */
export interface ContextFileText {
    text: string;
    /** `disk`: the current file; `git`: an explicitly saved revision or the legacy historical fallback. */
    from: "disk" | "git";
    commit?: string;
    /** Why this text may not be what the meeting saw. */
    warning?: string;
}

/** One git read; a stalled git (a hung filesystem, a lock) counts as no historical version, like any other failure. */
const GIT_TIMEOUT_MS = 10_000;

function git(cwd: string, args: string[]): string | undefined {
    const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: GIT_TIMEOUT_MS });
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

/** The one Git resolver for explicit revisions and the legacy time-based fallback. */
function textAtRevision({
    path,
    at,
    rev,
}: {
    path: string;
    at?: Date;
    rev?: string;
}): { text: string; commit: string } | undefined {
    const folder = existsSync(path) ? dirname(realpathSync(path)) : existingFolder(path);
    const root = folder ? git(folder, ["rev-parse", "--show-toplevel"])?.trim() : undefined;

    if (!folder || !root) {
        return undefined;
    }

    // git prints the real path of the root (/private/var on macOS for /var): resolve the folder the same way.
    const file = relative(
        root,
        existsSync(path) ? realpathSync(path) : join(realpathSync(folder), relative(folder, path))
    );
    const commit =
        rev !== undefined
            ? git(root, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`])?.trim()
            : at
              ? git(root, ["rev-list", "-1", `--before=${at.toISOString()}`, "HEAD", "--", `:(literal)${file}`])?.trim()
              : undefined;

    if (!commit) {
        return undefined;
    }

    const tree = git(root, ["ls-tree", "-z", commit, "--", `:(literal)${file}`]);
    const entry = tree === undefined ? undefined : parseLsTreeZ(tree).find((entry) => entry.path === file);

    if (entry?.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
        return undefined;
    }

    const text = git(root, ["show", `${commit}:${file}`]);
    return text === undefined ? undefined : { text, commit };
}

/** Reads a context file as of the meeting's end (`at`); undefined when it is gone and no commit holds it. */
export function contextFileText(path: string, at: Date | undefined): ContextFileText | undefined {
    const onDisk = existsSync(path);

    if (onDisk && (!at || statSync(path).mtime <= at)) {
        return { text: readFileSync(path, "utf8"), from: "disk" };
    }

    const committed = at ? textAtRevision({ path, at }) : undefined;

    if (committed) {
        return { ...committed, commit: committed.commit.slice(0, 10), from: "git" };
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

/** Explicit selection snapshots bytes now; later reads never consult Git or the working file for this entry. */
export function contextFileRevision(options: {
    path: string;
    rev?: string;
    beforeMeeting?: boolean;
    start: string;
}): NonNullable<MeetingContext["file"]>["revision"] | undefined {
    const { path, rev, beforeMeeting, start } = options;

    if (rev !== undefined && beforeMeeting) {
        throw new Error("--rev and --before-meeting cannot be used together.");
    }

    if (existsSync(path) && !statSync(path).isFile()) {
        throw new Error(`Not a file: ${path}. Give a document file.`);
    }

    if (rev === undefined && !beforeMeeting) {
        if (!existsSync(path)) {
            throw new Error(
                `No such file: ${path}. Give --rev <sha> or --before-meeting to select a committed document.`
            );
        }

        return undefined;
    }

    const revision = textAtRevision({ path, rev, ...(beforeMeeting ? { at: new Date(start) } : {}) });

    if (!revision) {
        throw new Error(
            `Cannot read ${path} as a committed file ${beforeMeeting ? `before meeting start ${start}` : `at revision "${rev}"`}. Check the Git repository, revision and file path.`
        );
    }

    return revision;
}

/** One entry reader for quotes, term vocabulary and warnings. Legacy references retain their time-based fallback. */
export function contextEntryText(
    entry: MeetingContext,
    record: Pick<MeetingRecord, "start" | "end">
): ContextFileText | undefined {
    if (entry.kind !== "file") {
        return undefined;
    }

    const revision = entry.file?.revision;
    return revision ? { ...revision, from: "git" } : contextFileText(entry.ref, contextMoment(record));
}

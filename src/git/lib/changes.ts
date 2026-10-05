import type { CommitInfo, RawChange, StatusEntry } from "@genesiscz/utils/git";

export interface FileChange {
    file: string;
    /** Two characters in `git status --short` style: `M `, ` M`, `??`, `R `. */
    status: string;
    mtime: Date;
}

export interface TimeGroup {
    label: string;
    files: FileChange[];
}

/** Modification time of a path under the repository root, or null when it cannot be read. */
export type MtimeLookup = (path: string) => Date | null;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function timeBucketLabel(mtime: Date, now: Date): string {
    const diffMs = now.getTime() - mtime.getTime();
    const diffHours = Math.floor(diffMs / HOUR_MS);
    const diffDays = Math.floor(diffMs / DAY_MS);

    if (diffHours < 1) {
        return "Last hour";
    }

    if (diffHours < 3) {
        return "Last 3 hours";
    }

    if (diffHours < 6) {
        return "Last 6 hours";
    }

    if (diffHours < 12) {
        return "Last 12 hours";
    }

    if (diffDays < 1) {
        return "Today";
    }

    if (diffDays < 2) {
        return "Yesterday";
    }

    if (diffDays < 7) {
        return `Last ${diffDays} days`;
    }

    return "Older";
}

export function sortNewestFirst(files: FileChange[]): FileChange[] {
    return [...files].sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/** Group consecutive files that share a bucket. Pass the files newest first. */
export function groupChangesByTime(files: FileChange[], now: Date): TimeGroup[] {
    const groups: TimeGroup[] = [];

    for (const file of files) {
        const label = timeBucketLabel(file.mtime, now);
        const last = groups.at(-1);

        if (last && last.label === label) {
            last.files.push(file);
        } else {
            groups.push({ label, files: [file] });
        }
    }

    return groups;
}

function statusChar(char: string): string {
    return char === "." ? " " : char;
}

/** The two-character status of a porcelain v2 entry, with `.` (unchanged) shown as a space. */
export function statusPair(entry: StatusEntry): string {
    return `${statusChar(entry.index)}${statusChar(entry.worktree)}`;
}

/** The letter that says what happened to a file: the index side when it has one, else the worktree side. */
export function statusLetter(status: string): string {
    const index = status.charAt(0);

    return index === " " ? status.charAt(1) : index;
}

/**
 * Uncommitted files with the time each was last touched, newest first. A deleted file has no
 * mtime, so it counts as touched now. Any other path whose mtime cannot be read is left out.
 */
export function uncommittedChanges(entries: StatusEntry[], lookup: MtimeLookup, now: Date): FileChange[] {
    const files: FileChange[] = [];

    for (const entry of entries) {
        if (entry.kind === "ignored") {
            continue;
        }

        const status = statusPair(entry);
        const mtime = lookup(entry.path) ?? (status.includes("D") ? now : null);

        if (mtime) {
            files.push({ file: entry.path, status, mtime });
        }
    }

    return sortNewestFirst(files);
}

/**
 * Files changed by the given commits, each stamped with its commit's committer time, newest first.
 * A merge commit lists nothing of its own (its files appear under the commits it brought in), and
 * a rename or copy is listed under its new path.
 */
export function committedChanges(commits: CommitInfo[], changes: RawChange[]): FileChange[] {
    const commitTime = new Map<string, Date>();

    for (const commit of commits) {
        if (commit.parents.length < 2) {
            commitTime.set(commit.sha, new Date(commit.committer.epoch * 1000));
        }
    }

    const files: FileChange[] = [];

    for (const change of changes) {
        const mtime = commitTime.get(change.commit);

        if (mtime) {
            files.push({ file: change.path, status: `${change.status} `, mtime });
        }
    }

    return sortNewestFirst(files);
}

const COMMITTED_DESCRIPTIONS: Record<string, string> = {
    M: "modified",
    A: "added",
    D: "deleted",
    R: "renamed",
    C: "copied",
};

export function describeUncommitted(status: string): string {
    const staged = status.charAt(0);
    const unstaged = status.charAt(1);

    if (status === "??") {
        return "untracked";
    }

    if (staged === "M" && unstaged === "M") {
        return "modified (staged & unstaged)";
    }

    const stagedName = COMMITTED_DESCRIPTIONS[staged];
    const unstagedName = COMMITTED_DESCRIPTIONS[unstaged];

    if (stagedName && unstagedName && staged !== unstaged) {
        return `${stagedName} (staged), ${unstagedName} (unstaged)`;
    }

    if (staged === "M") {
        return "modified (staged)";
    }

    if (unstaged === "M") {
        return "modified (unstaged)";
    }

    if (staged === "A") {
        return "added (staged)";
    }

    if (unstaged === "A") {
        return "added (unstaged)";
    }

    if (staged === "D") {
        return "deleted (staged)";
    }

    if (unstaged === "D") {
        return "deleted (unstaged)";
    }

    if (staged === "R") {
        return "renamed (staged)";
    }

    if (staged === "C") {
        return "copied (staged)";
    }

    return status;
}

export function describeCommitted(status: string): string {
    return COMMITTED_DESCRIPTIONS[status.trim()] ?? status.trim();
}

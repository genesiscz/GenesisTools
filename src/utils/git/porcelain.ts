/**
 * Typed parsers for git's machine-readable ("porcelain") output.
 *
 * Every parser here is pure: it takes the text git printed and returns plain
 * objects, so the shapes are pinned by fixtures and every tool gets the same
 * answer for the same output. The matching `createGit()` methods in core.ts
 * run the command with the exact flags each parser expects; call those, and
 * never re-parse `status` or `for-each-ref` by hand in a tool.
 *
 * The NUL-terminated forms (`-z`, `%x00`) are used throughout: paths with
 * spaces, tabs, quotes or non-ASCII bytes arrive verbatim, where the
 * newline forms would C-quote them.
 */

// ---------------------------------------------------------------------------
// status --porcelain=v2 -z
// ---------------------------------------------------------------------------

export type StatusEntryKind = "changed" | "renamed" | "unmerged" | "untracked" | "ignored";

export interface StatusEntry {
    kind: StatusEntryKind;
    path: string;
    /** Source path of a rename or copy. */
    origPath?: string;
    /** Index state letter (`M`, `A`, `D`, `R`, `C`, `U`, `.`); `?`/`!` for untracked/ignored. */
    index: string;
    /** Worktree state letter, same alphabet. */
    worktree: string;
    /** `R<score>`/`C<score>` similarity for renames and copies. */
    score?: number;
    /** Submodule state field (`N...` or `S<c><m><u>`). */
    submodule?: string;
}

export interface StatusBranch {
    /** Current commit sha, or `(initial)` on an unborn branch. */
    oid: string;
    /** Branch name, or `(detached)`. */
    head: string;
    upstream: string | null;
    ahead: number | null;
    behind: number | null;
}

export interface StatusSummary {
    /** Present when the command ran with `--branch`. */
    branch: StatusBranch | null;
    entries: StatusEntry[];
}

export const STATUS_PORCELAIN_ARGS = ["status", "--porcelain=v2", "-z", "--branch"] as const;

function splitFields(token: string, count: number): { fields: string[]; rest: string } {
    const fields: string[] = [];
    let rest = token;

    for (let i = 0; i < count; i++) {
        const space = rest.indexOf(" ");

        if (space < 0) {
            fields.push(rest);
            rest = "";
            break;
        }

        fields.push(rest.slice(0, space));
        rest = rest.slice(space + 1);
    }

    return { fields, rest };
}

/** Parse `git status --porcelain=v2 -z [--branch]` output. */
export function parseStatusPorcelainV2Z(text: string): StatusSummary {
    const tokens = text.split("\0");
    const entries: StatusEntry[] = [];
    let branch: StatusBranch | null = null;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (token.length === 0) {
            continue;
        }

        if (token.startsWith("# ")) {
            branch = branch ?? { oid: "", head: "", upstream: null, ahead: null, behind: null };
            const [key, ...valueParts] = token.slice(2).split(" ");
            const value = valueParts.join(" ");

            if (key === "branch.oid") {
                branch.oid = value;
            } else if (key === "branch.head") {
                branch.head = value;
            } else if (key === "branch.upstream") {
                branch.upstream = value;
            } else if (key === "branch.ab") {
                const m = /^\+(\d+) -(\d+)$/.exec(value);
                branch.ahead = m ? Number(m[1]) : null;
                branch.behind = m ? Number(m[2]) : null;
            }

            continue;
        }

        const type = token.charAt(0);

        if (type === "?" || type === "!") {
            entries.push({
                kind: type === "?" ? "untracked" : "ignored",
                path: token.slice(2),
                index: type,
                worktree: type,
            });
            continue;
        }

        if (type === "1") {
            const { fields, rest } = splitFields(token, 8);
            entries.push({
                kind: "changed",
                path: rest,
                index: fields[1][0],
                worktree: fields[1][1],
                submodule: fields[2],
            });
            continue;
        }

        if (type === "2") {
            const { fields, rest } = splitFields(token, 9);
            const origPath = tokens[i + 1] ?? "";
            i++;
            entries.push({
                kind: "renamed",
                path: rest,
                origPath,
                index: fields[1][0],
                worktree: fields[1][1],
                submodule: fields[2],
                score: Number.parseInt(fields[8].slice(1), 10) || 0,
            });
            continue;
        }

        if (type === "u") {
            const { fields, rest } = splitFields(token, 10);
            entries.push({
                kind: "unmerged",
                path: rest,
                index: fields[1][0],
                worktree: fields[1][1],
                submodule: fields[2],
            });
        }
    }

    return { branch, entries };
}

/** True when nothing is modified, staged, unmerged or untracked (ignored files do not count). */
export function isCleanStatus(summary: StatusSummary): boolean {
    return summary.entries.every((e) => e.kind === "ignored");
}

// ---------------------------------------------------------------------------
// for-each-ref
// ---------------------------------------------------------------------------

export interface RefInfo {
    /** Full ref, e.g. `refs/heads/feat/x`. */
    ref: string;
    /** Short name, e.g. `feat/x` or `origin/master`. */
    name: string;
    sha: string;
    type: "commit" | "tag" | "tree" | "blob";
    /** Short upstream name, e.g. `origin/feat/x`, or null when none is configured. */
    upstream: string | null;
    /** The upstream is configured but no longer exists on the remote. */
    upstreamGone: boolean;
    /** Commits ahead of / behind the upstream; null without an upstream. */
    ahead: number | null;
    behind: number | null;
    committerEpoch: number;
    /** Checked out in the current worktree. */
    isHead: boolean;
    subject: string;
}

export const FOR_EACH_REF_FORMAT =
    "%(refname)%00%(refname:short)%00%(objectname)%00%(objecttype)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:unix)%00%(HEAD)%00%(subject)";

/** Parse `git for-each-ref --format=<FOR_EACH_REF_FORMAT>` output. */
export function parseForEachRef(text: string): RefInfo[] {
    const refs: RefInfo[] = [];

    for (const line of text.split("\n")) {
        if (line.length === 0) {
            continue;
        }

        const [ref, name, sha, type, upstream, track, epoch, head, ...subject] = line.split("\0");
        const gone = track === "[gone]";
        const ahead = /ahead (\d+)/.exec(track ?? "");
        const behind = /behind (\d+)/.exec(track ?? "");
        const hasUpstream = Boolean(upstream);

        refs.push({
            ref,
            name,
            sha,
            type: (type as RefInfo["type"]) ?? "commit",
            upstream: hasUpstream ? upstream : null,
            upstreamGone: gone,
            ahead: hasUpstream && !gone ? Number(ahead?.[1] ?? 0) : null,
            behind: hasUpstream && !gone ? Number(behind?.[1] ?? 0) : null,
            committerEpoch: Number.parseInt(epoch ?? "0", 10) || 0,
            isHead: head === "*",
            subject: subject.join("\0"),
        });
    }

    return refs;
}

// ---------------------------------------------------------------------------
// log -z --format
// ---------------------------------------------------------------------------

export interface CommitIdentity {
    name: string;
    email: string;
    epoch: number;
}

export interface CommitInfo {
    sha: string;
    shortSha: string;
    parents: string[];
    author: CommitIdentity;
    committer: CommitIdentity;
    subject: string;
    body: string;
}

const LOG_FIELDS = ["%H", "%h", "%P", "%an", "%ae", "%at", "%cn", "%ce", "%ct", "%s", "%b"] as const;

/** Pair with `-z`: each commit becomes exactly `LOG_FIELDS.length` NUL-terminated tokens. */
export const LOG_FORMAT = `--format=${LOG_FIELDS.join("%x00")}`;

/** Parse `git log -z <LOG_FORMAT>` output. */
export function parseLogZ(text: string): CommitInfo[] {
    const tokens = text.split("\0");
    const commits: CommitInfo[] = [];
    const width = LOG_FIELDS.length;

    for (let i = 0; i + width <= tokens.length; i += width) {
        const [sha, shortSha, parents, an, ae, at, cn, ce, ct, subject, body] = tokens.slice(i, i + width);

        if (!sha) {
            break;
        }

        commits.push({
            sha,
            shortSha,
            parents: parents.split(" ").filter(Boolean),
            author: { name: an, email: ae, epoch: Number.parseInt(at, 10) || 0 },
            committer: { name: cn, email: ce, epoch: Number.parseInt(ct, 10) || 0 },
            subject,
            body: body.replace(/\n+$/, ""),
        });
    }

    return commits;
}

// ---------------------------------------------------------------------------
// diff --name-status -z
// ---------------------------------------------------------------------------

export type ChangeStatus = "A" | "M" | "D" | "T" | "R" | "C" | "U" | "X";

export interface NameStatusEntry {
    status: ChangeStatus;
    path: string;
    /** Source path of a rename or copy (only when renames are enabled). */
    origPath?: string;
    /** Similarity score of a rename or copy. */
    score?: number;
}

/** Parse `git diff --name-status -z` output. Rename and copy entries carry two paths. */
export function parseNameStatusZ(text: string): NameStatusEntry[] {
    const tokens = text.split("\0");
    const entries: NameStatusEntry[] = [];

    for (let i = 0; i + 1 < tokens.length; i += 2) {
        const raw = tokens[i];

        if (raw.length === 0) {
            i--;
            continue;
        }

        const status = raw.charAt(0) as ChangeStatus;

        if (status === "R" || status === "C") {
            entries.push({
                status,
                origPath: tokens[i + 1],
                path: tokens[i + 2] ?? "",
                score: Number.parseInt(raw.slice(1), 10) || 0,
            });
            i++;
            continue;
        }

        entries.push({ status, path: tokens[i + 1] });
    }

    return entries;
}

// ---------------------------------------------------------------------------
// ls-tree -r -z
// ---------------------------------------------------------------------------

export interface TreeEntry {
    mode: string;
    type: "blob" | "tree" | "commit";
    sha: string;
    path: string;
    /** Present with `-l`. */
    size?: number;
}

/** Parse `git ls-tree -r -z [-l]` output. */
export function parseLsTreeZ(text: string): TreeEntry[] {
    const entries: TreeEntry[] = [];

    for (const token of text.split("\0")) {
        const m = /^(\d+) (blob|tree|commit) ([0-9a-f]+)(?: +(\d+|-))?\t(.+)$/s.exec(token);

        if (!m) {
            continue;
        }

        const entry: TreeEntry = { mode: m[1], type: m[2] as TreeEntry["type"], sha: m[3], path: m[5] };

        if (m[4] !== undefined && m[4] !== "-") {
            entry.size = Number(m[4]);
        }

        entries.push(entry);
    }

    return entries;
}

/** path → blob sha for every blob of a tree listing. */
export function blobMap(entries: TreeEntry[]): Map<string, string> {
    const map = new Map<string, string>();

    for (const e of entries) {
        if (e.type === "blob") {
            map.set(e.path, e.sha);
        }
    }

    return map;
}

// ---------------------------------------------------------------------------
// log --raw -z
// ---------------------------------------------------------------------------

export interface RawChange {
    /** The commit the change belongs to; empty when the log ran with an empty format. */
    commit: string;
    oldMode: string;
    newMode: string;
    oldSha: string;
    newSha: string;
    status: ChangeStatus;
    path: string;
    origPath?: string;
}

/** Pair with `--raw -z --no-abbrev`: each commit header is one NUL-terminated sha. */
export const RAW_LOG_FORMAT = "--format=%H";

/**
 * Parse `git log --raw -z --no-abbrev` output. Token-wise, so the exact
 * separators git puts between commits do not matter: a 40/64-hex token is
 * a commit header, a `:`-prefixed token is a change followed by its path
 * (two paths for renames and copies).
 */
export function parseRawLogZ(text: string): RawChange[] {
    const changes: RawChange[] = [];
    const tokens = text.split("\0").map((t) => t.replace(/^\n+/, ""));
    let commit = "";

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (/^[0-9a-f]{40,64}$/.test(token)) {
            commit = token;
            continue;
        }

        const meta = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(token);

        if (!meta || i + 1 >= tokens.length) {
            continue;
        }

        const status = meta[5] as ChangeStatus;
        const change: RawChange = {
            commit,
            oldMode: meta[1],
            newMode: meta[2],
            oldSha: meta[3],
            newSha: meta[4],
            status,
            path: tokens[i + 1],
        };
        i++;

        if ((status === "R" || status === "C") && i + 1 < tokens.length) {
            change.origPath = change.path;
            change.path = tokens[i + 1];
            i++;
        }

        changes.push(change);
    }

    return changes;
}

// ---------------------------------------------------------------------------
// diff --numstat -z
// ---------------------------------------------------------------------------

export interface NumstatEntry {
    path: string;
    origPath?: string;
    insertions: number;
    deletions: number;
    /** git printed `-` for both counts. */
    binary: boolean;
}

/** Parse `git diff --numstat -z` output; renames carry `\t\0old\0new`. */
export function parseNumstatZ(text: string): NumstatEntry[] {
    const tokens = text.split("\0");
    const entries: NumstatEntry[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);

        if (!m) {
            continue;
        }

        const entry: NumstatEntry = {
            path: m[3],
            insertions: m[1] === "-" ? 0 : Number(m[1]),
            deletions: m[2] === "-" ? 0 : Number(m[2]),
            binary: m[1] === "-",
        };

        if (m[3].length === 0 && i + 2 < tokens.length) {
            entry.origPath = tokens[i + 1];
            entry.path = tokens[i + 2];
            i += 2;
        }

        entries.push(entry);
    }

    return entries;
}

// ---------------------------------------------------------------------------
// cherry
// ---------------------------------------------------------------------------

export interface CherryEntry {
    sha: string;
    /** `-`: an equivalent patch already exists upstream; `+`: it does not. */
    present: boolean;
    subject?: string;
}

/** Parse `git cherry [-v] <upstream> <head>` output. */
export function parseCherry(text: string): CherryEntry[] {
    const entries: CherryEntry[] = [];

    for (const line of text.split("\n")) {
        const m = /^([+-]) ([0-9a-f]+)(?: (.*))?$/.exec(line);

        if (m) {
            entries.push({ sha: m[2], present: m[1] === "-", subject: m[3] });
        }
    }

    return entries;
}

// ---------------------------------------------------------------------------
// rev-list --left-right --count
// ---------------------------------------------------------------------------

export interface AheadBehind {
    ahead: number;
    behind: number;
}

/** Parse `git rev-list --left-right --count <base>...<branch>`: left is behind, right is ahead. */
export function parseLeftRightCount(text: string): AheadBehind {
    const [behind, ahead] = text.trim().split(/\s+/);
    return { ahead: Number.parseInt(ahead ?? "0", 10) || 0, behind: Number.parseInt(behind ?? "0", 10) || 0 };
}

// ---------------------------------------------------------------------------
// merge-tree --write-tree -z --name-only
// ---------------------------------------------------------------------------

export interface MergeTreeMessage {
    paths: string[];
    /** e.g. `CONFLICT (contents)`, `Auto-merging`. */
    type: string;
    message: string;
}

export interface MergeTreeResult {
    /** The merged tree; with conflicts it holds conflict markers. */
    tree: string;
    clean: boolean;
    conflictedFiles: string[];
    messages: MergeTreeMessage[];
}

export const MERGE_TREE_ARGS = ["merge-tree", "--write-tree", "-z", "--name-only", "--messages"] as const;

/**
 * Parse `git merge-tree --write-tree -z --name-only --messages` output. With
 * `-z` every field is NUL-terminated: the tree oid first, then the
 * conflicted file names, then an empty token opening the informational
 * section of `<count>\0<path>…\0<type>\0<message>\0` records. The docs warn
 * that an empty conflict list is not a clean merge: `clean` follows the exit
 * code, never the list.
 */
export function parseMergeTreeZ(stdout: string, exitCode: number): MergeTreeResult {
    const tokens = stdout.split("\0");
    const tree = (tokens.shift() ?? "").trim();
    const conflictedFiles: string[] = [];
    const messages: MergeTreeMessage[] = [];
    let i = 0;

    for (; i < tokens.length; i++) {
        if (tokens[i].length === 0) {
            i++;
            break;
        }

        conflictedFiles.push(tokens[i]);
    }

    while (i < tokens.length) {
        const count = Number.parseInt(tokens[i], 10);

        if (Number.isNaN(count)) {
            break;
        }

        const paths = tokens.slice(i + 1, i + 1 + count);
        const type = tokens[i + 1 + count] ?? "";
        const message = tokens[i + 2 + count] ?? "";
        messages.push({ paths, type, message: message.replace(/\n+$/, "") });
        i += 3 + count;
    }

    return { tree, clean: exitCode === 0, conflictedFiles: [...new Set(conflictedFiles)], messages };
}

// ---------------------------------------------------------------------------
// worktree list --porcelain
// ---------------------------------------------------------------------------

export interface WorktreeEntry {
    path: string;
    head: string;
    /** Short branch name, null when detached. */
    branch: string | null;
    isBare: boolean;
    /** The first entry is the main checkout. */
    isMain: boolean;
    locked: string | null;
    prunable: string | null;
}

export const WORKTREE_LIST_ARGS = ["worktree", "list", "--porcelain", "-z"] as const;

/**
 * Parse `git worktree list --porcelain -z` output: one NUL-terminated
 * attribute per token, an empty token ends a record. With `-z` a path or a
 * lock reason keeps its newlines and is never C-quoted.
 */
export function parseWorktreeListZ(text: string): WorktreeEntry[] {
    return parseWorktreeAttributes(text.split("\0"));
}

/** Parse `git worktree list --porcelain` output (newline form; paths with newlines are C-quoted there). */
export function parseWorktreeList(text: string): WorktreeEntry[] {
    return parseWorktreeAttributes(text.split("\n"));
}

function parseWorktreeAttributes(lines: string[]): WorktreeEntry[] {
    const entries: WorktreeEntry[] = [];
    let current: WorktreeEntry | null = null;

    for (const line of lines) {
        if (line.startsWith("worktree ")) {
            current = {
                path: line.slice(9),
                head: "",
                branch: null,
                isBare: false,
                isMain: entries.length === 0,
                locked: null,
                prunable: null,
            };
            entries.push(current);
        } else if (!current) {
        } else if (line.startsWith("HEAD ")) {
            current.head = line.slice(5);
        } else if (line.startsWith("branch ")) {
            current.branch = line.slice(7).replace(/^refs\/heads\//, "");
        } else if (line === "bare") {
            current.isBare = true;
        } else if (line === "detached") {
            current.branch = null;
        } else if (line.startsWith("locked")) {
            current.locked = line.slice(6).trim() || "locked";
        } else if (line.startsWith("prunable")) {
            current.prunable = line.slice(8).trim() || "prunable";
        }
    }

    return entries;
}

// ---------------------------------------------------------------------------
// Command bundles: the exact flags a parser expects, next to that parser
// ---------------------------------------------------------------------------

export interface StatusArgs {
    untracked?: "all" | "normal" | "no";
}

export interface LogArgs {
    /** A revision range such as `origin/master..feat/x`, or a single ref. */
    range: string;
    paths?: string[];
    limit?: number;
    reverse?: boolean;
}

export interface DiffRangeArgs {
    from: string;
    to: string;
    /** Detect renames (`--find-renames`); off by default so every change is A/M/D/T. */
    renames?: boolean;
    paths?: string[];
}

export interface LsTreeArgs {
    ref: string;
    sizes?: boolean;
    paths?: string[];
}

export interface RawChangesArgs {
    range: string;
    renames?: boolean;
    paths?: string[];
}

function withPaths(args: string[], paths: string[] | undefined): string[] {
    return paths?.length ? [...args, "--", ...paths] : args;
}

/**
 * One entry per porcelain command: `args(...)` builds the exact git argument
 * list the parser was written for, `parse(...)` turns the stdout into typed
 * objects. Neither runs git. `createGit()` composes them for the common case;
 * a tool with its own invocation splices `porcelain.log.args(...)` in and
 * parses with `porcelain.log.parse`, so the flags and the parser never drift
 * apart.
 */
export const porcelain = {
    status: {
        args: (opts: StatusArgs = {}): string[] => [
            ...STATUS_PORCELAIN_ARGS,
            `--untracked-files=${opts.untracked ?? "all"}`,
        ],
        parse: parseStatusPorcelainV2Z,
    },
    refs: {
        args: (patterns: string[] = ["refs/heads/"]): string[] => [
            "for-each-ref",
            `--format=${FOR_EACH_REF_FORMAT}`,
            ...patterns,
        ],
        parse: parseForEachRef,
    },
    log: {
        args: ({ range, paths, limit, reverse }: LogArgs): string[] => {
            const args = ["log", "-z", LOG_FORMAT];

            if (limit !== undefined) {
                args.push(`-${limit}`);
            }

            if (reverse) {
                args.push("--reverse");
            }

            args.push(range);
            return withPaths(args, paths);
        },
        parse: parseLogZ,
    },
    nameStatus: {
        args: ({ from, to, renames, paths }: DiffRangeArgs): string[] =>
            withPaths(["diff", "--name-status", "-z", renames ? "--find-renames" : "--no-renames", from, to], paths),
        parse: parseNameStatusZ,
    },
    lsTree: {
        args: ({ ref, sizes, paths }: LsTreeArgs): string[] =>
            withPaths(["ls-tree", "-r", "-z", "--full-tree", ...(sizes ? ["-l"] : []), ref], paths),
        parse: parseLsTreeZ,
    },
    rawChanges: {
        args: ({ range, renames, paths }: RawChangesArgs): string[] =>
            withPaths(
                [
                    "log",
                    "--raw",
                    "-z",
                    "--no-abbrev",
                    "--diff-merges=first-parent",
                    renames ? "--find-renames" : "--no-renames",
                    RAW_LOG_FORMAT,
                    range,
                ],
                paths
            ),
        parse: parseRawLogZ,
    },
    numstat: {
        args: ({ from, to, renames, paths }: DiffRangeArgs): string[] =>
            withPaths(["diff", "--numstat", "-z", renames ? "--find-renames" : "--no-renames", from, to], paths),
        parse: parseNumstatZ,
    },
    cherry: {
        args: (upstream: string, head: string): string[] => ["cherry", "-v", upstream, head],
        parse: parseCherry,
    },
    leftRightCount: {
        args: (base: string, branch: string): string[] => [
            "rev-list",
            "--left-right",
            "--count",
            `${base}...${branch}`,
        ],
        parse: parseLeftRightCount,
    },
    mergeTree: {
        args: (base: string, branch: string): string[] => [...MERGE_TREE_ARGS, base, branch],
        /** `exitCode` decides `clean`; the docs say an empty conflict list never does. */
        parse: parseMergeTreeZ,
    },
    worktrees: {
        args: (): string[] => [...WORKTREE_LIST_ARGS],
        parse: parseWorktreeListZ,
    },
} as const;

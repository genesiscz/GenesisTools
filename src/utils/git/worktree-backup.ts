/**
 * Back up a linked git worktree before it is removed, and prove that the backup restores it.
 *
 * The layout is Martin's rule from `~/.agents/AGENTS.md` ("When the user confirms removing a dirty worktree"): one
 * `format-patch` file per commit since the base, the uncommitted changes as one binary patch, the untracked and the
 * kept ignored files copied with their paths, and a README with the restore commands. The proof runs in a throwaway
 * repository that borrows the source's objects as an alternate, so the user's repository sees no write except the
 * safety ref and, with `remove`, the removal itself.
 *
 * A disk-reclaim script in another repository imports this file by its absolute path and calls
 * `planWorktreeBackup` and `backupWorktree`: keep those names and the shapes of their results.
 */

import { createHash } from "node:crypto";
import {
    appendFileSync,
    chmodSync,
    constants,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExecResult } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { createGit } from "./core";
import { porcelain } from "./porcelain";

const log = logger.child({ component: "git:worktree-backup" });

/** Ignored entries with these names are rebuilt by a tool (an install, a build, a cache), so a backup skips them. */
export const REBUILDABLE_IGNORED_NAMES: ReadonlySet<string> = new Set([
    "node_modules",
    "dist",
    "build",
    ".build",
    ".next",
    ".turbo",
    ".output",
    "out",
    ".nuxt",
    ".svelte-kit",
    ".parcel-cache",
    ".vite",
    ".expo",
    "target",
    "DerivedData",
    "coverage",
    ".cache",
    ".swiftpm",
    ".gradle",
    ".cxx",
    "Pods",
    "__pycache__",
    ".venv",
    ".pytest_cache",
    ".DS_Store",
    "next-env.d.ts",
]);

const REBUILDABLE_SUFFIX = /\.(tsbuildinfo|log|pyc)$/;

/** Default ceiling for the untracked and kept ignored bytes a backup copies: 512 MiB. */
export const DEFAULT_WORKTREE_BACKUP_MAX_COPY_BYTES = 512 * 1024 * 1024;

/** The namespace of the safety refs that keep a removed worktree's otherwise unreachable commits alive. */
export const WORKTREE_BACKUP_REF_PREFIX = "refs/backups/worktrees/";

/** True when a file or folder of this name is rebuilt by a tool and a backup may skip it. */
export function isRebuildableName(name: string): boolean {
    return REBUILDABLE_IGNORED_NAMES.has(name) || REBUILDABLE_SUFFIX.test(name);
}

export interface WorktreeBackupPlan {
    /** The real path of the worktree. */
    path: string;
    /** The path as `git worktree list --porcelain` spells it (`/tmp/...` against `/private/tmp/...`). */
    listed: string;
    /** The main checkout: the first entry of `git worktree list`. */
    repoRoot: string;
    repo: string;
    /** `<common dir>/worktrees/<name>`. */
    gitdir: string;
    /** `refs/heads/<name>`, or null when HEAD is detached. */
    branch: string | null;
    head: string;
    /** The merge base and the ref it was taken from; null when no candidate ref exists. */
    base: { sha: string; ref: string } | null;
    /** `base..HEAD`, oldest first, merge commits excluded. */
    commits: Array<{ sha: string; subject: string }>;
    /** Merge commits in `base..HEAD`: `format-patch` skips them. */
    merges: number;
    /** Commits of HEAD that no branch, remote branch or tag holds. */
    unreachable: number;
    /** `git diff HEAD --name-only`: staged and unstaged changes to tracked files. */
    changed: string[];
    untracked: string[];
    /** Ignored entries that are not rebuildable (a folder ends with `/`). */
    ignored: string[];
    /** Bytes of the untracked and kept ignored files (folders walked, rebuildable names inside skipped). */
    copyBytes: number;
    /** Content of `<gitdir>/locked`: "" when locked without a reason, null when not locked. */
    locked: string | null;
    /** Each a sentence: why the worktree cannot be backed up (and, when asked, removed). Empty means it may proceed. */
    blockers: string[];
    /** sha256 over HEAD, the uncommitted diff and the untracked and ignored files with their size and mtime. */
    fingerprint: string;
}

export interface WorktreeBackupProof {
    /** `git apply --cached --check` of the uncommitted patch on HEAD's tree: "ok", "none", or why it failed. */
    uncommitted: "ok" | "none" | string;
    /** `git am` of the commit patches on the base in a scratch repository: "ok", "none", or why it failed. */
    commits: "ok" | "none" | string;
    /** The tree `git am` built equals HEAD's tree; null when not compared (no commits, or merges in the range). */
    treeMatches: boolean | null;
}

export interface WorktreeBackupResult {
    plan: WorktreeBackupPlan;
    /** The backup folder; null when refused before anything was written. */
    folder: string | null;
    /** `refs/backups/worktrees/<folder name>` when `plan.unreachable > 0`. */
    ref: string | null;
    proof: WorktreeBackupProof;
    removed: boolean;
    /** Why it was not backed up, or (with `remove`) not removed; null on full success. */
    refusal: string | null;
    /** Sockets, fifos and devices found among the files to copy: listed, not copied. */
    skipped: string[];
}

export interface PlanWorktreeBackupOptions {
    path: string;
    maxCopyBytes?: number;
    /** Also report what would stop the removal: a lock, a process working inside the worktree. */
    remove?: boolean;
}

export interface BackupWorktreeOptions {
    path: string;
    remove?: boolean;
    /** What the work was, for the README. */
    note?: string;
    maxCopyBytes?: number;
    /** Default `~/.genesis-tools/backups/worktrees`. */
    backupRoot?: string;
    now?: Date;
    /** Runs once the backup and its proof are written, before the removal checks (progress, or a test's change). */
    afterBackup?: (result: WorktreeBackupResult) => void | Promise<void>;
}

// =============================================================================
// git calls
// =============================================================================

/**
 * Variables that point git at another repository or hand it a parent git's `-c` options. A caller that runs inside
 * a git hook inherits them, and every read here would then answer for the wrong repository.
 */
const FOREIGN_GIT_ENV: Record<string, string | undefined> = {
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_NAMESPACE: undefined,
    GIT_PREFIX: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
    GIT_CONFIG_COUNT: undefined,
};

/**
 * Diff flags for a patch that `git apply` and `git am` accept whatever the user's config says: no external diff, no
 * textconv, no color, the whole tree, and the `a/` `b/` prefixes that `diff.noprefix` would drop.
 */
const PATCH_FLAGS = [
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-relative",
    "--src-prefix=a/",
    "--dst-prefix=b/",
];

/** Every proof call: no hook runs, nothing is signed, and an identity exists even on a machine without one. */
const PROOF_CONFIG = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "user.name=worktree-backup",
    "-c",
    "user.email=worktree-backup@localhost",
];

/** The proof ignores the user's global and system config, so `apply.whitespace=fix` or `am.threeWay` cannot help it pass. */
const PROOF_ENV: Record<string, string> = {
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
};

async function runGit({
    cwd,
    args,
    env,
}: {
    cwd: string;
    args: string[];
    env?: Record<string, string | undefined>;
}): Promise<ExecResult> {
    return createGit({ cwd }).executor.exec(args, { env: { ...FOREIGN_GIT_ENV, ...env } });
}

/** A read: `--no-optional-locks`, so even a dry run never refreshes the index. */
async function readGit(cwd: string, args: string[]): Promise<ExecResult> {
    return runGit({ cwd, args: ["--no-optional-locks", ...args] });
}

async function mustRead(cwd: string, args: string[]): Promise<string> {
    const res = await readGit(cwd, args);

    if (!res.success) {
        throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || `exit ${res.exitCode}`}`);
    }

    return res.stdout;
}

function splitZ(stdout: string): string[] {
    return stdout.split("\0").filter((part) => part !== "");
}

function firstLines(text: string, count = 4): string {
    return text.split("\n").slice(0, count).join(" | ").trim();
}

// =============================================================================
// Paths
// =============================================================================

function realOrResolved(path: string): string {
    return existsSync(path) ? realpathSync(path) : resolve(path);
}

function isInside(child: string, parent: string): boolean {
    const rel = relative(parent, child);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function hasRebuildableSegment(rel: string): boolean {
    return rel.split(/[/\\]/).some((segment) => segment !== "" && isRebuildableName(segment));
}

interface WorktreeIdentity {
    path: string;
    listed: string;
    gitdir: string;
    commonDir: string;
    repoRoot: string;
    /** `refs/heads/<name>` of this worktree, null when detached. */
    branch: string | null;
    /** `refs/heads/<name>` checked out in the main checkout, null when detached or bare. */
    mainBranch: string | null;
    /** Other worktrees whose folder lies inside this one. */
    nested: string[];
}

/**
 * Proves that `path` is a linked worktree: its `.git` file points into `<common dir>/worktrees/<name>`, that folder's
 * back-pointer names this folder, and `git worktree list` lists it as neither the main checkout nor prunable.
 */
async function identifyWorktree(path: string): Promise<WorktreeIdentity> {
    const requested = resolve(path);

    if (!existsSync(requested)) {
        throw new Error(`${requested} does not exist.`);
    }

    const real = realpathSync(requested);
    const marker = join(real, ".git");
    const markerStat = lstatSync(marker, { throwIfNoEntry: false });

    if (!markerStat) {
        throw new Error(`${real} is not a linked git worktree: it has no .git entry.`);
    }

    if (markerStat.isDirectory()) {
        throw new Error(`${real} is a main checkout (its .git is a folder), not a linked worktree.`);
    }

    const pointer = readFileSync(marker, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];

    if (!pointer) {
        throw new Error(`${marker} has no gitdir line, so ${real} is not a linked worktree.`);
    }

    const pointed = resolve(real, pointer);

    if (!existsSync(pointed)) {
        throw new Error(`${marker} points at ${pointed}, which does not exist.`);
    }

    const gitdir = realpathSync(pointed);

    if (basename(dirname(gitdir)) !== "worktrees") {
        throw new Error(
            `${marker} points at ${gitdir}, which is not <common dir>/worktrees/<name> (a submodule or a --separate-git-dir checkout), so ${real} is not a linked worktree.`
        );
    }

    const backFile = join(gitdir, "gitdir");
    const back = existsSync(backFile) ? readFileSync(backFile, "utf8").trim() : "";
    const backDir = back === "" ? "" : realOrResolved(dirname(resolve(gitdir, back)));

    if (backDir !== real) {
        throw new Error(
            `${backFile} names ${back || "nothing"}, not ${marker}, so git does not count ${real} as that worktree.`
        );
    }

    const entries = porcelain.worktrees.parse(await mustRead(real, porcelain.worktrees.args()));
    const index = entries.findIndex((entry) => realOrResolved(entry.path) === real);

    if (index === -1) {
        throw new Error(`git worktree list does not list ${real}, so it is not a linked worktree of its repository.`);
    }

    const entry = entries[index];

    if (index === 0 || entry.isMain) {
        throw new Error(`${real} is the main checkout of its repository, not a linked worktree.`);
    }

    if (entry.prunable !== null) {
        throw new Error(`git lists ${real} as prunable (${entry.prunable}); run git worktree prune instead.`);
    }

    const nested = entries
        .filter((other, i) => i !== index && i !== 0 && isInside(realOrResolved(other.path), real))
        .map((other) => other.path);
    const main = entries[0];

    return {
        path: real,
        listed: entry.path,
        gitdir,
        commonDir: dirname(dirname(gitdir)),
        repoRoot: main.path,
        branch: entry.branch === null ? null : `refs/heads/${entry.branch}`,
        mainBranch: main.branch === null ? null : `refs/heads/${main.branch}`,
        nested,
    };
}

// =============================================================================
// Work state: HEAD, the diff, the files to copy, the fingerprint
// =============================================================================

type EntryKind = "file" | "dir" | "symlink" | "special";

interface WalkedEntry {
    group: "untracked" | "ignored";
    /** Relative to the worktree root. */
    rel: string;
    kind: EntryKind;
    size: number;
    mode: number;
    atimeMs: number;
    mtimeMs: number;
}

interface CopyBudget {
    bytes: number;
    limit: number;
    over: boolean;
}

/**
 * Every file under the listed entries, folders walked with rebuildable names skipped. The walk stops once the bytes
 * pass the limit: that is a blocker, and counting a huge folder to the end would only make the refusal slower.
 */
function walkEntries({
    root,
    group,
    entries,
    budget,
}: {
    root: string;
    group: WalkedEntry["group"];
    entries: string[];
    budget: CopyBudget;
}): WalkedEntry[] {
    const found: WalkedEntry[] = [];

    const visit = (rel: string): void => {
        if (budget.over) {
            return;
        }

        const stat = lstatSync(join(root, rel), { throwIfNoEntry: false });

        if (!stat) {
            log.debug({ root, rel }, "listed entry vanished before the walk");
            return;
        }

        const base = { group, rel, mode: stat.mode, atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs };

        if (stat.isDirectory()) {
            found.push({ ...base, kind: "dir", size: 0 });

            for (const name of readdirSync(join(root, rel)).sort()) {
                if (!isRebuildableName(name)) {
                    visit(join(rel, name));
                }
            }

            return;
        }

        if (stat.isSymbolicLink()) {
            found.push({ ...base, kind: "symlink", size: 0 });
            return;
        }

        if (!stat.isFile()) {
            found.push({ ...base, kind: "special", size: 0 });
            return;
        }

        budget.bytes += stat.size;
        budget.over = budget.bytes > budget.limit;
        found.push({ ...base, kind: "file", size: stat.size });
    };

    for (const entry of entries) {
        visit(entry.replace(/[/\\]+$/, ""));
    }

    return found;
}

interface WorkState {
    head: string;
    headSubject: string;
    untracked: string[];
    ignored: string[];
    entries: WalkedEntry[];
    copyBytes: number;
    overLimit: boolean;
    fingerprint: string;
}

/** HEAD, the uncommitted diff and the files to copy, read without writing anything; the plan and the recheck share it. */
async function readWorkState(path: string, maxCopyBytes: number): Promise<WorkState> {
    const [headLine, diff, untrackedOut, ignoredOut] = await Promise.all([
        mustRead(path, ["log", "-1", "--format=%H%x1f%s", "HEAD"]),
        mustRead(path, ["diff", "HEAD", ...PATCH_FLAGS]),
        mustRead(path, ["ls-files", "--others", "--exclude-standard", "-z"]),
        mustRead(path, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]),
    ]);
    const [head, headSubject = ""] = headLine.split("\x1f");
    const untracked = splitZ(untrackedOut);
    const ignored = splitZ(ignoredOut).filter((rel) => !hasRebuildableSegment(rel));
    const budget: CopyBudget = { bytes: 0, limit: maxCopyBytes, over: false };
    const entries = [
        ...walkEntries({ root: path, group: "untracked", entries: untracked, budget }),
        ...walkEntries({ root: path, group: "ignored", entries: ignored, budget }),
    ];
    const hash = createHash("sha256");
    hash.update(`head ${head}\n`);
    hash.update(diff);
    hash.update("\0");

    for (const entry of entries) {
        hash.update(`${entry.group}\0${entry.rel}\0${entry.kind}\0${entry.size}\0${entry.mtimeMs}\0`);
    }

    return {
        head,
        headSubject,
        untracked,
        ignored,
        entries,
        copyBytes: budget.bytes,
        overLimit: budget.over,
        fingerprint: hash.digest("hex"),
    };
}

// =============================================================================
// Plan
// =============================================================================

const OPERATION_MARKERS: ReadonlyArray<{ file: string; what: string }> = [
    { file: "MERGE_HEAD", what: "merge" },
    { file: "rebase-merge", what: "rebase" },
    { file: "rebase-apply", what: "rebase or am" },
    { file: "CHERRY_PICK_HEAD", what: "cherry-pick" },
    { file: "REVERT_HEAD", what: "revert" },
    { file: "BISECT_LOG", what: "bisect" },
];

/**
 * The merge base with the branch's upstream when it has one. Otherwise the closest of `origin/HEAD` and the branch the
 * main checkout has out (unless it is this worktree's own branch): the one that leaves the fewest commits in
 * `<base>..HEAD`. A worktree cut from a feature branch would otherwise patch and replay that whole branch (725 commits
 * for one GenesisTools worktree on 2026-11-09).
 */
async function detectBackupBase({
    path,
    head,
    identity,
}: {
    path: string;
    head: string;
    identity: WorktreeIdentity;
}): Promise<{ sha: string; ref: string } | null> {
    const candidates: string[] = [];

    if (identity.branch !== null) {
        const short = identity.branch.slice("refs/heads/".length);
        const upstream = await readGit(path, ["rev-parse", "--symbolic-full-name", `${short}@{upstream}`]);

        if (upstream.success && upstream.stdout !== "") {
            const mergeBase = await readGit(path, ["merge-base", head, upstream.stdout]);

            if (mergeBase.success && mergeBase.stdout !== "") {
                return { sha: mergeBase.stdout, ref: upstream.stdout };
            }
        }
    }

    const originHead = await readGit(path, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);

    if (originHead.success && originHead.stdout !== "") {
        candidates.push(originHead.stdout);
    }

    if (identity.mainBranch !== null && identity.mainBranch !== identity.branch) {
        candidates.push(identity.mainBranch);
    }

    let best: { sha: string; ref: string; count: number } | null = null;

    for (const ref of [...new Set(candidates)]) {
        const mergeBase = await readGit(path, ["merge-base", head, ref]);

        if (!mergeBase.success || mergeBase.stdout === "") {
            log.debug({ path, ref, stderr: mergeBase.stderr }, "no merge base with this candidate");
            continue;
        }

        const count = await readGit(path, ["rev-list", "--count", `${mergeBase.stdout}..${head}`]);
        const n = count.success ? Number(count.stdout) : Number.POSITIVE_INFINITY;

        if (best === null || n < best.count) {
            best = { sha: mergeBase.stdout, ref, count: n };
        }
    }

    return best === null ? null : { sha: best.sha, ref: best.ref };
}

function readLock(gitdir: string): string | null {
    const file = join(gitdir, "locked");

    if (!existsSync(file)) {
        return null;
    }

    return readFileSync(file, "utf8").replace(/\r?\n$/, "");
}

/**
 * Every live process with a short name. The kernel table is one `sysctl`; `ps` cost about 400 ms with 2,000
 * processes (measured 2026-11-10) and runs only where that table is not available. Loaded on first use, because the
 * `@genesiscz/utils/git` index re-exports this file and only a removal needs the process readers.
 */
async function listProcesses(): Promise<Array<{ pid: number; command: string }>> {
    const { listProcessTable } = await import("@genesiscz/utils/process/libproc-table");
    const table = listProcessTable();

    if (table !== null) {
        return table.filter((row) => !row.zombie).map((row) => ({ pid: row.pid, command: row.comm }));
    }

    const { listPsRows } = await import("@genesiscz/utils/process/ps");
    return (await listPsRows({ timeoutMs: 10_000 })).map((row) => ({ pid: row.pid, command: row.command }));
}

/**
 * Processes whose working directory lies inside the worktree, as blocker sentences: the process list plus the
 * kernel's cwd per pid. This process's own cwd is the positive control, so a reader that answers nothing is a
 * blocker, not "none".
 */
async function processBlockers(path: string): Promise<string[]> {
    const rows = await listProcesses();

    if (rows.length === 0) {
        return ["The process list could not be read, so a process working inside the worktree cannot be ruled out."];
    }

    const { batchCwd } = await import("@genesiscz/utils/process/ps");
    const cwds = batchCwd(rows.map((row) => row.pid));

    if (!cwds.has(process.pid)) {
        return [
            "The working directories of running processes could not be read (not even this process's own), so a process working inside the worktree cannot be ruled out.",
        ];
    }

    const blockers: string[] = [];

    for (const row of rows) {
        const cwd = cwds.get(row.pid);

        if (cwd !== undefined && isInside(cwd, path)) {
            blockers.push(
                `Process ${row.pid} (${row.command.slice(0, 80)}) has its working directory inside the worktree (${cwd}).`
            );
        }
    }

    return blockers;
}

interface Inspection {
    plan: WorktreeBackupPlan;
    identity: WorktreeIdentity;
    state: WorkState;
}

async function inspectWorktree(options: PlanWorktreeBackupOptions): Promise<Inspection> {
    const maxCopyBytes = options.maxCopyBytes ?? DEFAULT_WORKTREE_BACKUP_MAX_COPY_BYTES;
    const identity = await identifyWorktree(options.path);
    const path = identity.path;
    const [state, changedOut, unmergedOut] = await Promise.all([
        readWorkState(path, maxCopyBytes),
        mustRead(path, ["diff", "HEAD", "--name-only", "--no-renames", "--no-relative", "-z"]),
        mustRead(path, ["ls-files", "--unmerged", "-z"]),
    ]);
    const base = await detectBackupBase({ path, head: state.head, identity });
    const [rangeLog, unreachableOut] = await Promise.all([
        base === null
            ? Promise.resolve("")
            : mustRead(path, [
                  "log",
                  "--topo-order",
                  "--reverse",
                  "-z",
                  "--format=%H%x1f%P%x1f%s",
                  `${base.sha}..${state.head}`,
              ]),
        mustRead(path, ["rev-list", "--count", state.head, "--not", "--branches", "--remotes", "--tags"]),
    ]);
    const commits: WorktreeBackupPlan["commits"] = [];
    let merges = 0;

    for (const record of splitZ(rangeLog)) {
        const [sha, parents = "", subject = ""] = record.split("\x1f");

        if (parents.split(" ").filter(Boolean).length > 1) {
            merges++;
            continue;
        }

        commits.push({ sha, subject });
    }

    const locked = readLock(identity.gitdir);
    const blockers: string[] = [];

    for (const marker of OPERATION_MARKERS) {
        if (existsSync(join(identity.gitdir, marker.file))) {
            blockers.push(
                `A ${marker.what} is in progress in this worktree (${marker.file} in its git dir); finish or abort it first.`
            );
        }
    }

    if (existsSync(join(identity.gitdir, "modules"))) {
        blockers.push(
            "The worktree has initialized submodules; git worktree remove refuses them, and this backup does not copy them."
        );
    }

    const unmerged = new Set(splitZ(unmergedOut).map((line) => line.split("\t").slice(1).join("\t")));

    if (unmerged.size > 0) {
        blockers.push(`The index has unmerged entries (${unmerged.size} paths); resolve the conflict first.`);
    }

    if (state.overLimit) {
        blockers.push(
            `The untracked and ignored files to copy take more than ${mib(maxCopyBytes)} (counted ${mib(state.copyBytes)} before stopping); raise the limit (maxCopyBytes, --max-copy-mb) or clean them up first.`
        );
    }

    for (const nested of identity.nested) {
        blockers.push(`Another worktree lives inside this folder (${nested}); removing this one would delete it.`);
    }

    if (options.remove) {
        if (locked !== null) {
            blockers.push(
                `The worktree is locked${locked === "" ? "" : ` (${locked})`}; unlock it with git worktree unlock first.`
            );
        }

        blockers.push(...(await processBlockers(path)));
    }

    const plan: WorktreeBackupPlan = {
        path,
        listed: identity.listed,
        repoRoot: identity.repoRoot,
        repo: basename(identity.repoRoot),
        gitdir: identity.gitdir,
        branch: identity.branch,
        head: state.head,
        base,
        commits,
        merges,
        unreachable: Number.parseInt(unreachableOut, 10) || 0,
        changed: splitZ(changedOut),
        untracked: state.untracked,
        ignored: state.ignored,
        copyBytes: state.copyBytes,
        locked,
        blockers,
        fingerprint: state.fingerprint,
    };
    log.debug(
        {
            path,
            repoRoot: plan.repoRoot,
            branch: plan.branch,
            base,
            commits: commits.length,
            merges,
            unreachable: plan.unreachable,
            changed: plan.changed.length,
            untracked: plan.untracked.length,
            ignored: plan.ignored.length,
            copyBytes: plan.copyBytes,
            blockers,
        },
        "worktree backup plan"
    );

    return { plan, identity, state };
}

function mib(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * What a backup of the worktree at `path` would hold and what stops it. Writes nothing and changes nothing: every git
 * read runs with `--no-optional-locks`. Throws, saying why, when `path` is not a linked worktree.
 */
export async function planWorktreeBackup(options: PlanWorktreeBackupOptions): Promise<WorktreeBackupPlan> {
    return (await inspectWorktree(options)).plan;
}

// =============================================================================
// Writing the backup
// =============================================================================

function localDay(now: Date): string {
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function localMinute(now: Date): string {
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${localDay(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** `<day>-<repo>-<worktree>` in `[A-Za-z0-9._-]`, and also a valid ref name component for the safety ref. */
function backupFolderBase({ now, repo, name }: { now: Date; repo: string; name: string }): string {
    return `${localDay(now)}-${repo}-${name}`
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .replace(/\.{2,}/g, "-")
        .replace(/(\.lock|\.)$/, "-");
}

function isAlreadyThere(err: unknown): boolean {
    return err instanceof Error && "code" in err && err.code === "EEXIST";
}

/** Creates the folder, adding `-2`, `-3`, ... when the name is taken (several repos have a worktree of one name). */
function createBackupFolder({ root, base }: { root: string; base: string }): string {
    mkdirSync(root, { recursive: true });

    for (let n = 1; n < 10_000; n++) {
        const folder = join(root, n === 1 ? base : `${base}-${n}`);

        try {
            mkdirSync(folder);
            return folder;
        } catch (err) {
            if (!isAlreadyThere(err)) {
                throw err;
            }
        }
    }

    throw new Error(`Every name from ${base} to ${base}-9999 is taken under ${root}.`);
}

function copyEntries({
    root,
    entries,
    to,
    skipped,
}: {
    root: string;
    entries: WalkedEntry[];
    to: string;
    skipped: string[];
}): void {
    for (const entry of entries) {
        const source = join(root, entry.rel);
        const target = join(to, entry.rel);

        if (entry.kind === "dir") {
            mkdirSync(target, { recursive: true });
            continue;
        }

        if (entry.kind === "special") {
            skipped.push(entry.rel);
            continue;
        }

        mkdirSync(dirname(target), { recursive: true });

        if (entry.kind === "symlink") {
            symlinkSync(readlinkSync(source), target);
            continue;
        }

        // An APFS clone: no extra space on the same volume, a plain copy elsewhere.
        copyFileSync(source, target, constants.COPYFILE_FICLONE);
        chmodSync(target, entry.mode & 0o7777);
        utimesSync(target, new Date(entry.atimeMs), new Date(entry.mtimeMs));
    }
}

/** A `--no-cone` sparse-checkout line that matches exactly this path. */
function sparsePattern(path: string): string {
    const escaped = path
        .replace(/[\\*?[\]!#]/g, (char) => `\\${char}`)
        .replace(/^ /, "\\ ")
        .replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
    return `/${escaped}`;
}

async function proofGit({
    cwd,
    args,
    env,
}: {
    cwd: string;
    args: string[];
    env?: Record<string, string>;
}): Promise<ExecResult> {
    return runGit({ cwd, args: [...PROOF_CONFIG, ...args], env: { ...PROOF_ENV, ...env } });
}

async function proveUncommitted({
    tmp,
    head,
    patchFile,
}: {
    tmp: string;
    head: string;
    patchFile: string;
}): Promise<string> {
    const env = { GIT_INDEX_FILE: join(tmp, "proof-index") };
    const read = await proofGit({ cwd: tmp, args: ["read-tree", head], env });

    if (!read.success) {
        return `failed: git read-tree ${head}: ${firstLines(read.stderr)}`;
    }

    const check = await proofGit({ cwd: tmp, args: ["apply", "--cached", "--check", patchFile], env });
    return check.success ? "ok" : `failed: git apply --cached --check: ${firstLines(check.stderr)}`;
}

async function proveCommits({
    tmp,
    plan,
    base,
    patchFiles,
}: {
    tmp: string;
    plan: WorktreeBackupPlan;
    base: string;
    patchFiles: string[];
}): Promise<Pick<WorktreeBackupProof, "commits" | "treeMatches">> {
    // Only the paths the range touches are checked out, so the proof costs the same in a huge repository.
    const touched = new Set(
        splitZ(
            await mustRead(plan.path, [
                "log",
                "--no-renames",
                "--name-only",
                "--format=",
                "-z",
                `${base}..${plan.head}`,
            ])
        )
    );
    mkdirSync(join(tmp, ".git", "info"), { recursive: true });
    writeFileSync(
        join(tmp, ".git", "info", "sparse-checkout"),
        [...touched].map((p) => `${sparsePattern(p)}\n`).join("")
    );
    appendFileSync(join(tmp, ".git", "config"), "[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = false\n");
    const checkout = await proofGit({ cwd: tmp, args: ["checkout", "-q", "--detach", base] });

    if (!checkout.success) {
        return { commits: `failed: git checkout ${base}: ${firstLines(checkout.stderr)}`, treeMatches: null };
    }

    const am = await proofGit({ cwd: tmp, args: ["am", "--quiet", "--keep-cr", "--empty=keep", ...patchFiles] });

    if (!am.success) {
        return { commits: `failed: git am: ${firstLines(am.stderr || am.stdout)}`, treeMatches: null };
    }

    if (plan.merges > 0) {
        return { commits: "ok", treeMatches: null };
    }

    const trees = await proofGit({ cwd: tmp, args: ["rev-parse", "HEAD^{tree}", `${plan.head}^{tree}`] });
    const [built, expected] = trees.stdout.split("\n");

    if (!trees.success || built !== expected) {
        return {
            commits: `failed: the patches applied, but they built tree ${built ?? "?"} where HEAD has ${expected ?? "?"}`,
            treeMatches: false,
        };
    }

    return { commits: "ok", treeMatches: true };
}

/**
 * Proves the backup in a throwaway repository under the OS temp dir whose object store borrows the source's as an
 * alternate. Nothing is written to the user's repository; the temp dir is this function's own and is deleted.
 */
async function proveBackup({
    plan,
    commonDir,
    patchFile,
    patchFiles,
}: {
    plan: WorktreeBackupPlan;
    commonDir: string;
    patchFile: string | null;
    patchFiles: string[];
}): Promise<WorktreeBackupProof> {
    const proof: WorktreeBackupProof = { uncommitted: "none", commits: "none", treeMatches: null };

    if (patchFile === null && patchFiles.length === 0) {
        return proof;
    }

    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gt-worktree-proof-")));

    try {
        const init = await runGit({ cwd: tmp, args: ["init", "-q", "--template=", tmp], env: PROOF_ENV });

        if (!init.success) {
            const failure = `failed: git init of the scratch repository: ${firstLines(init.stderr)}`;
            return {
                uncommitted: patchFile === null ? "none" : failure,
                commits: patchFiles.length === 0 ? "none" : failure,
                treeMatches: null,
            };
        }

        mkdirSync(join(tmp, ".git", "objects", "info"), { recursive: true });
        writeFileSync(join(tmp, ".git", "objects", "info", "alternates"), `${join(commonDir, "objects")}\n`);

        if (patchFile !== null) {
            proof.uncommitted = await proveUncommitted({ tmp, head: plan.head, patchFile });
        }

        if (patchFiles.length > 0 && plan.base !== null) {
            Object.assign(proof, await proveCommits({ tmp, plan, base: plan.base.sha, patchFiles }));
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }

    return proof;
}

function proofPassed(proof: WorktreeBackupProof): boolean {
    const passed = (value: string): boolean => value === "ok" || value === "none";
    return passed(proof.uncommitted) && passed(proof.commits) && proof.treeMatches !== false;
}

function shellQuote(value: string): string {
    return /^[A-Za-z0-9_./@:+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function proofLine(label: string, value: string, okText: string): string {
    if (value === "ok") {
        return `- ${label}: ok. ${okText}`;
    }

    if (value === "none") {
        return `- ${label}: none to prove.`;
    }

    return `- ${label}: ${value}`;
}

function renderReadme({
    result,
    note,
    headSubject,
    now,
}: {
    result: WorktreeBackupResult;
    note: string | undefined;
    headSubject: string;
    now: Date;
}): string {
    const { plan } = result;
    const folder = result.folder ?? "";
    const q = shellQuote;
    const short = plan.head.slice(0, 10);
    const branchShort = plan.branch?.slice("refs/heads/".length) ?? null;
    const patchName = `uncommitted-on-${short}.patch`;
    const keptIgnored = result.plan.ignored.length;
    const lines: string[] = [];

    lines.push(`# Worktree backup: ${plan.repo} / ${basename(plan.path)}`, "");
    lines.push(`Written ${localMinute(now)} by \`tools git worktree backup\`.`, "");
    lines.push("| What | Value |", "|---|---|");
    lines.push(
        `| Original path | \`${plan.path}\`${plan.listed === plan.path ? "" : ` (git listed it as \`${plan.listed}\`)`} |`
    );
    lines.push(`| Repository | \`${plan.repoRoot}\` |`);
    lines.push(
        `| Branch | ${branchShort === null ? "detached HEAD" : `\`${branchShort}\` (the branch stays in the repository)`} |`
    );
    lines.push(`| HEAD | \`${plan.head}\` ${headSubject.replaceAll("|", "\\|")} |`);
    lines.push(
        `| Base | ${plan.base === null ? "none found (no upstream, no origin/HEAD, no other branch in the main checkout), so no commit patches" : `\`${plan.base.sha}\` from \`${plan.base.ref}\``} |`
    );
    lines.push(
        `| Safety ref | ${result.ref === null ? "not needed: a branch, a remote branch or a tag holds every commit of HEAD" : `\`${result.ref}\` holds ${plan.unreachable} commit(s) nothing else holds`} |`
    );
    lines.push(
        `| Commits since the base | ${plan.commits.length} in \`commits/\`${plan.merges > 0 ? ` (${plan.merges} merge commits skipped: format-patch cannot write them)` : ""} |`
    );
    lines.push(
        `| Changed tracked files | ${plan.changed.length}${plan.changed.length > 0 ? ` in \`${patchName}\`` : ""} |`
    );
    lines.push(`| Untracked entries | ${plan.untracked.length} in \`untracked/\` |`);
    lines.push(
        `| Ignored entries kept | ${keptIgnored} in \`ignored/\` (rebuildable folders such as node_modules skipped) |`
    );
    lines.push(`| Bytes copied | ${plan.copyBytes} |`);

    if (result.skipped.length > 0) {
        lines.push(
            `| Not copied (sockets, fifos, devices) | ${result.skipped.map((rel) => `\`${rel}\``).join(", ")} |`
        );
    }

    lines.push(
        `| Removed | ${result.removed ? "yes" : result.refusal === null ? "no (not asked)" : `no: ${result.refusal.replaceAll("|", "\\|")}`} |`,
        ""
    );
    lines.push("## What the work was", "", note?.trim() ? note.trim() : "No note was given.", "");
    lines.push("## Proof", "");
    lines.push(
        proofLine(
            "Uncommitted patch",
            result.proof.uncommitted,
            "`git apply --cached --check` accepted it on a clean index of HEAD."
        )
    );
    lines.push(
        proofLine(
            "Commit patches",
            result.proof.commits,
            result.proof.treeMatches === true
                ? "`git am` rebuilt them on the base in a scratch repository, and the tree equals HEAD's tree."
                : "`git am` rebuilt them on the base in a scratch repository (merge commits in the range, so the tree was not compared)."
        ),
        ""
    );
    lines.push("## Restore", "", "```bash");
    lines.push("# 1. The worktree at its old path");

    if (branchShort !== null) {
        lines.push(`git -C ${q(plan.repoRoot)} worktree add ${q(plan.path)} ${q(branchShort)}`);
    } else {
        lines.push(`git -C ${q(plan.repoRoot)} worktree add --detach ${q(plan.path)} ${q(result.ref ?? plan.head)}`);
    }

    if (plan.base !== null && plan.commits.length > 0) {
        lines.push(
            "",
            "# 1b. Only when the branch and the safety ref are gone: rebuild the commits on the base instead",
            `git -C ${q(plan.repoRoot)} worktree add --detach ${q(plan.path)} ${plan.base.sha}`,
            `git -C ${q(plan.path)} am --keep-cr ${q(join(folder, "commits"))}/*.patch`
        );
    }

    if (plan.changed.length > 0) {
        lines.push("", "# 2. The uncommitted changes", `git -C ${q(plan.path)} apply ${q(join(folder, patchName))}`);
    }

    if (plan.untracked.length > 0 || keptIgnored > 0) {
        lines.push("", "# 3. Untracked and ignored files");
    }

    if (plan.untracked.length > 0) {
        lines.push(`cp -R ${q(join(folder, "untracked"))}/. ${q(plan.path)}/`);
    }

    if (keptIgnored > 0) {
        lines.push(`cp -R ${q(join(folder, "ignored"))}/. ${q(plan.path)}/`);
    }

    lines.push("```", "");
    return lines.join("\n");
}

function writeReport({
    result,
    note,
    headSubject,
    now,
}: {
    result: WorktreeBackupResult;
    note: string | undefined;
    headSubject: string;
    now: Date;
}): void {
    if (result.folder === null) {
        return;
    }

    writeFileSync(join(result.folder, "backup.json"), `${SafeJSON.stringify(result, null, 2)}\n`);
    writeFileSync(join(result.folder, "README.md"), renderReadme({ result, note, headSubject, now }));
}

/**
 * Removes the worktree after the backup, when the proof passed and nothing changed since the plan: the fingerprint is
 * read again and processes are checked again right before `git worktree remove --force` (one `--force`, so a lock
 * still refuses). Returns the refusal, or null when the folder is gone.
 */
async function removeAfterBackup({
    inspection,
    maxCopyBytes,
}: {
    inspection: Inspection;
    maxCopyBytes: number;
}): Promise<string | null> {
    const { plan } = inspection;
    const again = await readWorkState(plan.path, maxCopyBytes);

    if (again.fingerprint !== plan.fingerprint) {
        return "The worktree changed during the backup, so it was kept; the backup stays.";
    }

    const processes = await processBlockers(plan.path);

    if (processes.length > 0) {
        return processes.join(" ");
    }

    const removal = await runGit({ cwd: plan.repoRoot, args: ["worktree", "remove", "--force", plan.listed] });

    if (!removal.success) {
        return `git worktree remove failed, so the worktree was kept: ${firstLines(removal.stderr)}`;
    }

    if (existsSync(plan.path)) {
        return `git worktree remove exited 0, but ${plan.path} is still there.`;
    }

    return null;
}

/**
 * Backs up the worktree at `path` into its own folder under `backupRoot`, proves the backup in a scratch repository,
 * and with `remove` removes the worktree once the proof passed and nothing changed. A blocker refuses before anything
 * is written. Throws when `path` is not a linked worktree; any later failure lands in `refusal` and keeps the worktree.
 */
export async function backupWorktree(options: BackupWorktreeOptions): Promise<WorktreeBackupResult> {
    const maxCopyBytes = options.maxCopyBytes ?? DEFAULT_WORKTREE_BACKUP_MAX_COPY_BYTES;
    const now = options.now ?? new Date();
    const inspection = await inspectWorktree({ path: options.path, maxCopyBytes, remove: options.remove });
    const { plan, identity, state } = inspection;
    const result: WorktreeBackupResult = {
        plan,
        folder: null,
        ref: null,
        proof: { uncommitted: "none", commits: "none", treeMatches: null },
        removed: false,
        refusal: null,
        skipped: [],
    };

    if (plan.blockers.length > 0) {
        result.refusal = plan.blockers.join(" ");
        log.debug({ path: plan.path, blockers: plan.blockers }, "worktree backup refused before writing");
        return result;
    }

    const root = options.backupRoot ?? genesisToolsDir("backups", "worktrees");
    const folder = createBackupFolder({
        root,
        base: backupFolderBase({ now, repo: plan.repo, name: basename(plan.path) }),
    });
    result.folder = folder;
    const report = (): void => writeReport({ result, note: options.note, headSubject: state.headSubject, now });

    try {
        if (plan.unreachable > 0) {
            const ref = `${WORKTREE_BACKUP_REF_PREFIX}${basename(folder)}`;
            const update = await runGit({ cwd: plan.path, args: ["update-ref", ref, plan.head] });

            if (!update.success) {
                throw new Error(`git update-ref ${ref} failed: ${firstLines(update.stderr)}`);
            }

            result.ref = ref;
        }

        let patchFiles: string[] = [];

        if (plan.base !== null && plan.commits.length > 0) {
            const commitsDir = join(folder, "commits");
            await mustRead(plan.path, [
                "format-patch",
                "--quiet",
                "--no-cover-letter",
                "--no-attach",
                "--no-signoff",
                "--suffix=.patch",
                ...PATCH_FLAGS.filter((flag) => flag !== "--no-relative"),
                "--output-directory",
                commitsDir,
                `${plan.base.sha}..${plan.head}`,
            ]);
            patchFiles = readdirSync(commitsDir)
                .filter((name) => name.endsWith(".patch"))
                .sort()
                .map((name) => join(commitsDir, name));
        }

        let patchFile: string | null = null;

        if (plan.changed.length > 0) {
            patchFile = join(folder, `uncommitted-on-${plan.head.slice(0, 10)}.patch`);
            await mustRead(plan.path, ["diff", plan.head, ...PATCH_FLAGS, `--output=${patchFile}`]);
        }

        for (const group of ["untracked", "ignored"] as const) {
            copyEntries({
                root: plan.path,
                entries: state.entries.filter((entry) => entry.group === group),
                to: join(folder, group),
                skipped: result.skipped,
            });
        }

        result.proof = await proveBackup({ plan, commonDir: identity.commonDir, patchFile, patchFiles });
        report();
        await options.afterBackup?.(result);

        if (!proofPassed(result.proof)) {
            result.refusal = `The proof failed, so nothing was removed: uncommitted ${result.proof.uncommitted}; commits ${result.proof.commits}.`;
        } else if (options.remove) {
            result.refusal = await removeAfterBackup({ inspection, maxCopyBytes });
            result.removed = result.refusal === null;
        }
    } catch (err) {
        result.refusal = `The backup failed, so nothing was removed: ${err instanceof Error ? err.message : String(err)}`;
        log.debug({ err, path: plan.path, folder }, "worktree backup failed");
    }

    report();
    log.debug(
        {
            path: plan.path,
            folder,
            ref: result.ref,
            proof: result.proof,
            removed: result.removed,
            refusal: result.refusal,
        },
        "worktree backup finished"
    );
    return result;
}

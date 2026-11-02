import { lstatSync, opendirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { concurrentMap } from "@genesiscz/utils/async";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { createGit } from "@genesiscz/utils/git/core";
import { porcelain, type StatusEntry } from "@genesiscz/utils/git/porcelain";
import { repoRootOf } from "@genesiscz/utils/git/repo-root";
import { logger } from "@genesiscz/utils/logger";

/** What git says about a path: not in any commit, ignored, changed, as committed, or outside a repository. */
export type RmGitState = "untracked" | "ignored" | "modified" | "clean" | "none";

/** An item's git facts for the approval window. */
export interface ItemGit {
    state: RmGitState;
    /** The top folder of the repository around it; absent outside one. */
    repo?: string;
    /** `<short sha> <when>: <subject>` of the last commit that touched a tracked path. */
    lastCommit?: string;
}

/** A folder's file count and newest file change, from a walk that stops at a cap. */
export interface FolderStats {
    files: number;
    /** The newest file's mtime (ISO time); null for a folder with no files. */
    newestAt: string | null;
    /** The walk stopped at its cap: `files` is a lower bound. */
    capped?: boolean;
    /** A folder of the tree could not be listed (no permission, say): `files` counts only what was read. */
    unreadable?: boolean;
}

/** A path to ask git about; `aside` when it was moved out of the way, so git sees its files deleted. */
export interface GitProbe {
    path: string;
    aside?: boolean;
}

const GIT_TIMEOUT_MS = 10_000;
/** At most this many git processes at once for one approval window, across every repository and path. */
const GIT_CONCURRENCY = 8;

/** One git call in a repository: its stdout, or null when it failed. */
export type RmGitRunner = (repo: string, args: string[], env?: Record<string, string>) => Promise<string | null>;
export const FOLDER_WALK_CAP = 2000;

function posixRelative(repo: string, path: string): string {
    return relative(repo, path).split(sep).join("/");
}

function entryPath(entry: StatusEntry): string {
    return entry.path.replace(/\/$/, "");
}

/** `inner` is `outer` or inside it; the empty path is the repository's top. */
function covers(outer: string, inner: string): boolean {
    return outer === "" || inner === outer || inner.startsWith(`${outer}/`);
}

/** The status entries that are the path itself or a folder around it. */
function coveringEntries(entries: readonly StatusEntry[], rel: string): StatusEntry[] {
    return entries.filter((entry) => entryPath(entry) !== "" && covers(entryPath(entry), rel));
}

/** A state decided by the folder around the path alone (an ignored or untracked parent); null when it needs more. */
export function coveredState(entries: readonly StatusEntry[], rel: string): RmGitState | null {
    const covering = coveringEntries(entries, rel);

    if (covering.some((entry) => entry.kind === "ignored")) {
        return "ignored";
    }

    if (covering.some((entry) => entry.kind === "untracked")) {
        return "untracked";
    }

    return null;
}

/**
 * The path's state from one `git status --porcelain=v2 --ignored=matching` of its repository and whether any commit
 * holds it. A path moved aside shows its tracked files as deleted; those deletions are the move, not a change.
 */
export function itemGitState(input: {
    entries: readonly StatusEntry[];
    rel: string;
    aside: boolean;
    tracked: boolean;
}): RmGitState {
    const entries = input.aside
        ? input.entries.filter((entry) => !(entry.kind === "changed" && entry.worktree === "D"))
        : input.entries;
    const covered = coveredState(entries, input.rel);

    if (covered) {
        return covered;
    }

    const inside = entries.filter((entry) => covers(input.rel, entryPath(entry)));

    if (inside.some((entry) => entry.kind !== "ignored")) {
        return input.tracked ? "modified" : "untracked";
    }

    if (input.tracked) {
        return "clean";
    }

    return inside.length > 0 ? "ignored" : "untracked";
}

/** One git call in `repo` with the approval's timeout; null when it failed, timed out or could not start. */
async function runGit(repo: string, args: string[], env?: Record<string, string>): Promise<string | null> {
    try {
        const res = await createGit({ cwd: repo }).executor.exec(args, { env, timeout: GIT_TIMEOUT_MS });

        if (!res.success) {
            logger.debug({ repo, args, stderr: res.stderr, timedOut: res.timedOut }, "rm: git for the approval failed");
            return null;
        }

        return res.stdout;
    } catch (error) {
        logger.debug({ repo, args, error }, "rm: git for the approval did not finish");
        return null;
    }
}

async function repoStatus(git: RmGitRunner, repo: string, rels: readonly string[]): Promise<StatusEntry[] | null> {
    const args = [
        "--literal-pathspecs",
        ...porcelain.status.args({ untracked: "normal" }),
        "--ignored=matching",
        "--",
        ...rels.map((rel) => rel || "."),
    ];
    const stdout = await git(repo, args, { GIT_OPTIONAL_LOCKS: "0" });
    return stdout === null ? null : porcelain.status.parse(stdout).entries;
}

/** `<short sha> <when>: <subject>` of the last commit that touched `rel`; null when no commit holds it. */
async function lastCommitOf(git: RmGitRunner, repo: string, rel: string): Promise<string | null> {
    const args = ["--literal-pathspecs", ...porcelain.log.args({ range: "HEAD", paths: [rel || "."], limit: 1 })];
    const stdout = await git(repo, args);
    const commit = stdout === null ? undefined : porcelain.log.parse(stdout)[0];

    if (!commit) {
        return null;
    }

    const when = formatRelativeTime(new Date(commit.committer.epoch * 1000));
    return `${commit.shortSha} ${when}: ${commit.subject}`;
}

interface RepoProbe {
    repo: string;
    probes: GitProbe[];
    rels: string[];
}

interface CommitJob {
    repo: RepoProbe;
    index: number;
}

/**
 * Git facts for each path: one `git status` per repository (not per path), and for a tracked path its last commit.
 * A path outside any repository is `none`; a path whose repository git cannot read is left out. Every git call of
 * the request shares one bound (`concurrency`), so a request with a thousand tracked paths never starts a thousand
 * processes at once.
 */
export async function probeItemGit(
    probes: readonly GitProbe[],
    options: { git?: RmGitRunner; concurrency?: number } = {}
): Promise<Map<string, ItemGit>> {
    const git = options.git ?? runGit;
    const concurrency = options.concurrency ?? GIT_CONCURRENCY;
    const found = new Map<string, ItemGit>();
    const byRepo = new Map<string, GitProbe[]>();

    for (const probe of probes) {
        const repo = repoRootOf(probe.path);

        if (!repo) {
            found.set(probe.path, { state: "none" });
            continue;
        }

        byRepo.set(repo, [...(byRepo.get(repo) ?? []), probe]);
    }

    const repos: RepoProbe[] = [...byRepo].map(([repo, group]) => ({
        repo,
        probes: group,
        rels: group.map((probe) => posixRelative(repo, probe.path)),
    }));
    const statuses = await concurrentMap({
        items: repos,
        fn: (repo) => repoStatus(git, repo.repo, repo.rels),
        concurrency,
    });
    const jobs: CommitJob[] = repos.flatMap((repo) => {
        const entries = statuses.get(repo);
        return entries ? repo.rels.flatMap((rel, index) => (coveredState(entries, rel) ? [] : [{ repo, index }])) : [];
    });
    const commits = await concurrentMap({
        items: jobs,
        fn: (job) => lastCommitOf(git, job.repo.repo, job.repo.rels[job.index] ?? ""),
        concurrency,
    });
    const lastCommits = new Map<RepoProbe, Array<string | null>>();

    for (const [job, commit] of commits) {
        const list = lastCommits.get(job.repo) ?? [];
        list[job.index] = commit;
        lastCommits.set(job.repo, list);
    }

    for (const repo of repos) {
        const entries = statuses.get(repo);

        if (!entries) {
            continue;
        }

        for (const [index, probe] of repo.probes.entries()) {
            const rel = repo.rels[index] ?? "";
            const lastCommit = lastCommits.get(repo)?.[index] ?? null;
            const state = itemGitState({ entries, rel, aside: probe.aside ?? false, tracked: lastCommit !== null });
            found.set(probe.path, lastCommit ? { state, repo: repo.repo, lastCommit } : { state, repo: repo.repo });
        }
    }

    logger.debug({ paths: probes.length, repos: byRepo.size }, "rm: git facts for the approval window");
    return found;
}

function mtimeOf(path: string): number {
    try {
        return lstatSync(path).mtimeMs;
    } catch (error) {
        logger.debug({ error, path }, "rm: an entry vanished during the folder walk");
        return 0;
    }
}

/**
 * How many files a folder holds and when the newest changed; the walk stops after `cap` entries. A folder it could
 * not list makes the result `unreadable`, so 0 files from a folder it may not read never reads as an empty folder.
 */
export function folderStats(dir: string, cap = FOLDER_WALK_CAP): FolderStats {
    const stack = [dir];
    let seen = 0;
    let files = 0;
    let newest = 0;
    let capped = false;
    let unreadable = false;

    while (stack.length > 0 && !capped) {
        const current = stack.pop() ?? dir;

        try {
            const handle = opendirSync(current);
            try {
                while (true) {
                    const entry = handle.readSync();
                    if (!entry) {
                        break;
                    }
                    if (seen >= cap) {
                        capped = true;
                        break;
                    }
                    seen++;
                    const path = join(current, entry.name);
                    if (entry.isDirectory()) {
                        stack.push(path);
                        continue;
                    }
                    files++;
                    newest = Math.max(newest, mtimeOf(path));
                }
            } finally {
                handle.closeSync();
            }
        } catch (error) {
            // A folder removed during the walk holds nothing now; any other failure hid what is inside.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                unreadable = true;
            }

            logger.debug({ error, dir: current }, "rm: could not list a folder for its stats");
        }
    }

    const stats: FolderStats = { files, newestAt: newest > 0 ? new Date(newest).toISOString() : null };
    const walked = capped || stack.length > 0 ? { ...stats, capped: true } : stats;
    return unreadable ? { ...walked, unreadable: true } : walked;
}

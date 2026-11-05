import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";

const prof = profiler.scope("agent-context");
const { log } = logger.scoped("agent-context");

/**
 * The checkout facts of a caller's cwd: the layout (which repo, which worktree) and the HEAD facts (branch, short
 * sha, subject of the last commit). Six `git` spawns when nothing is cached.
 */
export interface GitFacts {
    project: string;
    repoRoot: string;
    isWorktree: boolean;
    worktreePath: string | null;
    branch: string | null;
    commitSha: string | null;
    commitMessage: string | null;
}

/** The facts a caller already holds: none of them is read again (an answered question passes all of them). */
export type GivenGitFacts = Partial<Record<keyof GitFacts, true>>;

interface Layout {
    gitDir: string | null;
    gitCommonDir: string | null;
    topLevel: string | null;
}

interface HeadFacts {
    key: string;
    branch: string | null;
    commitSha: string | null;
    commitMessage: string | null;
}

/**
 * The cache, per process. A long-lived process (the MCP gateway, a watcher) must see a branch switch and a new commit,
 * so the HEAD facts are keyed on what git itself rewrites for each: the inode and mtime (ns) of `<git dir>/HEAD`
 * (a checkout or a detach), of the loose ref HEAD points to (a commit: git writes the ref by rename, so a new inode)
 * and of `packed-refs` (a `pack-refs` or a fetch). Those are one small read and three `stat`s per call instead of
 * three spawns. The layout of a cwd is kept while its HEAD file still exists; a folder that is no repository is not
 * cached, so `git init` there is seen on the next call.
 */
const layouts = new Map<string, Layout>();
const heads = new Map<string, HeadFacts>();

function gitSync(args: string[], cwd: string): string | null {
    try {
        const r = prof.measure(`runtime.git ${args.join(" ")}`, () =>
            Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" })
        );
        if (r.exitCode !== 0) {
            return null;
        }

        const out = r.stdout.toString().trim();
        return out.length > 0 ? out : null;
    } catch (error) {
        log.debug({ error, cwd, args }, "agent context has no readable Git checkout");
        return null;
    }
}

function statKey(path: string): string {
    try {
        const stat = statSync(path, { bigint: true });
        return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
    } catch {
        return "-";
    }
}

function exists(path: string): boolean {
    return statKey(path) !== "-";
}

function layoutOf(cwd: string): Layout {
    const cached = layouts.get(cwd);

    if (cached?.gitDir && exists(resolve(cwd, cached.gitDir, "HEAD"))) {
        return cached;
    }

    const layout: Layout = {
        gitDir: gitSync(["rev-parse", "--git-dir"], cwd),
        gitCommonDir: gitSync(["rev-parse", "--git-common-dir"], cwd),
        topLevel: gitSync(["rev-parse", "--show-toplevel"], cwd),
    };

    if (layout.gitDir) {
        layouts.set(cwd, layout);
    } else {
        layouts.delete(cwd);
    }

    return layout;
}

/**
 * What git rewrites when the HEAD facts change; see `heads`. The files ref format writes HEAD, the loose ref and
 * `packed-refs`. The reftable format keeps HEAD fixed (`ref: refs/heads/.invalid`) and replaces `reftable/tables.list`
 * on every ref update, in the worktree's own git dir (its HEAD) and in the common dir (the branches).
 */
function headKey(gitDir: string, commonDir: string): string {
    const headPath = resolve(gitDir, "HEAD");
    let ref = "";

    try {
        const text = readFileSync(headPath, "utf8").trim();
        ref = text.startsWith("ref: ") ? text.slice("ref: ".length) : "";
    } catch {
        return "-";
    }

    const refKey = ref ? statKey(resolve(commonDir, ref)) : "detached";
    const tables = `${statKey(resolve(gitDir, "reftable", "tables.list"))}|${statKey(resolve(commonDir, "reftable", "tables.list"))}`;
    return `${statKey(headPath)}|${ref}|${refKey}|${statKey(resolve(commonDir, "packed-refs"))}|${tables}`;
}

function headFactsOf(cwd: string, layout: Layout, given: GivenGitFacts): Omit<HeadFacts, "key"> {
    const read = (field: keyof GitFacts, args: string[]) => (given[field] ? null : gitSync(args, cwd));

    if (!layout.gitDir || !layout.gitCommonDir) {
        return {
            branch: read("branch", ["rev-parse", "--abbrev-ref", "HEAD"]),
            commitSha: read("commitSha", ["rev-parse", "--short", "HEAD"]),
            commitMessage: read("commitMessage", ["log", "-1", "--format=%s"]),
        };
    }

    const gitDir = resolve(cwd, layout.gitDir);
    const key = headKey(gitDir, resolve(cwd, layout.gitCommonDir));
    const cached = heads.get(gitDir);

    if (cached && cached.key === key && key !== "-") {
        return cached;
    }

    const fresh: HeadFacts = {
        key,
        branch: read("branch", ["rev-parse", "--abbrev-ref", "HEAD"]),
        commitSha: read("commitSha", ["rev-parse", "--short", "HEAD"]),
        commitMessage: read("commitMessage", ["log", "-1", "--format=%s"]),
    };

    // A partial read (some fields given) is not a full answer for the next caller, so only a full read is kept.
    if (!given.branch && !given.commitSha && !given.commitMessage && key !== "-") {
        heads.set(gitDir, fresh);
    }

    return fresh;
}

/** The checkout facts of `cwd`, with the fields in `given` left null and not read. */
export function readGitFacts(cwd: string, given: GivenGitFacts = {}): GitFacts {
    return prof.measure("identity.git", () => {
        const layoutGiven = given.repoRoot && given.project && given.isWorktree && given.worktreePath;
        const layout: Layout = layoutGiven ? { gitDir: null, gitCommonDir: null, topLevel: null } : layoutOf(cwd);
        // Canonical worktree test: in the main repo `--git-dir` and `--git-common-dir` resolve to the same path; in a
        // linked worktree the git-dir is `.../.git/worktrees/<name>` while the common-dir is the main `.git`.
        const isWorktree =
            layout.gitDir != null &&
            layout.gitCommonDir != null &&
            resolve(cwd, layout.gitDir) !== resolve(cwd, layout.gitCommonDir);
        // A linked worktree's main repo is the parent of the shared `.git`; anywhere else it is the checkout root.
        const repoRoot =
            isWorktree && layout.gitCommonDir ? resolve(cwd, layout.gitCommonDir, "..") : (layout.topLevel ?? cwd);
        const head = headFactsOf(cwd, layout, given);

        return {
            project: basename(repoRoot),
            repoRoot,
            isWorktree,
            worktreePath: isWorktree ? layout.topLevel : null,
            branch: head.branch,
            commitSha: head.commitSha,
            commitMessage: head.commitMessage,
        };
    });
}

/**
 * Absolute, CANONICAL path of the shared `.git`. Every worktree of one repo returns the same value.
 *
 * realpath, not just resolve (PR #343 review t1 round 13): the kernel reports `/private/tmp/...` where
 * `process.cwd()` keeps `/tmp/...`, and comparing a lexical common-dir against a canonical one made the SAME
 * repository reached through a symlink produce two unequal strings.
 */
export function gitCommonRoot(cwd: string): string | null {
    const common = layoutOf(cwd).gitCommonDir;

    if (!common) {
        return null;
    }

    const absolute = resolve(cwd, common);

    try {
        return realpathSync(absolute);
    } catch {
        // Not yet on disk (a pruned worktree, a race): the lexical form is still a usable comparison key.
        return absolute;
    }
}

/** Forget every cached layout and HEAD; for a test that rewrites a repository behind git's back. */
export function clearGitFactsCache(): void {
    layouts.clear();
    heads.clear();
}

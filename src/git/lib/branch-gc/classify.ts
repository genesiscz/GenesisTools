import { createGit } from "@app/utils/git";

export type BranchStatus = "current" | "base" | "merged" | "squash-merged" | "gone" | "stale" | "active";

const SECONDS_PER_DAY = 86_400;

/** Statuses whose work is provably contained in base (or pushed & pruned) → safe to auto-delete. */
const SAFE_STATUSES: ReadonlySet<BranchStatus> = new Set<BranchStatus>(["merged", "squash-merged", "gone"]);

export interface BranchInfo {
    name: string;
    status: BranchStatus;
    /** Commits on branch not in base. */
    ahead: number;
    /** Commits on base not in branch. */
    behind: number;
    lastCommitEpoch: number;
    /** Age in days, derived from the injected `nowEpoch`. */
    ageDays: number;
    /** True for merged / squash-merged / gone (never current or base). */
    deletable: boolean;
}

export interface ClassifyOptions {
    cwd: string;
    base: string;
    /** Current branch name; empty string when HEAD is detached. */
    current: string;
    /** Injected wall-clock epoch (seconds) — keeps staleness deterministic in tests. */
    nowEpoch: number;
    staleDays: number;
}

export class BaseNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BaseNotFoundError";
    }
}

/** Local branch short-names via `for-each-ref refs/heads`. */
export async function listLocalBranches(cwd: string): Promise<string[]> {
    const { executor } = createGit({ cwd });
    const { stdout } = await executor.exec(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    return stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}

/** True if a local branch with this name exists. */
export async function localBranchExists(cwd: string, name: string): Promise<boolean> {
    const { executor } = createGit({ cwd });
    const { success } = await executor.exec(["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return success;
}

/**
 * Resolve the base branch: honour `explicit` if given, else prefer local `master`,
 * then `main`. Verifies the chosen base exists locally; throws otherwise.
 */
export async function detectBase(cwd: string, explicit?: string): Promise<string> {
    if (explicit) {
        if (await localBranchExists(cwd, explicit)) {
            return explicit;
        }

        throw new BaseNotFoundError(`Base branch "${explicit}" does not exist locally.`);
    }

    for (const candidate of ["master", "main"]) {
        if (await localBranchExists(cwd, candidate)) {
            return candidate;
        }
    }

    throw new BaseNotFoundError("Could not auto-detect a base branch (no local master/main). Pass --base <branch>.");
}

/** Current branch short-name, or "" on detached HEAD. */
export async function getCurrentBranch(cwd: string): Promise<string> {
    const { executor } = createGit({ cwd });
    const { stdout, success } = await executor.exec(["symbolic-ref", "--short", "-q", "HEAD"]);
    if (!success) {
        return "";
    }

    return stdout;
}

/** Set of branch names whose upstream tracking branch is gone (`[gone]`). */
export async function getUpstreamGone(cwd: string): Promise<Set<string>> {
    const { executor } = createGit({ cwd });
    const { stdout } = await executor.exec([
        "for-each-ref",
        "--format=%(refname:short)\t%(upstream:track)",
        "refs/heads",
    ]);

    const gone = new Set<string>();
    for (const line of stdout.split("\n")) {
        const [name, track] = line.split("\t");
        if (name && track?.includes("gone")) {
            gone.add(name.trim());
        }
    }

    return gone;
}

/** Ahead/behind vs base via `rev-list --left-right --count base...branch` (left=behind, right=ahead). */
export async function aheadBehind(
    cwd: string,
    base: string,
    branch: string
): Promise<{ ahead: number; behind: number }> {
    const { executor } = createGit({ cwd });
    const { stdout, success } = await executor.exec(["rev-list", "--left-right", "--count", `${base}...${branch}`]);
    if (!success) {
        return { ahead: 0, behind: 0 };
    }

    const [behindStr, aheadStr] = stdout.split(/\s+/);
    const behind = Number.parseInt(behindStr ?? "0", 10);
    const ahead = Number.parseInt(aheadStr ?? "0", 10);
    return { ahead: Number.isNaN(ahead) ? 0 : ahead, behind: Number.isNaN(behind) ? 0 : behind };
}

/** Committer epoch (seconds) of the branch tip via `log -1 --format=%ct`. */
export async function lastCommitEpoch(cwd: string, branch: string): Promise<number> {
    const { executor } = createGit({ cwd });
    const { stdout, success } = await executor.exec(["log", "-1", "--format=%ct", branch]);
    if (!success) {
        return 0;
    }

    const epoch = Number.parseInt(stdout, 10);
    return Number.isNaN(epoch) ? 0 : epoch;
}

/** True if `branch`'s tip is an ancestor of `base` (catches real merges and fast-forwards). */
export async function isAncestor(cwd: string, branch: string, base: string): Promise<boolean> {
    const { executor } = createGit({ cwd });
    const { success } = await executor.exec(["merge-base", "--is-ancestor", branch, base]);
    return success;
}

/**
 * Squash-merge detection via tree synthesis (NOT per-commit `git cherry`, which
 * misses squashes):
 *   mb       = merge-base base branch
 *   squashed = commit-tree branch^{tree} -p mb -m _
 *   cherry   = git cherry base squashed  →  leading "-" means base already
 *              contains the combined patch.
 * Returns false on unrelated histories or when the branch has no commits ahead of mb.
 */
export async function isSquashMerged(cwd: string, base: string, branch: string): Promise<boolean> {
    const { executor } = createGit({ cwd });

    const mbRes = await executor.exec(["merge-base", base, branch]);
    if (!mbRes.success) {
        return false;
    }

    const mb = mbRes.stdout;
    if (!mb) {
        return false;
    }

    const countRes = await executor.exec(["rev-list", "--count", `${mb}..${branch}`]);
    if (!countRes.success || Number.parseInt(countRes.stdout, 10) === 0) {
        return false;
    }

    const treeRes = await executor.exec(["rev-parse", `${branch}^{tree}`]);
    if (!treeRes.success) {
        return false;
    }

    const tree = treeRes.stdout;

    // Synthesize a commit of the branch's full tree on top of the merge-base,
    // then ask `git cherry` whether base already contains the equivalent patch
    // (leading "-"). This catches squash-merges that per-commit `git cherry`
    // misses. The synthetic commit is unreachable and pruned by routine `git gc`.
    // A fixed identity keeps `commit-tree` deterministic on machines/CI that
    // have no configured git user (otherwise the result is environment-dependent).
    const identityEnv: Record<string, string> = {
        GIT_AUTHOR_NAME: "branch-gc",
        GIT_AUTHOR_EMAIL: "branch-gc@local",
        GIT_COMMITTER_NAME: "branch-gc",
        GIT_COMMITTER_EMAIL: "branch-gc@local",
    };

    const squashRes = await executor.exec(["commit-tree", tree, "-p", mb, "-m", "_"], { env: identityEnv });
    if (!squashRes.success) {
        return false;
    }

    const squashed = squashRes.stdout;
    const cherryRes = await executor.exec(["cherry", base, squashed]);
    const firstLine = cherryRes.stdout
        .split("\n")
        .find((l) => l.trim().length > 0)
        ?.trim();
    return firstLine?.startsWith("-") ?? false;
}

async function classifyOne(branch: string, opts: ClassifyOptions, gone: Set<string>): Promise<BranchInfo> {
    const { cwd, base, current, nowEpoch, staleDays } = opts;

    const [{ ahead, behind }, epoch] = await Promise.all([
        aheadBehind(cwd, base, branch),
        lastCommitEpoch(cwd, branch),
    ]);
    const ageDays = epoch > 0 ? Math.floor((nowEpoch - epoch) / SECONDS_PER_DAY) : 0;

    const status = await resolveStatus(branch, opts, gone, ageDays);
    const deletable = SAFE_STATUSES.has(status);

    return { name: branch, status, ahead, behind, lastCommitEpoch: epoch, ageDays, deletable };

    async function resolveStatus(
        name: string,
        o: ClassifyOptions,
        goneSet: Set<string>,
        age: number
    ): Promise<BranchStatus> {
        if (name === current) {
            return "current";
        }

        if (name === base) {
            return "base";
        }

        if (await isAncestor(o.cwd, name, o.base)) {
            return "merged";
        }

        if (await isSquashMerged(o.cwd, o.base, name)) {
            return "squash-merged";
        }

        if (goneSet.has(name)) {
            return "gone";
        }

        if (age >= staleDays) {
            return "stale";
        }

        return "active";
    }
}

const STATUS_RANK: Record<BranchStatus, number> = {
    merged: 0,
    "squash-merged": 1,
    gone: 2,
    stale: 3,
    active: 4,
    base: 5,
    current: 6,
};

/**
 * Classify every local branch into exactly one status, applying the spec's
 * priority order. Pure w.r.t. time — uses `opts.nowEpoch`, never `Date.now()`.
 * Sorted: safe-to-delete first, then stale/active by age desc, base & current last.
 */
export async function classifyBranches(opts: ClassifyOptions): Promise<BranchInfo[]> {
    const [branches, gone] = await Promise.all([listLocalBranches(opts.cwd), getUpstreamGone(opts.cwd)]);

    const infos = await Promise.all(branches.map((b) => classifyOne(b, opts, gone)));

    return infos.sort((a, b) => {
        const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
        if (rankDiff !== 0) {
            return rankDiff;
        }

        return b.ageDays - a.ageDays;
    });
}

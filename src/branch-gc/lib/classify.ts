import { gitOk, runGit } from "./git";

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
    const { stdout } = await runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    return stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}

/** True if a local branch with this name exists. */
export async function localBranchExists(cwd: string, name: string): Promise<boolean> {
    return gitOk(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
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
    const { stdout, code } = await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (code !== 0) {
        return "";
    }

    return stdout.trim();
}

/** Set of branch names whose upstream tracking branch is gone (`[gone]`). */
export async function getUpstreamGone(cwd: string): Promise<Set<string>> {
    const { stdout } = await runGit(cwd, [
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
    const { stdout, code } = await runGit(cwd, ["rev-list", "--left-right", "--count", `${base}...${branch}`]);
    if (code !== 0) {
        return { ahead: 0, behind: 0 };
    }

    const [behindStr, aheadStr] = stdout.trim().split(/\s+/);
    const behind = Number.parseInt(behindStr ?? "0", 10);
    const ahead = Number.parseInt(aheadStr ?? "0", 10);
    return { ahead: Number.isNaN(ahead) ? 0 : ahead, behind: Number.isNaN(behind) ? 0 : behind };
}

/** Committer epoch (seconds) of the branch tip via `log -1 --format=%ct`. */
export async function lastCommitEpoch(cwd: string, branch: string): Promise<number> {
    const { stdout, code } = await runGit(cwd, ["log", "-1", "--format=%ct", branch]);
    if (code !== 0) {
        return 0;
    }

    const epoch = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(epoch) ? 0 : epoch;
}

/** True if `branch`'s tip is an ancestor of `base` (catches real merges and fast-forwards). */
export async function isAncestor(cwd: string, branch: string, base: string): Promise<boolean> {
    return gitOk(cwd, ["merge-base", "--is-ancestor", branch, base]);
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
    const mbRes = await runGit(cwd, ["merge-base", base, branch]);
    if (mbRes.code !== 0) {
        return false;
    }

    const mb = mbRes.stdout.trim();
    if (!mb) {
        return false;
    }

    const countRes = await runGit(cwd, ["rev-list", "--count", `${mb}..${branch}`]);
    if (Number.parseInt(countRes.stdout.trim(), 10) === 0) {
        return false;
    }

    const treeRes = await runGit(cwd, ["rev-parse", `${branch}^{tree}`]);
    if (treeRes.code !== 0) {
        return false;
    }

    const tree = treeRes.stdout.trim();
    const squashRes = await runGit(cwd, ["commit-tree", tree, "-p", mb, "-m", "_"]);
    if (squashRes.code !== 0) {
        return false;
    }

    const squashed = squashRes.stdout.trim();
    const cherryRes = await runGit(cwd, ["cherry", base, squashed]);
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

        if (age > staleDays) {
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

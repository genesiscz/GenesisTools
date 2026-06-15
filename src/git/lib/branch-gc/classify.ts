import { createGit, getCurrentBranch as getCurrentBranchOrNull } from "@app/utils/git";

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

/** Current branch short-name, or "" on detached HEAD. */
export async function getCurrentBranch(cwd: string): Promise<string> {
    return (await getCurrentBranchOrNull(cwd)) ?? "";
}

/** Resolve the base branch for `cwd` (explicit, else local master/main). Throws BaseNotFoundError. */
export async function detectBase(cwd: string, explicit?: string): Promise<string> {
    return await createGit({ cwd }).detectBase(explicit);
}

async function classifyOne(branch: string, opts: ClassifyOptions, gone: Set<string>): Promise<BranchInfo> {
    const { cwd, base, current, nowEpoch, staleDays } = opts;
    const git = createGit({ cwd });

    const [{ ahead, behind }, epoch] = await Promise.all([git.aheadBehind(base, branch), git.lastCommitEpoch(branch)]);
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

        if (await git.isAncestor(name, o.base)) {
            return "merged";
        }

        if (await git.isSquashMerged(o.base, name)) {
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
    const git = createGit({ cwd: opts.cwd });
    const [branches, gone] = await Promise.all([git.listLocalBranchNames(), git.upstreamGoneBranches()]);

    const infos = await Promise.all(branches.map((b) => classifyOne(b, opts, gone)));

    return infos.sort((a, b) => {
        const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
        if (rankDiff !== 0) {
            return rankDiff;
        }

        return b.ageDays - a.ageDays;
    });
}

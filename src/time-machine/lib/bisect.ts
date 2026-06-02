/**
 * Pure bisect core for `tools time-machine`.
 *
 * Given an ordered list of commits (oldest → newest) and an async predicate
 * that reports whether the command PASSES at a given commit, find the FIRST
 * commit that FAILS — i.e. the commit that introduced the failure.
 *
 * The list MUST be monotonic for the binary search to be correct: every
 * commit at or before the transition point passes, every commit at or after
 * it fails. This is the same assumption `git bisect` makes. Real-world
 * histories that flap (pass → fail → pass) violate it; we surface that as a
 * caveat in the CLI but the algorithm still returns a defensible answer.
 */

export type CommitStatus = "pass" | "fail";

export type BisectPredicate = (index: number) => Promise<CommitStatus> | CommitStatus;

export interface BisectResult<T> {
    /**
     * The first failing commit (the one that introduced the failure), or
     * `null` when every commit passes (nothing to blame).
     */
    firstBad: T | null;
    /** Index of `firstBad` in the input list, or -1 when none failed. */
    firstBadIndex: number;
    /**
     * The last passing commit (the green parent of `firstBad`), or `null`
     * when even the oldest commit already fails (the failure predates the
     * searched range — widen with --depth or seed --good).
     */
    lastGood: T | null;
    /** Index of `lastGood`, or -1 when no commit passed. */
    lastGoodIndex: number;
    /** Number of predicate evaluations performed (for reporting / tests). */
    probes: number;
}

/**
 * Binary search for the first failing commit in a monotonic pass→fail list.
 *
 * @param commits Ordered oldest → newest. Index 0 is the oldest / lower bound.
 * @param predicate Resolves "pass"/"fail" for `commits[index]`.
 *
 * Results are cached per index so a probe is never repeated (checkouts are
 * expensive). The returned `probes` count reflects unique evaluations.
 */
export async function findFirstBad<T>(commits: readonly T[], predicate: BisectPredicate): Promise<BisectResult<T>> {
    const cache = new Map<number, CommitStatus>();
    let probes = 0;

    const evaluate = async (index: number): Promise<CommitStatus> => {
        const cached = cache.get(index);
        if (cached !== undefined) {
            return cached;
        }

        const status = await predicate(index);
        cache.set(index, status);
        probes += 1;
        return status;
    };

    const empty: BisectResult<T> = {
        firstBad: null,
        firstBadIndex: -1,
        lastGood: null,
        lastGoodIndex: -1,
        probes: 0,
    };

    if (commits.length === 0) {
        return empty;
    }

    // Classic lower-bound binary search: find the smallest index whose status
    // is "fail". Everything strictly below it is assumed to pass.
    let lo = 0;
    let hi = commits.length; // exclusive; `hi` == length means "no fail found yet".

    while (lo < hi) {
        const mid = lo + Math.floor((hi - lo) / 2);
        const status = await evaluate(mid);

        if (status === "fail") {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }

    const firstBadIndex = lo < commits.length ? lo : -1;

    if (firstBadIndex === -1) {
        // Every probed commit passed — nothing to blame.
        return {
            firstBad: null,
            firstBadIndex: -1,
            lastGood: commits[commits.length - 1] ?? null,
            lastGoodIndex: commits.length - 1,
            probes,
        };
    }

    const lastGoodIndex = firstBadIndex - 1;

    return {
        firstBad: commits[firstBadIndex],
        firstBadIndex,
        lastGood: lastGoodIndex >= 0 ? commits[lastGoodIndex] : null,
        lastGoodIndex,
        probes,
    };
}

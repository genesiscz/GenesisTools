/**
 * Did the turn actually do anything?
 *
 * The harness can only tell "the turn died mid-flight" (no end event) from "the turn
 * ended". A worker that stops cleanly having written nothing looks identical to one
 * that finished the job — observed 2026-09-04: a grok worker ended turn 1 after writing
 * its sweep script but before running it, the harness printed "turn 1 completed" and
 * exited 0, and the empty worktree was only noticed by a separate grader.
 *
 * Comparing the git porcelain state either side of the turn is a cheap, honest signal:
 * it says what changed, and says nothing at all when cwd is not a git repo.
 */

/** Porcelain lines for `cwd`, or null when it is not a git repo (or git is unavailable). */
export const worktreeState = (cwd: string): string[] | null => {
    try {
        const res = Bun.spawnSync({
            cmd: ["git", "status", "--porcelain"],
            cwd,
            stdout: "pipe",
            stderr: "ignore",
        });

        if (res.exitCode !== 0) {
            return null;
        }

        return res.stdout
            .toString()
            .split("\n")
            .filter((line) => line.trim() !== "");
    } catch {
        return null;
    }
};

export interface WorktreeDelta {
    /** Porcelain entries present after the turn that were not present before it. */
    changedThisTurn: number;
    /** Every dirty entry after the turn, including whatever was already dirty. */
    dirtyTotal: number;
}

/** Compare two porcelain snapshots. Null when either side is unknown. */
export const worktreeDelta = (before: string[] | null, after: string[] | null): WorktreeDelta | null => {
    if (before === null || after === null) {
        return null;
    }

    const seen = new Set(before);

    return {
        changedThisTurn: after.filter((line) => !seen.has(line)).length,
        dirtyTotal: after.length,
    };
};

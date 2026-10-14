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
 * it says what changed, and says nothing at all when cwd is not a git repo. A worker that
 * commits its work leaves a clean tree, so the commits HEAD gained count as well (observed
 * 2026-10-14: a probe worker committed, and the report said the turn changed NOTHING).
 */
import { logger } from "@genesiscz/utils/logger";

/** stdout of `git <args>` in `cwd`, or null when it fails (not a repo, no git, a bad ref). */
const gitOutput = (cwd: string, args: string[]): string | null => {
    try {
        const res = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "ignore" });

        return res.exitCode === 0 ? res.stdout.toString() : null;
    } catch (err) {
        logger.debug({ err, cwd, args }, "grok worktree: git did not run");
        return null;
    }
};

/** Porcelain lines for `cwd`, or null when it is not a git repo (or git is unavailable). */
export const worktreeState = (cwd: string): string[] | null => {
    const out = gitOutput(cwd, ["status", "--porcelain"]);

    if (out === null) {
        return null;
    }

    return out.split("\n").filter((line) => line.trim() !== "");
};

/** The commit HEAD points at, or null outside a repo and before its first commit. */
export const worktreeHead = (cwd: string): string | null => {
    const out = gitOutput(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);

    return out?.trim() || null;
};

/** How many commits HEAD gained since `head`, or null when git cannot say. */
export const commitsSince = (cwd: string, head: string): number | null => {
    const count = Number(gitOutput(cwd, ["rev-list", "--count", `${head}..HEAD`])?.trim() ?? Number.NaN);

    return Number.isInteger(count) ? count : null;
};

export interface WorktreeDelta {
    /** Porcelain entries present after the turn that were not present before it. */
    changedThisTurn: number;
    /** Every dirty entry after the turn, including whatever was already dirty. */
    dirtyTotal: number;
    /** Commits HEAD gained during the turn (`commitsSince`); 0 when unknown. */
    commitsThisTurn: number;
}

/** Compare two porcelain snapshots. Null when either side is unknown. */
export const worktreeDelta = (
    before: string[] | null,
    after: string[] | null,
    commitsThisTurn = 0
): WorktreeDelta | null => {
    if (before === null || after === null) {
        return null;
    }

    const seen = new Set(before);

    return {
        changedThisTurn: after.filter((line) => !seen.has(line)).length,
        dirtyTotal: after.length,
        commitsThisTurn,
    };
};

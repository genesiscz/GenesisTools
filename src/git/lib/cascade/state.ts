import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * The plan file lives in the git COMMON dir, so every worktree of the clone
 * sees the same operation. The old git-rebase-multiple wrote
 * `${repoRoot}/.git/…`, which inside a worktree is a file, not a directory.
 */
export const CASCADE_STATE_FILENAME = "genesis-cascade.json";
export const BACKUP_REF_PREFIX = "refs/backup/cascade";
export const BACKUP_TAG_PREFIX = "bkp/cascade";

export type CascadePhase = "planned" | "parent" | "children" | "done";

/** How the parent reaches the target: replay, already upstream, or the human runs the oracle merge. */
export type ParentRoute = "rebase" | "merged" | "oracle";

export interface CascadeChild {
    name: string;
    /** The parent branch, or another child when this one is stacked on it. */
    directParent: string;
    /** merge-base(old tip of directParent, child): the upstream of the `--onto` transplant. */
    forkPoint: string;
    /** Commits the child owns (`forkPoint..child`). */
    commits: number;
    /** Worktree the branch is checked out in, when any; the rebase runs there. */
    worktree: string | null;
}

export interface CascadeBackup {
    ref: string;
    tag: string;
    sha: string;
}

export interface CascadePlan {
    version: 1;
    startedAt: string;
    /** The checkout the command ran in; branches checked out nowhere are rebased here. */
    cwd: string;
    parent: string;
    parentWorktree: string | null;
    target: string;
    /** Target sha at plan time; a moved target is reported by --status. */
    targetSha: string;
    /** Parent tip before anything moved. */
    oldParent: string;
    parentRoute: ParentRoute;
    /** Numbers behind an `oracle` route, for the human. */
    parentEvidence: { touched: number; unmerged: number; cherryPlus: number; conflicts: string[] } | null;
    children: CascadeChild[];
    /** Candidates with parent-only history but no commits of their own (a pointer at an older parent commit); never moved. */
    skipped: { name: string; reason: string }[];
    /** Every branch's tip before the first move, by name. */
    oldTips: Record<string, string>;
    backups: Record<string, CascadeBackup>;
    /** `origin/<branch>` sha at plan time, for the force-with-lease anchors printed at the end. */
    upstreams: Record<string, string | null>;
    phase: CascadePhase;
    /** The branch being rebased, when a conflict left its rebase in progress. */
    current: string | null;
    completed: string[];
    originalBranch: string | null;
}

export function statePath(commonDir: string): string {
    return join(commonDir, CASCADE_STATE_FILENAME);
}

export function loadState(commonDir: string): CascadePlan | null {
    const path = statePath(commonDir);

    if (!existsSync(path)) {
        return null;
    }

    try {
        return SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as CascadePlan;
    } catch (err) {
        logger.warn({ err, path }, "cascade: unreadable plan file");
        return null;
    }
}

export function saveState(commonDir: string, plan: CascadePlan): void {
    writeFileSync(statePath(commonDir), `${SafeJSON.stringify(plan, null, 2)}\n`);
}

export function clearState(commonDir: string): void {
    const path = statePath(commonDir);

    if (existsSync(path)) {
        unlinkSync(path);
    }
}

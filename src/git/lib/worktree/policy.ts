/**
 * Reads the `git.worktrees` section and turns it into the decisions `tools git worktree`
 * needs. Everything here is pure so the command layer can stay a thin door.
 *
 * `init` refuses to run unconfigured on purpose. Guessing a base directory scatters
 * worktrees across the disk, and moving one afterwards means re-pointing its gitdir file,
 * so a wrong default is expensive rather than merely untidy.
 */

import { isAbsolute, join, resolve } from "node:path";
import { type RepoConfig, WORKTREE_BASE_PRESETS, type WorktreeSection } from "@genesiscz/utils/git";

export interface WorktreePolicy {
    /** Absolute directory new worktrees are created in. */
    baseDir: string;
    /** Exactly what was written in the config, so messages can echo it back. */
    baseSetting: string;
    /** Command to run inside a new worktree, or null when the repo opted out. */
    install: string | null;
    plansSync: boolean;
}

export class WorktreeNotConfiguredError extends Error {
    constructor(readonly repoRoot: string) {
        super("`git.worktrees` is not configured for this repository");
        this.name = "WorktreeNotConfiguredError";
    }
}

/** Resolve `base` the way the config documents it: absolute wins, otherwise repo-root relative. */
export function resolveWorktreeBase(base: string, repoRoot: string): string {
    return isAbsolute(base) ? base : resolve(repoRoot, base);
}

/**
 * The policy for this repo, or a refusal. Callers surface the error with the
 * `tools git worktree config` remedy rather than falling back to a default.
 */
export function worktreePolicy(config: RepoConfig, repoRoot: string): WorktreePolicy {
    const section: WorktreeSection | undefined = config.git?.worktrees;
    const base = section?.base;

    if (typeof base !== "string" || base.trim() === "") {
        throw new WorktreeNotConfiguredError(repoRoot);
    }

    return {
        baseDir: resolveWorktreeBase(base.trim(), repoRoot),
        baseSetting: base.trim(),
        install: section?.install?.trim() ? section.install.trim() : null,
        plansSync: section?.plansSync === true,
    };
}

/**
 * What each preset would produce for a concrete branch, so the config prompt can show real
 * paths instead of asking someone to picture them. `.claude/worktrees` is the default because
 * it is where Claude Code puts its own worktrees, and one location beats two.
 */
export function basePresetExamples(
    repoRoot: string,
    sampleBranch = "feat/login"
): Array<{
    value: string;
    label: string;
    example: string;
}> {
    const leaf = worktreeDirName(sampleBranch);

    return WORKTREE_BASE_PRESETS.map((preset) => ({
        value: preset,
        label:
            preset === ".claude/worktrees"
                ? ".claude/worktrees — inside the repo, where Claude Code already puts its own"
                : preset === ".worktrees"
                  ? ".worktrees — inside the repo, separate from Claude Code's"
                  : "../ — beside the repo, as siblings of the checkout",
        example: join(resolveWorktreeBase(preset, repoRoot), leaf),
    }));
}

/** Branch name to directory leaf: slashes would otherwise create nested directories. */
export function worktreeDirName(branch: string): string {
    return branch
        .replace(/^refs\/heads\//, "")
        .replace(/[/\\]/g, "-")
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

// --ignore-worktrees support: figure out which subtrees under the scan root are
// git worktrees (or worktree containers) so they can be pruned from the scan.
//
// Two sources, both relative to the scan root:
//   1. `.worktrees/` and `*.worktrees/` container dirs (immediate children).
//   2. git-registered worktree paths (via the repo's own git helpers) that live
//      under the scan root and aren't the root itself.
//
// This matters because clone-heavy trees are usually clone-heavy *because* of
// worktrees — including them double-counts naive size and muddies the per-dir
// clone table.

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { listWorktrees } from "@genesiscz/utils/git";
import { logger } from "@genesiscz/utils/logger";

function isDir(p: string): boolean {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Return absolute directory paths under `scanRoot` that should be excluded when
 * `--ignore-worktrees` is set.
 */
export async function detectWorktreeExcludes(scanRoot: string): Promise<string[]> {
    const root = resolve(scanRoot);
    const excludes = new Set<string>();

    // 1. Container dirs: .worktrees, *.worktrees among immediate children.
    try {
        for (const name of readdirSync(root)) {
            if (name === ".worktrees" || name.endsWith(".worktrees")) {
                const p = join(root, name);
                if (isDir(p)) {
                    excludes.add(p);
                }
            }
        }
    } catch (err) {
        logger.debug({ root, err }, "du: could not read scan root for worktree containers");
    }

    // 2. git-registered worktrees under the scan root (excluding the root itself).
    try {
        const worktrees = await listWorktrees(root);
        for (const wt of worktrees) {
            const wtPath = resolve(wt.path);
            if (wtPath !== root && wtPath.startsWith(`${root}/`)) {
                excludes.add(wtPath);
            }
        }
    } catch (err) {
        logger.debug({ root, err }, "du: git worktree detection failed (not a git repo?)");
    }

    return [...excludes];
}

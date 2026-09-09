/**
 * Rescues `.claude/plans` from a worktree into the main checkout.
 *
 * The problem this solves: `.claude/plans/` is gitignored, so nothing under it is tracked,
 * and `git worktree remove` deletes the directory without warning. Git offers no
 * worktree-removal hook, so there is no "last chance" moment to hook into. Copying forward
 * on every commit is the only point git reliably gives us.
 *
 * Copies never overwrite. A plan already in the main checkout is the authority, because the
 * worktree copy may be a stale duplicate seeded when the worktree was created.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface PlansSyncResult {
    copied: string[];
    skipped: number;
    from: string;
    to: string;
}

function walkFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);

        if (entry.isSymbolicLink()) {
            continue;
        }

        if (entry.isDirectory()) {
            walkFiles(full, out);
            continue;
        }

        out.push(full);
    }

    return out;
}

/**
 * Copy every plan file that the main checkout does not already have.
 * Returns the relative paths copied so the caller can report them.
 */
export function syncPlansToMain(options: { worktreeRoot: string; repoRoot: string }): PlansSyncResult {
    const from = join(options.worktreeRoot, ".claude", "plans");
    const to = join(options.repoRoot, ".claude", "plans");
    const result: PlansSyncResult = { copied: [], skipped: 0, from, to };

    if (options.worktreeRoot === options.repoRoot || !existsSync(from) || !statSync(from).isDirectory()) {
        return result;
    }

    for (const file of walkFiles(from)) {
        const rel = relative(from, file);
        const target = join(to, rel);

        if (existsSync(target)) {
            result.skipped++;
            continue;
        }

        mkdirSync(join(target, ".."), { recursive: true });
        copyFileSync(file, target);
        result.copied.push(rel);
    }

    return result;
}

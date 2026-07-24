import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * Dependency-tree health checks for the `bun test` wrapper (`scripts/test.ts`).
 *
 * Split out from the runner so the decision logic is testable without spawning
 * installs or test runs — everything here is pure apart from `stat`.
 */

/**
 * Packages that must resolve for the suite to run at all. Deliberately a
 * hand-picked spread — a types package, a leaf dep, a transitive-heavy one and
 * the workspace link — rather than the whole dependency list, which would cost
 * more to check than it saves.
 */
export const CANARY_PACKAGES = ["bun-types", "picocolors", "commander", "@clack/prompts", "parse5", "@genesiscz/utils"];

export const STAMP_FILE = ".genesis-install-stamp";

function statOrNull(path: string): ReturnType<typeof statSync> | null {
    try {
        return statSync(path);
    } catch {
        // Missing is the normal answer here, not an error worth logging.
        return null;
    }
}

/**
 * Lockfile identity without reading it: any install rewrites size or mtime, so
 * this is one `stat` instead of hashing a megabyte on every test run.
 */
export function lockStamp(root: string): string {
    for (const name of ["bun.lock", "bun.lockb", "package-lock.json"]) {
        const stat = statOrNull(join(root, name));

        if (stat) {
            return `${name}:${stat.size}:${Math.round(stat.mtimeMs)}`;
        }
    }

    return "no-lockfile";
}

export function missingCanaries(root: string, canaries: readonly string[] = CANARY_PACKAGES): string[] {
    const nodeModules = join(root, "node_modules");

    return canaries.filter((pkg) => statOrNull(join(nodeModules, pkg)) === null);
}

/**
 * Why the dependency tree is unusable, or null when it looks healthy.
 *
 * The case this exists for: inside a git worktree, any `bunx` call creates a
 * PARTIAL `node_modules/` that shadows the parent checkout's complete one. Every
 * later `bun test` then dies with resolution errors like
 * `Cannot find module 'parse5/lib/common/doctype'` across a hundred unrelated
 * files, which reads exactly like the branch broke the world.
 */
export function diagnose(root: string, canaries: readonly string[] = CANARY_PACKAGES): string | null {
    if (statOrNull(join(root, "node_modules")) === null) {
        return "node_modules is missing";
    }

    const missing = missingCanaries(root, canaries);

    if (missing.length > 0) {
        return `node_modules is incomplete (missing ${missing.join(", ")})`;
    }

    return null;
}

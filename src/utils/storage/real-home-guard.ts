import { realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";

/**
 * Refuse, during `bun test`, to write anywhere under the user's REAL
 * `~/.genesis-tools`.
 *
 * This has now destroyed real user data twice. PR #177: a leaked mock emptied
 * `~/.genesis-tools/mcp-manager/config.json`. 2026-08-29: a full-suite run reset
 * `~/.genesis-tools/ai/config.json` to an empty default, losing every account
 * entry (the vault survived, so nothing was unrecoverable, but the metadata had
 * to be rebuilt by hand).
 *
 * The mechanism both times: `Storage` resolves its base directory ONCE, in the
 * constructor. A cached instance or a module-level singleton built while a
 * sandbox `GENESIS_TOOLS_HOME` was set outlives the `afterEach` that restores the
 * real home, and its next write lands on the real path. `AIConfig` is exactly
 * this shape: a process-wide singleton with an `invalidate()` that no test calls.
 *
 * `test-sandbox.ts` already guards this, but only for test files that opt in, and
 * neither incident was in a file that had. So this check is ALWAYS ON under
 * `NODE_ENV=test` (which `bun test` sets), and it is checked at WRITE time
 * against the resolved path rather than at construction time — the whole failure
 * is that the path was resolved too early.
 *
 * Production is unaffected: the first line returns immediately when NODE_ENV is
 * not "test".
 */

/** Deliberate opt-out for a test that genuinely must touch the real home. */
const ESCAPE_HATCH = "GENESIS_TOOLS_ALLOW_REAL_HOME_IN_TESTS";

/**
 * A real path-boundary check, NOT a string prefix: a prefix test would wrongly
 * accept "/tmp/sbX-evil" for root "/tmp/sbX".
 */
export function isInside(root: string, target: string): boolean {
    const rel = relative(root, target);

    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The real store, ignoring any `GENESIS_TOOLS_HOME` override. */
export function realGenesisToolsRoot(): string {
    // lint-rules-ignore: this function's whole contract is to bypass the override — it is what the guard compares against
    return join(homedir(), ".genesis-tools");
}

export function isTestProcess(): boolean {
    return env.get("NODE_ENV") === "test";
}

/**
 * Resolve symlinks as far up as the path really exists, then re-attach the
 * components that do not exist yet. Also makes a relative path absolute: a bare
 * "config.json" while the cwd is inside the real store used to slip through the
 * guard entirely (PR #343 review t22).
 *
 * Resolving only the target's immediate parent was not enough (review t20). For
 * "/tmp/link/new/config.json", where "link" points into the real store and "new"
 * does not exist yet, realpathSync("/tmp/link/new") throws, the lexical fallback
 * kept "link" unresolved, and the guard passed — after which the recursive mkdir
 * followed the link and wrote into the real store anyway.
 */
function canonical(path: string): string {
    const absolute = resolve(path);
    const missing: string[] = [];
    let current = absolute;

    for (;;) {
        try {
            const existing = realpathSync(current);
            return missing.length > 0 ? join(existing, ...missing) : existing;
        } catch {
            const parent = dirname(current);

            if (parent === current) {
                return absolute;
            }

            missing.unshift(basename(current));
            current = parent;
        }
    }
}

/**
 * Throw if `targetPath` is inside the real store while running under test.
 *
 * Reads are deliberately NOT guarded: a test reading the user's real config is
 * merely impure, while a write is data loss.
 */
export function assertTestSafePath(targetPath: string, operation: string): void {
    if (!isTestProcess()) {
        return;
    }

    if (env.getTrimmed(ESCAPE_HATCH)) {
        return;
    }

    if (!isInside(canonical(realGenesisToolsRoot()), canonical(targetPath))) {
        return;
    }

    throw new Error(
        `Refusing to ${operation} "${targetPath}" from a test: that is the REAL ~/.genesis-tools, not a sandbox.\n` +
            `A Storage instance or a cached singleton (AIConfig, AiConfigStore) resolved its path before the test\n` +
            `sandbox was installed, or outlived the teardown that removed it.\n` +
            `Fix the test: set GENESIS_TOOLS_HOME to a mkdtemp dir BEFORE the module under test is imported, and\n` +
            `invalidate any singleton in afterEach. See utils/storage/test-sandbox.ts.\n` +
            `If this write is genuinely intended, set ${ESCAPE_HATCH}=1.`
    );
}

/**
 * Delete a path only after proving it is not inside the real store.
 *
 * `rmSync` is a raw `node:fs` call, so `assertTestSafePath` never sees it. A test
 * that resolves its target from `env.tools.getHome()` deletes the developer's own
 * config the moment the sandbox preload is missing or late.
 *
 * A separate `it(...)` asserting the sandbox is in place does NOT cover this:
 * `beforeEach` runs before every test in the describe, including that assertion,
 * so the delete happens first and the guard fails only after the data is gone
 * (verified 2026-08-29). The check has to sit immediately before the delete.
 */
export function rmTestPath(targetPath: string): void {
    if (isInside(canonical(realGenesisToolsRoot()), canonical(targetPath))) {
        throw new Error(
            `Refusing to delete "${targetPath}" from a test: that is the REAL ~/.genesis-tools, not a sandbox.\n` +
                `The GENESIS_TOOLS_HOME sandbox preload did not take effect. See utils/bun/preload-test-sandbox.ts.`
        );
    }

    rmSync(targetPath, { force: true });
}

import { execFileSync } from "node:child_process";
import { env } from "@genesiscz/utils/env";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { logger } from "@genesiscz/utils/logger";
import { sandboxInstalled } from "@genesiscz/utils/storage/real-home-guard";
import { testProcessReason } from "@genesiscz/utils/test-process";

/**
 * May this process write a migrated config shape into the user's REAL `~/.genesis-tools`?
 *
 * `tools` on PATH runs the main checkout. When a build from a linked worktree migrates a shared
 * config to a newer shape, every main-checkout run then reads a file it does not understand. That
 * happened on 2026-07-29 from a single `bun run tools ai --help` in a worktree, which left a hybrid
 * AI config behind. So every loader that writes a migrated shape back asks this first, and keeps the
 * migrated shape in memory when the answer is no.
 *
 * The answer, in order:
 *  1. A sandbox home (`GENESIS_TOOLS_HOME` pointing elsewhere) is never the real home: allowed.
 *  2. A test process never writes the real home: refused.
 *  3. `GENESIS_TOOLS_ALLOW_REAL_MIGRATION=1` is the deliberate post-merge run: allowed.
 *  4. Code that runs from a linked worktree: refused. Git answers this for the checkout that holds
 *     THIS module, not for the cwd: agent shells reset the cwd, daemons run from `/`, and
 *     `bun /abs/worktree/src/...` from $HOME has an innocent cwd. In a linked worktree
 *     `git rev-parse --git-dir` (`<common>/worktrees/<name>`) differs from `--git-common-dir`.
 *     The path markers this replaced (`/.worktrees/`, `/.claude/worktrees/`) missed 6 of the 7
 *     worktrees on this Mac (`/tmp/cc/.../worktrees/*`, `~/.t3/worktrees/*`).
 *  5. Otherwise allowed, also when git is missing or the code is not in a checkout (an install
 *     from a package has no worktree to fear).
 *
 * One git spawn per process at most, and only when steps 1 to 3 did not answer, which means only
 * on the rare path where a real-home write is about to happen.
 */
export interface PersistVerdict {
    allowed: boolean;
    reason: string;
}

interface TestOverrides {
    /** Pretend this module lives in `codeDir` (a checkout the test built). */
    codeDir?: string;
    /** Replace the test-process signal, which inside `bun test` is always on. */
    testProcess?: boolean;
    /** Replace the sandbox signal, which the test preload always turns on. */
    sandbox?: boolean;
}

let overrides: TestOverrides = {};
/** The checkout verdict, per code folder. The folder only changes under a test override. */
const checkoutVerdicts = new Map<string, PersistVerdict>();

export function mayPersistMigration(): PersistVerdict {
    if (overrides.sandbox ?? sandboxInstalled()) {
        return { allowed: true, reason: `the home is a sandbox (${env.tools.getHome()})` };
    }

    const testReason =
        overrides.testProcess === undefined ? testProcessReason() : overrides.testProcess ? "test override" : null;

    if (testReason) {
        return { allowed: false, reason: `a test process never writes the real home (${testReason})` };
    }

    if (env.tools.allowsRealMigration()) {
        return { allowed: true, reason: "GENESIS_TOOLS_ALLOW_REAL_MIGRATION=1" };
    }

    const codeDir = overrides.codeDir ?? moduleDir(import.meta);
    let verdict = checkoutVerdicts.get(codeDir);

    if (!verdict) {
        verdict = checkoutVerdict(codeDir);
        checkoutVerdicts.set(codeDir, verdict);
        logger.debug({ codeDir, ...verdict }, "real-home write check: the checkout verdict");
    }

    return verdict;
}

function checkoutVerdict(codeDir: string): PersistVerdict {
    let lines: string[];

    try {
        lines = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], {
            cwd: codeDir,
            encoding: "utf-8",
            timeout: 2000,
            stdio: ["ignore", "pipe", "pipe"],
            env: gitEnvFor(),
        })
            .trim()
            .split("\n");
    } catch (err) {
        logger.debug({ err, codeDir }, "real-home write check: git did not answer, so this is not a checkout");
        return { allowed: true, reason: `the code is not in a git checkout, or git is missing (${codeDir})` };
    }

    const [gitDir, commonDir] = lines;

    if (!gitDir || !commonDir) {
        return { allowed: true, reason: `git gave no git dir for ${codeDir}` };
    }

    if (gitDir !== commonDir) {
        return {
            allowed: false,
            reason:
                `the code runs from a linked worktree (git dir ${gitDir}, common dir ${commonDir}); ` +
                "the installed tools share the real home. Set GENESIS_TOOLS_HOME to a sandbox, " +
                "or GENESIS_TOOLS_ALLOW_REAL_MIGRATION=1 for the deliberate post-merge run",
        };
    }

    return { allowed: true, reason: `the code runs from a main checkout (${gitDir})` };
}

/**
 * The parent's environment without the variables that point git at another repository. Inside a git
 * hook `GIT_DIR` is set, and git would answer for that repository instead of the one holding the code.
 */
function gitEnvFor(): Record<string, string | undefined> {
    const result = { ...env.getProcessEnv() };

    for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
        delete result[key];
    }

    return result;
}

/** Test seam: replace the signals the check reads. Pass undefined to restore the real ones. */
export function _overrideRealHomeWriteForTest(next: TestOverrides | undefined): void {
    overrides = next ?? {};
    checkoutVerdicts.clear();
}

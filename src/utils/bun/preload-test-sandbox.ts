import { afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";

/**
 * Force every test process to use a throwaway `~/.genesis-tools` root.
 *
 * `Storage` resolves its root from `GENESIS_TOOLS_HOME || homedir()`, so any test
 * that touches config, caches or databases without setting that variable writes
 * to the user's REAL data. That is not theoretical: the AIConfig suite persisted
 * a `test-app` block into the live `ai/config.json` on every run until 2026-07-29.
 *
 * Per-file discipline does not hold, because the next test written without the
 * override silently reintroduces the bug. Setting it here means the sandbox is
 * the default and an author has to opt OUT deliberately.
 *
 * Loaded from bunfig.toml's `[test] preload`, so it runs before any test module
 * is imported and before any `Storage` instance can capture the root.
 *
 * Escape hatches:
 *  - Set `GENESIS_TOOLS_HOME` yourself (a test wanting a specific fixture root).
 *  - Set `GENESIS_TOOLS_TEST_ALLOW_REAL_HOME=1` for a test that must exercise the
 *    real user directory. Nothing in the suite should need this.
 *
 * Installing the sandbox once is NOT enough, which is what 2026-08-29 proved: a
 * full-suite run reset the live `ai/config.json` to an empty default. Four test
 * files call `env.testing.unset("GENESIS_TOOLS_HOME")` in their teardown, and any
 * one of them leaves the process pointing at the REAL home for every test that
 * follows. Worse, `AIConfig` is a process-wide singleton that captured its path
 * when it was first loaded, so it can keep writing the real file long after the
 * env is fixed. So the sandbox is also RE-ASSERTED after every test, and the
 * cached config singletons are dropped whenever it had drifted.
 */
function installSandbox(): void {
    if (env.test.allowsRealHome()) {
        return;
    }

    if (env.tools.hasExplicitHome()) {
        return;
    }

    // `env.testing.set` writes straight through to `process.env`, which is what
    // this needs: `Storage` reads the facade, but so do third-party consumers of
    // the raw variable, and the sandbox has to be visible to both.
    const sandboxRoot = mkdtempSync(join(tmpdir(), "gt-test-home-"));
    env.testing.set("GENESIS_TOOLS_HOME", sandboxRoot);
    guardSandbox(sandboxRoot);
}

/**
 * Drop config singletons that may be holding a path resolved under a different
 * root. Dynamic + best-effort on purpose: a preload must never be the reason a
 * suite fails to start.
 */
async function invalidateConfigSingletons(): Promise<void> {
    try {
        const { AIConfig } = await import("@genesiscz/utils/ai/AIConfig");
        AIConfig.invalidate();
    } catch {
        // The module is not part of every test binary's graph; nothing to drop.
    }
}

/**
 * Keep the variable from ever being ABSENT during a test run.
 *
 * The invariant is deliberately narrow: unset means `Storage` falls back to
 * `homedir()` and writes the user's real store, which is the whole failure. A
 * DIFFERENT value is fine and must be left alone — `setupStorageSandbox()` and
 * several suites install their own fixture root on purpose, and forcing them
 * back to this one breaks them (50 tests, measured).
 */
function guardSandbox(sandboxRoot: string): void {
    afterEach(async () => {
        if (env.getTrimmed("GENESIS_TOOLS_HOME")) {
            return;
        }

        env.testing.set("GENESIS_TOOLS_HOME", sandboxRoot);
        // A singleton may already be holding a path resolved while the variable
        // was missing, so dropping it is part of restoring the invariant.
        // Awaited, not fire-and-forget: bun can start the next test before the
        // invalidation runs, and that test would write through the cached
        // real-home path (PR #343 review t27).
        await invalidateConfigSingletons();
    });
}

installSandbox();

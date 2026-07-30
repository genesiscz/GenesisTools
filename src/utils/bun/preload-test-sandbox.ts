import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 */
function installSandbox(): void {
    if (process.env.GENESIS_TOOLS_TEST_ALLOW_REAL_HOME === "1") {
        return;
    }

    if (process.env.GENESIS_TOOLS_HOME) {
        return;
    }

    process.env.GENESIS_TOOLS_HOME = mkdtempSync(join(tmpdir(), "gt-test-home-"));
}

installSandbox();

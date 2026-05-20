import { mock } from "bun:test";
import * as cliUtils from "@app/utils/cli";
import type { PromptBackend } from "@app/utils/prompts/p";
import { setBackend } from "@app/utils/prompts/p";

/**
 * Shared test helpers for prompt-using code paths.
 *
 * Why this exists
 * ---------------
 * Tests that exercise commands which interactively prompt the user need two
 * things: (a) prompt calls return pre-canned answers, (b) `isInteractive()`
 * returns true so the command's TTY-gated branches actually run.
 *
 * The HISTORICAL pattern (per-tool `inquirer-mock.ts` files using
 * `mock.module("@app/utils/prompts/p", () => ({...}))`) works but suffers
 * cross-file pollution under bun:test's worker-pool reuse — a mock.module
 * call in one test file leaks into another. The setBackend approach below
 * is per-process state we explicitly own, with no module-cache effects.
 *
 * Use it like this
 * ----------------
 *
 *   // top of your test file
 *   import { installPromptMock } from "@app/utils/testing/prompt-mock";
 *   import { makeTestBackend } from "@app/utils/prompts/p/__tests__/test-backend";
 *
 *   installPromptMock(makeTestBackend({ text: "answer", confirm: true }));
 *
 *   // For dynamic per-test responses, build a custom PromptBackend that
 *   // dispatches on YOUR test's response-key conventions (see the
 *   // mcp-manager `inquirer-mock.ts` for an example). Pass it to
 *   // installPromptMock the same way.
 */

/**
 * Install a fake PromptBackend + stub `isInteractive()` to true.
 *
 * Call this ONCE at the top of a test file, BEFORE importing any module
 * that uses prompts at module-eval time. Calling again with a different
 * backend swaps the active backend without re-running the isInteractive
 * mock setup (idempotent on that side).
 */
export function installPromptMock(backend: PromptBackend): void {
    // Re-export the real @app/utils/cli surface so suggestCommand/Executor/etc.
    // keep working; only isInteractive is stubbed. Idempotent — bun's
    // mock.module replaces any prior mock for the same specifier.
    mock.module("@app/utils/cli", () => ({
        ...cliUtils,
        isInteractive: () => true,
    }));

    setBackend(backend);
}

/**
 * Replace the active backend mid-test. Useful for `beforeEach` blocks that
 * want fresh response state, or for individual tests that need different
 * answers than the file-level default.
 */
export function setPromptBackend(backend: PromptBackend): void {
    setBackend(backend);
}

/**
 * Test-only preload: neutralizes real `process.exit()` calls.
 *
 * `bun test` runs every test file in ONE shared process. Application code
 * that calls `process.exit(n)` on an error path (e.g. CLI commands in
 * non-interactive mode) therefore terminates the WHOLE test run mid-stream —
 * every file after the offending one never executes.
 *
 * The industry-standard fix (Jest/Vitest/Node `--test` all do this) is to
 * replace `process.exit` in a test setup file with a function that THROWS
 * instead of exiting: the runner stays alive, the call becomes a normal
 * catchable test failure, and execution continues to the next file.
 *
 * Wired ONLY into bunfig.toml `[test].preload` — never the top-level
 * `preload` — so production `tools` invocations keep the real
 * `process.exit` and still exit with the original code/output.
 */

export class ProcessExitError extends Error {
    readonly code: number;

    constructor(code: number) {
        super(`process.exit(${code}) called during a test (intercepted by preload-test-process-exit)`);
        this.name = "ProcessExitError";
        this.code = code;
    }
}

// Command code legitimately sets `process.exitCode = 1` on error paths. Under
// `bun test` (one shared process) that lingering value makes the whole run
// exit non-zero even with 0 failures — a false red. bun derives its own exit
// from pass/fail, so reset the side effect after every test, globally.
import { afterEach } from "bun:test";

afterEach(() => {
    process.exitCode = 0;
});

const realExit = process.exit;

function throwingExit(code?: number | string | null): never {
    throw new ProcessExitError(typeof code === "number" ? code : 0);
}

process.exit = throwingExit as typeof process.exit;

(globalThis as typeof globalThis & { __realProcessExit?: typeof realExit }).__realProcessExit = realExit;

import { env } from "@genesiscz/utils/env";

/**
 * Set by the `[test] preload` entries in `bunfig.toml`, which bun applies to `bun test` and to
 * nothing else. It is the only signal that survives into a subprocess a test spawns.
 */
export const TEST_RUNTIME_FLAG = "GENESIS_TOOLS_TEST_RUNTIME";

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Why this process looks like a test, or `null` when it does not.
 *
 * 🛑 Three independent signals, because any ONE of them has a hole and the things that depend on
 * this answer are data-loss guards. Measured 2026-09-22: `NODE_ENV` alone is not enough.
 * `bun test` sets it to "test" only when it is not ALREADY set (oven-sh/bun#4118, closed as
 * working-as-intended), so a parent process that exports `NODE_ENV=development` — a shell, a CI
 * job, an agent harness — silently turns every NODE_ENV-gated guard in this repo off. That is
 * not hypothetical: the Claude Code process on this machine carried exactly that value, and a
 * full test run wrote into the real `~/.genesis-tools`.
 *
 * The signals and what each one covers:
 *  - `NODE_ENV=test`: the classic case, and what `scripts/test.ts` forces for its children.
 *  - `Bun.main` naming a `.test.`/`.spec.` file: the runner's entrypoint IS the test file, and
 *    bun refuses to collect files without that infix, so this holds even when NODE_ENV is
 *    polluted. It cannot see a subprocess, whose entrypoint is its own script.
 *  - `GENESIS_TOOLS_TEST_RUNTIME`: set by the bunfig test preload and inherited by every child,
 *    which is exactly the case the other two miss.
 *
 * A false positive fails SAFE everywhere this is used: `bun run foo.test.ts` gets the sandboxed
 * keychain item and a guarded write, which is inconvenient and never destructive.
 */
export function testProcessReason(entrypoint: string = globalThis.Bun?.main ?? ""): string | null {
    if (env.get("NODE_ENV") === "test") {
        return "NODE_ENV=test";
    }

    if (TEST_FILE.test(entrypoint)) {
        return "Bun.main is a test file";
    }

    if (env.isFlag(TEST_RUNTIME_FLAG)) {
        return `${TEST_RUNTIME_FLAG}=1 from the bun test preload`;
    }

    return null;
}

export function isTestProcess(entrypoint?: string): boolean {
    return testProcessReason(entrypoint) !== null;
}

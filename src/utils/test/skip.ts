/**
 * Centralized test skip gates.
 *
 * Instead of hand-rolling `describe.skipIf(process.platform === "win32" || …)`
 * in every file, import a named gate here and pass it straight to bun's
 * `describe.skipIf(...)` / `it.skipIf(...)` (they take a boolean).
 *
 *   import { skip } from "@app/utils/test/skip";
 *
 *   describe.skipIf(skip.unlessMac)("Apple Mail indexer", () => { … });
 *   describe.skipIf(skip.network)("live crawl", () => { … });
 *   it.skipIf(skip.onWindows)("uses a POSIX path", () => { … });
 *
 * Platform gates evaluate immediately. "Opt-in" gates default to SKIPPED and
 * only run when their env flag is set, e.g.:
 *
 *   RUN_NETWORK_TESTS=1 bun test         # network suites
 *   RUN_NOTIFY_E2E=1 bun test            # real macOS-notification e2e
 *   RUN_E2E=1 bun test                   # heavier end-to-end suites
 *   RUN_WIP_E2E=1 bun test               # tests for in-progress features
 *
 * Env-var names intentionally reuse the conventions already in the repo
 * (RUN_NETWORK_TESTS, RUN_LIVE, …) so existing CI/local muscle memory holds.
 */

const env = process.env;

function flag(name: string): boolean {
    const v = env[name];
    return v != null && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";
export const isLinux = process.platform === "linux";
export const isCI = flag("CI");
export const isInteractiveTTY = !!process.stdin.isTTY;

/** Opt-in switches (false unless the matching env var is set). */
export const optIn = {
    network: flag("RUN_NETWORK_TESTS"),
    live: flag("RUN_LIVE"),
    liveSmoke: flag("RUN_LIVE_SMOKE"),
    e2e: flag("RUN_E2E"),
    notifyE2E: flag("RUN_NOTIFY_E2E"),
    /** Tests for features still being built (won't pass on a clean tree yet). */
    wip: flag("RUN_WIP_E2E"),
} as const;

/**
 * Booleans to hand directly to `describe.skipIf` / `it.skipIf`.
 * Read each name as "skip when …".
 */
export const skip = {
    /** Skip on Windows (POSIX-only behaviour: shell quoting, path seps, …). */
    onWindows: isWindows,
    /** Skip on Linux. */
    onLinux: isLinux,
    /** Skip unless running on macOS (darwinkit, Apple Mail/Notes, osascript). */
    unlessMac: !isMac,
    /** Skip unless an interactive TTY is attached. */
    unlessInteractive: !isInteractiveTTY,
    /** Skip in CI. */
    inCI: isCI,
    /** Skip unless RUN_NETWORK_TESTS is set. */
    network: !optIn.network,
    /** Skip unless RUN_LIVE is set. */
    live: !optIn.live,
    /** Skip unless RUN_LIVE_SMOKE is set. */
    liveSmoke: !optIn.liveSmoke,
    /** Skip unless RUN_E2E is set. */
    e2e: !optIn.e2e,
    /** Skip unless RUN_NOTIFY_E2E is set (fires real OS notifications). */
    notifyE2E: !optIn.notifyE2E,
    /** Skip unless RUN_WIP_E2E is set (feature under construction). */
    wip: !optIn.wip,
} as const;

/** Compose gates: skip if ANY condition is true. */
export function skipIfAny(...conditions: boolean[]): boolean {
    return conditions.some(Boolean);
}

/** Back-compat alias for the originally-proposed helper name. */
export function shouldSkipOnWindows(): boolean {
    return isWindows;
}

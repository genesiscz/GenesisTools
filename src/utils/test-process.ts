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
    return testProcessSignals(entrypoint)[0] ?? null;
}

export function isTestProcess(entrypoint?: string): boolean {
    return testProcessReason(entrypoint) !== null;
}

/** Every test signal this process carries, in the order {@link testProcessReason} checks them. */
export function testProcessSignals(entrypoint: string = globalThis.Bun?.main ?? ""): string[] {
    const signals: string[] = [];

    if (env.get("NODE_ENV") === "test") {
        signals.push("NODE_ENV=test");
    }

    if (TEST_FILE.test(entrypoint)) {
        signals.push("Bun.main is a test file");
    }

    if (env.isFlag(TEST_RUNTIME_FLAG)) {
        signals.push(`${TEST_RUNTIME_FLAG}=1 from the bun test preload`);
    }

    return signals;
}

/** The opt-out of {@link hostEffectRefusal}, for a deliberate end-to-end check against the real machine. */
export const RUN_HOST_EFFECTS_FLAG = "RUN_HOST_EFFECTS";

/**
 * Why a host effect (a browser tab, a System Settings pane, a dialog, a banner, a message, the app RPC) must not run
 * here, or `null` when it may. The surface calls this at its own entry, so a `tools` child that a test spawns, which
 * runs outside the test preload, is refused too.
 *
 * 🛑 It needs TWO of the three signals, where the data-loss guards above need one. A refusal here breaks a real
 * feature, and a lone `GENESIS_TOOLS_TEST_RUNTIME=1` reached the user's tmux server twice (2026-09-14, 2026-10-15),
 * so one signal would have made every terminal of that server refuse to open a URL. A test process carries all three;
 * a child it spawns carries the flag and `NODE_ENV=test` (`scripts/test.ts` forces it, `bun test` sets it).
 *
 * The message names the surface, the signals and the remedy.
 */
export function hostEffectRefusal(
    surface: string,
    remedy: string,
    entrypoint: string = globalThis.Bun?.main ?? ""
): string | null {
    if (env.isFlag(RUN_HOST_EFFECTS_FLAG)) {
        return null;
    }

    const signals = testProcessSignals(entrypoint);

    if (signals.length < 2) {
        return null;
    }

    return (
        `${surface} is refused in a test process (${signals.join(", ")}): it reaches the machine the user is sitting at. ` +
        `${remedy} Set ${RUN_HOST_EFFECTS_FLAG}=1 only for a deliberate end-to-end check against the real machine.`
    );
}

/** Throws the {@link hostEffectRefusal} message when the surface must not run here. */
export function refuseHostEffectInTest(surface: string, remedy: string): void {
    const refusal = hostEffectRefusal(surface, remedy);

    if (refusal) {
        throw new Error(refusal);
    }
}

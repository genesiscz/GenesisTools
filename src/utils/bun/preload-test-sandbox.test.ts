import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { env } from "@genesiscz/utils/env";
import { Storage } from "@genesiscz/utils/storage/storage";

/**
 * Guards the sandbox itself. If this fails, tests are writing to the user's real
 * ~/.genesis-tools and the preload is either missing from bunfig.toml or loading
 * too late.
 *
 * The preload cannot be imported here — it is a `[test] preload`, it runs before
 * any test module loads, and importing it again would install a second sandbox.
 * So these assert the INVARIANTS it maintains, from inside a process it has
 * already configured.
 */
describe("test sandbox preload", () => {
    test("GENESIS_TOOLS_HOME is set to a throwaway root", () => {
        const root = process.env.GENESIS_TOOLS_HOME;

        expect(root).toBeTruthy();
        expect(root).not.toBe(homedir());
    });

    test("Storage resolves outside the real home directory", () => {
        const base = new Storage("sandbox-probe").getBaseDir();

        // lint-rules-ignore: asserts against the REAL home on purpose — the whole point is that the sandbox is elsewhere
        expect(base.startsWith(`${homedir()}/.genesis-tools`)).toBe(false);
        expect(base).toContain(".genesis-tools/sandbox-probe");
    });

    // The next two run in order and are a PAIR (PR #343 review t22). Four suites
    // call `env.testing.unset("GENESIS_TOOLS_HOME")` in their own teardown, and
    // on 2026-08-29 that left the whole rest of the run pointing at the real
    // home. The preload's afterEach re-asserts the variable between tests; the
    // two tests above cannot see that, because neither ever clears it. This is
    // what pins the repair (commit 64bbad780, previously untested).
    test("a test may clear the variable within its own body", () => {
        env.testing.unset("GENESIS_TOOLS_HOME");

        expect(env.getTrimmed("GENESIS_TOOLS_HOME")).toBeUndefined();
    });

    test("and it is repaired before the following test runs", () => {
        const root = env.getTrimmed("GENESIS_TOOLS_HOME");

        expect(root).toBeTruthy();
        // lint-rules-ignore: asserts against the REAL home on purpose — the repair must not restore it to the real store
        expect(root).not.toBe(homedir());
        expect(new Storage("sandbox-probe").getBaseDir()).toContain(".genesis-tools/sandbox-probe");
    });
});

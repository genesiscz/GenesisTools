import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { configCandidates, resolveActiveVault } from "@genesiscz/utils/obsidian/discovery";
import { Storage } from "@genesiscz/utils/storage/storage";

test("a startup Obsidian override survives fixture cleanup between tests", () => {
    const fixture = mkdtempSync(join(tmpdir(), "obsidian-startup-config-"));
    // Run the paired assertions below in a fresh process so the override precedes the preload.
    // The name filter excludes this launcher to avoid recursively spawning the suite.
    const result = Bun.spawnSync(
        [
            process.execPath,
            "scripts/test.ts",
            import.meta.path,
            "--test-name-pattern",
            "^Obsidian sandbox between tests",
        ],
        {
            cwd: join(import.meta.dir, "../../.."),
            env: {
                ...env.getProcessEnv(),
                OBSIDIAN_CONFIG_DIR: fixture,
                GENESIS_TOOLS_TEST_ALLOW_REAL_HOME: "0",
            },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 30_000,
        }
    );
    const output = result.stdout.toString() + result.stderr.toString();

    expect(result.exitCode, output).toBe(0);
    // Some tests ran and none failed; an exact count would break whenever a sibling test is added.
    expect(output).toMatch(/\b[1-9]\d* pass\b/);
    expect(output).toMatch(/\b0 fail\b/);
    expect(output).toContain("[test] suite complete (exit 0)");
}, 40_000);

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

describe("Obsidian sandbox between tests", () => {
    const sandbox = env.getTrimmed("OBSIDIAN_CONFIG_DIR");
    const home = mkdtempSync(join(tmpdir(), "obsidian-preload-home-"));
    const vault = join(home, "fixture-vault");
    const config = configCandidates({ HOME: home })[0];
    mkdirSync(vault);
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, SafeJSON.stringify({ vaults: { fixture: { path: vault, ts: 1, open: true } } }));
    const discover = () =>
        resolveActiveVault({ HOME: home, OBSIDIAN_CONFIG_DIR: env.getTrimmed("OBSIDIAN_CONFIG_DIR") });

    test("the real preload blocks a fake platform vault by default", () => {
        expect(sandbox).toBeTruthy();
        expect(resolveActiveVault({ HOME: home })).toBe(vault);
        expect(discover()).toBeNull();
    });

    // Each mutation and its assertion run in separate tests so the real preload's afterEach runs between them.
    for (const cleared of [undefined, "", " \t "]) {
        test(`fixture cleanup may clear the override to ${SafeJSON.stringify(cleared)}`, () => {
            if (cleared === undefined) {
                env.testing.unset("OBSIDIAN_CONFIG_DIR");
            } else {
                env.testing.set("OBSIDIAN_CONFIG_DIR", cleared);
            }

            expect(env.getTrimmed("OBSIDIAN_CONFIG_DIR")).toBeUndefined();
        });

        test(`the next test is isolated after clearing to ${SafeJSON.stringify(cleared)}`, () => {
            expect(env.getTrimmed("OBSIDIAN_CONFIG_DIR")).toBe(sandbox);
            expect(discover()).toBeNull();
        });
    }

    test("a test may select a nonempty fixture override", () => {
        env.testing.set("OBSIDIAN_CONFIG_DIR", dirname(config));
        expect(discover()).toBe(vault);
    });

    test("the next test retains the nonempty fixture override", () => {
        try {
            expect(env.getTrimmed("OBSIDIAN_CONFIG_DIR")).toBe(dirname(config));
            expect(discover()).toBe(vault);
        } finally {
            env.testing.unset("OBSIDIAN_CONFIG_DIR");
        }
    });

    const originalOptOut = env.get("GENESIS_TOOLS_TEST_ALLOW_REAL_HOME");
    test("the explicit real-home escape hatch may leave the override absent", () => {
        env.testing.set("GENESIS_TOOLS_TEST_ALLOW_REAL_HOME", "1");
        env.testing.unset("OBSIDIAN_CONFIG_DIR");
        expect(discover()).toBe(vault);
    });

    test("the next test respects the escape hatch", () => {
        try {
            expect(env.getTrimmed("OBSIDIAN_CONFIG_DIR")).toBeUndefined();
            expect(discover()).toBe(vault);
        } finally {
            if (originalOptOut === undefined) {
                env.testing.unset("GENESIS_TOOLS_TEST_ALLOW_REAL_HOME");
            } else {
                env.testing.set("GENESIS_TOOLS_TEST_ALLOW_REAL_HOME", originalOptOut);
            }
        }
    });

    test("isolation resumes after the escape hatch is removed", () => {
        expect(env.getTrimmed("OBSIDIAN_CONFIG_DIR")).toBe(sandbox);
        expect(discover()).toBeNull();
    });
});

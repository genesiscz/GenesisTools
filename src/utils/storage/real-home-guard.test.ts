import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { assertTestSafePath, isInside, realGenesisToolsRoot } from "./real-home-guard";
import { Storage } from "./storage";

const REAL_AI_CONFIG = join(realGenesisToolsRoot(), "ai", "config.json");
const ESCAPE_HATCH = "GENESIS_TOOLS_ALLOW_REAL_HOME_IN_TESTS";

afterEach(() => {
    env.testing.unset(ESCAPE_HATCH);
});

describe("isInside", () => {
    test("a path boundary, not a string prefix", () => {
        // "/tmp/sbX-evil" must NOT count as inside "/tmp/sbX".
        expect(isInside("/tmp/sbX", "/tmp/sbX-evil/config.json")).toBe(false);
        expect(isInside("/tmp/sbX", "/tmp/sbX/config.json")).toBe(true);
        expect(isInside("/tmp/sbX", "/tmp/sbX")).toBe(true);
    });

    test("an escape upwards is outside", () => {
        expect(isInside("/tmp/sbX", "/tmp/other")).toBe(false);
    });
});

describe("assertTestSafePath", () => {
    // This suite runs under `bun test`, so NODE_ENV is already "test" and the
    // guard is live. That makes the assertions below a real check of the
    // shipped behaviour rather than a simulation.
    test("blocks a write to the real ai config", () => {
        expect(() => assertTestSafePath(REAL_AI_CONFIG, "write")).toThrow(/REAL ~\/\.genesis-tools/);
    });

    test("blocks any path under the real store, not just known configs", () => {
        expect(() => assertTestSafePath(join(realGenesisToolsRoot(), "anything", "x.json"), "write")).toThrow();
    });

    test("allows a sandbox path", () => {
        expect(() => assertTestSafePath("/tmp/gt-sandbox-abc/.genesis-tools/ai/config.json", "write")).not.toThrow();
    });

    test("allows an unrelated path", () => {
        expect(() => assertTestSafePath(join(homedir(), "notes.md"), "write")).not.toThrow();
    });

    test("the escape hatch lets a deliberate write through", () => {
        env.testing.set(ESCAPE_HATCH, "1");
        expect(() => assertTestSafePath(REAL_AI_CONFIG, "write")).not.toThrow();
    });
});

describe("Storage integration: the actual 2026-08-29 incident", () => {
    /**
     * The regression test for the real event. A `Storage` built with no
     * GENESIS_TOOLS_HOME resolves to the user's real store — exactly what a
     * singleton that outlived its sandbox teardown holds. Every data-destroying
     * entry point must refuse it.
     *
     * The tool name is a THROWAWAY, never "ai" or any real tool. These tests
     * exist to be mutation-checked, and a mutation check disables the very guard
     * under test — so pointing them at a real config would destroy it the moment
     * someone verified they work. That is not hypothetical: it happened while
     * this file was being written.
     */
    const PROBE_TOOL = "__real_home_guard_probe__";

    // A mutation check deliberately disables the guard, so these tests DO write
    // once in that mode. Clearing the probe dir around every test keeps that
    // leftover from turning the next honest run red.
    const probeDir = join(realGenesisToolsRoot(), PROBE_TOOL);
    const clearProbe = () => rmSync(probeDir, { recursive: true, force: true });

    beforeEach(clearProbe);
    afterEach(clearProbe);

    const unsandboxed = () => {
        const prev = env.get("GENESIS_TOOLS_HOME");
        env.testing.unset("GENESIS_TOOLS_HOME");
        const storage = new Storage(PROBE_TOOL);

        if (prev !== undefined) {
            env.testing.set("GENESIS_TOOLS_HOME", prev);
        }

        return storage;
    };

    test("the probe really does resolve to the real store", () => {
        // Without this the suite could pass while testing a sandbox path, which
        // would make every assertion below vacuous.
        expect(isInside(realGenesisToolsRoot(), unsandboxed().getConfigPath())).toBe(true);
    });

    test("setConfig on the real store throws instead of writing", async () => {
        await expect(unsandboxed().setConfig({ accounts: [] })).rejects.toThrow(/REAL ~\/\.genesis-tools/);
    });

    test("clearConfig on the real store throws", async () => {
        await expect(unsandboxed().clearConfig()).rejects.toThrow(/REAL ~\/\.genesis-tools/);
    });

    test("ensureDirs on the real store throws", async () => {
        await expect(unsandboxed().ensureDirs()).rejects.toThrow(/REAL ~\/\.genesis-tools/);
    });

    test("nothing is left behind on disk", async () => {
        await unsandboxed()
            .setConfig({ accounts: [] })
            .catch(() => undefined);

        expect(existsSync(unsandboxed().getBaseDir())).toBe(false);
    });
});

describe("assertTestSafePath canonicalisation", () => {
    // PR #343 review t22: the check was lexical, so both a relative path and a
    // symlink pointing into the real store walked straight past it.
    const realRoot = realGenesisToolsRoot();

    // These tests need the real root to EXIST so realpathSync can resolve it,
    // and `mkdirSync` is a raw fs call the guard cannot intercept — so on a
    // machine or CI image without one they created a directory outside the
    // sandbox and left it there. Remove it again, but only when this suite is
    // what created it: a developer's real store must never be touched
    // (PR #343 review t25).
    const realRootPreexisted = existsSync(realRoot);

    afterEach(() => {
        if (realRootPreexisted || !existsSync(realRoot)) {
            return;
        }

        // rmdirSync, never a recursive rm (PR #343 review t1 round 7).
        // `realRootPreexisted` is sampled once when this block is DEFINED, so a
        // store created and filled by the developer or another process in the
        // meantime would look like ours. This cleanup runs outside the write
        // guard, so a recursive delete here would recreate the exact data loss
        // the suite exists to prevent. rmdirSync removes an empty directory and
        // throws ENOTEMPTY on anything else, which fails loudly instead.
        rmdirSync(realRoot);
    });

    it("catches a relative path resolved from inside the real store", () => {
        const cwd = process.cwd();

        try {
            mkdirSync(realRoot, { recursive: true });
            process.chdir(realRoot);
            expect(() => assertTestSafePath("config.json", "write")).toThrow(/REAL ~\/.genesis-tools/);
        } finally {
            process.chdir(cwd);
        }
    });

    it("catches a symlink that points into the real store", () => {
        const dir = mkdtempSync(join(tmpdir(), "guard-link-"));
        const link = join(dir, "link");
        mkdirSync(realRoot, { recursive: true });
        symlinkSync(realRoot, link);

        expect(() => assertTestSafePath(join(link, "config.json"), "write")).toThrow(/REAL ~\/.genesis-tools/);
    });

    it("catches a symlink with a not-yet-created directory below it", () => {
        // PR #343 review t20: resolving only the immediate parent left "link"
        // lexical here, because realpathSync("<dir>/link/new") throws while
        // "new" does not exist. The recursive mkdir would then have followed
        // the link into the real store.
        const dir = mkdtempSync(join(tmpdir(), "guard-deep-link-"));
        const link = join(dir, "link");
        mkdirSync(realRoot, { recursive: true });
        symlinkSync(realRoot, link);

        expect(() => assertTestSafePath(join(link, "new", "deeper", "config.json"), "write")).toThrow(
            /REAL ~\/.genesis-tools/
        );
    });

    it("still allows a genuine sandbox path", () => {
        const sandbox = mkdtempSync(join(tmpdir(), "guard-sandbox-"));
        expect(() => assertTestSafePath(join(sandbox, "config.json"), "write")).not.toThrow();
    });

    it("still allows a deep not-yet-created path inside a sandbox", () => {
        // The negative control for the walk: it must not start rejecting
        // ordinary writes into directories that do not exist yet.
        const sandbox = mkdtempSync(join(tmpdir(), "guard-sandbox-deep-"));
        expect(() => assertTestSafePath(join(sandbox, "a", "b", "config.json"), "write")).not.toThrow();
    });
});

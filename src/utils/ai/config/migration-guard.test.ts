import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { assertSafeToWriteRealConfig, isWorktreeCheckout, migrationAllowedHere } from "./migration-guard";

/**
 * These tests exist because the first version of this guard was a silent no-op:
 * it asked `env.tools.getHome()`, which falls back to homedir() and is therefore
 * never falsy, so every worktree run "was sandboxed" and migrated the user's real
 * config to v4 — twice, breaking the installed v3 tools both times.
 *
 * The lesson is in the shape of the tests: assert the guard SAYS NO, not just
 * that it says yes when expected.
 */

const REAL_WORKTREE = "/Users/someone/Projects/GenesisTools/.worktrees/feat-x";
const CLAUDE_WORKTREE = "/Users/someone/Projects/GenesisTools/.claude/worktrees/feat-x";
const MAIN_CHECKOUT = "/Users/someone/Projects/GenesisTools";

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_ALLOW_REAL_MIGRATION");
});

describe("isWorktreeCheckout", () => {
    test("recognises both worktree layouts and nothing else", () => {
        expect(isWorktreeCheckout(REAL_WORKTREE)).toBe(true);
        expect(isWorktreeCheckout(CLAUDE_WORKTREE)).toBe(true);
        expect(isWorktreeCheckout(MAIN_CHECKOUT)).toBe(false);
        expect(isWorktreeCheckout(join(tmpdir(), "whatever"))).toBe(false);
    });
});

describe("migrationAllowedHere", () => {
    // The test preload always sets GENESIS_TOOLS_HOME, so this is the sandboxed case.
    test("allows migration when a sandbox root is configured", () => {
        expect(env.tools.hasExplicitHome()).toBe(true);
        expect(migrationAllowedHere()).toBe(true);
    });

    test("hasExplicitHome is the honest question; getHome always answers yes", () => {
        // Guards the exact footgun: getHome() falls back to homedir(), so a truthy
        // check on it can never fail and cannot gate anything.
        env.testing.withOverrides({ GENESIS_TOOLS_HOME: undefined }, () => {
            expect(env.tools.getHome()).toBeTruthy();
            expect(env.tools.hasExplicitHome()).toBe(false);
        });
    });

    test("refuses in a worktree with no sandbox, and the explicit override re-allows it", () => {
        env.testing.withOverrides({ GENESIS_TOOLS_HOME: undefined }, () => {
            const cwd = process.cwd;
            process.cwd = () => REAL_WORKTREE;

            try {
                expect(migrationAllowedHere()).toBe(false);

                env.testing.set("GENESIS_TOOLS_ALLOW_REAL_MIGRATION", "1");
                expect(migrationAllowedHere()).toBe(true);
            } finally {
                process.cwd = cwd;
            }
        });
    });

    test("allows migration from a normal checkout", () => {
        env.testing.withOverrides({ GENESIS_TOOLS_HOME: undefined }, () => {
            const cwd = process.cwd;
            process.cwd = () => MAIN_CHECKOUT;

            try {
                expect(migrationAllowedHere()).toBe(true);
            } finally {
                process.cwd = cwd;
            }
        });
    });
});

describe("assertSafeToWriteRealConfig", () => {
    test("passes when sandboxed", () => {
        expect(() => assertSafeToWriteRealConfig()).not.toThrow();
    });

    test("throws in a worktree writing the real home, naming both escape hatches", () => {
        env.testing.withOverrides({ GENESIS_TOOLS_HOME: undefined }, () => {
            const cwd = process.cwd;
            process.cwd = () => REAL_WORKTREE;

            try {
                expect(() => assertSafeToWriteRealConfig()).toThrow(/Refusing to write/);
                expect(() => assertSafeToWriteRealConfig()).toThrow(/GENESIS_TOOLS_ALLOW_REAL_MIGRATION=1/);
            } finally {
                process.cwd = cwd;
            }
        });
    });
});

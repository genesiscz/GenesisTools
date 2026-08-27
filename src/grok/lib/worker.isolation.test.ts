import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { turnLogPath } from "./paths";
import { GrokSessionStore } from "./store";
import { buildRunArgs, buildSteerArgs, buildTurnEnv, steerSession } from "./worker";

/**
 * Regression test: PR #330 review t2 — the worker's isolation contract was
 * documented ("verified against grok CLI 1.0.3") but never asserted anywhere.
 * Both halves of it are security controls:
 *
 *  - the GROK_CLAUDE_*_ENABLED toggles, because a fresh GROK_HOME alone does
 *    NOT stop the worker loading the user's personal rules, skills and hooks
 *    and acting on them;
 *  - `--tools` on EVERY turn, because the grok CLI drops safety flags on
 *    `--resume`, so a read-only session silently became writable on turn 2.
 */
describe("worker isolation env", () => {
    test("every claude-compat pickup is switched off and GROK_HOME is pinned", () => {
        const built = buildTurnEnv({ PATH: "/usr/bin" }, "/tmp/worker-home");

        expect(built.GROK_HOME).toBe("/tmp/worker-home");
        expect(built.PATH).toBe("/usr/bin");
        expect(built).toMatchObject({
            GROK_CLAUDE_SKILLS_ENABLED: "0",
            GROK_CLAUDE_RULES_ENABLED: "0",
            GROK_CLAUDE_AGENTS_ENABLED: "0",
            GROK_CLAUDE_MCPS_ENABLED: "0",
            GROK_CLAUDE_HOOKS_ENABLED: "0",
            GROK_CLAUDE_SESSIONS_ENABLED: "0",
        });
    });

    /**
     * The ambient environment is the attacker here: whoever launches `tools grok`
     * may already export GROK_CLAUDE_SKILLS_ENABLED=1, and a spread that put the
     * caller's env last would hand the worker the user's ~200 personal skills.
     */
    test("an ambient GROK_CLAUDE_* value cannot re-enable a pickup", () => {
        const built = buildTurnEnv(
            { GROK_CLAUDE_SKILLS_ENABLED: "1", GROK_CLAUDE_HOOKS_ENABLED: "1", GROK_HOME: "/home/attacker" },
            "/tmp/worker-home"
        );

        expect(built.GROK_CLAUDE_SKILLS_ENABLED).toBe("0");
        expect(built.GROK_CLAUDE_HOOKS_ENABLED).toBe("0");
        expect(built.GROK_HOME).toBe("/tmp/worker-home");
    });
});

describe("read-only tool restriction", () => {
    test("a read-only run is restricted to non-mutating tools", () => {
        const args = buildRunArgs({ sessionId: "s-1", model: undefined, readOnly: true }, ["-p", "hi"]);

        expect(args).toContain("--tools");
        expect(args[args.indexOf("--tools") + 1]).toBe("read_file,list_dir,grep");
    });

    test("a writable run carries no tool restriction", () => {
        const args = buildRunArgs({ sessionId: "s-1", model: undefined, readOnly: false }, ["-p", "hi"]);

        expect(args).not.toContain("--tools");
    });

    /**
     * This is the compensating control for the CLI bug. If `--tools` ever stops
     * being re-armed on resume, a session the user started read-only gains write
     * tools from turn 2 onward with nothing in the output saying so.
     */
    test("a resumed read-only session is re-armed, because the CLI forgets the flag", () => {
        const args = buildSteerArgs({ sessionId: "s-1" }, true, ["-p", "again"]);

        expect(args).toContain("--resume");
        expect(args[args.indexOf("--resume") + 1]).toBe("s-1");
        expect(args).toContain("--tools");
        expect(args[args.indexOf("--tools") + 1]).toBe("read_file,list_dir,grep");
    });

    test("a resumed writable session stays unrestricted", () => {
        const args = buildSteerArgs({ sessionId: "s-1" }, false, ["-p", "again"]);

        expect(args).toContain("--resume");
        expect(args).not.toContain("--tools");
    });
});

/**
 * Regression test: PR #330 review t28 — the safety mode was persisted BEFORE
 * the turn reservation, so a `steer --writable` that lost the race still left
 * `readOnly: false` in metadata and the next unflagged steer ran writable.
 */
describe("safety mode is only persisted by the turn that wins the reservation", () => {
    test("a steer that loses the reservation leaves readOnly untouched", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-grok-race-"));
        const binDir = mkdtempSync(join(tmpdir(), "gt-grok-bin-"));

        // steerSession resolves the binary before it reserves the turn, so the
        // race is only reachable with something named `grok` on PATH.
        writeFileSync(join(binDir, "grok"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const originalPath = process.env.PATH;
        process.env.PATH = `${binDir}:${originalPath}`;

        try {
            await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
                const store = new GrokSessionStore();
                store.createMeta({
                    name: "reviewer",
                    sessionId: "3f1d2a9c-0000-4000-8000-000000000000",
                    cwd: "/repo",
                    workerHome: join(home, "worker"),
                    readOnly: true,
                    turns: 0,
                    createdAt: new Date(0).toISOString(),
                });

                // Stand in for the turn a concurrent steer already reserved.
                writeFileSync(turnLogPath("reviewer", 1), "");

                await expect(steerSession({ name: "reviewer", prompt: "go", readOnly: false })).rejects.toThrow(
                    /already has a transcript/
                );

                expect(store.readMeta("reviewer")?.readOnly).toBe(true);
            });
        } finally {
            process.env.PATH = originalPath;
        }
    });
});

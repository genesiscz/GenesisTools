import { afterEach, describe, expect, test } from "bun:test";
import {
    _setFindClaudeCommandTestHooks,
    claudeInstallLocations,
    findClaudeCommand,
    findClaudeExecutable,
} from "./index";

describe("findClaudeCommand timeout cleanup", () => {
    afterEach(() => {
        _setFindClaudeCommandTestHooks(undefined);
    });

    test("kills the candidate-probe child when the timeout race loses", async () => {
        const marker = `sleep-30-claude-test-${Date.now()}`;

        _setFindClaudeCommandTestHooks({
            candidates: ["hung-probe"],
            timeoutMs: 100,
            spawnProbe: () =>
                Bun.spawn({
                    env: process.env,
                    cmd: ["bash", "-c", `exec -a ${marker} sleep 30`],
                    stdio: ["ignore", "pipe", "pipe"],
                }),
        });

        await findClaudeCommand();
        await new Promise((r) => setTimeout(r, 200));

        const after = Bun.spawnSync(["pgrep", "-f", marker], { env: process.env }).stdout.toString().trim();
        expect(after).toBe("");
    });
});

describe("findClaudeExecutable", () => {
    const home = "/Users/alice";
    const noShell = async () => null;

    test("PATH wins, then the installers' folders, then the interactive shell", async () => {
        expect(
            await findClaudeExecutable({
                which: () => "/usr/bin/claude",
                exists: () => true,
                shellLookup: noShell,
                home,
            })
        ).toBe("/usr/bin/claude");

        const local = `${home}/.local/bin/claude`;
        expect(
            await findClaudeExecutable({
                which: () => null,
                exists: (path) => path === local,
                shellLookup: noShell,
                home,
            })
        ).toBe(local);

        expect(
            await findClaudeExecutable({
                which: () => null,
                exists: () => false,
                shellLookup: async () => "/opt/tools/claude",
                home,
            })
        ).toBe("/opt/tools/claude");
    });

    test("a Mac without Claude Code answers null, so tools update skips the plugin steps instead of failing them", async () => {
        expect(
            await findClaudeExecutable({ which: () => null, exists: () => false, shellLookup: noShell, home })
        ).toBeNull();
        expect(claudeInstallLocations(home)).toContain(`${home}/.claude/local/claude`);
    });
});

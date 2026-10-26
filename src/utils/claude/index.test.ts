import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { interactiveShellLookup } from "./executable";
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
                isExecutable: () => true,
                shellLookup: noShell,
                home,
            })
        ).toBe("/usr/bin/claude");

        const local = `${home}/.local/bin/claude`;
        expect(
            await findClaudeExecutable({
                which: () => null,
                isExecutable: (path) => path === local,
                shellLookup: noShell,
                home,
            })
        ).toBe(local);

        expect(
            await findClaudeExecutable({
                which: () => null,
                isExecutable: (path) => path === "/opt/tools/claude",
                shellLookup: async () => "/opt/tools/claude",
                home,
            })
        ).toBe("/opt/tools/claude");
    });

    test("skips non-executable files and directories, accepting a later installer symlink", async () => {
        const fixture = await mkdtemp(join(tmpdir(), "claude-executable-"));
        try {
            const candidates = claudeInstallLocations(fixture);
            const first = candidates[0]!;
            const second = candidates[1]!;
            await mkdir(join(fixture, ".local/bin"), { recursive: true });
            await mkdir(join(fixture, ".claude/local"), { recursive: true });
            await writeFile(first, "stale", { mode: 0o644 });
            await symlink("/bin/sh", second);
            expect(await findClaudeExecutable({ which: () => null, home: fixture, shellLookup: noShell })).toBe(second);
            await rm(first);
            await mkdir(first);
            expect(await findClaudeExecutable({ which: () => null, home: fixture, shellLookup: noShell })).toBe(second);
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    test("a missing shell is optional when Claude is not installed", async () => {
        await env.testing.withOverrides({ SHELL: "/nonexistent/fixture-shell" }, async () => {
            expect(await findClaudeExecutable({ which: () => null, isExecutable: () => false, home })).toBeNull();
        });
    });

    test("the shell deadline covers exit even after stdout closes and kills the child", async () => {
        const proc = Bun.spawn({
            env: process.env,
            cmd: ["/bin/sh", "-c", "exec 1>&-; exec sleep 30"],
            stdio: ["ignore", "pipe", "ignore"],
        });
        try {
            expect(await interactiveShellLookup({ spawn: () => proc, timeoutMs: 100 })).toBeNull();
            expect(await proc.exited).not.toBe(0);
        } finally {
            proc.kill();
        }
    });

    test("a successful shell lookup still returns the executable path", async () => {
        expect(
            await interactiveShellLookup({
                spawn: () =>
                    Bun.spawn({
                        env: process.env,
                        cmd: ["/bin/sh", "-c", "printf '/bin/sh\\n'"],
                        stdio: ["ignore", "pipe", "ignore"],
                    }),
            })
        ).toBe("/bin/sh");
    });

    test("shell paths may contain spaces or use Windows separators", async () => {
        for (const candidate of ["/Applications/Custom Tools/claude", "C:\\Tools\\Claude Code\\claude.exe"]) {
            expect(
                await interactiveShellLookup({
                    spawn: () =>
                        Bun.spawn({
                            env: process.env,
                            cmd: ["/bin/sh", "-c", "printf '%s\\n' \"$1\"", "sh", candidate],
                            stdio: ["ignore", "pipe", "ignore"],
                        }),
                })
            ).toBe(candidate);
        }
    });

    test("a Mac without Claude Code answers null, so tools update skips the plugin steps instead of failing them", async () => {
        expect(
            await findClaudeExecutable({ which: () => null, isExecutable: () => false, shellLookup: noShell, home })
        ).toBeNull();
        expect(claudeInstallLocations(home)).toContain(`${home}/.claude/local/claude`);
    });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { interactiveShellLookup } from "./executable";
import {
    _setFindClaudeCommandTestHooks,
    type ClaudeCandidateVerdict,
    claudeInstallLocations,
    findClaudeCommand,
    findClaudeExecutable,
    pickClaudeCommand,
    probeScript,
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

describe("pickClaudeCommand", () => {
    /** Each candidate answers with its verdicts in order; the last one repeats. */
    const answers = (script: Record<string, ClaudeCandidateVerdict[]>) => {
        const asked: string[] = [];
        const probe = async (candidate: string): Promise<ClaudeCandidateVerdict> => {
            const seen = asked.filter((name) => name === candidate).length;
            asked.push(candidate);
            const verdicts = script[candidate];
            return verdicts[Math.min(seen, verdicts.length - 1)];
        };

        return { asked, probe };
    };
    const candidates = ["wrapper", "compiler", "binary"];

    test("the first candidate that is Claude wins and is settled", async () => {
        const { asked, probe } = answers({ wrapper: ["is-claude"] });

        expect(await pickClaudeCommand({ candidates, probe })).toEqual({ command: "wrapper", settled: true });
        expect(asked).toEqual(["wrapper"]);
    });

    test("names that are not Claude leave a later pick settled", async () => {
        const { probe } = answers({ wrapper: ["not-claude"], compiler: ["not-claude"], binary: ["is-claude"] });

        expect(await pickClaudeCommand({ candidates, probe })).toEqual({ command: "binary", settled: true });
    });

    test("a wrapper that gave no answer wins on its second try", async () => {
        const { asked, probe } = answers({
            wrapper: ["no-answer", "is-claude"],
            compiler: ["not-claude"],
            binary: ["is-claude"],
        });

        expect(await pickClaudeCommand({ candidates, probe })).toEqual({ command: "wrapper", settled: true });
        expect(asked).toEqual(["wrapper", "compiler", "binary", "wrapper"]);
    });

    test("a pick behind a wrapper that stays silent is not settled", async () => {
        const { probe } = answers({ wrapper: ["no-answer"], compiler: ["not-claude"], binary: ["is-claude"] });

        expect(await pickClaudeCommand({ candidates, probe })).toEqual({ command: "binary", settled: false });
    });

    test("no candidate is Claude", async () => {
        const { probe } = answers({ wrapper: ["no-answer"], compiler: ["not-claude"], binary: ["no-answer"] });

        expect(await pickClaudeCommand({ candidates, probe })).toBeNull();
    });
});

describe("findClaudeCommand probe verdicts", () => {
    afterEach(() => {
        _setFindClaudeCommandTestHooks(undefined);
    });

    test("a failed probe is no answer, and the candidate gets a second try", async () => {
        const calls: string[] = [];
        const outputs: Record<string, string[]> = {
            // A defined wrapper whose binary is away for a moment, then back.
            wrapper: ["echo 'no such file'; exit 127", "echo '9.9.9 (Claude Code)'"],
            compiler: ["echo 'Some compiler 1.0'"],
            binary: ["echo '9.9.9 (Claude Code)'"],
        };

        _setFindClaudeCommandTestHooks({
            candidates: ["wrapper", "compiler", "binary"],
            timeoutMs: 5000,
            spawnProbe: (candidate) => {
                const seen = calls.filter((name) => name === candidate).length;
                calls.push(candidate);
                const scripts = outputs[candidate];
                return Bun.spawn({
                    env: process.env,
                    cmd: ["bash", "-c", scripts[Math.min(seen, scripts.length - 1)]],
                    stdio: ["ignore", "pipe", "pipe"],
                });
            },
        });

        expect(await findClaudeCommand()).toBe("wrapper");
        expect(calls).toEqual(["wrapper", "compiler", "binary", "wrapper"]);
    });
});

describe("probeScript in a real shell", () => {
    async function run(prelude: string, candidate: string): Promise<{ exitCode: number; stdout: string }> {
        const proc = Bun.spawn({
            env: process.env,
            cmd: ["bash", "-c", `shopt -s expand_aliases\n${prelude}\n${probeScript(candidate)}`],
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout = await new Response(proc.stdout).text();
        return { exitCode: await proc.exited, stdout };
    }

    test("an alias counts as not defined, because exec does not expand it", async () => {
        expect((await run("alias fakeclaude='echo Claude Code'", "fakeclaude")).exitCode).toBe(97);
    });

    test("an undefined name exits 97", async () => {
        expect((await run(":", "gt-no-such-claude-wrapper")).exitCode).toBe(97);
    });

    test("a function that prints Claude Code answers", async () => {
        const result = await run("fakeclaude() { echo '9.9.9 (Claude Code)'; }", "fakeclaude");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Claude Code");
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

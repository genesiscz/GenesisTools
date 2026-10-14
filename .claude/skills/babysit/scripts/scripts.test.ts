import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { execTool } from "@genesiscz/utils/cli";
import { toolsEntrypoint } from "@genesiscz/utils/cli/tools";
import { SafeJSON } from "@genesiscz/utils/json";
import { allowedCommand, decide, type RunEntry, watchApprovals } from "./approve-codex";
import { pump } from "./watch-workers";

const entry: RunEntry = {
    name: "fixture",
    cwd: "/fixture",
    scope: ["src/a.ts", "src/with space.ts"],
    subject: "fix(tools): #1 followup - subject",
    verify: ["bunx biome check src/a.ts"],
};

describe("brief approval boundary", () => {
    test("verification requires the entire configured command", () => {
        expect(allowedCommand(entry, "bunx biome check src/a.ts")).toBe(true);
        for (const command of [
            "bunx biome check --write src/outside.ts",
            "bunx biome check src/a.ts --write",
            "bunx biome check src/a.tsx",
            "bunx biome check src/a.ts src/outside.ts",
            'bunx biome check "$(touch owned)"',
        ]) {
            expect(allowedCommand(entry, command)).toBe(false);
        }
    });

    test("normalizes file changes and git paths and rejects traversal and pathspecs", () => {
        for (const path of [
            ".claude/work/babysit/../../../src/outside.ts",
            "../outside.ts",
            "/other/a.ts",
            ":(glob)**",
        ]) {
            expect(
                decide(entry, { method: "item/fileChange/requestApproval", detail: "edit " + path, paths: [path] }).ok
            ).toBe(false);
            expect(allowedCommand(entry, "git add -- '" + path + "'")).toBe(false);
        }
        expect(
            decide(entry, {
                method: "item/fileChange/requestApproval",
                detail: "edit /fixture/src/a.ts",
                paths: ["/fixture/src/a.ts"],
            }).ok
        ).toBe(true);
        expect(allowedCommand(entry, "git add -- 'src/with space.ts'")).toBe(true);
        expect(allowedCommand(entry, "git add -- .claude/work/babysit/replies.json")).toBe(true);
        expect(allowedCommand(entry, "git add --")).toBe(false);
    });

    test("command approval requires the actual command and its working directory", () => {
        const request = {
            method: "item/commandExecution/requestApproval",
            detail: entry.verify[0],
            command: "touch outside.ts",
            cwd: entry.cwd,
        };
        expect(decide(entry, request).ok).toBe(false);
        expect(decide(entry, { ...request, command: undefined }).ok).toBe(false);
        expect(decide(entry, { ...request, command: entry.verify[0], cwd: undefined }).ok).toBe(false);
        expect(decide(entry, { ...request, command: entry.verify[0], cwd: "/other" }).ok).toBe(false);
        expect(decide(entry, { ...request, command: entry.verify[0], cwd: "." }).ok).toBe(false);
        expect(decide(entry, { ...request, command: entry.verify[0], detail: "explanation only" }).ok).toBe(true);
        expect(decide(entry, { ...request, command: `/bin/zsh -lc '${entry.verify[0]}'` }).ok).toBe(true);
        expect(decide(entry, { ...request, command: `/tmp/zsh -lc '${entry.verify[0]}'` }).ok).toBe(false);
        expect(decide(entry, { ...request, command: `/bin/zsh -lc '${entry.verify[0]}' extra` }).ok).toBe(false);
    });

    test("file approval uses exact structured paths, never the display label", () => {
        const request = {
            method: "item/fileChange/requestApproval",
            detail: "edit src/a.ts (copy).ts, src/outside.ts",
        };
        expect(decide(entry, request).ok).toBe(false);
        expect(decide(entry, { ...request, paths: ["src/a.ts (copy).ts", "src/outside.ts"] }).ok).toBe(false);
        expect(decide(entry, { ...request, paths: ["src/a.ts", "src/outside.ts"] }).ok).toBe(false);
        expect(decide(entry, { ...request, paths: ["src/a.ts", 42] }).ok).toBe(false);
        expect(decide(entry, { ...request, paths: [] }).ok).toBe(false);
        const names = ["src/a.ts (copy).ts", "src/a,b.ts"];
        expect(decide({ ...entry, scope: names }, { ...request, paths: names }).ok).toBe(true);
    });

    test("an unrelated staged file never permits a commit without an explicit path list", () => {
        const root = fs.mkdtempSync(join(tmpdir(), "babysit-index-"));
        const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, env: process.env });
        expect(git(["init", "-q"]).exitCode).toBe(0);
        fs.writeFileSync(join(root, "unrelated.txt"), "another worker");
        expect(git(["add", "--", "unrelated.txt"]).exitCode).toBe(0);
        const scoped = { ...entry, cwd: root };
        expect(allowedCommand(scoped, "git commit -m 'fix(tools): #1 followup - fix'")).toBe(false);
        expect(allowedCommand(scoped, "git commit -m 'fix(tools): #1 followup - fix' --")).toBe(false);
        expect(allowedCommand(scoped, "git commit -m 'fix(tools): #1 followup - fix' -- src/a.ts")).toBe(true);
        expect(allowedCommand(scoped, "git commit -m 'wrong' -- src/a.ts")).toBe(false);
        expect(git(["diff", "--cached", "--name-only"]).stdout.toString().trim()).toBe("unrelated.txt");
    });
});

test("approval failures retry until acknowledged and the watch has a deadline", async () => {
    const messages: string[] = [];
    const output = spyOn(console, "log").mockImplementation((value) => messages.push(String(value)));
    const errors = spyOn(console, "error").mockImplementation((value) => messages.push(String(value)));
    let time = 0;
    let approvals = 0;
    const pending = {
        pendingApprovals: {
            "request-1": {
                method: "item/commandExecution/requestApproval",
                detail: "bunx biome check src/a.ts",
                command: "bunx biome check src/a.ts",
                cwd: entry.cwd,
            },
        },
    };
    const exec: typeof execTool = async (args) => {
        if (args[1] === "approve") {
            approvals += 1;
            return {
                success: approvals > 1,
                exitCode: approvals > 1 ? 0 : 124,
                stdout: "",
                stderr: "temporary failure",
                timedOut: approvals === 1,
            };
        }
        return { success: true, exitCode: 0, stdout: SafeJSON.stringify(pending), stderr: "" };
    };
    try {
        await watchApprovals({
            entry,
            exec,
            now: () => time,
            sleep: async (ms) => {
                time += ms;
            },
            timeoutMs: 20,
            pollMs: 5,
        });
        expect(approvals).toBe(2);
        expect(messages.filter((line) => line.includes("approved #request-1"))).toHaveLength(1);
        expect(messages.some((line) => line.includes("approval failed #request-1"))).toBe(true);
        expect(messages.at(-1)).toContain("watch deadline reached");
        expect(time).toBe(20);
    } finally {
        output.mockRestore();
        errors.mockRestore();
    }
});

test("persistent approval failure asks the lead after three attempts, without claiming success", async () => {
    const messages: string[] = [];
    const output = spyOn(console, "log").mockImplementation((value) => messages.push(String(value)));
    const errors = spyOn(console, "error").mockImplementation((value) => messages.push(String(value)));
    let time = 0;
    let attempts = 0;
    const exec: typeof execTool = async (args) => {
        if (args[1] === "approve") {
            attempts += 1;
            throw new Error("unavailable");
        }
        return {
            success: true,
            exitCode: 0,
            stderr: "",
            stdout: SafeJSON.stringify({
                pendingApprovals: {
                    r: {
                        method: "execCommandApproval",
                        detail: "bunx biome check src/a.ts",
                        command: "bunx biome check src/a.ts",
                        cwd: entry.cwd,
                    },
                },
            }),
        };
    };
    try {
        await watchApprovals({
            entry,
            exec,
            now: () => time,
            sleep: async (ms) => {
                time += ms;
            },
            timeoutMs: 20,
            pollMs: 2,
        });
        expect(attempts).toBe(3);
        expect(messages.some((line) => line.includes("NEEDS LEAD #r"))).toBe(true);
        expect(messages.some((line) => line.includes("approved #"))).toBe(false);
    } finally {
        output.mockRestore();
        errors.mockRestore();
    }
});

test("monitor drains large stderr, preserves its label, and returns failures", async () => {
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((text) => output.push(String(text)));
    try {
        const worker = {
            backend: "codex" as const,
            name: "fixture",
            label: "codex:fixture",
            lastAt: 0,
            running: true,
            stallSaid: false,
        };
        const code = await pump(
            worker,
            [
                process.execPath,
                "-e",
                'await Bun.write(Bun.stderr, "diagnostic ".repeat(100000)); console.log("✔ done"); process.exit(7)',
            ],
            2000
        );
        expect(code).toBe(7);
        expect(output.some((line) => line.startsWith("[codex:fixture] stderr: diagnostic"))).toBe(true);
        expect(output.some((line) => line.includes("✔ done"))).toBe(true);
        const expired = await pump(worker, [process.execPath, "-e", "setInterval(() => {}, 1000)"], 50);
        expect(expired).toBe(124);
    } finally {
        log.mockRestore();
    }
});

test("the free-space override never probes the filesystem", async () => {
    const argv = process.argv;
    const probe = spyOn(fs, "statfsSync").mockImplementation(() => {
        throw new Error("probe must not run");
    });
    process.argv = [process.execPath, "mode.ts", "--free-gb", "4", "--json"];
    try {
        await import("./mode");
        expect(probe).not.toHaveBeenCalled();
    } finally {
        process.argv = argv;
        probe.mockRestore();
    }
});

test("babysit control scripts use checkout-local executors", () => {
    const approval = fs.readFileSync(join(import.meta.dir, "approve-codex.ts"), "utf8");
    const watch = fs.readFileSync(join(import.meta.dir, "watch-workers.ts"), "utf8");
    expect(approval).not.toContain('Bun.spawnSync(["tools"');
    expect(approval).toContain("exec = execTool");
    expect(watch).not.toContain('["tools"');
    expect(watch).toContain("toolsEntrypoint()");
    expect(toolsEntrypoint()).toBe(join(import.meta.dir, "../../../../tools"));
});

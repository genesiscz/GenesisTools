import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { execTool } from "@genesiscz/utils/cli";
import { toolsEntrypoint } from "@genesiscz/utils/cli/tools";
import { env } from "@genesiscz/utils/env";
import { waitForPath } from "@genesiscz/utils/fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import {
    allowedCommand,
    chainSegments,
    decide,
    fableReplaceCommand,
    innerCommand,
    type RunEntry,
    readOnlyChain,
    watchApprovals,
} from "./approve-codex";
import { type ConflictPick, resolutionProblems, resolveConflictText } from "./conflicts";
import { threadRefs } from "./fetch-threads";
import { earlierVerdicts, PRE_PUSH_GUARDS, postingExitCode } from "./integrate";
import { recordLandingPush } from "./land";
import { appendEvent, readEvents, renderMarkdown } from "./ledger";
import { continueVersionPick } from "./pick-unified";
import { summarize, testEvidence } from "./plant";
import { hitsInAddedLines, probeAddedLines } from "./probe";
import { reviewBrief } from "./review-brief";
import { loadRun, runPaths } from "./run";
import { trySwiftSlot } from "./swift-slot";
import { parseSwiftTargets, typecheckPackage } from "./swift-typecheck";
import { openPaths } from "./tmp-reclaim";
import {
    conflictedFiles,
    higherVersionSide,
    newExecutablesStall,
    prepGit,
    resolveVersionConflicts,
    resolveVersionText,
} from "./versions";
import { createTaskLookup, pump } from "./watch-workers";

const mainCheckout = dirname(
    Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
    })
        .stdout.toString()
        .trim()
);
const trustedCli = join(mainCheckout, "plugins/genesis-tools/skills/fable-replace/scripts/cli.ts");

const approvalRoot = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-approval-root-")));
fs.mkdirSync(join(approvalRoot, ".claude/work/babysit"), { recursive: true });

const entry: RunEntry = {
    name: "fixture",
    cwd: approvalRoot,
    scope: ["src/a.ts", "src/with space.ts"],
    subject: "fix(tools): #1 followup - subject",
    verify: ["bunx biome check src/a.ts"],
};

describe("read-only chains", () => {
    test("a chain of readers is approved without the lead", () => {
        for (const command of [
            "pwd; git status --short; git rev-parse --path-format=absolute --git-common-dir; wc -l CLAUDE.md",
            "git diff --no-textconv --no-ext-diff --stat origin/master...HEAD; rg --files .claude/rules",
            "rg --files Genesis -g CLAUDE.md | rg 'rules/'",
            "gh pr view 93 --json body --jq .body",
            "sed -n '40,80p' src/a.ts && git log --no-textconv --no-ext-diff --oneline -5",
            "tools github review 93 --llm",
            "git diff --no-textconv --no-ext-diff --stat origin/master...HEAD; if test -f /x/AGENTS.md; then cat /x/AGENTS.md; fi",
        ]) {
            expect(readOnlyChain(entry, command)).toBe(true);
            expect(allowedCommand(entry, command)).toBe(true);
        }
    });

    test("anything that can write or run code still asks the lead", () => {
        for (const command of [
            "git diff > out.patch",
            "cat a.ts | tee b.ts",
            "rg x --pre ./run.sh",
            "find . -name '*.ts' -delete",
            "sed -i 's/a/b/' src/a.ts",
            "sed -n '1w out' src/a.ts",
            "git diff --output=x.patch",
            "git checkout -- src/a.ts",
            "gh api repos/o/r/issues/1/comments -f body=hi",
            "tools github review 93 respond t1 ok",
            "echo $(rm -rf x)",
            "sort -o a.txt b.txt",
            "uniq in.txt out.txt",
            "sleep 1 &",
            "cd /etc && cat passwd",
            "bun scripts/test.ts src/a.test.ts",
            "if test -f a; then rm a; fi",
            "then",
            "fi x",
        ]) {
            expect(readOnlyChain(entry, command)).toBe(false);
        }
    });

    test("a double-quoted shell wrapper with escapes unwraps when nothing in it expands", () => {
        const wrapped = String.raw`/bin/zsh -lc "sed -n '530,580p' a.ts; rg --heading -n '\\.md|Markdown' areas.json | head -20"`;
        expect(innerCommand(wrapped)).toBe(
            String.raw`sed -n '530,580p' a.ts; rg --heading -n '\.md|Markdown' areas.json | head -20`
        );
        expect(readOnlyChain(entry, innerCommand(wrapped))).toBe(true);
        expect(innerCommand(`/bin/zsh -lc "echo $HOME"`)).toBe(`/bin/zsh -lc "echo $HOME"`);
        expect(innerCommand('/bin/zsh -lc "echo `id`"')).toBe('/bin/zsh -lc "echo `id`"');
        expect(innerCommand(`/usr/local/bin/fish -c "ls"`)).toBe(`/usr/local/bin/fish -c "ls"`);
    });

    test("separators inside quotes do not split a command", () => {
        expect(chainSegments("rg 'a;b|c' src && pwd")).toEqual(["rg 'a;b|c' src", "pwd"]);
        expect(chainSegments("echo 'x > y'")).toEqual(["echo 'x > y'"]);
        expect(chainSegments("cat a 2>&1")).toBeNull();
    });
});

describe("fetch-threads", () => {
    test("reads each thread ref once, in numeric order", () => {
        expect(threadRefs("t10 a\nt2 b\nt1 c\nsee t2 again; not5 or at3x")).toEqual(["t1", "t2", "t10"]);
        expect(threadRefs("Stats: 0 threads")).toEqual([]);
    });
});

describe("integrate's gates", () => {
    test("run every guard of the pre-push hook with the same arguments", () => {
        const hook = fs.readFileSync(join(import.meta.dir, "../../../../.githooks/pre-push"), "utf8");
        const fromHook = [...hook.matchAll(/^run_guard (\S+) (.+)$/gm)].map((m) => [m[1], ...m[2].trim().split(/\s+/)]);
        expect(fromHook.length).toBeGreaterThan(5);
        expect(PRE_PUSH_GUARDS).toEqual([
            ["lint:dashboard", "bun", "run", "lint:dashboard"],
            ["typecheck:all", "bun", "run", "typecheck:all"],
            ...fromHook,
        ]);
    });
});

describe("negated tests", () => {
    test("a test ! guard before a read", () => {
        expect(readOnlyChain(entry, "test ! -f /x/AGENTS.md || cat /x/AGENTS.md")).toBe(true);
        expect(readOnlyChain(entry, "! rm x")).toBe(false);
        expect(readOnlyChain(entry, "test ! -f x || rm x")).toBe(false);
    });
});

describe("fixer checks", () => {
    test("a verify command under timeout or logged to the scratch folder is the same command", () => {
        const configured = entry.verify[0];
        expect(allowedCommand(entry, `timeout 600 ${configured}`)).toBe(true);
        expect(allowedCommand(entry, `timeout 600 ${configured} > .claude/work/babysit/r1.log 2>&1`)).toBe(true);
        expect(
            allowedCommand(entry, "timeout 600 bun scripts/test.ts src/a.test.ts > .claude/work/babysit/t.log 2>&1")
        ).toBe(true);
        expect(allowedCommand(entry, "bunx biome check --write src/a.ts")).toBe(true);
        for (const command of [
            `${configured} > src/a.ts 2>&1`,
            `${configured} > /tmp/x.log 2>&1`,
            `timeout 600 timeout 600 ${configured}`,
            "bunx biome check --write src/outside.ts",
            "bunx biome check --config-path x src/a.ts",
        ]) {
            expect({ command, ok: allowedCommand(entry, command) }).toEqual({ command, ok: false });
        }
    });
});

describe("fixer edits through fable-replace", () => {
    const cli = trustedCli;
    const spec = (target: string) => `@@ ${target}\n<<<\nold\n===\nnew\n>>>`;
    test("approved only when every target is in scope", () => {
        expect(allowedCommand(entry, `bun ${cli} <<'FR'\n${spec("src/a.ts")}\nFR`)).toBe(true);
        expect(
            allowedCommand(entry, `GENESIS_TOOLS_HOME=/tmp/cc/p/s/fr bun ${cli} <<'FR'\n${spec("src/a.ts")}\nFR`)
        ).toBe(true);
        for (const command of [
            `bun ${cli} <<'FR'\n${spec("src/outside.ts")}\nFR`,
            `bun ${cli} <<'FR'\n${spec("src/a.ts")}\n${spec("../other/b.ts")}\nFR`,
            `HOME=/tmp/cc/x bun ${cli} <<'FR'\n${spec("src/a.ts")}\nFR`,
            `TMPDIR=/Users/x bun ${cli} <<'FR'\n${spec("src/a.ts")}\nFR`,
            `bun /tmp/evil/cli.ts <<'FR'\n${spec("src/a.ts")}\nFR`,
            `bun ${cli} <<'FR'\n${spec("src/a.ts")}\nFR\nrm -rf src`,
            `TMPDIR=/tmp/cc/p/s/x$(touch\${IFS}/tmp/cc/p/s/owned) bun ${cli} <<'FR'\n${spec("src/a.ts")}\nFR`,
            `GENESIS_TOOLS_HOME=/tmp/cc/p/s/\`id\` bun ${cli} <<'FR'\n${spec("src/a.ts")}\nFR`,
        ]) {
            expect({ command, ok: allowedCommand(entry, command) }).toEqual({ command, ok: false });
        }
    });
});

describe("reviewer probe folder", () => {
    test("a reviewer's logged check may write to its own probe folder, never a sibling or a parent", () => {
        const probeRoot = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-reviewer-probe-")));
        const reviewer: RunEntry = { ...entry, role: "review", pr: 5, scratch: probeRoot };
        const check = "timeout 600 bun scripts/test.ts src/a.test.ts";
        expect(allowedCommand(reviewer, `${check} > ${probeRoot}/t.log 2>&1`)).toBe(true);
        for (const destination of [
            "/tmp/cc/p/s/review-50/t.log",
            "/tmp/cc/p/s/review-5/../t.log",
            "/tmp/cc/p/s/t.log",
        ]) {
            expect({ destination, ok: allowedCommand(reviewer, `${check} > ${destination} 2>&1`) }).toEqual({
                destination,
                ok: false,
            });
        }
        expect(allowedCommand(entry, `${check} > ${probeRoot}/t.log 2>&1`)).toBe(false);
    });
});

describe("reviewer reads", () => {
    test("the scratch folder by its absolute path, and the ts readers", () => {
        expect(allowedCommand(entry, `mkdir -p ${entry.cwd}/.claude/work/babysit`)).toBe(true);
        expect(allowedCommand(entry, "mkdir -p /tmp/elsewhere")).toBe(false);
        expect(
            readOnlyChain(
                { ...entry, cwd: join(import.meta.dir, "../../../..") },
                "./tools ts skeleton src/a.ts --top-level"
            )
        ).toBe(true);
        expect(readOnlyChain(entry, "tools ts duplicates src --recommend")).toBe(false);
        expect(readOnlyChain(entry, "./tools github review 5 --respond x")).toBe(false);
    });
});

describe("sed stays a reader", () => {
    test("a second script after the range is refused", () => {
        expect(readOnlyChain(entry, "sed -n 1,9p src/a.ts")).toBe(true);
        for (const command of [
            "sed -n 1p -e 'w /tmp/x' src/a.ts",
            "sed -n 1p -i src/a.ts",
            "sed -n 1p -f s.sed a",
            "git grep -O'touch /tmp/x; cat' name -- a.md",
            "git grep -Otouch name",
        ]) {
            expect({ command, ok: readOnlyChain(entry, command) }).toEqual({ command, ok: false });
        }
    });
});

describe("brief approval boundary", () => {
    test("the briefs' test command runs test files inside the worktree only", () => {
        expect(allowedCommand(entry, "timeout 600 bun scripts/test.ts src/a.test.ts src/ui/b.test.tsx")).toBe(true);
        expect(allowedCommand(entry, "bun scripts/test.ts src/a.test.ts")).toBe(true);
        for (const command of [
            "timeout 600 bun scripts/test.ts",
            "timeout 600 bun scripts/test.ts src/a.ts",
            "timeout 600 bun scripts/test.ts ../other/a.test.ts",
            "timeout 600 bun scripts/test.ts /etc/a.test.ts",
            "timeout 600 bun scripts/test.ts src/a.test.ts --preload evil.ts",
            "timeout 600 bun other.ts src/a.test.ts",
        ]) {
            expect({ command, ok: allowedCommand(entry, command) }).toEqual({ command, ok: false });
        }
    });

    test("verification requires the entire configured command", () => {
        expect(allowedCommand(entry, "bunx biome check src/a.ts")).toBe(true);
        // Biome with --write on a file of the scope is the brief's format step, allowed since 2026-10-16.
        expect(allowedCommand(entry, "bunx biome check src/a.ts --write")).toBe(true);
        for (const command of [
            "bunx biome check --write src/outside.ts",
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
                detail: `edit ${entry.cwd}/src/a.ts`,
                paths: [join(entry.cwd, "src/a.ts")],
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
            hiddenTools: 0,
            seen: new Set<string>(),
            seenTurn: -1,
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
    // A run card for another repository points run.main at a checkout with no ./tools (2026-10-14, GenesisPlayground).
    for (const name of ["steer.ts", "wait-turn.ts"]) {
        const source = fs.readFileSync(join(import.meta.dir, name), "utf8");
        expect(source).not.toContain('"./tools"');
        expect(source).toContain(name === "steer.ts" ? 'await execTool(["codex", "steer"' : "toolsEntrypoint()");
    }
    expect(toolsEntrypoint()).toBe(join(import.meta.dir, "../../../../tools"));
});

describe("merge-prep version conflicts", () => {
    const manifest = (version: string) => `{\n    "name": "genesis-tools",\n    "version": "${version}"\n}\n`;

    test("prepGit turns off hooks set in config, which ignore core.hooksPath", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-hooks-"));
        const git = prepGit(dir);
        const marker = join(dir, "hook-ran");

        git(["init", "-q"]);
        fs.appendFileSync(
            join(dir, ".git", "config"),
            `[hook "genesis-tools-pre-commit"]\n\tcommand = touch ${marker}\n\tevent = pre-commit\n`
        );
        fs.writeFileSync(join(dir, "a"), "a\n");
        git(["add", "a"]);
        expect(git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "m"]).code).toBe(0);
        expect(fs.existsSync(marker)).toBe(false);

        // Positive control: the same commit without the switches runs the hook.
        fs.writeFileSync(join(dir, "a"), "b\n");
        Bun.spawnSync(["git", "-C", dir, "add", "a"], { env: process.env });
        Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "n"], {
            env: process.env,
        });
        expect(fs.existsSync(marker)).toBe(true);
    });

    test("the higher version wins on either side, numerically", () => {
        expect(higherVersionSide(manifest("1.0.96"), manifest("1.0.82"))).toBe("--ours");
        expect(higherVersionSide(manifest("1.0.82"), manifest("1.0.96"))).toBe("--theirs");
        expect(higherVersionSide(manifest("1.0.100"), manifest("1.0.99"))).toBe("--ours");
    });

    test("a version-only conflict resolves to the higher version; a code conflict is left alone", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-versions-"));
        const git = prepGit(dir);
        const file = "plugins/genesis-tools/.claude-plugin/plugin.json";
        const write = (path: string, text: string) => {
            fs.mkdirSync(join(dir, path, ".."), { recursive: true });
            fs.writeFileSync(join(dir, path), text);
        };
        const commit = (message: string) => {
            git(["add", "-A"]);
            git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", message]);
        };

        git(["init", "-q", "-b", "main"]);
        const mergedManifest = (version: string, skills: string) =>
            SafeJSON.stringify(
                { version, name: "fixture", description: "fixture", commands: [], hooks: {}, skills },
                null,
                4
            ) + "\n";
        write(file, mergedManifest("1.0.80", "./old-skills/"));
        write("src/a.ts", "export const a = 1;\n");
        commit("base");
        git(["checkout", "-qb", "child"]);
        write(file, mergedManifest("1.0.81", "./new-skills/"));
        commit("child bump");
        git(["checkout", "-q", "main"]);
        write(file, mergedManifest("1.0.96", "./old-skills/"));
        commit("main bump");

        expect(git(["cherry-pick", "child"]).code).not.toBe(0);
        expect(resolveVersionConflicts(git, conflictedFiles(git))).toBe(true);
        expect(fs.readFileSync(join(dir, file), "utf8")).toContain('"1.0.96"');
        expect(fs.readFileSync(join(dir, file), "utf8")).toContain('"./new-skills/"');
        git(["cherry-pick", "--skip"]);

        git(["checkout", "-qb", "code", "child"]);
        write("src/a.ts", "export const a = 2;\n");
        commit("code change");
        git(["checkout", "-q", "main"]);
        write("src/a.ts", "export const a = 3;\n");
        commit("main code change");

        expect(git(["cherry-pick", "code"]).code).not.toBe(0);
        const conflicted = conflictedFiles(git);
        expect(conflicted).toContain("src/a.ts");
        expect(resolveVersionConflicts(git, conflicted)).toBe(false);
        expect(fs.readFileSync(join(dir, "src/a.ts"), "utf8")).toContain("<<<<<<<");
    });
});

test("the probe for another repository's push fails only on a hit in a line the push adds", () => {
    // The probe's hit list: two files, one hit each (the matched text is fixture filler).
    const probe = ["✗ placeholder-check: 2 line(s)", "    docs/OLD.md:4:filler", "    src/a.swift:12:filler"].join(
        "\n"
    );
    // A diff that adds lines 10-13 of src/a.swift and line 9 of docs/OLD.md.
    const diff = [
        "diff --git a/src/a.swift b/src/a.swift",
        "+++ b/src/a.swift",
        "@@ -9,0 +10,4 @@ func f() {",
        "+line",
        "diff --git a/docs/OLD.md b/docs/OLD.md",
        "+++ b/docs/OLD.md",
        "@@ -9 +9 @@",
        "+line",
    ].join("\n");
    expect(hitsInAddedLines(probe, diff)).toEqual(["src/a.swift:12"]);
    // The same hits with a diff that adds nothing near them: an older hit does not block the push.
    expect(hitsInAddedLines(probe, "+++ b/src/a.swift\n@@ -1,0 +2,3 @@\n+x")).toEqual([]);
});

test("a run card for another repository supplies its own verify bullets", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "babysit-run-"));
    fs.writeFileSync(
        join(dir, "run.json"),
        SafeJSON.stringify({ repo: "owner/other", verify: ["swift typecheck only"] })
    );
    expect(loadRun(dir).verify).toEqual(["swift typecheck only"]);
    // No list (or a list that is not all strings): fill-brief falls back to this repository's commands.
    fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "owner/other", verify: [1] }));
    expect(loadRun(dir).verify).toBeUndefined();
});
describe("independent review brief", () => {
    test("every PR reference in the brief is the one PR", () => {
        for (const postMerge of [false, true]) {
            const text = reviewBrief({
                pr: 498,
                title: "fixture title",
                wt: "/fixture/wt",
                base: "master",
                scratch: "/fixture/scratch",
                postMerge,
                swift: true,
            });
            const numbers = [...text.matchAll(/(?:#|gh pr (?:view|diff) |review )(\d+)|\/(\d+)-review\.md/g)].map(
                (m) => m[1] ?? m[2]
            );
            expect(numbers.length).toBeGreaterThanOrEqual(postMerge ? 5 : 4);
            expect(new Set(numbers)).toEqual(new Set(["498"]));
            expect(text).toContain(
                postMerge ? "gh pr diff 498" : "git diff --no-textconv --no-ext-diff origin/master...HEAD"
            );
        }
    });

    test("a fresh PR's brief says the bots review next to it, not that they found nothing", () => {
        const input = { pr: 498, title: "t", wt: "/w", base: "master", scratch: "/s", postMerge: false, swift: false };
        const fresh = reviewBrief({ ...input, fresh: true });
        expect(fresh).toContain("was just opened");
        expect(fresh).not.toContain("found nothing more");
        expect(fresh).not.toContain("already answered");
        expect(reviewBrief(input)).toContain("found nothing more");
    });
});
describe("planted-regression summary", () => {
    test("reads bun counts and the XCTest total, and says so when there is none", () => {
        expect(summarize("x\n 53 pass\n 3 fail\nRan 56 tests")).toBe("53 pass 3 fail");
        expect(
            summarize(
                "Executed 2 tests, with 1 failure (0 unexpected) in 0.1 (0.1) seconds\nExecuted 158 tests, with 0 failures (0 unexpected) in 10.1 (10.2) seconds"
            )
        ).toBe("Executed 158 tests, with 0 failures (0 unexpected) in 10.1 (10.2) seconds");
        expect(summarize("bun test v1.4.2")).toBe("no test count");
    });
});

// d9687720a (2026-10-14): an inline resolver returned any string pick as text, so ["ours", "ours"] wrote the word
// `ours` into both plugin manifests and the plugin did not load for 12 hours.
describe("conflict resolution helper", () => {
    const two = [
        "{\n",
        "<<<<<<< HEAD\n",
        '    "version": "1.0.101",\n',
        "=======\n",
        '    "version": "1.0.99",\n',
        ">>>>>>> pick\n",
        '    "name": "genesis-tools",\n',
        "<<<<<<< HEAD\n",
        '    "a": 1\n',
        "||||||| base\n",
        '    "a": 0\n',
        "=======\n",
        '    "a": 2\n',
        ">>>>>>> pick\n",
        "}\n",
    ].join("");
    const picks = (...sides: Array<"ours" | "theirs" | "both" | "base">): ConflictPick[] =>
        sides.map((side) => ({ side }));

    test("a pick is a side or explicit text, so a side's name is never written into the file", () => {
        expect(resolveConflictText(two, picks("ours", "theirs"))).toBe(
            '{\n    "version": "1.0.101",\n    "name": "genesis-tools",\n    "a": 2\n}\n'
        );
        expect(resolveConflictText(two, picks("theirs", "base"))).toBe(
            '{\n    "version": "1.0.99",\n    "name": "genesis-tools",\n    "a": 0\n}\n'
        );
        expect(resolveConflictText(two, [{ text: "" }, { side: "ours" }])).toBe(
            '{\n    "name": "genesis-tools",\n    "a": 1\n}\n'
        );
        // The d9687720a call, made the way its untyped inline script made it.
        expect(() => Reflect.apply(resolveConflictText, null, [two, ["ours", "ours"]])).toThrow("never a bare string");
    });

    test("one pick per block, every block closed, and base only from the diff3 form", () => {
        expect(() => resolveConflictText(two, picks("ours"))).toThrow("conflict block 2 has no pick (1 given)");
        expect(() => resolveConflictText(two, picks("ours", "ours", "ours"))).toThrow(
            "3 pick(s) for 2 conflict block(s)"
        );
        expect(() => resolveConflictText("<<<<<<< HEAD\na\n=======\n", picks("ours"))).toThrow("is not closed");
        expect(() => resolveConflictText(two, picks("base", "ours"))).toThrow("conflict block 1 has no base section");
        expect(resolveConflictText(two, picks("both", "ours"))).toContain('"1.0.101",\n    "version": "1.0.99",\n');
    });

    test("the check names a conflict marker left and a JSON file that does not parse, and nothing else", () => {
        const files: Record<string, string> = {
            "src/a.ts": "export const a = 1;\n<<<<<<< HEAD\n",
            ".claude-plugin/marketplace.json": '{\nours    "description": "Skills"\n}\n',
            "plugins/p/.claude-plugin/plugin.json": '{ "version": "1.0.101" }\n',
            "docs/a.md": "Title\n=======\n",
        };

        expect(resolutionProblems(Object.keys(files), (file) => files[file] ?? "")).toEqual([
            "src/a.ts:2: conflict marker left",
            expect.stringContaining(".claude-plugin/marketplace.json: JSON Parse error"),
        ]);
    });

    test("the version resolver refuses a side whose manifest does not parse", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-broken-manifest-"));
        const git = prepGit(dir);
        const file = ".claude-plugin/marketplace.json";
        const manifest = (version: string) => `{\n    "name": "genesis-tools",\n    "version": "${version}"\n}\n`;
        const commit = (text: string, message: string) => {
            fs.mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
            fs.writeFileSync(join(dir, file), text);
            git(["add", "-A"]);
            git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", message]);
        };

        git(["init", "-q", "-b", "main"]);
        commit(manifest("1.0.80"), "base");
        git(["checkout", "-qb", "child"]);
        commit(manifest("1.0.81"), "child bump");
        git(["checkout", "-q", "main"]);
        // The higher version is on the side that already carries the stray word, as unified did after d9687720a.
        commit(manifest("1.0.96").replace('    "name"', 'ours    "name"'), "broken bump");

        expect(git(["cherry-pick", "child"]).code).not.toBe(0);
        expect(resolveVersionConflicts(git, conflictedFiles(git))).toBe(false);
        git(["cherry-pick", "--abort"]);
    });
});

test("a status that keeps failing names the exit and the output, then hands over to the lead", async () => {
    const messages: string[] = [];
    const output = spyOn(console, "log").mockImplementation((value) => messages.push(String(value)));
    const errors = spyOn(console, "error").mockImplementation((value) => messages.push(String(value)));
    let time = 0;
    const exec: typeof execTool = async () => ({
        success: false,
        exitCode: 1,
        stderr: "",
        stdout: "no session named fixture\n",
    });

    try {
        await watchApprovals({
            entry,
            exec,
            now: () => time,
            sleep: async (ms) => {
                time += ms;
            },
            timeoutMs: 1_000,
            pollMs: 5,
        });
        expect(messages[0]).toBe("[approver] status failed (exit 1): no session named fixture");
        expect(messages.filter((line) => line.startsWith("[approver] status failed"))).toHaveLength(10);
        expect(messages.at(-1)).toBe(
            "[approver] NEEDS LEAD: codex status failed 10 times in a row for fixture; stopped"
        );
        expect(time).toBe(45);
    } finally {
        output.mockRestore();
        errors.mockRestore();
    }
});

test("--run takes the run folder or its run.json, and refuses anything that would fall back to another repo", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "babysit-run-"));
    try {
        const card = join(dir, "run.json");
        fs.writeFileSync(card, SafeJSON.stringify({ repo: "example/playground" }));
        expect(runPaths(dir)).toEqual({ runDir: dir, cardPath: card });
        expect(runPaths(card)).toEqual({ runDir: dir, cardPath: card });
        expect(() => runPaths(join(dir, "missing"))).toThrow("is not a folder");
        expect(() => runPaths(join(dir, "missing", "run.json"))).toThrow("no run card");
        fs.writeFileSync(join(dir, "notes.md"), "x");
        expect(() => runPaths(join(dir, "notes.md"))).toThrow("is not a folder");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe("round 1 regression guards", () => {
    test("version resolution preserves merged fields and rejects mixed conflicts", () => {
        const text =
            '{\n<<<<<<< HEAD\n    "version": "1.0.96",\n=======\n    "version": "1.0.81",\n>>>>>>> child\n    "skills": "./new-skills/"\n}\n';
        expect(resolveVersionText(text)).toBe('{\n    "version": "1.0.96",\n    "skills": "./new-skills/"\n}\n');
        expect(
            resolveVersionText(text.replace('    "version": "1.0.81",', '    "version": "1.0.81",\n    "hooks": {}'))
        ).toBeNull();
        expect(
            resolveVersionText(text.replace("=======", '||||||| base\n    "version": "1.0.80",\n======='))
        ).toContain('"1.0.96"');
        expect(resolveVersionText(text.replace(">>>>>>> child", ">>>>>>> child\n<<<<<<< unclosed"))).toBeNull();
    });

    test("an older hit never hides an added hit in a space path or an unparseable hit", () => {
        const original = Bun.spawnSync;
        const diff = "+++ b/docs/New Guide.md\n@@ -0,0 +1 @@\n+fixture\n";
        let output = "    docs/old.md:4:fixture\n    docs/New Guide.md:1:fixture\n";
        const spawn = spyOn(Bun, "spawnSync").mockImplementation((command, options) =>
            original(
                [
                    process.execPath,
                    "-e",
                    command[0] === "bash"
                        ? "console.log(" + SafeJSON.stringify(output) + "); process.exit(1)"
                        : command.includes("ls-files")
                          ? "process.stdout.write('docs/old.md\\0docs/New Guide.md\\0')"
                          : "console.log(" + SafeJSON.stringify(diff) + ")",
                ],
                options
            )
        );
        try {
            expect(hitsInAddedLines(output, diff)).toEqual(["docs/New Guide.md:1"]);
            expect(hitsInAddedLines('    "docs/New\\tGuide.md":1:fixture', diff)).toEqual(["unparseable probe hit"]);
            expect(probeAddedLines({ wt: ".", from: "a", to: "b" })).toBe(false);
            output = "    docs/old.md:4:fixture\n    malformed hit\n";
            expect(probeAddedLines({ wt: ".", from: "a", to: "b" })).toBe(false);
            output = "    docs/old.md:4:fixture\n";
            expect(probeAddedLines({ wt: ".", from: "a", to: "b" })).toBe(true);
            expect(
                hitsInAddedLines("    docs/New Guide.md:1:fixture", '+++ "b/docs/New Guide.md"\n@@ -0,0 +1 @@')
            ).toEqual(["docs/New Guide.md:1"]);
        } finally {
            spawn.mockRestore();
        }
    });

    test("lsof must return a complete successful listing before reclamation", () => {
        const original = Bun.spawnSync;
        let code = 1;
        let listing = "p123\nn/fixture/open\n";
        const spawn = spyOn(Bun, "spawnSync").mockImplementation((_command, options) =>
            original(
                [
                    process.execPath,
                    "-e",
                    "console.log(" + SafeJSON.stringify(listing) + "); process.exit(" + code + ")",
                ],
                options
            )
        );
        try {
            expect(() => openPaths()).toThrow("listing incomplete");
            code = 0;
            expect(openPaths()).toEqual(["/fixture/open"]);
            listing = "";
            expect(() => openPaths()).toThrow("listing incomplete");
        } finally {
            spawn.mockRestore();
        }
    });

    test("executable probes remain on disk after success and timeout", async () => {
        const original = Bun.spawn;
        const files: string[] = [];
        let slow = false;
        // Run the existing interpreter, avoiding a new executable's OS approval during the test.
        const spawn = spyOn(Bun, "spawn").mockImplementation((command, options) => {
            files.push(String(command[0]));
            return original(
                slow ? [process.execPath, "-e", "await Bun.sleep(10000)"] : ["/bin/sh", String(command[0])],
                options
            );
        });
        try {
            expect(await newExecutablesStall(1000)).toBe(false);
            slow = true;
            expect(await newExecutablesStall(5)).toBe(true);
            for (const file of files) {
                expect(fs.readFileSync(file, "utf8")).toBe("#!/bin/sh\nexit 0\n");
            }
            expect(files).toHaveLength(2);
        } finally {
            spawn.mockRestore();
        }
    });

    test("posting failure remains a failure even when other replies succeed", () => {
        expect(postingExitCode(1, [{ code: 0 }])).toBe(1);
        expect(postingExitCode(0, [{ code: 1 }, { code: 0 }])).toBe(1);
        expect(postingExitCode(0, [{ code: 0 }])).toBe(0);
    });

    test("plants require executed failures and completed passing runs", () => {
        const failed = "(fail) regression\n 0 pass\n 1 fail\n[test] suite complete (exit 1)";
        const passed = " 1 pass\n 0 fail\n[test] suite complete (exit 0)";
        expect(testEvidence({ code: 1, out: failed }, true)).toBe(true);
        expect(testEvidence({ code: 0, out: passed }, false)).toBe(true);
        for (const out of ["error: No matching export", "0 pass\n0 fail\n[test] suite complete (exit 1)"]) {
            expect(testEvidence({ code: 1, out }, true)).toBe(false);
        }
        expect(testEvidence({ code: 1, out: failed.replace("[test] suite complete (exit 1)", "") }, true)).toBe(true);
        expect(testEvidence({ code: 1, out: "1 fail\n[test] suite complete (exit 1)" }, true)).toBe(true);
        expect(testEvidence({ code: 0, out: passed.replace("[test] suite complete (exit 0)", "") }, false)).toBe(false);
        expect(testEvidence({ code: 0, out: "0 pass\n0 fail\n[test] suite complete (exit 0)" }, false)).toBe(false);
        expect(testEvidence({ code: 1, out: "Executed 2 tests, with 1 failure" }, true)).toBe(true);
        expect(testEvidence({ code: 0, out: "Executed 2 tests, with 0 failures" }, false)).toBe(true);
    });

    test("judge pack includes the worker report next to the claims and diff", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-judge-"));
        const report = join(dir, "report.txt");
        fs.writeFileSync(report, "VERIFY: fixture check passed\nOPEN: fixture concern\n");
        const result = Bun.spawnSync(
            [process.execPath, join(import.meta.dir, "judge-pack.ts"), "--range", "HEAD..HEAD", "--report", report],
            { stdout: "pipe", stderr: "pipe", env: process.env }
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toContain("VERIFY: fixture check passed");
        expect(result.stdout.toString()).toContain("OPEN: fixture concern");
        expect(result.stdout.toString()).toContain("# Diff HEAD..HEAD");
    });
});

describe("round 2 regression guards", () => {
    test("log redirects approve one literal scratch path and reject shell execution", () => {
        for (const destination of [
            ".claude/work/babysit/x;touch${IFS}/tmp/babysit-owned",
            ".claude/work/babysit/x;pwd",
            ".claude/work/babysit/$(pwd)",
            ".claude/work/babysit/\x60pwd\x60".replaceAll("\\x60", String.fromCharCode(96)),
            ".claude/work/babysit/x|pwd",
            ".claude/work/babysit/x&pwd",
            ".claude/work/babysit/x\npwd",
            ".claude/work/babysit/*",
            ".claude/work/babysit/x outside",
            "'../outside.log'",
        ]) {
            expect(allowedCommand(entry, "pwd > " + destination + " 2>&1")).toBe(false);
        }
        expect(allowedCommand(entry, "pwd > .claude/work/babysit/x.log 2>&1")).toBe(true);
        expect(
            allowedCommand(entry, "timeout 600 bunx biome check src/a.ts > '.claude/work/babysit/with space.log' 2>&1")
        ).toBe(true);
        expect(allowedCommand(entry, "touch outside > .claude/work/babysit/x.log 2>&1")).toBe(false);
    });

    test("Swift slot has one owner for concurrent stale-file contenders and releases on exit", async () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-slot-"));
        const lock = join(dir, "slot.lock");
        fs.writeFileSync(lock, "99999999");
        const module = join(import.meta.dir, "swift-slot.ts");
        const code =
            "const { trySwiftSlot } = await import(" +
            SafeJSON.stringify(module) +
            "); const release = trySwiftSlot(" +
            SafeJSON.stringify(lock) +
            '); console.log(release ? "held" : "busy"); if (release) { for await (const _ of Bun.stdin.stream()) { break; } }';
        const children = [0, 1].map(() =>
            Bun.spawn([process.execPath, "-e", code], {
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
                env: process.env,
            })
        );
        try {
            const results = await Promise.all(
                children.map(async (child) => {
                    const first = await child.stdout.getReader().read();
                    return new TextDecoder().decode(first.value).trim();
                })
            );
            expect(results.sort()).toEqual(["busy", "held"]);
            expect(trySwiftSlot(lock)).toBeNull();
        } finally {
            for (const child of children) {
                child.stdin.end("release\n");
            }
            await Promise.all(children.map((child) => child.exited));
        }
        const release = trySwiftSlot(lock);
        expect(release).not.toBeNull();
        release?.();
        release?.();
        expect(fs.readFileSync(lock, "utf8")).toBe("99999999");
        // The old unlink/read race cannot arise: missing files are created and no PID file is read.
        const fresh = trySwiftSlot(join(dir, "missing.lock"));
        expect(fresh).not.toBeNull();
        fresh?.();
    });

    test("standalone Swift library, executable and test commands share the package identity", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-swift-"));
        const pkg = join(dir, "Fixture-Kit");
        fs.mkdirSync(pkg);
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        fs.writeFileSync(
            join(pkg, "Package.swift"),
            'let package = Package(name: "Fixture", targets: [.target(name: "Kit"), .executableTarget(name: "App"), .testTarget(name: "KitTests")])'
        );
        for (const target of ["Sources/Kit", "Sources/App", "Tests/KitTests"]) {
            fs.mkdirSync(join(pkg, target), { recursive: true });
            fs.writeFileSync(
                join(pkg, target, "Fixture.swift"),
                target.startsWith("Tests/") ? "@testable import App\n" : "package func fixture() {}\n"
            );
        }
        const original = Bun.spawnSync;
        const success = original([process.execPath, "-e", ""], { stdout: "pipe", stderr: "pipe", env: process.env });
        const commands: string[][] = [];
        const spawn = spyOn(Bun, "spawnSync").mockImplementation((command) => {
            const words = Array.from(command, String);
            if (words[0] === "xcrun" && words[1] === "swiftc") {
                commands.push(words);
                const moduleName = words[words.indexOf("-module-name") + 1];
                if (words.includes("-emit-module") && words.includes("-enable-testing")) {
                    fs.writeFileSync(words[words.indexOf("-emit-module-path") + 1], "fresh " + moduleName);
                }
                const appModule = join(dir, "out", "App.swiftmodule");
                const good =
                    words.includes("-package-name") &&
                    words[words.indexOf("-package-name") + 1] === "fixture_kit" &&
                    (moduleName !== "KitTests" ||
                        (fs.existsSync(appModule) && fs.readFileSync(appModule, "utf8") === "fresh App"));
                return {
                    ...success,
                    exitCode: good ? 0 : 1,
                    stderr: Buffer.from(good ? "" : "fixture.swift:1: error: package name required"),
                };
            }
            return { ...success, stdout: Buffer.from(dir) };
        });
        const argv = process.argv;
        process.argv = [
            process.execPath,
            "swift-typecheck.ts",
            "--package",
            pkg,
            "--run",
            dir,
            "--out",
            join(dir, "out"),
            "--deps",
            dir,
        ];
        try {
            expect(typecheckPackage()).toBe(0);
            expect(commands).toHaveLength(3);
            expect(commands.filter((words) => words.includes("-emit-module"))).toHaveLength(2);
            expect(commands.filter((words) => words.includes("-typecheck"))).toHaveLength(1);
            const app = commands.find((words) => words.includes("App"));
            expect(app).toContain("-enable-testing");
            expect(fs.readFileSync(join(pkg, "Tests/KitTests/Fixture.swift"), "utf8")).toContain(
                "@testable import App"
            );
        } finally {
            spawn.mockRestore();
            process.argv = argv;
        }
    });

    test("worker attribution parses unchanged ledgers once, and refreshes changed or removed ledgers", () => {
        const dirs = [0, 1].map(() => fs.mkdtempSync(join(tmpdir(), "babysit-task-")));
        appendEvent(dirs[0], { kind: "spawn", worker: "worker", pr: 1, round: 1, at: "2026-01-01T00:00:00Z" });
        appendEvent(dirs[1], { kind: "steer", worker: "worker", pr: 2, round: 2, at: "2026-01-01T01:00:00Z" });
        let reads = 0;
        const lookup = createTaskLookup({
            dirs,
            read: (dir) => {
                reads++;
                return readEvents(dir);
            },
        });
        for (let n = 0; n < 100; n++) {
            expect(lookup("worker")).toBe(" #2 r2");
            expect(lookup("missing")).toBe("");
        }
        expect(reads).toBe(2);
        appendEvent(dirs[0], { kind: "steer", worker: "worker", pr: 3, round: 1, at: "2026-01-01T02:00:00Z" });
        expect(lookup("worker")).toBe(" #3 r1");
        expect(reads).toBe(3);
        fs.renameSync(join(dirs[0], "ledger.jsonl"), join(dirs[0], "saved.jsonl"));
        expect(lookup("worker")).toBe(" #2 r2");
        expect(reads).toBe(3);
    });

    test("failed continuations never skip nonempty picks or hide skip failures", () => {
        let empty = false;
        let continuation = 1;
        let skip = 0;
        let state = 0;
        let unmerged = "";
        const calls: string[] = [];
        const git = (args: string[]) => {
            calls.push(args.join(" "));
            if (args[1] === "--continue") {
                return { code: continuation, out: "commit failed" };
            }
            if (args[1] === "--skip") {
                return { code: skip, out: "skip diagnostic" };
            }
            if (args[0] === "rev-parse") {
                return { code: state, out: "fixture-sha" };
            }
            if (args[0] === "ls-files") {
                return { code: 0, out: unmerged };
            }
            return { code: empty ? 0 : 1, out: "" };
        };
        expect(continueVersionPick(git)).toEqual({ code: 1, out: "commit failed" });
        expect(calls).not.toContain("cherry-pick --skip");
        empty = true;
        expect(continueVersionPick(git).skipped).toBe(true);
        skip = 1;
        expect(continueVersionPick(git)).toEqual({ code: 1, out: "commit failedskip diagnostic" });
        calls.length = 0;
        state = 1;
        expect(continueVersionPick(git).code).toBe(1);
        expect(calls).not.toContain("cherry-pick --skip");
        state = 0;
        unmerged = "unmerged fixture";
        expect(continueVersionPick(git).code).toBe(1);
        expect(calls).not.toContain("cherry-pick --skip");
        continuation = 0;
        calls.length = 0;
        expect(continueVersionPick(git).code).toBe(0);
        expect(calls).toEqual(["cherry-pick --continue"]);
    });

    test("landing push is recorded before any later merge failure, and failed pushes record nothing", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-land-"));
        const options = {
            run: dir,
            pr: 536,
            branch: "fixture",
            oldHead: "before",
            newHead: "after",
            result: { code: 0, out: "pushed" },
        };
        recordLandingPush(options);
        expect(readEvents(dir)).toMatchObject([
            { kind: "push", pr: 536, meta: { branch: "fixture", from: "before", to: "after", source: "land.ts" } },
        ]);
        expect(() => recordLandingPush({ ...options, result: { code: 1, out: "push rejected" } })).toThrow(
            "push rejected"
        );
        expect(readEvents(dir)).toHaveLength(1);
    });
});

describe("round 3 approval boundaries", () => {
    const spec = "@@ src/a.ts\n<<<\nold\n===\nnew\n>>>";
    const invocation = (body: string) => "bun " + trustedCli + " <<'FR'\n" + body + "\nFR";

    test("GitHub review reads use complete allowlisted flags and subcommands", () => {
        for (const command of [
            "./tools github review 5 --resolve-thread -t PRRT_fixture",
            "./tools github review 5 -r fixed -t PRRT_fixture",
            "./tools github review comment 5 --body text --file src/a.ts --line 1 --now",
            "tools github review 5 --respond=fixed --thread-id=PRRT_fixture",
            "tools github review 5 --worktree",
            "tools github review 5 --save",
            "tools github review summary --resolve",
            "tools github review expand t1 -s fixture --resolve-thread",
            "tools github review 5 --unknown",
            "tools github review 5 --repo",
        ]) {
            expect(allowedCommand(entry, command)).toBe(false);
        }
        for (const command of [
            "tools github review 5 --llm -u -s fixture --repo fixture/repo",
            "tools github review 5 --json --session=fixture --author=reviewer",
            "tools github review expand t1,t2 --session fixture",
            "tools github review summary -s fixture",
            "tools github review sessions",
        ]) {
            expect(allowedCommand(entry, command)).toBe(true);
        }
    });

    test("fable moves and destination-writing modifiers always require the lead", () => {
        for (const marker of [
            "<<< move to=src/outside.ts lines=1-1",
            "<<<move to=src/outside.ts lines=1-1",
            "<<< move to=src/a.ts symbol=fixture imports=fix",
            "<<< optional move to=src/outside.ts lines=1-1",
            "<<< to=src/outside.ts move lines=1-1",
            "<<< renameTo=src/outside.ts",
        ]) {
            const command = invocation("@@ src/a.ts\n" + marker + "\n>>>");
            expect(fableReplaceCommand(entry, command)).toBe(false);
            expect(allowedCommand(entry, command)).toBe(false);
        }
        const json = '[\n/*\n@@ src/a.ts\n*/\n{"file":"src/outside.ts","createWith":"fixture"}\n]';
        expect(fableReplaceCommand(entry, invocation(json))).toBe(false);
        expect(fableReplaceCommand(entry, invocation(spec))).toBe(true);
    });

    test("Git readers require disabling flags before paths, without later re-enabling converters", () => {
        for (const verb of ["diff", "show", "log", "blame", "grep"]) {
            const safe =
                "git " + verb + " --no-textconv" + (["diff", "show", "log"].includes(verb) ? " --no-ext-diff" : "");
            expect(allowedCommand(entry, "git " + verb + " fixture")).toBe(false);
            expect(allowedCommand(entry, safe)).toBe(true);
            expect(allowedCommand(entry, safe + " --textconv")).toBe(false);
            expect(allowedCommand(entry, safe + " --textconv=true")).toBe(false);
            expect(allowedCommand(entry, "git " + verb + " -- --no-textconv --no-ext-diff")).toBe(false);
        }
        expect(allowedCommand(entry, "git diff --no-textconv")).toBe(false);
        expect(allowedCommand(entry, "git diff --no-textconv --no-ext-diff --ext-diff=true")).toBe(false);
    });

    test("an approved Git read never reaches a configured text converter", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-converter-"));
        const git = prepGit(dir);
        expect(git(["init", "-q"]).code).toBe(0);
        const marker = join(dir, "converter-ran");
        fs.appendFileSync(join(dir, ".git/config"), '\n[diff "fixture"]\n\ttextconv = /usr/bin/touch ' + marker + "\n");
        fs.writeFileSync(join(dir, ".gitattributes"), "*.txt diff=fixture\n");
        fs.writeFileSync(join(dir, "fixture.txt"), "before\n");
        expect(git(["add", "--", ".gitattributes", "fixture.txt"]).code).toBe(0);
        fs.writeFileSync(join(dir, "fixture.txt"), "after\n");
        // Positive fixture control proves this repository really has an executable text converter.
        expect(git(["diff"]).code).toBe(0);
        expect(fs.existsSync(marker)).toBe(true);
        fs.renameSync(marker, join(dir, "positive-control"));
        const worker = { ...entry, cwd: dir };
        const unsafe = "git diff -- fixture.txt";
        expect(allowedCommand(worker, unsafe)).toBe(false);
        if (allowedCommand(worker, unsafe)) {
            git(["diff", "--", "fixture.txt"]);
        }
        const safe = "git diff --no-textconv --no-ext-diff -- fixture.txt";
        expect(allowedCommand(worker, safe)).toBe(true);
        expect(git(["diff", "--no-textconv", "--no-ext-diff", "--", "fixture.txt"]).code).toBe(0);
        expect(fs.existsSync(marker)).toBe(false);
    });

    test("fable heredoc terminators and shell expansions never reach command execution", () => {
        const normal = invocation(spec);
        expect(fableReplaceCommand(entry, normal)).toBe(true);
        const bad = [
            "FABLE_REPLACE_HOME=/tmp/cc/p/s/journal TMPDIR=/tmp/cc/p/s/$(true>/tmp/cc/p/s/env-expansion-proof) " +
                normal,
            "TMPDIR=/tmp/cc/p/s/x$(touch\x24{IFS}/tmp/cc/p/s/owned) " + normal,
            "bun " + trustedCli + " <<'FR'\n" + spec + "\nFR\ntrue > /tmp/cc/p/s/heredoc-proof\nFR",
            "bun " + trustedCli.replace("/plugins/", "/$(true)/plugins/") + " <<'FR'\n" + spec + "\nFR",
        ];
        const execute = spyOn(Bun, "spawnSync").mockImplementation(() => {
            throw new Error("unauthorized execution reached");
        });
        try {
            for (const command of bad) {
                const decision = decide(entry, {
                    method: "item/commandExecution/requestApproval",
                    cwd: entry.cwd,
                    command,
                });
                if (decision.ok) {
                    Bun.spawnSync(["/bin/zsh", "-c", command], { env: process.env });
                }
                expect(decision.ok).toBe(false);
            }
            expect(execute).not.toHaveBeenCalled();
        } finally {
            execute.mockRestore();
        }
    });

    test("fable CLI trust rejects worker copies and symlinks while accepting approver-owned tools", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-cli-"));
        const fake = join(dir, ".claude/work/babysit/plugins/genesis-tools/skills/fable-replace/scripts/cli.ts");
        fs.mkdirSync(dirname(fake), { recursive: true });
        fs.writeFileSync(fake, "throw new Error('worker-written script executed');\n");
        const command = (cli: string) => "bun " + cli + " <<'FR'\n" + spec + "\nFR";
        expect(allowedCommand(entry, command(trustedCli))).toBe(true);
        const cached = join(
            homedir(),
            ".codex/plugins/cache/genesis-tools/genesis-tools/1.0.107/skills/fable-replace/scripts/cli.ts"
        );
        if (fs.existsSync(cached)) {
            expect(allowedCommand(entry, command(cached))).toBe(true);
        }
        const symlink = join(
            dir,
            ".claude/work/babysit/link/plugins/genesis-tools/skills/fable-replace/scripts/cli.ts"
        );
        fs.mkdirSync(dirname(symlink), { recursive: true });
        fs.symlinkSync(trustedCli, symlink);
        const execute = spyOn(Bun, "spawnSync").mockImplementation(() => {
            throw new Error("worker script reached execution");
        });
        try {
            for (const cli of [fake, symlink]) {
                const decision = decide(entry, {
                    method: "item/commandExecution/requestApproval",
                    cwd: entry.cwd,
                    command: command(cli),
                });
                if (decision.ok) {
                    Bun.spawnSync(["/bin/zsh", "-c", command(cli)], { env: process.env });
                }
                expect(decision.ok).toBe(false);
            }
            expect(execute).not.toHaveBeenCalled();
        } finally {
            execute.mockRestore();
        }
    });
});

describe("round 5 carried findings", () => {
    const workerFor = (backend: "grok" | "codex") => ({
        backend,
        name: "fixture",
        label: backend + ":fixture",
        lastAt: 0,
        running: true,
        stallSaid: false,
        hiddenTools: 0,
        seen: new Set<string>(),
        seenTurn: 1,
    });
    const feed = (lines: string[]) => [
        process.execPath,
        "-e",
        "process.stdout.write(" + SafeJSON.stringify(lines.join("\n") + "\n") + ")",
    ];

    test("Codex displays repeated commands within and across turns", async () => {
        const output: string[] = [];
        const log = spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
        const worker = workerFor("codex");
        const tool = "\u{1f527} exec_command echo fixture";
        try {
            expect(
                await pump(
                    worker,
                    feed(["\u25B6 turn 1", tool, tool, "\u2714 turn 1", "\u25B6 turn 2", tool, "\u2714 turn 2"])
                )
            ).toBe(0);
            expect(output.filter((line) => line.includes("tool exec_command echo fixture"))).toHaveLength(3);
            // A restarted session-long --tail 0 feed contains new events, even if their text repeats.
            expect(await pump(worker, feed(["\u25B6 turn 3", tool, "\u2714 turn 3"]))).toBe(0);
            expect(output.filter((line) => line.includes("tool exec_command echo fixture"))).toHaveLength(4);
        } finally {
            log.mockRestore();
        }
    });

    test("Grok deduplicates replayed positions, preserving equal calls and new turns", async () => {
        const output: string[] = [];
        const log = spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
        const worker = workerFor("grok");
        const tool = "\u{1f527} exec_command echo fixture";
        const partial = ["\u25B6 turn 1", tool, "\u{1f527} read_file fixture", tool];
        const complete = [...partial, tool, "\u2714 turn 1"];
        try {
            expect(await pump(worker, feed(partial))).toBe(0);
            expect(output.filter((line) => line.includes("tool exec_command echo fixture"))).toHaveLength(2);
            expect(worker.hiddenTools).toBe(1);
            expect(await pump(worker, feed(complete))).toBe(0);
            expect(output.filter((line) => line.includes("tool exec_command echo fixture"))).toHaveLength(3);
            expect(worker.hiddenTools).toBe(1);
            const afterComplete = output.length;
            expect(await pump(worker, feed(complete))).toBe(0);
            expect(output).toHaveLength(afterComplete);
            expect(worker.hiddenTools).toBe(1);
            worker.seenTurn = 2;
            expect(await pump(worker, feed(["\u25B6 turn 2", tool, tool, "\u2714 turn 2"]))).toBe(0);
            expect(output.filter((line) => line.includes("tool exec_command echo fixture"))).toHaveLength(5);
        } finally {
            log.mockRestore();
        }
    });

    test("judge pack rejects invalid refs and worktrees without overwriting an existing pack", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-judge-errors-"));
        const out = join(dir, "pack.md");
        const script = join(import.meta.dir, "judge-pack.ts");
        fs.writeFileSync(out, "existing approved pack\n");
        for (const args of [
            ["--range", "missing-fixture-ref..HEAD"],
            ["--wt", join(dir, "missing"), "--range", "HEAD..HEAD"],
        ]) {
            const result = Bun.spawnSync([process.execPath, script, ...args, "--out", out], {
                stdout: "pipe",
                stderr: "pipe",
                env: process.env,
            });
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr.toString()).toContain("git log");
            expect(result.stderr.toString()).toContain("failed (exit");
            expect(result.stdout.toString()).toBe("");
            expect(fs.readFileSync(out, "utf8")).toBe("existing approved pack\n");
        }
    });

    test("judge pack stops at any failed Git stage, including a per-file diff", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-judge-stages-"));
        const script = join(import.meta.dir, "judge-pack.ts");
        for (const stage of ["log", "--stat", "--name-only", "per-file"]) {
            const preload = join(dir, stage + ".ts");
            const out = join(dir, stage + ".md");
            const mock = [
                "const spawn = Bun.spawnSync;",
                "Bun.spawnSync = (args, options) => {",
                "  const stage = " + SafeJSON.stringify(stage) + ";",
                "  if (args[0] === 'git') {",
                "    const fail = stage === 'per-file' ? args[3] === 'diff' && args.includes('--') : args.includes(stage);",
                "    if (fail) return spawn([process.execPath, '-e', 'console.error(\"fixture Git read failed\");process.exit(42)'], options);",
                "    if (stage === 'per-file' && args.includes('--name-only')) return spawn([process.execPath, '-e', 'console.log(\"fixture.ts\")'], options);",
                "  }",
                "  return spawn(args, options);",
                "};",
            ].join("\n");
            fs.writeFileSync(preload, mock);
            fs.writeFileSync(out, "existing approved pack\n");
            const result = Bun.spawnSync(
                [process.execPath, "--preload", preload, script, "--range", "HEAD..HEAD", "--out", out],
                { stdout: "pipe", stderr: "pipe", env: process.env }
            );
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr.toString()).toContain("failed (exit 42)");
            expect(result.stderr.toString()).toContain("fixture Git read failed");
            expect(result.stdout.toString()).toBe("");
            expect(fs.readFileSync(out, "utf8")).toBe("existing approved pack\n");
        }
    });
});

test("generated worker briefs follow the size, round and dedicated-review policy", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "babysit-policy-"));
    const preload = join(dir, "github-fixture.ts");
    fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
    const fixture = SafeJSON.stringify({
        title: "Fixture review",
        headRefName: "fixture",
        baseRefName: "main",
        changedFiles: 63,
    });
    fs.writeFileSync(
        preload,
        [
            "const spawn = Bun.spawnSync;",
            "Bun.spawnSync = (args, options) => args[0] === 'gh'",
            " ? spawn([process.execPath, '-e', " +
                SafeJSON.stringify("console.log(" + SafeJSON.stringify(fixture) + ")") +
                "], options)",
            " : spawn(args, options);",
        ].join("\n")
    );
    for (const [changedFiles, round, dedicated, all] of [
        [63, 1, false, true],
        [63, 2, false, true],
        [63, 3, false, false],
        [120, 3, false, true],
        [120, 4, false, false],
        [120, 32, true, true],
    ] as const) {
        const metadata = { title: "Fixture review", headRefName: "fixture", baseRefName: "main", changedFiles };
        fs.writeFileSync(
            preload,
            "Bun.spawnSync=(args)=>({exitCode:0,stdout:Buffer.from(JSON.stringify(" +
                SafeJSON.stringify(metadata) +
                ")),stderr:Buffer.alloc(0)});"
        );
        const target = join(dir, "brief-" + round + ".md");
        const result = Bun.spawnSync(
            [
                process.execPath,
                "--preload",
                preload,
                join(import.meta.dir, "fill-brief.ts"),
                "--run",
                dir,
                "--pr",
                "536",
                "--round",
                String(round),
                ...(dedicated ? ["--dedicated-review"] : []),
                "--wt",
                dir,
                "--out",
                target,
            ],
            { stdout: "pipe", stderr: "pipe", env: process.env }
        );
        expect(result.exitCode).toBe(0);
        const brief = fs.readFileSync(target, "utf8");
        expect(brief).toContain(all ? "fix EVERY valid finding" : "fix Critical and High");
        expect(brief).toContain("A valid security finding is always fixed");
        expect(brief).toContain("Change every file the fix needs in this PR");
        if (!all) {
            expect(brief).toContain("deferred");
            expect(brief).toContain("OPEN");
            expect(brief).not.toContain("never defer");
        }
        expect(brief).not.toContain("not worth a change");
        expect(brief).not.toContain("You may change only the PR's own files");
        expect(brief).not.toContain("do NOT fix that one");
    }
});

describe("round 6 regressions", () => {
    test("the Grok watch loop follows the active log with finished-turn metadata", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-active-turn-"));
        const script = join(import.meta.dir, "watch-workers.ts");
        const cli = join(import.meta.dir, "../../../../src/utils/cli/index.ts");
        const paths = join(import.meta.dir, "../../../../src/utils/grok/worker-paths.ts");
        for (const [index, meta, active] of [
            [0, { running: true, turns: 0, activeTurn: { turn: 1 } }, 1],
            [1, { running: true, turns: 0 }, 1],
            [2, { running: true, turns: 3, activeTurn: { turn: 7 } }, 7],
        ] as const) {
            const preload = join(dir, "preload-" + index + ".ts");
            const logFile = join(dir, "turn-" + active + ".jsonl");
            fs.writeFileSync(logFile, "fixture\n");
            const feed = "\u{1f527} run_terminal_command echo fixture\n\u{1f4ac} Continue?\n\u2714 turn complete\n";
            fs.writeFileSync(
                preload,
                [
                    "import { mock } from 'bun:test';",
                    "import * as cli from " + SafeJSON.stringify(cli) + ";",
                    "import * as paths from " + SafeJSON.stringify(paths) + ";",
                    "const originalCli = {...cli}; const originalPaths = {...paths}; let reads = 0;",
                    "mock.module(" + SafeJSON.stringify(cli) + ", () => ({...originalCli, execTool: async (args) => {",
                    "  if (args[0] !== 'grok' || args[1] !== 'status') throw new Error('unexpected tool execution');",
                    "  const meta = reads++ === 0 ? " +
                        SafeJSON.stringify(meta) +
                        " : {running:false, turns:" +
                        active +
                        ",lastTurn:{turn:" +
                        active +
                        ",exitCode:0}};",
                    "  return {success:true,exitCode:0,stderr:'',stdout:JSON.stringify(meta)};",
                    "}}));",
                    "mock.module(" +
                        SafeJSON.stringify(paths) +
                        ", () => ({...originalPaths, turnLogPath: (_name, turn) => " +
                        SafeJSON.stringify(dir + "/turn-") +
                        " + turn + '.jsonl'}));",
                    "const spawn = Bun.spawn;",
                    "Bun.spawn = (args, options) => {",
                    "  if (!args.includes('grok') || !args.includes('tail')) throw new Error('unexpected child execution');",
                    "  return spawn([process.execPath, '-e', " +
                        SafeJSON.stringify("process.stdout.write(" + SafeJSON.stringify(feed) + ")") +
                        "], {...options,env:process.env});",
                    "};",
                    "let elapsed = 0; const initial = Date.now(); Date.now = () => initial + elapsed;",
                    "Bun.sleep = async (ms) => { elapsed += ms; if (ms === 3000) process.exit(0); };",
                ].join("\n")
            );
            const result = Bun.spawnSync([process.execPath, "--preload", preload, script, "grok:fixture"], {
                stdout: "pipe",
                stderr: "pipe",
                env: process.env,
                timeout: 5000,
            });
            expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" });
            const out = result.stdout.toString();
            expect(out).toContain("turn " + active + " RUNNING");
            expect(out).toContain("tool run_terminal_command echo fixture");
            expect(out).toContain("QUESTION Continue?");
            expect(out).toContain("turn " + active + " ENDED exit=0");
            expect(out).not.toContain("log unavailable");
        }
    });

    test("plant evidence accepts parsed failures without a wrapper marker and any failing XCTest count", () => {
        for (const out of [
            "(fail) fixture one\n(fail) fixture two\n240 pass\n2 fail\n",
            "Executed 1 test, with 3 failures in 0.1 seconds\nExecuted 0 tests, with 0 failures\ntrailer\n",
            "\x1b[31m 240 pass\x1b[0m\n\x1b[31m 2 fail\x1b[0m\n(fail) fixture\n",
        ]) {
            expect(testEvidence({ code: 1, out }, true)).toBe(true);
            expect(testEvidence({ code: 0, out }, true)).toBe(false);
        }
        for (const out of [
            "Unhandled error between tests\nSyntaxError: No matching export\n0 pass\n1 fail\n[test] suite complete (exit 1)",
            "SyntaxError: Unexpected token\n0 pass\n1 fail\n",
        ]) {
            expect(testEvidence({ code: 1, out }, true)).toBe(false);
        }
    });

    test("plant CLI distinguishes import breakage from a caught behavior fault and restores the source", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-plant-evidence-"));
        const source = join(dir, "source.ts");
        const preload = join(dir, "preload.ts");
        const script = join(import.meta.dir, "plant.ts");
        const loadFailure =
            "Unhandled error between tests\nSyntaxError: No matching export\n0 pass\n1 fail\n[test] suite complete (exit 1)";
        for (const [mode, failed] of [
            ["load", loadFailure],
            ["behavior", "(fail) fixture\n240 pass\n2 fail\n"],
        ]) {
            fs.writeFileSync(source, "fixed\n");
            fs.writeFileSync(
                preload,
                [
                    "import { readFileSync } from 'node:fs'; const spawn = Bun.spawnSync;",
                    "Bun.spawnSync = (args, options) => {",
                    "  if (args[0] === 'git') return spawn([process.execPath,'-e',args[1] === 'show' ? 'console.log(\"old\")' : 'void 0'], options);",
                    "  if (args[0] !== 'bun' || args[1] !== 'scripts/test.ts') throw new Error('unexpected command');",
                    "  const planted = readFileSync(" + SafeJSON.stringify(source) + ", 'utf8').trim() === 'old';",
                    "  const out = planted ? " +
                        SafeJSON.stringify(failed) +
                        " : '1 pass\\n0 fail\\n[test] suite complete (exit 0)';",
                    "  return spawn([process.execPath,'-e','console.log(' + JSON.stringify(out) + ');process.exit(' + (planted ? 1 : 0) + ')'], options);",
                    "};",
                ].join("\n")
            );
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    script,
                    "--wt",
                    dir,
                    "--file",
                    "source.ts",
                    "--test",
                    "fixture.test.ts",
                ],
                { stdout: "pipe", stderr: "pipe", env: process.env, timeout: 5000 }
            );
            const out = result.stdout.toString();
            expect(fs.readFileSync(source, "utf8")).toBe("fixed\n");
            if (mode === "load") {
                expect(result.exitCode).toBe(1);
                expect(out).toContain("the plant broke the test's import, plant a behaviour fault instead");
                expect(out).not.toContain("\u2714 the tests catch the fault");
            } else {
                expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" });
                expect(out).toContain("\u2714 the tests catch the fault and pass on the fix");
            }
        }
    });
});

describe("round 6 judge log regressions", () => {
    test("XCTest totals with skipped tests provide failing and passing evidence", () => {
        // Inline total copied from real-logs/xctest-fail-with-skipped.log; runtime never reads the work folder.
        const total = "\t Executed 25 tests, with 1 test skipped and 1 failure (0 unexpected) in 2.120 (2.165) seconds";
        const trailer =
            "\n\u25C7 Test run started.\n\u2714 Test run with 0 tests in 0 suites passed after 0.001 seconds.";
        expect(summarize(total + trailer)).toBe(total.trim());
        expect(testEvidence({ code: 1, out: total + trailer }, true)).toBe(true);
        expect(testEvidence({ code: 0, out: total + trailer }, false)).toBe(false);
        for (const skipped of ["1 test skipped", "2 tests skipped"]) {
            const passed = total.replace("1 test skipped", skipped).replace("1 failure", "0 failures");
            expect(testEvidence({ code: 0, out: passed + trailer }, false)).toBe(true);
            expect(testEvidence({ code: 1, out: passed + trailer }, true)).toBe(false);
        }
    });

    test("completed Bun counts take precedence over a logged SyntaxError fixture", () => {
        // Relevant lines copied from real-logs/bun-pass-with-syntaxerror-fixture.log.
        const out = [
            "WARN: [cmux-install] invalid installation manifest",
            '      "type": "SyntaxError",',
            "          SyntaxError: Unexpected token 'b', \"{broken\" is not valid JSON",
            " 944 pass",
            " 6 skip",
            " 0 fail",
            " 3115 expect() calls",
            "Ran 950 tests across 114 files. [19.68s]",
            "[test] suite complete (exit 0)",
        ].join("\n");
        expect(testEvidence({ code: 0, out }, false)).toBe(true);
        expect(testEvidence({ code: 1, out }, true)).toBe(false);
        expect(testEvidence({ code: 0, out: out.replace("944 pass", "0 pass") }, false)).toBe(false);
        expect(testEvidence({ code: 0, out: "SyntaxError: Unexpected token" }, false)).toBe(false);
    });

    test("only whole Bun summary lines count, never test names or inline prose", () => {
        // Summary lines copied from real-logs/bun-pass-with-syntaxerror-fixture.log.
        const totals =
            " 944 pass\n 6 skip\n 0 fail\n 3115 expect() calls\nRan 950 tests across 114 files. [19.68s]\n[test] suite complete (exit 0)";
        const out = "(pass) retries 3 fail before recovering\n" + totals;
        expect(summarize(out)).toBe("944 pass 0 fail");
        expect(testEvidence({ code: 0, out }, false)).toBe(true);
        expect(testEvidence({ code: 1, out }, true)).toBe(false);
        for (const name of ["(pass) retries 3 fail before recovering", "exit 1 \u00B7 240 pass 2 fail"]) {
            expect(summarize(name)).toBe("no test count");
            expect(testEvidence({ code: 1, out: name }, true)).toBe(false);
        }
    });

    test("ANSI-colored whole summary lines must be stripped before counting", () => {
        const failed = "\u001b[32m 7 pass\u001b[0m\n\u001b[31m 1 fail\u001b[0m\n(fail) fixture\n";
        expect(summarize(failed)).toBe("7 pass 1 fail");
        expect(testEvidence({ code: 1, out: failed }, true)).toBe(true);
        const passed = "\u001b[32m 7 pass\u001b[0m\n\u001b[32m 0 fail\u001b[0m\n[test] suite complete (exit 0)";
        expect(summarize(passed)).toBe("7 pass 0 fail");
        expect(testEvidence({ code: 0, out: passed }, false)).toBe(true);
    });
});

describe("round 7 review regressions", () => {
    function reclaimFixture() {
        const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-reclaim-")));
        const root = join(dir, "tmp");
        const run = join(dir, "run");
        const home = join(dir, "home");
        for (const folder of [root, run, home]) {
            fs.mkdirSync(folder);
        }
        const native = join(home, ".grok", "sessions");
        const managed = join(home, "managed", "sessions");
        const preload = join(dir, "preload.ts");
        const sessionModule = join(import.meta.dir, "../../../../src/utils/providers/session-paths.ts");
        fs.writeFileSync(
            preload,
            [
                "import {mock} from 'bun:test'; import * as fs from 'node:fs';",
                "const original = {...fs};",
                "mock.module('node:fs', () => ({...original, realpathSync: (p) => p === '/tmp' ? " +
                    SafeJSON.stringify(root) +
                    " : original.realpathSync(p)}));",
                "mock.module(" +
                    SafeJSON.stringify(sessionModule) +
                    ", () => ({nativeSessionRoots: (kind) => kind === 'grok' ? " +
                    SafeJSON.stringify([native, managed]) +
                    " : [], nativeTranscriptMaxDepth: () => 4}));",
                "const spawn = Bun.spawnSync; Bun.spawnSync = (args, opts) => {",
                "if (args[0] !== 'lsof') throw new Error('unexpected command');",
                "return {exitCode:0,stdout:Buffer.from('p1\\nn/unrelated-fixture-file'),stderr:Buffer.alloc(0)}; };",
            ].join("\n")
        );
        const execute = (args: string[]) =>
            Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "tmp-reclaim.ts"),
                    "--run",
                    run,
                    ...args,
                ],
                {
                    stdout: "pipe",
                    stderr: "pipe",
                    timeout: 5000,
                    env: { ...env.getProcessEnv(), HOME: home, TMPDIR: root },
                }
            );
        return { dir, root, run, native, managed, execute };
    }

    test("reclaim protects Grok directory identities from native and managed provider roots", () => {
        const s = reclaimFixture();
        const ids = ["55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"];
        for (const [index, top] of [s.native, s.managed].entries()) {
            const transcript = join(top, "fixture-cwd", ids[index]);
            fs.mkdirSync(transcript, { recursive: true });
            fs.writeFileSync(join(transcript, "chat_history.jsonl"), "{}\n");
            fs.mkdirSync(join(s.root, "scratch-" + ids[index].slice(0, 8)));
        }
        const dead = join(s.root, "dead-scratch");
        fs.mkdirSync(dead);
        const result = s.execute(["--min-age-hours", "0"]);
        expect({ code: result.exitCode, err: result.stderr.toString() }).toEqual({ code: 0, err: "" });
        const planPath = /plan: (.+)/.exec(result.stdout.toString())?.[1] ?? "";
        const plan = SafeJSON.parse(fs.readFileSync(planPath, "utf8"), { strict: true });
        expect(plan.candidates.map((candidate: { path: string }) => candidate.path)).toEqual([dead]);
        expect(result.stdout.toString()).toContain('"live-session":2');
    });

    test("reclaim apply rejects traversal, symlink ancestors and unplanned shapes before deletion", () => {
        const s = reclaimFixture();
        const outside = join(s.dir, "outside");
        fs.mkdirSync(outside);
        fs.mkdirSync(join(outside, "victim"));
        fs.symlinkSync(outside, join(s.root, "linked"));
        fs.mkdirSync(join(s.root, "deep", "victim"), { recursive: true });
        fs.mkdirSync(join(s.root, "cc", "project", "session"), { recursive: true });
        // A session-shaped path whose project folder is a symlink: the shape passes, only the symlink check stops it.
        fs.mkdirSync(join(outside, "project", "session"), { recursive: true });
        fs.symlinkSync(join(outside, "project"), join(s.root, "cc", "linked-project"));
        const ordinary = join(s.root, "ordinary");
        fs.mkdirSync(ordinary);
        const paths = [
            s.root + "/../outside/victim",
            join(s.root, "linked", "victim"),
            join(s.root, "deep", "victim"),
            ordinary,
            join(s.root, "cc", "project", "session"),
            join(s.root, "cc", "linked-project", "session"),
        ];
        const plan = join(s.dir, "plan.json");
        fs.writeFileSync(
            plan,
            SafeJSON.stringify({
                createdAt: Date.now(),
                minAgeHours: 0,
                candidates: paths.map((path) => ({ path, ino: fs.lstatSync(path).ino, bytes: 0, newest: 0 })),
            })
        );
        const result = s.execute(["--apply", "--plan", plan]);
        expect({ code: result.exitCode, err: result.stderr.toString() }).toEqual({ code: 0, err: "" });
        expect(fs.existsSync(join(outside, "victim"))).toBe(true);
        expect(fs.existsSync(join(s.root, "deep", "victim"))).toBe(true);
        expect(fs.existsSync(ordinary)).toBe(false);
        expect(fs.existsSync(join(s.root, "cc", "project", "session"))).toBe(false);
        expect(fs.existsSync(join(outside, "project", "session"))).toBe(true);
        expect(result.stdout.toString()).toContain('"invalid-path":4');
    });

    test("production babysit environment access uses the facade and honors a scoped run override", async () => {
        for (const name of new Bun.Glob("*.ts").scanSync({ cwd: import.meta.dir })) {
            if (!name.endsWith(".test.ts")) {
                expect(fs.readFileSync(join(import.meta.dir, name), "utf8")).not.toMatch(/\b(?:process|Bun)\.env\b/);
            }
        }
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-env-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        const argv = process.argv;
        process.argv = [process.execPath, "fixture.ts"];
        try {
            await env.testing.withOverrides({ BABYSIT_RUN: dir }, async () => expect(loadRun().dir).toBe(dir));
        } finally {
            process.argv = argv;
        }
    });

    test("turn waits bound the child and preserve inner and supervisor timeout outcomes", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-wait-deadline-"));
        appendEvent(dir, { kind: "steer", worker: "fixture", meta: { sentAt: 1000 } });
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        const preload = join(dir, "preload.ts");
        for (const mode of ["done", "timeout", "supervisor"]) {
            fs.writeFileSync(
                preload,
                [
                    "const spawn = Bun.spawnSync; Bun.sleep = async () => {};",
                    "Bun.spawnSync = (args, opts) => {",
                    "if (args[0] === 'git') return spawn([process.execPath,'-e','void 0'],opts);",
                    "if (!args.includes('wait') || args[args.indexOf('--timeout')+1] !== '5' || opts.timeout !== 35000) throw new Error('wait lacks absolute/supervisor deadline');",
                    "const result = spawn([process.execPath,'-e','void 0'],opts);",
                    "return {...result,exitCode:" +
                        (mode === "done" ? 0 : 124) +
                        ",signalCode:" +
                        (mode === "supervisor" ? "'SIGTERM'" : "undefined") +
                        ",stdout:Buffer.from(JSON.stringify({outcome:'" +
                        (mode === "done" ? "done" : "timeout") +
                        "',lastText:'fixture done'}))}; };",
                ].join("\n")
            );
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "wait-turn.ts"),
                    "--run",
                    dir,
                    "--worker",
                    "fixture",
                    "--timeout",
                    "5",
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(result.exitCode, result.stderr.toString()).toBe(mode === "done" ? 0 : 124);
            const event = readEvents(dir).at(-1);
            expect(event?.meta?.exit).toBe(mode === "done" ? 0 : 124);
            expect(event?.meta?.outcome).toBe(mode === "done" ? "done" : "timeout");
            if (mode === "supervisor") {
                expect(event?.meta?.error).toBe("wait supervisor deadline expired");
            }
        }
    });

    test("run-wide ledger events retain full text, metadata and attribution like per-PR events", () => {
        const text = Array.from({ length: 12 }, (_, i) => "audit line " + i + " " + "detail ".repeat(12)).join("\n");
        const event = {
            at: "2026-01-01T00:00:00Z",
            kind: "decision" as const,
            round: 3,
            worker: "fixture",
            model: "fixture-model",
            meta: { verdict: "fixed", details: { reason: "fixture" } },
            text,
        };
        const general = renderMarkdown([event]);
        const perPr = renderMarkdown([{ ...event, pr: 1 }]);
        expect(general).toContain(text.trim());
        expect(general).toContain("<details><summary>text");
        expect(general).toContain("**verdict**: fixed");
        expect(general).toContain('"reason":"fixture"');
        expect(general).toContain("round 3 · fixture, fixture-model");
        expect(general.split("## Run-wide events\n\n")[1]).toBe(perPr.split("## PR #1\n\n")[1]);
    });

    test("integration uses the latest numeric prior round and explicit suffix order", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-earlier-"));
        const write = (round: string, verdict: string) =>
            fs.writeFileSync(
                join(dir, "1-r" + round + "-replies.json"),
                SafeJSON.stringify({ items: [{ threadId: "thread", verdict }] })
            );
        write("9", "rejected");
        write("10", "fixed");
        expect(earlierVerdicts({ vault: dir, pr: "1", round: "11" }).get("thread")).toBe("fixed");
        write("10a", "rejected");
        write("10b", "fixed");
        expect(earlierVerdicts({ vault: dir, pr: "1", round: "10a" }).get("thread")).toBe("fixed");
        expect(earlierVerdicts({ vault: dir, pr: "1", round: "10b" }).get("thread")).toBe("rejected");
        expect(earlierVerdicts({ vault: dir, pr: "1", round: "11" }).get("thread")).toBe("fixed");
        write("10", "rejected");
        write("9", "fixed");
        fs.unlinkSync(join(dir, "1-r10a-replies.json"));
        fs.unlinkSync(join(dir, "1-r10b-replies.json"));
        expect(earlierVerdicts({ vault: dir, pr: "1", round: "11" }).get("thread")).toBe("rejected");
        expect(earlierVerdicts({ vault: dir, pr: "2", round: "11" }).size).toBe(0);
    });
});

describe("round 7 additional review regressions", () => {
    test("review prefetch uses bounded shared tool reads and propagates listing and expansion failures", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-prefetch-"));
        const wt = join(dir, "worktree");
        fs.mkdirSync(wt);
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        const preload = join(dir, "preload.ts");
        const cli = join(import.meta.dir, "../../../../src/utils/cli/index.ts");
        for (const failure of ["none", "listing", "expand"]) {
            fs.writeFileSync(
                preload,
                [
                    "import {mock} from 'bun:test'; import * as cli from " +
                        SafeJSON.stringify(cli) +
                        "; const original = {...cli};",
                    "mock.module(" + SafeJSON.stringify(cli) + ",()=>({...original,execTool:async(args,opts)=>{",
                    "if (args[0] !== 'github' || args[1] !== 'review' || !(opts.timeout > 0) || opts.cwd !== " +
                        SafeJSON.stringify(dir) +
                        ") throw new Error('wrong shared tool execution');",
                    "const expand = args[2] === 'expand'; const fail = " +
                        SafeJSON.stringify(failure) +
                        " === (expand ? 'expand' : 'listing');",
                    "return {success:!fail,exitCode:fail?9:0,stderr:fail?'fixture read failed':'',stdout:expand?'Thread ID: fixture-thread':'t1 fixture thread'}; }}));",
                    "Bun.spawnSync = (args) => { if (args[0] !== 'git' && args[0] !== 'gh') throw new Error('bare tools execution'); return {exitCode:0,stdout:Buffer.from(args[0] === 'gh' ? '[]' : ''),stderr:Buffer.alloc(0)}; };",
                ].join("\n")
            );
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "fetch-threads.ts"),
                    "--run",
                    dir,
                    "--wt",
                    wt,
                    "--pr",
                    "1",
                    "--round",
                    "7",
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            if (failure === "none") {
                expect(result.exitCode, result.stderr.toString()).toBe(0);
                const saved = fs.readFileSync(join(wt, ".claude/work/babysit/1-r7-threads.md"), "utf8");
                expect(saved).toContain("t1 fixture thread");
                expect(saved).toContain("Thread ID: fixture-thread");
            } else {
                expect(result.exitCode).not.toBe(0);
                expect(result.stderr.toString()).toContain("fixture read failed");
            }
        }
    });

    test("a review audit fails closed for every truncated connection, including an unseen unresolved thread", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-audit-pages-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        const preload = join(dir, "preload.ts");
        const comment = (login: string) => ({ author: { login }, createdAt: "2026-01-01T00:00:00Z", body: "fixture" });
        const threads = Array.from({ length: 101 }, (_, i) => ({
            id: "thread-" + i,
            isResolved: i < 100,
            resolvedBy: { login: "fixture-lead" },
            path: "fixture.ts",
            comments: {
                nodes: i < 100 ? [comment("fixture-reviewer"), comment("fixture-lead")] : [comment("fixture-reviewer")],
            },
        }));
        for (const mode of ["reviewThreads", "reviews", "comments", "complete", "unresolved"]) {
            const pullRequest = {
                title: "fixture",
                state: "OPEN",
                headRefOid: "000000000",
                reviews: { nodes: [], pageInfo: { hasNextPage: mode === "reviews" } },
                comments: { nodes: [], pageInfo: { hasNextPage: mode === "comments" } },
                reviewThreads: {
                    nodes: mode === "unresolved" ? threads : threads.slice(0, 100),
                    pageInfo: { hasNextPage: mode === "reviewThreads" },
                },
                timelineItems: { nodes: [] },
            };
            const payload = SafeJSON.stringify({
                data: { viewer: { login: "fixture-lead" }, repository: { pullRequest } },
            });
            fs.writeFileSync(
                preload,
                "Bun.spawnSync = (args) => { if (args[0] !== 'git' && args[0] !== 'gh') throw new Error('unexpected execution'); return {exitCode:0,stdout:Buffer.from(args[0] === 'gh' ? " +
                    SafeJSON.stringify(payload) +
                    " : ''),stderr:Buffer.alloc(0)}; };\n"
            );
            const result = Bun.spawnSync(
                [process.execPath, "--preload", preload, join(import.meta.dir, "audit-reviews.ts"), "--run", dir, "1"],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(result.exitCode, result.stderr.toString()).toBe(mode === "complete" ? 0 : 1);
            if (["reviews", "comments", "reviewThreads"].includes(mode)) {
                expect(result.stdout.toString()).toContain("more than 100 " + mode);
            }
            if (mode === "unresolved") {
                expect(result.stdout.toString()).toContain("open 1, unanswered 1");
            }
        }
    });
});

describe("round 8 review regressions", () => {
    test("reclaim refreshes lsof before every rename and stops closed if that refresh fails", () => {
        for (const mode of ["open", "failure"]) {
            const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-open-refresh-")));
            const root = join(dir, "tmp");
            const run = join(dir, "run");
            for (const folder of [root, run, join(root, "fixture-first"), join(root, "fixture-second")]) {
                fs.mkdirSync(folder);
            }
            const first = join(root, "fixture-first");
            const second = join(root, "fixture-second");
            fs.writeFileSync(join(second, "held.txt"), "fixture");
            const plan = join(dir, "plan.json");
            const moves = join(dir, "moves.txt");
            const preload = join(dir, "preload.ts");
            fs.writeFileSync(
                plan,
                SafeJSON.stringify({
                    createdAt: Date.now(),
                    minAgeHours: 0,
                    candidates: [first, second].map((path) => ({
                        path,
                        ino: fs.lstatSync(path).ino,
                        bytes: 0,
                        newest: 0,
                    })),
                })
            );
            const providers = join(import.meta.dir, "../../../../src/utils/providers/session-paths.ts");
            fs.writeFileSync(
                preload,
                [
                    "import {mock} from 'bun:test'; import * as fs from 'node:fs'; const original = {...fs};",
                    "mock.module('node:fs',()=>({...original,realpathSync:(p)=>p === '/tmp'?" +
                        SafeJSON.stringify(root) +
                        ":original.realpathSync(p),renameSync:(from,to)=>{original.appendFileSync(" +
                        SafeJSON.stringify(moves) +
                        ",from+'\\n');return original.renameSync(from,to);}}));",
                    "mock.module(" +
                        SafeJSON.stringify(providers) +
                        ",()=>({nativeSessionRoots:()=>[],nativeTranscriptMaxDepth:()=>4}));",
                    "let reads=0; Bun.spawnSync=(args)=>{if(args[0] !== 'lsof') throw new Error('unexpected command'); reads++;",
                    "const failure=reads >= 3 && " + SafeJSON.stringify(mode) + " === 'failure';",
                    "const open=reads >= 3 ? " +
                        SafeJSON.stringify(second + "/held.txt") +
                        " : '/unrelated-fixture-file';",
                    "return {exitCode:failure?1:0,stdout:Buffer.from('p1\\nn'+open+'\\n'),stderr:Buffer.alloc(0)};};",
                ].join("\n")
            );
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "tmp-reclaim.ts"),
                    "--apply",
                    "--plan",
                    plan,
                    "--run",
                    run,
                ],
                { stdout: "pipe", stderr: "pipe", env: { ...env.getProcessEnv(), TMPDIR: root }, timeout: 5000 }
            );
            expect(result.exitCode).toBe(mode === "open" ? 0 : 1);
            expect(fs.existsSync(first)).toBe(false);
            expect(fs.existsSync(second)).toBe(true);
            expect(fs.readFileSync(moves, "utf8").trim().split("\n")).toEqual([first]);
            expect(fs.readdirSync(root).filter((name) => name.startsWith(".tmp-reclaim-"))).toEqual([]);
            if (mode === "open") {
                expect(result.stdout.toString()).toContain('"open-file":1');
            } else {
                expect(result.stderr.toString()).toContain("lsof listing incomplete");
            }
        }
    });

    test("steering delivers the same prompt that was logged when caller and main directories differ", () => {
        const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-steer-path-")));
        const caller = join(dir, "caller");
        const main = join(dir, "main");
        fs.mkdirSync(caller);
        fs.mkdirSync(main);
        const name = "brief with space.md";
        const prompt = join(caller, name);
        fs.writeFileSync(prompt, "correct caller prompt");
        fs.writeFileSync(join(main, name), "different main prompt");
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main }));
        const preload = join(dir, "preload.ts");
        const received = join(dir, "received.json");
        fs.writeFileSync(
            preload,
            [
                "import {mock} from 'bun:test';import {readFileSync,writeFileSync} from 'node:fs'; import {resolve} from 'node:path';",
                "mock.module(" +
                    SafeJSON.stringify(join(import.meta.dir, "../../../../src/ai/commands/agent/wait.ts")) +
                    ",()=>({readTurnBaseline:async()=>null}));",
                "Bun.spawnSync=(args,opts)=>{if(args[0] === 'git') return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};",
                "if(!args.includes('steer')) throw new Error('unexpected command');const file=args[args.indexOf('--prompt-file')+1];",
                "writeFileSync(" +
                    SafeJSON.stringify(received) +
                    ",JSON.stringify({file,text:readFileSync(resolve(opts.cwd,file),'utf8')}));return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};};",
                "mock.module(" +
                    SafeJSON.stringify(join(import.meta.dir, "../../../../src/utils/cli/index.ts")) +
                    ",()=>({execTool:async(args,opts)=>{const p=Bun.spawnSync(args,opts);return {success:p.exitCode===0,exitCode:p.exitCode,stdout:'',stderr:''};}}));",
            ].join("\n")
        );
        for (const file of [name, prompt]) {
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "steer.ts"),
                    "--run",
                    dir,
                    "--worker",
                    "fixture",
                    "--file",
                    file,
                ],
                { cwd: caller, stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(result.exitCode, result.stderr.toString()).toBe(0);
            expect(SafeJSON.parse(fs.readFileSync(received, "utf8"), { strict: true })).toEqual({
                file: prompt,
                text: "correct caller prompt",
            });
            expect(readEvents(dir).at(-1)?.text).toBe("correct caller prompt");
        }
    });
});

describe("round 10 review regressions", () => {
    test("explicit protected paths shield ancestor candidates through canonical, alias and relative spellings", () => {
        for (const spelling of ["canonical", "alias", "relative", "exact"]) {
            const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-protected-path-")));
            const root = join(dir, "tmp");
            const run = join(dir, "run");
            const candidate = join(root, "candidate-box");
            const neighbor = join(root, "candidate-box-other");
            const session = join(root, "session-feedbeef");
            // A folder named like the protected id in the cwd must not turn the id into a path protection only.
            const sameName = join(root, "feedbeef");
            for (const folder of [root, run, candidate, join(candidate, "keep"), neighbor, session, sameName]) {
                fs.mkdirSync(folder);
            }
            const protectedPath =
                spelling === "alias"
                    ? "/tmp/candidate-box/keep"
                    : spelling === "relative"
                      ? "candidate-box/keep"
                      : spelling === "exact"
                        ? candidate
                        : join(candidate, "keep");
            const preload = join(dir, "preload.ts");
            const providers = join(import.meta.dir, "../../../../src/utils/providers/session-paths.ts");
            fs.writeFileSync(
                preload,
                [
                    "import {mock} from 'bun:test'; import * as fs from 'node:fs'; const original={...fs};",
                    "mock.module('node:fs',()=>({...original,realpathSync:(p)=>p === '/tmp'?" +
                        SafeJSON.stringify(root) +
                        ":original.realpathSync(p)}));",
                    "mock.module(" +
                        SafeJSON.stringify(providers) +
                        ",()=>({nativeSessionRoots:()=>[],nativeTranscriptMaxDepth:()=>4}));",
                    "Bun.spawnSync=(args)=>{if(args[0] !== 'lsof') throw new Error('unexpected command');return {exitCode:0,stdout:Buffer.from('p1\\nn/unrelated-fixture-file'),stderr:Buffer.alloc(0)};};",
                ].join("\n")
            );
            const execute = (args: string[]) =>
                Bun.spawnSync(
                    [
                        process.execPath,
                        "--preload",
                        preload,
                        join(import.meta.dir, "tmp-reclaim.ts"),
                        "--run",
                        run,
                        "--protect",
                        protectedPath,
                        "--protect",
                        "feedbeef",
                        ...args,
                    ],
                    {
                        cwd: root,
                        stdout: "pipe",
                        stderr: "pipe",
                        env: { ...env.getProcessEnv(), TMPDIR: root },
                        timeout: 5000,
                    }
                );
            const dry = execute(["--min-age-hours", "0"]);
            expect(dry.exitCode, dry.stderr.toString()).toBe(0);
            const dryPlan = /plan: (.+)/.exec(dry.stdout.toString())?.[1] ?? "";
            const planned = SafeJSON.parse(fs.readFileSync(dryPlan, "utf8"), { strict: true });
            expect(planned.candidates.map((c: { path: string }) => c.path)).toEqual([neighbor]);
            const plan = join(dir, "apply.json");
            fs.writeFileSync(
                plan,
                SafeJSON.stringify({
                    createdAt: Date.now(),
                    minAgeHours: 0,
                    candidates: [candidate, neighbor, session].map((path) => ({
                        path,
                        ino: fs.lstatSync(path).ino,
                        bytes: 0,
                        newest: 0,
                    })),
                })
            );
            const applied = execute(["--apply", "--plan", plan]);
            expect(applied.exitCode, applied.stderr.toString()).toBe(0);
            expect(fs.existsSync(join(candidate, "keep"))).toBe(true);
            expect(fs.existsSync(session)).toBe(true);
            expect(fs.existsSync(neighbor)).toBe(false);
        }
    });

    test("saved waits retain done, failed, stalled and timeout statuses and reject malformed reports", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-saved-wait-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        const preload = join(dir, "preload.ts");
        fs.writeFileSync(
            preload,
            "Bun.spawnSync=(args)=>{if(args[0] !== 'git') throw new Error('saved waits must not launch workers');return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};};\n"
        );
        const reports = [
            {
                raw: SafeJSON.stringify({ outcome: "done", error: null, lastText: "fixture done" }),
                code: 0,
                outcome: "done",
            },
            {
                raw: SafeJSON.stringify({ outcome: "stalled", error: null, lastText: "fixture stalled" }),
                code: 3,
                outcome: "stalled",
            },
            {
                raw: SafeJSON.stringify({ outcome: "timeout", error: null, lastText: "fixture timeout" }),
                code: 124,
                outcome: "timeout",
            },
            {
                raw: SafeJSON.stringify({ outcome: "done", error: "fixture failed", lastText: "" }),
                code: 4,
                outcome: "done",
            },
            ...[
                "{broken",
                "{}",
                "null",
                "[]",
                '{"outcome":"unknown"}',
                '{"outcome":"done","error":false}',
                '{"outcome":"done","lastText":7}',
            ].map((raw) => ({ raw, code: 1, outcome: "error" })),
        ];
        for (const [index, report] of reports.entries()) {
            const saved = join(dir, "wait-" + index + ".json");
            fs.writeFileSync(saved, report.raw);
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "wait-turn.ts"),
                    "--run",
                    dir,
                    "--worker",
                    "fixture",
                    "--from-file",
                    saved,
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(result.exitCode, result.stderr.toString()).toBe(report.code);
            const event = readEvents(dir).at(-1);
            expect(event?.meta?.exit).toBe(report.code);
            expect(event?.meta?.outcome).toBe(report.outcome);
        }
    });

    test("a recovered ledger line and invalid timestamp render with an explicit unknown time", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-ledger-recovery-"));
        appendEvent(dir, { kind: "note", at: "2026-01-01T00:00:00Z", text: "valid before" });
        fs.appendFileSync(join(dir, "ledger.jsonl"), "{truncated append\n");
        appendEvent(dir, { kind: "note", at: "not-a-time", text: "invalid timestamp survives" });
        appendEvent(dir, { kind: "note", at: "2026-01-01T00:01:00Z", text: "valid after" });
        const events = readEvents(dir);
        const rendered = renderMarkdown(events);
        expect(rendered).toContain("(unreadable ledger line) {truncated append");
        expect(rendered).toContain("unknown time");
        expect(rendered).toContain("invalid timestamp survives");
        expect(rendered).toContain("valid before");
        expect(rendered).toContain("valid after");
        expect(rendered).toContain("01:00:00");
        expect(renderMarkdown([{ at: "", kind: "note", pr: 1, text: "per-PR recovered note" }])).toContain(
            "unknown time"
        );
    });

    test("the audit fails reviewer-resolved unanswered threads but exempts our own documented resolutions", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-silent-resolution-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        const preload = join(dir, "preload.ts");
        const comment = (login: string) => ({
            author: { login },
            createdAt: "2026-01-01T00:00:00Z",
            body: "fixture finding",
        });
        for (const mode of ["silent", "ours", "answered"]) {
            const thread = {
                id: "fixture-thread",
                isResolved: true,
                resolvedBy: { login: mode === "ours" ? "fixture-lead" : "fixture-reviewer" },
                path: "fixture.ts",
                comments: {
                    nodes:
                        mode === "answered"
                            ? [comment("fixture-reviewer"), comment("fixture-lead")]
                            : [comment("fixture-reviewer")],
                },
            };
            const pullRequest = {
                title: "fixture",
                state: "OPEN",
                headRefOid: "000000000",
                reviews: { nodes: [], pageInfo: { hasNextPage: false } },
                comments: { nodes: [], pageInfo: { hasNextPage: false } },
                reviewThreads: { nodes: [thread], pageInfo: { hasNextPage: false } },
                timelineItems: { nodes: [] },
            };
            const payload = SafeJSON.stringify({
                data: { viewer: { login: "fixture-lead" }, repository: { pullRequest } },
            });
            fs.writeFileSync(
                preload,
                "Bun.spawnSync=(args)=>{if(args[0] !== 'git' && args[0] !== 'gh') throw new Error('unexpected command');return {exitCode:0,stdout:Buffer.from(args[0] === 'gh'?" +
                    SafeJSON.stringify(payload) +
                    ":''),stderr:Buffer.alloc(0)};};\n"
            );
            for (const flags of [[], ["--bodies"]]) {
                const result = Bun.spawnSync(
                    [
                        process.execPath,
                        "--preload",
                        preload,
                        join(import.meta.dir, "audit-reviews.ts"),
                        "--run",
                        dir,
                        "1",
                        ...flags,
                    ],
                    { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
                );
                expect(result.exitCode, result.stderr.toString()).toBe(mode === "silent" ? 1 : 0);
            }
        }
    });
});

describe("round 18 review regressions", () => {
    test("uniq parses valued options and counts every operand including dash-prefixed outputs", () => {
        for (const command of [
            "uniq -- in.txt -out.txt",
            "uniq in.txt out.txt",
            "uniq in.txt -c",
            "uniq -f 2 -- in.txt -out.txt",
            "uniq -f2 -s 1 in.txt out.txt",
            "uniq --skip-fields=2 --skip-chars 1 in.txt out.txt",
            "uniq -f in.txt",
        ]) {
            expect(readOnlyChain(entry, command), command).toBe(false);
            expect(allowedCommand(entry, command), command).toBe(false);
            expect(
                decide(entry, { method: "item/commandExecution/requestApproval", command, cwd: entry.cwd }).ok,
                command
            ).toBe(false);
        }
        for (const command of [
            "uniq -c in.txt",
            "uniq -f 2 -s 1 -w4 in.txt",
            "uniq -cf2 in.txt",
            "uniq --skip-fields=2 --skip-chars 1 --check-chars=4 in.txt",
            "uniq -- -input.txt",
            "uniq -c",
        ]) {
            expect(readOnlyChain(entry, command), command).toBe(true);
        }
    });

    test("both Swift plant runs use the shared slot with a bounded acquisition deadline", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-swift-plant-slot-"));
        const source = join(dir, "source.ts");
        fs.writeFileSync(source, "fixed\n");
        fs.mkdirSync(join(dir, "Package"));
        const calls = join(dir, "calls.jsonl");
        const preload = join(dir, "preload.ts");
        fs.writeFileSync(
            preload,
            [
                "import {appendFileSync,readFileSync} from 'node:fs';const source=" + SafeJSON.stringify(source) + ";",
                "const result=(code,out='')=>({exitCode:code,stdout:Buffer.from(out),stderr:Buffer.alloc(0)});",
                "Bun.spawnSync=(args,opts)=>{if(args[0] === 'git') return result(0,args[1] === 'show'?'old\\n':'');",
                "if(!args.includes('swift') || !args.includes('test')) throw new Error('unexpected command');appendFileSync(" +
                    SafeJSON.stringify(calls) +
                    ",JSON.stringify({args,cwd:opts.cwd})+'\\n');const failed=readFileSync(source,'utf8') === 'old\\n';return result(failed?1:0,'Executed 1 test, with '+(failed?1:0)+' failures (0 unexpected)\\n');};",
            ].join("\n")
        );
        const result = Bun.spawnSync(
            [
                process.execPath,
                "--preload",
                preload,
                join(import.meta.dir, "plant.ts"),
                "--wt",
                dir,
                "--file",
                "source.ts",
                "--swift-package",
                "Package",
                "--swift-filter",
                "FixtureSuite",
            ],
            { stdout: "pipe", stderr: "pipe", env: { ...env.getProcessEnv(), TMPDIR: dir }, timeout: 5000 }
        );
        expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
        const recorded = fs
            .readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map((line) => SafeJSON.parse(line, { strict: true }));
        expect(recorded).toHaveLength(2);
        for (const call of recorded) {
            expect(call).toEqual({
                args: [
                    "bun",
                    join(import.meta.dir, "swift-slot.ts"),
                    "--wait-minutes",
                    "40",
                    "--run-minutes",
                    "60",
                    "--",
                    "swift",
                    "test",
                    "--filter",
                    "FixtureSuite",
                ],
                cwd: join(dir, "Package"),
            });
        }
        expect(fs.readFileSync(source, "utf8")).toBe("fixed\n");
    });

    test("review watcher bounds each child by its remaining lifetime and reports expiry", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-review-watch-limit-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        for (const mode of ["hung", "updates", "failure", "invalid"]) {
            const preload = join(dir, "preload.ts");
            const facts = join(dir, "facts.json");
            fs.writeFileSync(
                preload,
                [
                    "import {writeFileSync} from 'node:fs';const mode=" +
                        SafeJSON.stringify(mode) +
                        ";let now=0;const timeouts=[];Date.now=()=>now;",
                    "Bun.sleep=async(ms)=>{now+=ms;if(now>1000) throw new Error('fixture missed deadline');};",
                    "Bun.spawnSync=(args,opts)=>{if(args[0] === 'git') return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};if(args[0] !== 'bun' || !args[1].endsWith('round-ready.ts')) throw new Error('unexpected command');timeouts.push(opts.timeout??null);if(mode === 'hung') now+=opts.timeout??301;return {exitCode:['failure','hung'].includes(mode)?1:0,stdout:Buffer.from(mode === 'updates'?'#1 '+(timeouts.length<3?'same':'new')+'\\n':''),stderr:Buffer.from('fixture query failed')};};",
                    "process.on('exit',()=>writeFileSync(" +
                        SafeJSON.stringify(facts) +
                        ",JSON.stringify({timeouts,now})));",
                ].join("\n")
            );
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "watch-reviews.ts"),
                    "--run",
                    dir,
                    "--for",
                    mode === "invalid" ? "Infinity" : "0.005",
                    "--every",
                    "0.1",
                    "1",
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(
                mode === "invalid" ? 2 : 124
            );
            const seen = SafeJSON.parse(fs.readFileSync(facts, "utf8"), { strict: true }) as {
                timeouts: number[];
                now: number;
            };
            expect(seen.timeouts).toEqual(mode === "invalid" ? [] : mode === "hung" ? [300] : [300, 200, 100]);
            if (mode !== "invalid") {
                expect(result.stdout.toString()).toContain("expired");
                expect(seen.now).toBe(300);
            }
            if (mode === "updates") {
                expect(result.stdout.toString().match(/#1 same/g)).toHaveLength(1);
                expect(result.stdout.toString()).toContain("#1 new");
            }
            if (mode === "failure") {
                expect(result.stdout.toString()).toContain("round-ready failed");
            }
        }
    });

    test("a signalled Swift supervisor retains its slot while its child remains alive", async () => {
        for (const signal of ["SIGTERM", "SIGINT"] as const) {
            const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-slot-signal-")));
            const ready = join(dir, "ready");
            const received = join(dir, "received");
            const probe = join(dir, "probe");
            const alive = join(dir, "alive");
            const release = join(dir, "release");
            const ended = join(dir, "ended");
            const preload = join(dir, "preload.ts");
            const processes = join(import.meta.dir, "../../../../src/utils/process/processes.ts");
            fs.writeFileSync(
                preload,
                "import {mock} from 'bun:test';mock.module(" +
                    SafeJSON.stringify(processes) +
                    ",()=>({listProcesses:()=>[]}));"
            );
            const childCode = [
                "import {writeFileSync} from 'node:fs';import {waitForPath} from " +
                    SafeJSON.stringify(join(import.meta.dir, "../../../../src/utils/fs/watcher.ts")) +
                    ";",
                ...["SIGTERM", "SIGINT"].map(
                    (sig) =>
                        "process.on('" +
                        sig +
                        "',()=>writeFileSync(" +
                        SafeJSON.stringify(received) +
                        ",'" +
                        sig +
                        "'));"
                ),
                "writeFileSync(" +
                    SafeJSON.stringify(ready) +
                    ",'ready');await waitForPath(" +
                    SafeJSON.stringify(probe) +
                    ",{timeoutMs:4000});writeFileSync(" +
                    SafeJSON.stringify(alive) +
                    ",'child alive after supervisor signal');await waitForPath(" +
                    SafeJSON.stringify(release) +
                    ",{timeoutMs:4000});writeFileSync(" +
                    SafeJSON.stringify(ended) +
                    ",'exited');process.exit(0);",
            ].join("\n");
            const supervisor = Bun.spawn(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "swift-slot.ts"),
                    "--wait-minutes",
                    "1",
                    "--",
                    process.execPath,
                    "-e",
                    childCode,
                ],
                { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: { ...env.getProcessEnv(), TMPDIR: dir } }
            );
            try {
                expect(await waitForPath(ready, { timeoutMs: 3000 })).toBe(true);
                supervisor.kill(signal);
                const controller = new AbortController();
                try {
                    await Promise.race([
                        supervisor.exited,
                        waitForPath(received, { timeoutMs: 2500, signal: controller.signal }),
                    ]);
                } finally {
                    controller.abort();
                }
                fs.writeFileSync(probe, "probe");
                expect(await waitForPath(alive, { timeoutMs: 2000 })).toBe(true);
                expect(fs.existsSync(ended)).toBe(false);
                const contenderCode =
                    "import {trySwiftSlot} from " +
                    SafeJSON.stringify(join(import.meta.dir, "swift-slot.ts")) +
                    ";const release=trySwiftSlot(" +
                    SafeJSON.stringify(join(dir, "genesis-swift-slot.lock")) +
                    ");console.log(release?'held':'busy');release?.();";
                const contender = Bun.spawnSync([process.execPath, "-e", contenderCode], {
                    stdout: "pipe",
                    stderr: "pipe",
                    env: env.getProcessEnv(),
                    timeout: 3000,
                });
                expect(contender.exitCode, contender.stderr.toString()).toBe(0);
                expect(contender.stdout.toString().trim()).toBe("busy");
                expect(fs.readFileSync(received, "utf8")).toBe(signal);
                expect(supervisor.exitCode).toBeNull();
                fs.writeFileSync(release, "release");
                expect(await supervisor.exited).toBe(signal === "SIGTERM" ? 143 : 130);
            } finally {
                fs.writeFileSync(probe, "cleanup");
                fs.writeFileSync(release, "cleanup");
                await waitForPath(ended, { timeoutMs: 4500 });
                if (supervisor.exitCode === null) {
                    supervisor.kill("SIGKILL");
                }
                await supervisor.exited;
            }
            const reacquired = trySwiftSlot(join(dir, "genesis-swift-slot.lock"));
            expect(reacquired).not.toBeNull();
            reacquired?.();
        }
    }, 15000);
});

describe("round 17 review regressions", () => {
    test("landing refuses staged, unstaged and unreadable status before moving HEAD", () => {
        for (const mode of ["staged", "unstaged", "status-error", "clean"]) {
            const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-landing-dirty-")));
            const wt = join(dir, "worker");
            fs.mkdirSync(wt);
            const git = (...args: string[]) => {
                const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
                    cwd: wt,
                    stdout: "pipe",
                    stderr: "pipe",
                    env: env.getProcessEnv(),
                });
                expect(result.exitCode, result.stderr.toString()).toBe(0);
                return result.stdout.toString();
            };
            git("init", "-q");
            git("config", "user.name", "Fixture");
            git("config", "user.email", "fixture@example.com");
            fs.writeFileSync(join(wt, "local.txt"), "base\n");
            git("add", "--", "local.txt");
            git("commit", "-qm", "base");
            git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD").trim());
            for (const [i, message] of [
                "feat(tools): fixture",
                "fix(tools): #1 followup - first",
                "fix(tools): #1 followup - second",
            ].entries()) {
                fs.writeFileSync(join(wt, "feature.txt"), String(i));
                git("add", "--", "feature.txt");
                git("commit", "-qm", message);
            }
            git("update-ref", "refs/remotes/origin/pr-head", git("rev-parse", "HEAD").trim());
            if (mode === "staged") {
                fs.writeFileSync(join(wt, "local.txt"), "staged work\n");
                git("add", "--", "local.txt");
                fs.appendFileSync(join(wt, "local.txt"), "unstaged work\n");
            } else if (mode === "unstaged") {
                fs.writeFileSync(join(wt, "local.txt"), "unstaged work\n");
            }
            const before = {
                head: git("rev-parse", "HEAD"),
                branch: git("symbolic-ref", "HEAD"),
                index: git("diff", "--cached", "--binary"),
                working: git("diff", "--binary"),
                text: fs.readFileSync(join(wt, "local.txt"), "utf8"),
            };
            fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "genesiscz/GenesisTools", main: wt }));
            const moved = join(dir, "moves.txt");
            const preload = join(dir, "preload.ts");
            fs.writeFileSync(
                preload,
                [
                    "import {appendFileSync} from 'node:fs';const spawn=Bun.spawnSync;const mode=" +
                        SafeJSON.stringify(mode) +
                        ";",
                    "const result=(code,out='')=>({exitCode:code,stdout:Buffer.from(out),stderr:Buffer.alloc(0)});",
                    'Bun.spawnSync=(args,opts)=>{if(args[0] === \'gh\') {if(args[1] !== \'pr\' || args[2] !== \'view\') throw new Error(\'no GitHub writes\');return result(0,\'{"headRefName":"pr-head","baseRefName":"main","state":"OPEN"}\');}',
                    "if(args[0] === 'git') {if(args.includes('fetch')) return result(0);if(args.includes('status') && mode === 'status-error') return result(2,'fixture status failed');if(args.some(arg=>['checkout','reset','commit'].includes(arg))) appendFileSync(" +
                        SafeJSON.stringify(moved) +
                        ",'move\\n');if(args.includes('push')) throw new Error('no push');return spawn(args,opts);}",
                    "if(args[0] === 'bun' && args[1] === 'scripts/git/check-commits.ts') return result(0);throw new Error('unexpected command');};",
                ].join("\n")
            );
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "land.ts"),
                    "--run",
                    dir,
                    "--wt",
                    wt,
                    "--pr",
                    "1",
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 10000 }
            );
            expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(mode === "clean" ? 0 : 1);
            if (mode === "clean") {
                expect(result.stdout.toString()).toContain("dry:");
            } else {
                expect(result.stderr.toString()).toContain(mode === "status-error" ? "status" : "uncommitted");
                expect(fs.existsSync(moved)).toBe(false);
                expect(git("rev-parse", "HEAD")).toBe(before.head);
                expect(git("symbolic-ref", "HEAD")).toBe(before.branch);
                expect(git("diff", "--cached", "--binary")).toBe(before.index);
                expect(git("diff", "--binary")).toBe(before.working);
                expect(fs.readFileSync(join(wt, "local.txt"), "utf8")).toBe(before.text);
            }
        }
    });

    test("integration Biome accepts ignored-only JSON changes and still refuses real lint errors", () => {
        for (const mode of ["ignored", "lint-error"]) {
            const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-integrate-unmatched-")));
            const wt = join(dir, "worker");
            fs.mkdirSync(wt);
            const git = (...args: string[]) => {
                const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
                    cwd: wt,
                    stdout: "pipe",
                    stderr: "pipe",
                    env: env.getProcessEnv(),
                });
                expect(result.exitCode, result.stderr.toString()).toBe(0);
                return result.stdout.toString().trim();
            };
            git("init", "-q");
            git("config", "user.name", "Fixture");
            git("config", "user.email", "fixture@example.com");
            fs.copyFileSync(join(import.meta.dir, "../../../../biome.json"), join(wt, "biome.json"));
            fs.mkdirSync(join(wt, ".claude-plugin"));
            fs.mkdirSync(join(wt, "src"));
            fs.writeFileSync(join(wt, ".claude-plugin/plugin.json"), '{"version":"1.0.0"}\n');
            fs.writeFileSync(join(wt, "src/fixture.ts"), 'export const fixture = "valid";\n');
            git("add", "--", "biome.json", ".claude-plugin/plugin.json", "src/fixture.ts");
            git("commit", "-qm", "base");
            git("update-ref", "refs/remotes/origin/pr-head", git("rev-parse", "HEAD"));
            const changed = mode === "ignored" ? ".claude-plugin/plugin.json" : "src/fixture.ts";
            fs.writeFileSync(
                join(wt, changed),
                mode === "ignored" ? '{"version":"1.0.1"}\n' : "export const fixture = JSON.stringify({});\n"
            );
            git("add", "--", changed);
            git("commit", "-qm", "fixture round");
            fs.symlinkSync(join(import.meta.dir, "../../../../node_modules"), join(wt, "node_modules"));
            fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "genesiscz/GenesisTools", main: wt }));
            const preload = join(dir, "preload.ts");
            fs.writeFileSync(
                preload,
                [
                    "const spawn=Bun.spawnSync;const result=(code,out='')=>({exitCode:code,stdout:Buffer.from(out),stderr:Buffer.alloc(0)});",
                    "Bun.spawnSync=(args,opts)=>{if(args[0] === 'gh') {if(args[1] !== 'pr' || args[2] !== 'view') throw new Error('no GitHub writes');return result(0,'{\"headRefName\":\"pr-head\",\"baseRefName\":\"main\"}');}",
                    "if(args[0] === 'git') {if(args.includes('fetch')) return result(0);if(args.includes('push')) throw new Error('no pushes');return spawn(args,opts);}",
                    "if(args[0].endsWith('/biome') || (args[0] === 'bunx' && args[1] === 'biome')) return spawn(args,opts);",
                    "return result(0,args.includes('scripts/git/check-commits.ts')?'0 with a subject to fix':'');};",
                ].join("\n")
            );
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "integrate.ts"),
                    "--run",
                    dir,
                    "--wt",
                    wt,
                    "--pr",
                    "1",
                    "--dry",
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 10000 }
            );
            expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(
                mode === "ignored" ? 0 : 1
            );
            expect(result.stdout.toString()).toContain(mode === "ignored" ? "dry: push skipped" : "biome failed");
            if (mode === "lint-error") {
                expect(result.stdout.toString()).toContain("noRestrictedGlobals");
            }
        }
    });
});

describe("round 16 review regressions", () => {
    test("disk watcher expires, bounds df and still reports low space and query failures", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-df-expiry-"));
        for (const mode of ["expiry", "default", "blocked", "low", "failure", "invalid", "bad-lifetime"]) {
            const preload = join(dir, "preload.ts");
            const facts = join(dir, "facts.json");
            fs.writeFileSync(
                preload,
                [
                    "import {writeFileSync} from 'node:fs';const mode=" +
                        SafeJSON.stringify(mode) +
                        ";let now=0;const calls=[],sleeps=[];",
                    "Date.now=()=>now;const lifetime=mode === 'default'?1800000:60;",
                    "Bun.sleep=async(ms)=>{sleeps.push(ms);now+=ms;if(now>lifetime+1) throw new Error('fixture: watcher missed its deadline');};",
                    "Bun.spawnSync=(args,opts)=>{if(args[0] !== 'df') throw new Error('unexpected command');calls.push(opts.timeout??null);if(mode === 'blocked') now+=opts.timeout??1000;return {exitCode:mode === 'failure'||mode === 'blocked'?1:0,stderr:Buffer.from('fixture df error'),stdout:Buffer.from(mode === 'invalid'?'bad output':'Filesystem 1K-blocks Used Available Capacity Mounted\\nfixture 100 0 '+(mode === 'low'?1048576:104857600)+' 0% /\\n')};};",
                    "process.on('exit',()=>writeFileSync(" +
                        SafeJSON.stringify(facts) +
                        ",JSON.stringify({calls,sleeps,now})));",
                ].join("\n")
            );
            const flags = mode === "default" ? [] : ["--for", mode === "bad-lifetime" ? "Infinity" : "0.001"];
            const result = Bun.spawnSync(
                [process.execPath, "--preload", preload, join(import.meta.dir, "df-watch.ts"), ...flags],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            const expected = ["expiry", "default", "blocked"].includes(mode)
                ? 124
                : mode === "low"
                  ? 0
                  : mode === "bad-lifetime"
                    ? 2
                    : 1;
            expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(expected);
            const seen = SafeJSON.parse(fs.readFileSync(facts, "utf8"), { strict: true }) as {
                calls: number[];
                sleeps: number[];
                now: number;
            };
            if (mode === "bad-lifetime") {
                expect(seen.calls).toEqual([]);
                continue;
            }
            expect(seen.calls.length).toBeGreaterThan(0);
            expect(seen.calls.every((timeout) => timeout > 0 && timeout <= 30000)).toBe(true);
            if (mode === "expiry") {
                expect(seen.calls).toEqual([60]);
                expect(seen.sleeps).toEqual([60]);
                expect(result.stdout.toString()).toContain("expired");
            }
            if (mode === "low") {
                expect(result.stdout.toString()).toContain("LOW DISK");
                expect(seen.sleeps).toEqual([]);
            }
        }
    });
});

describe("round 15 review regressions", () => {
    test("reader variable assignments and other write options require the lead", async () => {
        const commands = [
            "printf -v PATH /tmp/worker-bin; cat src/a.ts",
            "printf -vPATH /tmp/worker-bin; cat src/a.ts",
            "printf '%n' PATH; cat src/a.ts",
            "printf '%10n' PATH; cat src/a.ts",
            "stat -A PATH src/a.ts; cat src/a.ts",
            "stat -H PATH src/a.ts; cat src/a.ts",
            "gh api repos/fixture/repo --cache 1h",
            "tools ts duplicates src --recommend=true",
        ];
        const messages: string[] = [];
        const output = spyOn(console, "log").mockImplementation((line) => messages.push(String(line)));
        const errors = spyOn(console, "error").mockImplementation(() => {});
        try {
            for (const command of commands) {
                expect(readOnlyChain(entry, command), command).toBe(false);
                let time = 0;
                const exec: typeof execTool = async (args) => {
                    if (args[1] === "approve") {
                        throw new Error("unsafe approval reached");
                    }
                    return {
                        success: true,
                        exitCode: 0,
                        stderr: "",
                        stdout: SafeJSON.stringify({
                            pendingApprovals: {
                                write: {
                                    method: "item/commandExecution/requestApproval",
                                    cwd: entry.cwd,
                                    command,
                                    detail: "sandbox escalation: " + command,
                                },
                            },
                        }),
                    };
                };
                const start = messages.length;
                await watchApprovals({
                    entry,
                    exec,
                    now: () => time,
                    sleep: async (ms) => {
                        time += ms;
                    },
                    pollMs: 5,
                    timeoutMs: 10,
                });
                expect(
                    messages.slice(start).some((line) => line.includes("NEEDS LEAD #write")),
                    command
                ).toBe(true);
            }
            for (const command of [
                "printf '%s\\n' hello",
                "printf -- '%d' 3",
                "stat -f '%N' src/a.ts",
                "gh api repos/fixture/repo",
                "tools ts duplicates src",
            ]) {
                expect(readOnlyChain(entry, command), command).toBe(true);
            }
        } finally {
            output.mockRestore();
            errors.mockRestore();
        }
    });

    test("generated non-Codex Swift briefs use the kernel slot for build and test", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-swift-brief-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        const preload = join(dir, "preload.ts");
        fs.writeFileSync(
            preload,
            "Bun.spawnSync=(args)=>{if(args[0] !== 'gh' && args[0] !== 'git') throw new Error('unexpected command');return {exitCode:0,stdout:Buffer.from(args[0] === 'gh'?'" +
                SafeJSON.stringify({
                    title: "Fixture",
                    headRefName: "fixture",
                    baseRefName: "main",
                    changedFiles: 63,
                }) +
                "':''),stderr:Buffer.alloc(0)};};"
        );
        for (const model of ["Grok", "GPT-6.1 Sol"]) {
            const out = join(dir, "brief.md");
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "fill-brief.ts"),
                    "--run",
                    dir,
                    "--pr",
                    "1",
                    "--model",
                    model,
                    "--swift",
                    "--out",
                    out,
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(result.exitCode, result.stderr.toString()).toBe(0);
            const brief = fs.readFileSync(out, "utf8");
            if (model === "Grok") {
                expect(brief).toContain("swift-slot.ts --wait-minutes 40 -- swift build");
                expect(brief).toContain("swift-slot.ts --wait-minutes 40 -- swift test --filter");
                expect(brief).not.toContain("while ps");
            } else {
                expect(brief).toContain("do NOT run `swift build` or `swift test`");
            }
        }
    });

    test("reclaim rejects invalid CLI and plan age thresholds before scanning or deleting", () => {
        const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-age-input-")));
        const root = join(dir, "tmp");
        const run = join(dir, "run");
        const candidate = join(root, "fixture-candidate");
        fs.mkdirSync(candidate, { recursive: true });
        fs.mkdirSync(run);
        fs.writeFileSync(join(candidate, "keep"), "fixture");
        const providers = join(import.meta.dir, "../../../../src/utils/providers/session-paths.ts");
        const preload = join(dir, "preload.ts");
        const scanned = join(dir, "scanned");
        fs.writeFileSync(
            preload,
            [
                "import {mock} from 'bun:test';import * as fs from 'node:fs';const original={...fs};",
                "mock.module('node:fs',()=>({...original,realpathSync:(p)=>p === '/tmp'?" +
                    SafeJSON.stringify(root) +
                    ":original.realpathSync(p),renameSync:()=>{throw new Error('unsafe rename reached');}}));",
                "mock.module(" +
                    SafeJSON.stringify(providers) +
                    ",()=>({nativeSessionRoots:()=>[],nativeTranscriptMaxDepth:()=>4}));",
                "Bun.spawnSync=()=>{original.writeFileSync(" +
                    SafeJSON.stringify(scanned) +
                    ",'scanned');return {exitCode:0,stdout:Buffer.from('p1\\nn/unrelated-fixture-file\\n'),stderr:Buffer.alloc(0)};};",
            ].join("\n")
        );
        const execute = (args: string[]) =>
            Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "tmp-reclaim.ts"),
                    "--run",
                    run,
                    ...args,
                ],
                { stdout: "pipe", stderr: "pipe", env: { ...env.getProcessEnv(), TMPDIR: root }, timeout: 5000 }
            );
        for (const option of ["--min-age-hours", "--live-hours"]) {
            for (const value of ["six", "NaN", "Infinity", "-1", ""]) {
                const result = execute([option, value]);
                expect(result.exitCode, option + " " + value).not.toBe(0);
                expect(result.stderr.toString()).toContain("finite nonnegative");
                expect(fs.existsSync(scanned)).toBe(false);
            }
        }
        const plan = join(dir, "plan.json");
        for (const age of [null, "6", -1, "six"]) {
            fs.writeFileSync(
                plan,
                SafeJSON.stringify({
                    createdAt: Date.now(),
                    minAgeHours: age,
                    candidates: [{ path: candidate, ino: fs.lstatSync(candidate).ino, bytes: 0, newest: 0 }],
                })
            );
            const result = execute(["--apply", "--plan", plan]);
            expect(result.exitCode, String(age)).not.toBe(0);
            expect(result.stderr.toString()).toContain("finite nonnegative");
            expect(fs.existsSync(scanned)).toBe(false);
            expect(fs.readFileSync(join(candidate, "keep"), "utf8")).toBe("fixture");
        }
        const valid = execute(["--min-age-hours", "0", "--live-hours", "0"]);
        expect(valid.exitCode, valid.stderr.toString()).toBe(0);
        expect(fs.existsSync(scanned)).toBe(true);
    });

    test("integration gates read the captured commit even when the worker advances", () => {
        for (const mode of ["broken", "lint:dashboard", "typecheck:all", "correct"]) {
            const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-integrate-snapshot-")));
            const realWt = join(dir, "worker");
            const wt = join(dir, "worker-alias");
            fs.mkdirSync(realWt);
            fs.symlinkSync(realWt, wt);
            const git = (...args: string[]) => {
                const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
                    cwd: wt,
                    stdout: "pipe",
                    stderr: "pipe",
                    env: env.getProcessEnv(),
                });
                expect(result.exitCode, result.stderr.toString()).toBe(0);
                return result.stdout.toString().trim();
            };
            git("init", "-q");
            git("config", "user.name", "Fixture");
            git("config", "user.email", "fixture@example.com");
            fs.writeFileSync(join(wt, "evidence.txt"), "base");
            fs.mkdirSync(join(wt, "src/utils"), { recursive: true });
            fs.writeFileSync(join(wt, "src/utils/fixture.ts"), "export const fixture = 1;\n");
            git("add", "--", "evidence.txt", "src/utils/fixture.ts");
            git("commit", "-qm", "base");
            const base = git("rev-parse", "HEAD");
            git("update-ref", "refs/remotes/origin/pr-head", base);
            fs.writeFileSync(join(wt, "evidence.txt"), mode);
            fs.writeFileSync(join(wt, "src/café.ts"), "export const accented = 1;\n");
            git("config", "core.quotePath", "true");
            git("add", "--", "evidence.txt", "src/café.ts");
            git("commit", "-qm", "judged");
            const judged = git("rev-parse", "HEAD");
            const modules = join(wt, "node_modules");
            fs.mkdirSync(join(modules, "@fixture"), { recursive: true });
            fs.symlinkSync("../../src/utils", join(modules, "@fixture/utils"));
            const installed = join(dir, "installed");
            fs.mkdirSync(installed);
            fs.writeFileSync(join(installed, "fixture.txt"), "trusted dependency");
            fs.symlinkSync(installed, join(modules, "fixture-dependency"));
            fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "genesiscz/GenesisTools", main: wt }));
            const preload = join(dir, "preload.ts");
            const gateCwd = join(dir, "gate-cwd.txt");
            fs.writeFileSync(
                preload,
                [
                    "import * as fs from 'node:fs';const spawn=Bun.spawnSync;const wt=" + SafeJSON.stringify(wt) + ";",
                    "const result=(code,out='')=>({exitCode:code,stdout:Buffer.from(out),stderr:Buffer.alloc(0)});",
                    "Bun.spawnSync=(args,opts)=>{if(args[0] === 'gh') {if(args[1] !== 'pr' || args[2] !== 'view') throw new Error('no GitHub writes');return result(0,'{\"headRefName\":\"pr-head\",\"baseRefName\":\"main\"}');}",
                    "if(args[0] === 'git') {if(args.includes('fetch')) return result(0);if(args.includes('push')) throw new Error('no pushes');return spawn(args,opts);}",
                    "if(args.includes('--noEmit')) {fs.writeFileSync(wt+'/evidence.txt','fixed later');fs.writeFileSync(wt+'/src/utils/fixture.ts','export const fixture = 2;\\n');for(const cmd of [['add','--','evidence.txt'],['commit','-qm','next round']]) {const p=spawn(['git','-c','core.hooksPath=/dev/null',...cmd],{cwd:wt,stdout:'pipe',stderr:'pipe'});if(p.exitCode) throw new Error('fixture commit failed');}fs.writeFileSync(" +
                        SafeJSON.stringify(gateCwd) +
                        ",JSON.stringify({cwd:opts.cwd,evidence:fs.readFileSync(opts.cwd+'/evidence.txt','utf8'),utils:fs.realpathSync(opts.cwd+'/node_modules/@fixture/utils'),utilsText:fs.readFileSync(opts.cwd+'/node_modules/@fixture/utils/fixture.ts','utf8'),dependency:fs.realpathSync(opts.cwd+'/node_modules/fixture-dependency')}));return result(fs.readFileSync(opts.cwd+'/evidence.txt','utf8') === 'broken'?1:0,'fixture typecheck');}",
                    "if(args.includes('check') && args.includes('--no-errors-on-unmatched')) {fs.writeFileSync(" +
                        SafeJSON.stringify(gateCwd + ".biome") +
                        ",JSON.stringify(args));return result(0);}",
                    "if(args[1] === 'run' && ['lint:dashboard','typecheck:all'].includes(args[2])) {fs.appendFileSync(" +
                        SafeJSON.stringify(gateCwd + ".gates") +
                        ",JSON.stringify({gate:args[2],cwd:opts.cwd,evidence:fs.readFileSync(opts.cwd+'/evidence.txt','utf8')})+'\\n');return result(args[2] === " +
                        SafeJSON.stringify(mode) +
                        "?1:0,'fixture replacement gate');}",
                    "return result(0,args.includes('scripts/git/check-commits.ts')?'0 with a subject to fix':'');};",
                ].join("\n")
            );
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "integrate.ts"),
                    "--run",
                    dir,
                    "--wt",
                    wt,
                    "--pr",
                    "1",
                    "--dry",
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 10000 }
            );
            expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(
                mode === "correct" ? 0 : 1
            );
            if (mode !== "correct") {
                expect(result.stdout.toString()).toContain(`${mode === "broken" ? "tsgo" : mode} failed`);
            } else {
                expect(result.stdout.toString()).toContain("dry: push skipped");
            }
            // Read while the gate ran: the snapshot is removed when integrate exits.
            const seen = SafeJSON.parse(fs.readFileSync(gateCwd, "utf8"), { strict: true }) as {
                cwd: string;
                evidence: string;
                utils: string;
                utilsText: string;
                dependency: string;
            };
            expect(seen.cwd).not.toBe(wt);
            expect(seen.evidence).toBe(mode);
            if (mode !== "broken") {
                expect(fs.existsSync(gateCwd + ".biome")).toBe(true);
                expect(SafeJSON.parse(fs.readFileSync(gateCwd + ".biome", "utf8"), { strict: true })).toContain(
                    "src/café.ts"
                );
                const gates = fs
                    .readFileSync(gateCwd + ".gates", "utf8")
                    .trim()
                    .split("\n")
                    .map((line) => SafeJSON.parse(line, { strict: true }));
                expect(gates).toEqual(
                    (mode === "lint:dashboard" ? ["lint:dashboard"] : ["lint:dashboard", "typecheck:all"]).map(
                        (gate) => ({ gate, cwd: seen.cwd, evidence: mode })
                    )
                );
            }
            expect(seen.utils).toBe(join(seen.cwd, "src/utils"));
            expect(seen.utilsText).toBe("export const fixture = 1;\n");
            expect(seen.dependency).toBe(installed);
            expect(fs.existsSync(seen.cwd)).toBe(false);
            expect(git("rev-parse", "HEAD")).not.toBe(judged);
        }
    });
});

describe("round 14 review regressions", () => {
    test("native linking resolves relative checkout roots before storing symlink targets", () => {
        for (const relativePaths of [true, false]) {
            const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-native-relative-")));
            const main = join(dir, "main");
            const worker = join(dir, "worker");
            const suffix = "node_modules/fixture/nested/binding.node";
            const payload = Buffer.alloc(8192);
            Buffer.from("cffaedfe", "hex").copy(payload);
            for (const checkout of [main, worker]) {
                fs.mkdirSync(join(checkout, "node_modules/fixture/nested"), { recursive: true });
                fs.writeFileSync(join(checkout, suffix), payload);
            }
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    join(import.meta.dir, "link-native.ts"),
                    "--main",
                    relativePaths ? "." : main,
                    relativePaths ? "../worker" : worker,
                ],
                { cwd: main, stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(result.exitCode, result.stderr.toString()).toBe(0);
            expect(result.stdout.toString()).toContain("linked 1 native files");
            expect(fs.lstatSync(join(worker, suffix)).isSymbolicLink()).toBe(true);
            expect(fs.readlinkSync(join(worker, suffix))).toBe(join(main, suffix));
            expect(fs.readFileSync(join(worker, suffix))).toEqual(payload);
        }
    });

    test("review snapshots see activity after 100 threads, comments and reviews", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-review-pages-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        const preload = join(dir, "preload.ts");
        const author = { login: "fixture-reviewer" };
        const thread = (i: number) => ({
            id: "thread-" + i,
            isResolved: true,
            comments: { nodes: [{ author }] },
            latest: { nodes: [{ id: "reply-" + i, updatedAt: "2026-01-01T00:00:00Z" }] },
        });
        const comment = (i: number) => ({ id: "comment-" + i, author, updatedAt: "2026-01-01T00:00:00Z" });
        const review = (i: number) => ({
            id: "review-" + i,
            author,
            commit: { oid: "old-head" },
            submittedAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            state: "COMMENTED",
        });
        const snapshots: string[] = [];
        for (const mode of ["before", "thread", "comment", "review", "unreadable-page"]) {
            const threads = Array.from({ length: 101 }, (_, i) => thread(i));
            if (mode === "thread") {
                threads[100].isResolved = false;
            }
            const comments = Array.from({ length: 101 }, (_, i) => comment(i));
            if (mode === "comment") {
                comments.push(comment(101));
            }
            const reviews = Array.from({ length: 101 }, (_, i) => review(i));
            if (mode === "review") {
                reviews.push(review(101));
            }
            const fixture = { threads, comments, reviews, mode };
            fs.writeFileSync(
                preload,
                [
                    "const fixture=" + SafeJSON.stringify(fixture) + ";",
                    "Bun.spawnSync=(args)=>{if(args[0] === 'git') return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};if(args[0] !== 'gh') throw new Error('unexpected command');",
                    "const query=args.find(arg=>arg.startsWith('query=')).slice(6);const cursor=(name)=>args.find(arg=>arg.startsWith(name+'='))?.split('=').slice(1).join('=');",
                    "const connection=(name,values)=>{const offset=Number(cursor(name+'Cursor')??0);if(offset && fixture.mode === 'unreadable-page') throw new Error('fixture pagination failure');let selected=values.slice(offset,offset+100);if(!query.includes('pageInfo')) selected=name === 'threads'?values.slice(0,100):values.slice(-100);return {nodes:selected,pageInfo:{hasNextPage:offset+100<values.length,endCursor:String(offset+100)}};};",
                    "const pr={headRefOid:'fixture-head',reviewThreads:connection('threads',fixture.threads),comments:connection('comments',fixture.comments),reviews:connection('reviews',fixture.reviews),timelineItems:{nodes:[]}};",
                    "return {exitCode:0,stdout:Buffer.from(JSON.stringify({data:{viewer:{login:'fixture-lead'},repository:{pullRequest:pr}}})),stderr:Buffer.alloc(0)};};",
                ].join("\n")
            );
            const result = Bun.spawnSync(
                [process.execPath, "--preload", preload, join(import.meta.dir, "round-ready.ts"), "--run", dir, "1"],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(result.exitCode, result.stderr.toString()).toBe(0);
            const line = result.stdout.toString().trim();
            if (mode === "unreadable-page") {
                expect(line).toContain("ERR");
                continue;
            }
            expect(line).not.toContain("ERR");
            if (mode === "before") {
                expect(line).toContain('comments {"fixture-reviewer":101}');
            } else {
                expect(line, mode).not.toBe(snapshots[0]);
            }
            if (mode === "thread") {
                expect(line).toContain('open {"fixture-reviewer":1}');
            }
            snapshots.push(line);
        }
    });
});

describe("round 13 reader execution regressions", () => {
    test("Git reader abbreviations cannot override no-execution flags", () => {
        for (const command of [
            "git diff --no-textconv --no-ext-diff --textc HEAD",
            "git show --no-textconv --no-ext-diff --ext-d HEAD",
            "git grep --no-textconv --open-files-in=worker-program needle",
        ]) {
            expect(readOnlyChain(entry, command), command).toBe(false);
        }
    });

    test("reader options that launch programs require the lead, including escalation requests", async () => {
        const commands = [
            "sort -S 1K --compress-program=/worker/probe large-file",
            "sort -S 1K --compress-program /worker/probe large-file",
            "sort --compress-prog=/worker/probe large-file",
            "sort --comp=/worker/probe large-file",
            "sort -k -- --compress-program=/worker/probe large-file",
            "rg -e -- --pre=/worker/probe source.ts",
            "file -m -- -z archive.gz",
            "file -z archive.gz",
            "file -bZ archive.gz",
            "file --uncompress archive.gz",
            "file --uncompress-nobuffer archive.gz",
            "file --uncomp archive.gz",
            "rg -z needle archive.gz",
            "rg -nz needle archive.gz",
            "rg --search-zip needle archive.gz",
            "rg --hostname-bin /worker/probe --hyperlink-format default needle file",
            "rg --hostname-bin=/worker/probe needle file",
            "git cat-file --filters HEAD:src/a.ts",
            "git cat-file --filt HEAD:src/a.ts",
            "git cat-file --textc HEAD:src/a.ts",
            "gh pr view 1 --web",
            "gh pr list -w",
            "gh pr checks 1 --web",
        ];
        const messages: string[] = [];
        const output = spyOn(console, "log").mockImplementation((value) => messages.push(String(value)));
        const errors = spyOn(console, "error").mockImplementation(() => {});
        try {
            for (const command of commands) {
                let time = 0;
                let approvals = 0;
                const request = {
                    method: "item/commandExecution/requestApproval",
                    command,
                    cwd: entry.cwd,
                    detail: "sandbox escalation: " + command,
                    sandbox_permissions: "require_escalated",
                };
                expect(readOnlyChain(entry, command), command).toBe(false);
                expect(allowedCommand(entry, command), command).toBe(false);
                expect(decide(entry, request).ok, command).toBe(false);
                const exec: typeof execTool = async (args) => {
                    if (args[1] === "approve") {
                        approvals++;
                        throw new Error("unsafe approval reached");
                    }
                    return {
                        success: true,
                        exitCode: 0,
                        stderr: "",
                        stdout: SafeJSON.stringify({ pendingApprovals: { security: request } }),
                    };
                };
                const start = messages.length;
                await watchApprovals({
                    entry,
                    exec,
                    now: () => time,
                    sleep: async (ms) => {
                        time += ms;
                    },
                    timeoutMs: 10,
                    pollMs: 5,
                });
                expect(approvals, command).toBe(0);
                expect(
                    messages.slice(start).some((line) => line.includes("NEEDS LEAD #security")),
                    command
                ).toBe(true);
            }
        } finally {
            output.mockRestore();
            errors.mockRestore();
        }
    });

    test("ordinary reader options and option terminators remain approved", () => {
        for (const command of [
            "sort -S 1K -u large-file",
            "sort --numeric-sort --reverse file",
            "sort --key=2 --stable file",
            "sort -- source.ts",
            "file --brief archive.gz",
            "file -b source.ts",
            "rg -n needle source.ts",
            "rg --no-search-zip needle source.ts",
            "git cat-file -p HEAD:src/a.ts",
            "gh pr view 1 --json body",
            "gh pr list --limit 5",
        ]) {
            expect(readOnlyChain(entry, command), command).toBe(true);
        }
    });
});

describe("round 12 review regressions", () => {
    test("reclaim refuses incomplete metadata scans during planning and apply", () => {
        for (const code of ["EACCES", "EIO", "ENOENT", "healthy"]) {
            const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-stat-safety-")));
            const root = join(dir, "tmp");
            const run = join(dir, "run");
            const candidate = join(root, "fixture-candidate");
            const neighbor = join(root, "fixture-neighbor");
            fs.mkdirSync(candidate, { recursive: true });
            fs.mkdirSync(neighbor);
            fs.mkdirSync(run);
            const unreadable = join(candidate, "entry");
            fs.writeFileSync(unreadable, "keep");
            const moves = join(dir, "moves.txt");
            const preload = join(dir, "preload.ts");
            const providers = join(import.meta.dir, "../../../../src/utils/providers/session-paths.ts");
            fs.writeFileSync(
                preload,
                [
                    "import {mock} from 'bun:test'; import * as fs from 'node:fs'; const original={...fs};",
                    "const target=" + SafeJSON.stringify(unreadable) + ",code=" + SafeJSON.stringify(code) + ";",
                    "mock.module('node:fs',()=>({...original,realpathSync:(p)=>p === '/tmp'?" +
                        SafeJSON.stringify(root) +
                        ":original.realpathSync(p),",
                    "lstatSync:(p,...args)=>{if(p === target && code !== 'healthy') throw Object.assign(new Error('fixture stat error'),{code});return original.lstatSync(p,...args);},",
                    "renameSync:(from,to)=>{original.appendFileSync(" +
                        SafeJSON.stringify(moves) +
                        ",from+'\\n');if(from === " +
                        SafeJSON.stringify(candidate) +
                        " && code !== 'healthy') throw new Error('unsafe rename reached');return original.renameSync(from,to);}}));",
                    "mock.module(" +
                        SafeJSON.stringify(providers) +
                        ",()=>({nativeSessionRoots:()=>[],nativeTranscriptMaxDepth:()=>4}));",
                    "Bun.spawnSync=(args)=>{if(args[0] !== 'lsof') throw new Error('unexpected command');return {exitCode:0,stdout:Buffer.from('p1\\nn/unrelated-fixture-file\\n'),stderr:Buffer.alloc(0)};};",
                ].join("\n")
            );
            const execute = (args: string[]) =>
                Bun.spawnSync(
                    [
                        process.execPath,
                        "--preload",
                        preload,
                        join(import.meta.dir, "tmp-reclaim.ts"),
                        "--run",
                        run,
                        ...args,
                    ],
                    { stdout: "pipe", stderr: "pipe", env: { ...env.getProcessEnv(), TMPDIR: root }, timeout: 5000 }
                );
            const dry = execute(["--min-age-hours", "0"]);
            expect(dry.exitCode, dry.stderr.toString()).toBe(0);
            const planPath = /plan: (.+)/.exec(dry.stdout.toString())?.[1] ?? "";
            const planned = SafeJSON.parse(fs.readFileSync(planPath, "utf8"), { strict: true });
            expect(planned.candidates.map((c: { path: string }) => c.path).sort()).toEqual(
                (code === "healthy" ? [candidate, neighbor] : [neighbor]).sort()
            );
            const plan = join(dir, "apply.json");
            fs.writeFileSync(
                plan,
                SafeJSON.stringify({
                    createdAt: Date.now(),
                    minAgeHours: 0,
                    candidates: [candidate, neighbor].map((path) => ({
                        path,
                        ino: fs.lstatSync(path).ino,
                        bytes: 0,
                        newest: 0,
                    })),
                })
            );
            const applied = execute(["--apply", "--plan", plan]);
            expect(applied.exitCode, applied.stderr.toString()).toBe(0);
            expect(fs.readFileSync(moves, "utf8").trim().split("\n")).toEqual(
                code === "healthy" ? [candidate, neighbor] : [neighbor]
            );
            expect(fs.existsSync(candidate)).toBe(code !== "healthy");
            expect(fs.existsSync(neighbor)).toBe(false);
            if (code !== "healthy") {
                expect(applied.stdout.toString()).toContain('"unreadable":1');
            }
        }
    });

    test("audit blocks outside-diff review bodies until each exact review is acknowledged", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-body-audit-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        const preload = join(dir, "preload.ts");
        const reviews = ["fixture-review-a", "fixture-review-b"].map((id) => ({
            id,
            author: { login: "fixture-reviewer" },
            createdAt: "2026-01-01T00:00:00Z",
            state: "COMMENTED",
            body: "Outside diff range comments: 1\nA fixture finding.",
            commit: { oid: "fixture-head" },
        }));
        for (const late of [false, true]) {
            const pullRequest = {
                title: "fixture",
                state: late ? "MERGED" : "OPEN",
                mergedAt: late ? "2025-12-31T00:00:00Z" : null,
                headRefOid: "fixture-head",
                reviews: { nodes: reviews, pageInfo: { hasNextPage: false } },
                comments: { nodes: [], pageInfo: { hasNextPage: false } },
                reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
                timelineItems: { nodes: [] },
            };
            const payload = SafeJSON.stringify({
                data: { viewer: { login: "fixture-lead" }, repository: { pullRequest } },
            });
            fs.writeFileSync(
                preload,
                "Bun.spawnSync=(args)=>{if(args[0] !== 'git' && args[0] !== 'gh') throw new Error('unexpected command');return {exitCode:0,stdout:Buffer.from(args[0] === 'gh'?" +
                    SafeJSON.stringify(payload) +
                    ":''),stderr:Buffer.alloc(0)};};"
            );
            for (const ack of [[], ["wrong-review"], ["fixture-review-a"], ["fixture-review-a", "fixture-review-b"]]) {
                const result = Bun.spawnSync(
                    [
                        process.execPath,
                        "--preload",
                        preload,
                        join(import.meta.dir, "audit-reviews.ts"),
                        "--run",
                        dir,
                        "1",
                        ...ack.flatMap((id) => ["--ack-body", id]),
                    ],
                    { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
                );
                expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(
                    !late && ack.length === 2 ? 0 : 1
                );
                expect(result.stdout.toString()).toContain("fixture-review-a");
                expect(result.stdout.toString()).toContain("fixture-review-b");
                if (ack.length === 2) {
                    expect(result.stdout.toString()).toContain("acknowledged");
                }
            }
        }
    });
});

describe("round 11 review regressions", () => {
    test("thread prefetch keeps the run-card repository for listing, expansion, bodies and comments", () => {
        const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-prefetch-repo-")));
        const wt = join(dir, "worktree");
        fs.mkdirSync(wt);
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/selected", main: dir }));
        const preload = join(dir, "preload.ts");
        const cli = join(import.meta.dir, "../../../../src/utils/cli/index.ts");
        fs.writeFileSync(
            preload,
            [
                "import {mock} from 'bun:test'; import * as cli from " +
                    SafeJSON.stringify(cli) +
                    "; const original={...cli};let sessionRepo='';",
                "mock.module(" + SafeJSON.stringify(cli) + ",()=>({...original,execTool:async(args)=>{",
                "if(args[0] !== 'github' || args[1] !== 'review') throw new Error('unexpected tool');",
                "if(args[2] === 'expand') return {success:true,exitCode:0,stderr:'',stdout:'Thread ID: '+(sessionRepo === 'fixture/selected'?'selected-thread':'unrelated-thread')};",
                "sessionRepo=args.includes('--repo')?args[args.indexOf('--repo')+1]:'fixture/default';",
                "return {success:true,exitCode:0,stderr:'',stdout:'t1 '+sessionRepo};}}));",
                "Bun.spawnSync=(args)=>{if(args[0] === 'git') return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};",
                "if(args[0] === 'gh' && args[2] === 'user') return {exitCode:0,stdout:Buffer.from('fixture-lead'),stderr:Buffer.alloc(0)};",
                "if(args[0] !== 'gh' || !args[2].startsWith('repos/fixture/selected/')) throw new Error('wrong API repository');return {exitCode:0,stdout:Buffer.from('[]'),stderr:Buffer.alloc(0)};};",
            ].join("\n")
        );
        const result = Bun.spawnSync(
            [
                process.execPath,
                "--preload",
                preload,
                join(import.meta.dir, "fetch-threads.ts"),
                "--run",
                dir,
                "--wt",
                wt,
                "--pr",
                "1",
                "--round",
                "11",
            ],
            { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
        );
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const saved = fs.readFileSync(join(wt, ".claude/work/babysit/1-r11-threads.md"), "utf8");
        expect(saved).toContain("t1 fixture/selected");
        expect(saved).toContain("Thread ID: selected-thread");
        expect(saved).not.toContain("unrelated-thread");
    });

    test("setup preserves clean detached worker commits, permits published heads and refuses unverifiable ancestry", () => {
        for (const mode of ["unpublished", "equal", "behind", "unverifiable", "restacked"]) {
            const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-setup-history-")));
            const worktrees = join(dir, "workers");
            const wt = join(worktrees, "bs-1");
            fs.mkdirSync(wt, { recursive: true });
            const git = (...args: string[]) => {
                const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
                    cwd: wt,
                    stdout: "pipe",
                    stderr: "pipe",
                    env: env.getProcessEnv(),
                });
                expect(result.exitCode, result.stderr.toString()).toBe(0);
                return result.stdout.toString().trim();
            };
            git("init", "-q");
            git("config", "user.name", "Fixture");
            git("config", "user.email", "fixture@example.com");
            fs.writeFileSync(join(wt, "fixture.txt"), "base\n");
            git("add", "--", "fixture.txt");
            git("commit", "-qm", "fixture base");
            const base = git("rev-parse", "HEAD");
            fs.writeFileSync(join(wt, "fixture.txt"), "worker fix\n");
            git("add", "--", "fixture.txt");
            git("commit", "-qm", "fixture worker fix");
            const worker = git("rev-parse", "HEAD");
            let remote = mode === "unpublished" ? base : worker;
            if (mode === "restacked") {
                // The PR head was rebased onto a moved base: the worker's patch is there, its commit is not.
                git("checkout", "-q", "--detach", base);
                fs.writeFileSync(join(wt, "other.txt"), "base moved\n");
                git("add", "--", "other.txt");
                git("commit", "-qm", "fixture base moved");
                fs.writeFileSync(join(wt, "fixture.txt"), "worker fix\n");
                git("add", "--", "fixture.txt");
                git("commit", "-qm", "fixture worker fix");
                remote = git("rev-parse", "HEAD");
            }
            if (mode !== "unverifiable") {
                git("update-ref", "refs/remotes/origin/pr-head", remote);
            }
            git("checkout", "-q", "--detach", mode === "behind" ? base : worker);
            const before = git("rev-parse", "HEAD");
            expect(git("status", "--porcelain", "--untracked-files=no")).toBe("");
            fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: wt, worktrees }));
            const checkoutCalls = join(dir, "checkouts.txt");
            const installCalls = join(dir, "installs.txt");
            const preload = join(dir, "preload.ts");
            fs.writeFileSync(
                preload,
                [
                    "import {appendFileSync} from 'node:fs';const spawn=Bun.spawnSync;",
                    "Bun.spawnSync=(args,opts)=>{",
                    "if(args[0] === 'git' && (args.includes('fetch') || args.includes('--git-common-dir'))) return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};",
                    "if(args[0] === 'git') {if(args.includes('checkout')) appendFileSync(" +
                        SafeJSON.stringify(checkoutCalls) +
                        ",'checkout\\n');return spawn(args,opts);}",
                    "if(args[0] === 'bun' && args[1] === 'install') {appendFileSync(" +
                        SafeJSON.stringify(installCalls) +
                        ",'intercepted, not installed\\n');process.exit(0);}",
                    "throw new Error('unexpected command');};",
                ].join("\n")
            );
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "setup-wt.ts"),
                    "--run",
                    dir,
                    "--pr",
                    "1",
                    "--branch",
                    "pr-head",
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            const refuse = mode === "unpublished" || mode === "unverifiable";
            expect(result.exitCode, result.stderr.toString()).toBe(refuse ? 1 : 0);
            expect(git("rev-parse", "HEAD")).toBe(refuse ? before : remote);
            expect(fs.existsSync(checkoutCalls)).toBe(!refuse);
            expect(fs.existsSync(installCalls)).toBe(!refuse);
            if (mode === "unpublished") {
                expect(result.stderr.toString()).toContain("unpublished");
            } else if (mode === "unverifiable") {
                expect(result.stderr.toString()).toContain("cannot verify");
            }
        }
    });
});

describe("round 19 review regressions", () => {
    test("relative executables follow every cd and never run a scratch-local tools", () => {
        const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-approval-cd-")));
        const scratch = join(root, ".claude/work/babysit");
        const outside = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-approval-outside-")));
        fs.mkdirSync(join(scratch, "nested"), { recursive: true });
        fs.writeFileSync(join(scratch, "tools"), "worker executable (never executed)");
        fs.symlinkSync(outside, join(root, "escape"));
        const worker = { ...entry, cwd: root };
        for (const command of [
            "cd .claude/work/babysit && ./tools github review sessions",
            "cd .claude/work && cd babysit && ./tools github review sessions",
            "cd escape && cat fixture",
            "cd missing && cat fixture",
            "cd .claude/work/babysit || ./tools github review sessions",
        ]) {
            expect(allowedCommand(worker, command), command).toBe(false);
        }
        expect(readOnlyChain(worker, "cd .claude/work && cd babysit && pwd")).toBe(true);
        const checkout = fs.realpathSync(join(import.meta.dir, "../../../.."));
        expect(readOnlyChain({ ...entry, cwd: checkout }, "./tools github review sessions")).toBe(true);
    });

    test("log redirections resolve the runtime directory and canonical destination", () => {
        const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-approval-log-")));
        const scratch = join(root, ".claude/work/babysit");
        const outside = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-log-outside-")));
        fs.mkdirSync(join(scratch, "nested"), { recursive: true });
        fs.mkdirSync(join(root, "sub/.claude/work/babysit"), { recursive: true });
        fs.writeFileSync(join(outside, "keep.log"), "keep");
        fs.symlinkSync(join(outside, "keep.log"), join(scratch, "linked.log"));
        fs.symlinkSync(outside, join(scratch, "linked-dir"));
        fs.symlinkSync(join(outside, "missing.log"), join(scratch, "dangling.log"));
        const worker = { ...entry, cwd: root };
        for (const command of [
            "pwd > .claude/work/babysit/linked.log 2>&1",
            "pwd > .claude/work/babysit/linked-dir/new.log 2>&1",
            "pwd > .claude/work/babysit/dangling.log 2>&1",
            "pwd > .claude/work/babysit/missing/new.log 2>&1",
            "cd sub && pwd > .claude/work/babysit/new.log 2>&1",
            "'cd' sub | pwd > ../.claude/work/babysit/new.log 2>&1",
        ]) {
            expect(allowedCommand(worker, command), command).toBe(false);
        }
        expect(allowedCommand(worker, "pwd > .claude/work/babysit/new.log 2>&1")).toBe(true);
        expect(allowedCommand(worker, "cd .claude/work && cd babysit && pwd > nested/new.log 2>&1")).toBe(true);
        const reviewer = { ...worker, scratch: outside };
        expect(allowedCommand(reviewer, `pwd > ${outside}/probe.log 2>&1`)).toBe(true);
        expect(fs.readFileSync(join(outside, "keep.log"), "utf8")).toBe("keep");
    });

    test("integration replaces the dashboard lint and complete typecheck push gates", () => {
        expect(PRE_PUSH_GUARDS).toContainEqual(["lint:dashboard", "bun", "run", "lint:dashboard"]);
        expect(PRE_PUSH_GUARDS).toContainEqual(["typecheck:all", "bun", "run", "typecheck:all"]);
    });

    test("the prescribed judge pack includes the saved worker report", () => {
        const skill = fs.readFileSync(join(import.meta.dir, "../SKILL.md"), "utf8");
        const invocation = /`bun \.claude\/skills\/babysit\/scripts\/judge-pack\.ts ([^`]+)`/.exec(skill);
        expect(invocation).not.toBeNull();
        expect(invocation?.[1]).toContain("--report <worker-final file>");
    });
});

describe("round 20 readiness deadline", () => {
    test("a real child read is killed when the shared wait budget expires", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-ready-child-deadline-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        const preload = join(dir, "preload.ts");
        const evidence = join(dir, "child.json");
        fs.writeFileSync(
            preload,
            [
                "import * as fs from 'node:fs';const spawn=Bun.spawnSync;",
                "Bun.spawnSync=(args,opts)=>{if(args[0] === 'git')return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};if(args[0] !== 'gh')throw new Error('unexpected child');",
                "const result=spawn([process.execPath,'-e','await Bun.sleep(1000)'],opts);fs.writeFileSync(" +
                    SafeJSON.stringify(evidence) +
                    ",JSON.stringify({timeout:opts.timeout,signal:result.signalCode}));return result;};",
            ].join("\n")
        );
        const result = Bun.spawnSync(
            [
                process.execPath,
                "--preload",
                preload,
                join(import.meta.dir, "round-ready.ts"),
                "--run",
                dir,
                "1",
                "--wait",
                "0.005",
            ],
            { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
        );
        expect(result.exitCode, result.stderr.toString()).toBe(3);
        const child = SafeJSON.parse(fs.readFileSync(evidence, "utf8"), { strict: true }) as {
            timeout: number;
            signal: string;
        };
        expect(child.timeout).toBeGreaterThan(0);
        expect(child.timeout).toBeLessThanOrEqual(300);
        expect(child.signal).toBe("SIGKILL");
        expect(result.stdout.toString()).toContain("not every head reviewed");
    });

    test("all PRs, pages and subprocesses share the finite wait deadline", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-ready-deadline-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        const preload = join(dir, "preload.ts");
        const evidence = join(dir, "evidence.json");
        for (const mode of ["hung", "pages", "sleep", "late-ready", "ready", "-1", "Infinity", "NaN", "1e308"]) {
            const invalid = ["-1", "Infinity", "NaN", "1e308"].includes(mode);
            fs.writeFileSync(
                preload,
                [
                    "import * as fs from 'node:fs';let now=0;const calls=[];Date.now=()=>now;Bun.sleep=async(ms)=>{now+=ms;};",
                    "const mode=" +
                        SafeJSON.stringify(mode) +
                        ";process.on('exit',()=>fs.writeFileSync(" +
                        SafeJSON.stringify(evidence) +
                        ",JSON.stringify({now,calls})));",
                    "Bun.spawnSync=(args,opts)=>{if(args[0] === 'git')return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};if(args[0] !== 'gh')throw new Error('unexpected child');calls.push({timeout:opts.timeout,killSignal:opts.killSignal});",
                    "const cost=mode === 'pages'?70:mode === 'hung'?1000:mode === 'late-ready'?120:0;now+=Math.min(cost,opts.timeout??cost);const timed=cost>(opts.timeout??Infinity);",
                    "const connection=(nodes=[])=>({nodes,pageInfo:{hasNextPage:mode === 'pages',endCursor:String(calls.length)}});const reviews=['ready','late-ready'].includes(mode)?[{id:'r',author:{login:'eve-bot-lovinka'},commit:{oid:'fixture-head'},submittedAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',state:'APPROVED'}]:[];",
                    "const pr={headRefOid:'fixture-head',reviewThreads:connection(),comments:connection(),reviews:connection(reviews),timelineItems:{nodes:[]}};return {exitCode:timed?124:0,stdout:Buffer.from(JSON.stringify({data:{viewer:{login:'fixture-lead'},repository:{pullRequest:pr}}})),stderr:Buffer.from(timed?'read timed out':'')};};",
                ].join("\n")
            );
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "round-ready.ts"),
                    "--run",
                    dir,
                    "1",
                    "2",
                    "--wait",
                    invalid ? mode : "0.002",
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(result.exitCode, mode + result.stderr.toString()).toBe(invalid ? 2 : mode === "ready" ? 0 : 3);
            const seen = SafeJSON.parse(fs.readFileSync(evidence, "utf8"), { strict: true }) as {
                now: number;
                calls: Array<{ timeout: number; killSignal: string }>;
            };
            if (invalid) {
                expect(seen.calls, mode).toEqual([]);
                expect(result.stderr.toString()).toContain("finite nonnegative");
            } else if (mode === "ready") {
                expect(seen.calls.map((call) => call.timeout)).toEqual([120, 120]);
                expect(seen.now).toBe(0);
            } else {
                expect(seen.now, mode).toBe(120);
                expect(
                    seen.calls.map((call) => call.timeout),
                    mode
                ).toEqual(mode === "pages" ? [120, 50] : mode === "sleep" ? [120, 120] : [120]);
                expect(seen.calls.every((call) => call.killSignal === "SIGKILL")).toBe(true);
                expect(result.stdout.toString()).toContain("not every head reviewed");
            }
        }
    });
});

describe("round 21 review regressions", () => {
    test("Swift targets compile after local dependencies and reject invalid graphs", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-swift-order-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        for (const folder of ["Sources/App", "Sources/Support", "Tests/AppTests"]) {
            fs.mkdirSync(join(dir, folder), { recursive: true });
            fs.writeFileSync(join(dir, folder, "Fixture.swift"), "// compiler is mocked\n");
        }
        const original = Bun.spawnSync;
        const success = original([process.execPath, "-e", ""], { stdout: "pipe", stderr: "pipe" });
        const modules: string[] = [];
        const spawn = spyOn(Bun, "spawnSync").mockImplementation((args) => {
            const words = Array.from(args, String);
            if (words[0] === "xcrun" && words[1] === "swiftc") {
                modules.push(words[words.indexOf("-module-name") + 1]);
            }
            return { ...success, stdout: Buffer.from(dir) };
        });
        const argv = process.argv;
        process.argv = [
            process.execPath,
            "swift-typecheck.ts",
            "--package",
            dir,
            "--run",
            dir,
            "--out",
            join(dir, "out"),
            "--deps",
            dir,
        ];
        try {
            fs.writeFileSync(
                join(dir, "Package.swift"),
                `let package = Package(targets: [
                .testTarget(name: "AppTests", dependencies: [.target(name: "App")]),
                .executableTarget(name: "App", dependencies: ["Support", "GenesisKit", .byName(name: "ExternalByName"), .product(name: "External", package: "external")]),
                .target(name: "Support")])`
            );
            expect(typecheckPackage()).toBe(0);
            expect(modules).toEqual(["Support", "App", "AppTests"]);
            for (const [dependencies, error] of [
                ['[.target(name: "Missing")]', "unknown local dependency"],
                ['["App"]', "cycle"],
            ]) {
                modules.length = 0;
                fs.writeFileSync(
                    join(dir, "Package.swift"),
                    `let package = Package(targets: [.target(name: "App", dependencies: ${dependencies})])`
                );
                expect(() => typecheckPackage()).toThrow(error);
                expect(modules).toEqual([]);
            }
        } finally {
            process.argv = argv;
            spawn.mockRestore();
        }
    });
});

describe("round 21 delivery and lifetime regressions", () => {
    test("landing bounds real GitHub children by the remaining wait budget", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-land-deadline-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        const preload = join(dir, "preload.ts");
        const evidence = join(dir, "reads.json");
        fs.writeFileSync(
            preload,
            [
                "import * as fs from 'node:fs';const spawn=Bun.spawnSync;let armed=false,clockReads=0,now=0;const reads=[];",
                "Date.now=()=>{if(armed){clockReads++;now=clockReads===1?0:Math.max(now,119900);}return now;};Bun.sleep=async(ms)=>{now+=ms;};process.on('exit',()=>fs.writeFileSync(" +
                    SafeJSON.stringify(evidence) +
                    ",JSON.stringify(reads)));",
                "const ok=(out='')=>({exitCode:0,stdout:Buffer.from(out),stderr:Buffer.alloc(0)});Bun.spawnSync=(args,opts)=>{if(args[0] === 'git'){if(args.includes('fetch') && opts.cwd === " +
                    SafeJSON.stringify(dir) +
                    ")armed=true;if(args.includes('rev-parse'))return ok('fixture-head');if(args.includes('log'))return ok('');return ok();}",
                'if(args[0] === \'gh\'){reads.push({timeout:opts.timeout});if(args.includes(\'headRefName,baseRefName,state\'))return ok(\'{"headRefName":"fixture","baseRefName":"main","state":"OPEN"}\');const result=spawn([process.execPath,\'-e\',\'await Bun.sleep(1000)\'],opts);reads.at(-1).signal=result.signalCode;now=Math.max(now,120000);return result;}return ok();};',
            ].join("\n")
        );
        const result = Bun.spawnSync(
            [
                process.execPath,
                "--preload",
                preload,
                join(import.meta.dir, "land.ts"),
                "--run",
                dir,
                "--wt",
                join(dir, "worker"),
                "--pr",
                "1",
                "--merge",
            ],
            { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
        );
        expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(1);
        expect(result.stderr.toString()).toContain("after 120 s; not merging");
        const reads = SafeJSON.parse(fs.readFileSync(evidence, "utf8"), { strict: true }) as Array<{
            timeout: number;
            signal?: string;
        }>;
        expect(reads).toHaveLength(2);
        expect(reads[0].timeout).toBeGreaterThan(0);
        expect(reads[1]).toEqual({ timeout: 100, signal: "SIGKILL" });
    });

    test("reclaim refuses invalid plan timestamps before any scan or deletion", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-plan-time-"));
        const root = join(dir, "tmp");
        fs.mkdirSync(root);
        const scanned = join(dir, "scanned");
        const plan = join(dir, "plan.json");
        const preload = join(dir, "preload.ts");
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir, prs: [] }));
        fs.writeFileSync(
            preload,
            [
                "import {mock} from 'bun:test';import * as fs from 'node:fs';import {SafeJSON} from " +
                    SafeJSON.stringify(join(import.meta.dir, "../../../../src/utils/json")) +
                    ";const parse=SafeJSON.parse.bind(SafeJSON);SafeJSON.parse=(...args)=>{const value=parse(...args);if(value?.createdAt === 'fixture-NaN')value.createdAt=NaN;return value;};const original={...fs};",
                "mock.module('node:fs',()=>({...original,realpathSync:(p)=>p === '/tmp'?" +
                    SafeJSON.stringify(root) +
                    ":original.realpathSync(p),renameSync:()=>{throw new Error('deletion reached');}}));",
                "mock.module(" +
                    SafeJSON.stringify(join(import.meta.dir, "../../../../src/utils/providers/session-paths.ts")) +
                    ",()=>({nativeSessionRoots:()=>[],nativeTranscriptMaxDepth:()=>4}));Bun.spawnSync=()=>{original.writeFileSync(" +
                    SafeJSON.stringify(scanned) +
                    ",'scan');return {exitCode:0,stdout:Buffer.from('p1\\nn/unrelated-fixture\\n'),stderr:Buffer.alloc(0)};};",
            ].join("\n")
        );
        for (const createdAt of [
            undefined,
            String(Date.now()),
            "fixture-NaN",
            Date.now() + 86_400_000,
            Date.now() - 31 * 60_000,
        ]) {
            fs.writeFileSync(plan, SafeJSON.stringify({ createdAt, minAgeHours: 0, candidates: [] }));
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "tmp-reclaim.ts"),
                    "--run",
                    dir,
                    "--apply",
                    "--plan",
                    plan,
                ],
                { stdout: "pipe", stderr: "pipe", env: { ...env.getProcessEnv(), TMPDIR: root }, timeout: 5000 }
            );
            expect(result.exitCode, String(createdAt) + result.stderr.toString()).toBe(2);
            expect(fs.existsSync(scanned)).toBe(false);
        }
        fs.writeFileSync(plan, SafeJSON.stringify({ createdAt: Date.now(), minAgeHours: 0, candidates: [] }));
        const valid = Bun.spawnSync(
            [
                process.execPath,
                "--preload",
                preload,
                join(import.meta.dir, "tmp-reclaim.ts"),
                "--run",
                dir,
                "--apply",
                "--plan",
                plan,
            ],
            { stdout: "pipe", stderr: "pipe", env: { ...env.getProcessEnv(), TMPDIR: root }, timeout: 5000 }
        );
        expect(valid.exitCode, valid.stderr.toString()).toBe(0);
        expect(fs.existsSync(scanned)).toBe(true);
    });

    test("steering uses the bounded shared executor and preserves failed-delivery evidence and exit codes", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-steer-executor-"));
        const file = join(dir, "prompt.md");
        fs.writeFileSync(file, "fixture prompt");
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        const preload = join(dir, "preload.ts"),
            evidence = join(dir, "delivery.json");
        for (const code of [0, 7, 124]) {
            fs.writeFileSync(
                preload,
                [
                    "import {mock} from 'bun:test';import * as fs from 'node:fs';const record=(args,opts,via)=>fs.writeFileSync(" +
                        SafeJSON.stringify(evidence) +
                        ",JSON.stringify({args,cwd:opts.cwd,timeout:opts.timeout,via}));",
                    "mock.module(" +
                        SafeJSON.stringify(join(import.meta.dir, "../../../../src/ai/commands/agent/wait.ts")) +
                        ",()=>({readTurnBaseline:async()=>null}));",
                    "mock.module(" +
                        SafeJSON.stringify(join(import.meta.dir, "../../../../src/utils/cli/index.ts")) +
                        ",()=>({execTool:async(args,opts)=>{record(args,opts,'shared');return {success:" +
                        String(code === 0) +
                        ",exitCode:" +
                        code +
                        ",timedOut:" +
                        String(code === 124) +
                        ",stdout:'',stderr:'fixture delivery failure'};}}));",
                    "Bun.spawnSync=(args,opts)=>{if(args.includes('steer'))record(args,opts,'direct');return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};};",
                ].join("\n")
            );
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "steer.ts"),
                    "--run",
                    dir,
                    "--worker",
                    "fixture",
                    "--file",
                    file,
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(result.exitCode, result.stderr.toString()).toBe(code);
            const seen = SafeJSON.parse(fs.readFileSync(evidence, "utf8"), { strict: true }) as {
                args: string[];
                cwd: string;
                timeout: number;
                via: string;
            };
            expect(seen.via).toBe("shared");
            expect(seen.cwd).toBe(dir);
            expect(seen.timeout).toBeGreaterThan(0);
            expect(Number.isFinite(seen.timeout)).toBe(true);
            expect(seen.args).toEqual(["codex", "steer", "--name", "fixture", "--prompt-file", file]);
            const events = readEvents(dir);
            expect(events.at(code === 0 ? -1 : -2)?.text).toBe("fixture prompt");
            if (code !== 0) {
                expect(events.at(-1)?.text).toContain("steer NOT delivered");
            }
        }
    });
});

describe("round 22 judge pack paths", () => {
    test("committed accented and tab filenames retain their complete patches", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-pack-paths-"));
        const git = (...args: string[]) => {
            const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
                cwd: dir,
                stdout: "pipe",
                stderr: "pipe",
                env: env.getProcessEnv(),
            });
            expect(result.exitCode, result.stderr.toString()).toBe(0);
            return result.stdout.toString().trim();
        };
        git("init", "-q");
        git("config", "user.name", "Fixture");
        git("config", "user.email", "fixture@example.com");
        git("config", "core.quotePath", "true");
        const names = ["café.ts", "with\ttab.ts", "plain.test.ts"];
        for (const [i, name] of names.entries()) {
            fs.writeFileSync(join(dir, name), `export const marker${i} = "before";\n`);
        }
        git("add", "--", ...names);
        git("commit", "-qm", "fixture before");
        for (const [i, name] of names.entries()) {
            fs.writeFileSync(join(dir, name), `export const marker${i} = "after";\n`);
        }
        git("add", "--", ...names);
        git("commit", "-qm", "fixture after");
        const result = Bun.spawnSync(
            [process.execPath, join(import.meta.dir, "judge-pack.ts"), "--wt", dir, "--range", "HEAD~1..HEAD"],
            {
                stdout: "pipe",
                stderr: "pipe",
                env: env.getProcessEnv(),
                timeout: 5000,
            }
        );
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const pack = result.stdout.toString();
        for (const i of names.keys()) {
            expect(pack, names[i]).toContain(`-export const marker${i} = "before";`);
            expect(pack, names[i]).toContain(`+export const marker${i} = "after";`);
        }
        expect(pack.indexOf('+export const marker2 = "after";')).toBeLessThan(
            pack.indexOf('+export const marker0 = "after";')
        );
    });
});

describe("round 22 external Swift products", () => {
    test("real app manifests parse without running Swift or any subprocess", () => {
        const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => {
            throw new Error("manifest parsing must not run subprocesses");
        });
        try {
            for (const [manifest, expected] of [
                ["src/macos/GenesisTools/Package.swift", ["GenesisTools", "GenesisToolsTests"]],
                ["src/macos/GenesisWidgetPreview/Package.swift", ["GenesisWidgetPreview"]],
            ] as const) {
                const text = fs.readFileSync(join(import.meta.dir, "../../../..", manifest), "utf8");
                expect(parseSwiftTargets(text).map((target) => target.name)).toEqual([...expected]);
            }
            const targets = parseSwiftTargets(`let package = Package(targets: [
                .executableTarget(name: "App", dependencies: ["GenesisKit", .byName(name: "External"), "Support"]),
                .target(name: "Support")])`);
            expect(targets.map((target) => target.name)).toEqual(["Support", "App"]);
            expect(() =>
                parseSwiftTargets(
                    'let package = Package(targets: [.target(name: "A", dependencies: ["B"]), .target(name: "B", dependencies: ["A"])])'
                )
            ).toThrow("cycle");
            expect(() =>
                parseSwiftTargets(
                    'let package = Package(targets: [.target(name: "A", dependencies: [.target(name: "Missing")])])'
                )
            ).toThrow("unknown local dependency");
            expect(spawn).not.toHaveBeenCalled();
        } finally {
            spawn.mockRestore();
        }
    });
});

describe("round 23 landing squash hooks", () => {
    test.each(["normal", "stall", "reject"])("squash commit respects config hooks: %s", (mode) => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-land-hooks-"));
        const git = (...args: string[]) => {
            const p = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
                cwd: dir,
                stdout: "pipe",
                stderr: "pipe",
                env: env.getProcessEnv(),
            });
            expect(p.exitCode, p.stderr.toString()).toBe(0);
            return p.stdout.toString().trim();
        };
        git("init", "-q");
        git("config", "user.name", "Fixture");
        git("config", "user.email", "fixture@example.com");
        const file = join(dir, "fixture.txt");
        const commit = (text: string, subject: string) => {
            fs.writeFileSync(file, text);
            git("add", "--", "fixture.txt");
            git("commit", "-qm", subject);
            return git("rev-parse", "HEAD");
        };
        const base = commit("base", "base");
        const feature = commit("feature", "feat(tools): fixture feature");
        commit("round one", "fix(tools): #1 followup - first");
        const oldHead = commit("round two", "fix(tools): #1 followup - second");
        const tree = git("rev-parse", "HEAD^{tree}");
        git("update-ref", "refs/remotes/origin/main", base);
        git("update-ref", "refs/remotes/origin/fixture", oldHead);
        git("config", "hook.fixture-pre.event", "pre-commit");
        git(
            "config",
            "hook.fixture-pre.command",
            "printf 'pre-commit\\n' >> hook-marker" + (mode === "reject" ? "; exit 23" : "")
        );
        git("config", "hook.fixture-message.event", "commit-msg");
        git("config", "hook.fixture-message.command", "printf 'commit-msg\\n' >> hook-marker");
        expect(git("hook", "list", "pre-commit")).toContain("fixture-pre");
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "genesiscz/GenesisTools", main: dir }));
        const preload = join(dir, "preload.ts");
        const versions = join(import.meta.dir, "versions.ts");
        fs.writeFileSync(
            preload,
            [
                "import {mock} from 'bun:test';import * as versions from " +
                    SafeJSON.stringify(versions) +
                    ";const original={...versions};mock.module(" +
                    SafeJSON.stringify(versions) +
                    ",()=>({...original,newExecutablesStall:async()=>" +
                    String(mode === "stall") +
                    "}));",
                "const spawn=Bun.spawnSync;const ok=(out='')=>({exitCode:0,stdout:Buffer.from(out),stderr:Buffer.alloc(0)});Bun.spawnSync=(args,opts)=>{if(args[0] === 'gh'){if(args[1] !== 'pr' || args[2] !== 'view')throw new Error('no GitHub writes');return ok('{\"headRefName\":\"fixture\",\"baseRefName\":\"main\",\"state\":\"OPEN\"}');}if(args[0] === 'git'){if(args.includes('fetch'))return ok();if(args.includes('push'))throw new Error('no pushes');return spawn(args,opts);}if(args[0] === 'bun' && args[1] === 'scripts/git/check-commits.ts')return ok();throw new Error('unexpected command');};",
            ].join("\n")
        );
        const result = Bun.spawnSync(
            [
                process.execPath,
                "--preload",
                preload,
                join(import.meta.dir, "land.ts"),
                "--run",
                dir,
                "--wt",
                dir,
                "--pr",
                "1",
            ],
            {
                stdout: "pipe",
                stderr: "pipe",
                env: env.getProcessEnv(),
                timeout: 5000,
            }
        );
        expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(mode === "reject" ? 1 : 0);
        const marker = join(dir, "hook-marker");
        if (mode === "stall") {
            expect(fs.existsSync(marker)).toBe(false);
            expect(result.stdout.toString()).toContain("squash commit hooks disabled: new executables stall");
        } else {
            expect(fs.readFileSync(marker, "utf8")).toBe(
                mode === "reject" ? "pre-commit\n" : "pre-commit\ncommit-msg\n"
            );
        }
        expect(git("rev-parse", "HEAD")).not.toBe(oldHead);
        expect(git("rev-parse", "HEAD^{tree}")).toBe(mode === "reject" ? git("rev-parse", feature + "^{tree}") : tree);
        expect(git("log", "-1", "--format=%s")).toBe(
            mode === "reject"
                ? "feat(tools): fixture feature"
                : "fix(tools): #1 followup - address PR review (2 commits)"
        );
    });
});

describe("round 24 verification boundaries", () => {
    test("unsupported Swift target lists fail and whitespace declarations still compile", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-empty-targets-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        fs.mkdirSync(join(dir, "Sources/Kit"), { recursive: true });
        fs.writeFileSync(join(dir, "Sources/Kit/Fixture.swift"), "// mocked compiler fixture\n");
        const success = Bun.spawnSync([process.execPath, "-e", ""], {
            stdout: "pipe",
            stderr: "pipe",
            env: env.getProcessEnv(),
        });
        const commands: string[][] = [];
        const spawn = spyOn(Bun, "spawnSync").mockImplementation((args) => {
            commands.push(Array.from(args, String));
            return { ...success, stdout: Buffer.from(dir) };
        });
        const errors: string[] = [];
        const error = spyOn(console, "error").mockImplementation((text) => {
            errors.push(String(text));
        });
        const argv = process.argv;
        process.argv = [
            process.execPath,
            "swift-typecheck.ts",
            "--package",
            dir,
            "--run",
            dir,
            "--out",
            join(dir, "out"),
            "--deps",
            dir,
        ];
        try {
            for (const manifest of [
                'let targets = makeTargets(); let package = Package(name: "Fixture", targets: targets)',
                'let package = Package(name: "Fixture", targets: [])',
            ]) {
                fs.writeFileSync(join(dir, "Package.swift"), manifest);
                expect(typecheckPackage()).toBe(1);
                expect(errors.at(-1)).toContain("no supported targets");
                expect(commands).toEqual([]);
            }
            const manifest = 'let package = Package(targets: [.target \n (name: "Kit")])';
            expect(parseSwiftTargets(manifest).map((target) => target.name)).toEqual(["Kit"]);
            fs.writeFileSync(join(dir, "Package.swift"), manifest);
            expect(typecheckPackage()).toBe(0);
            expect(commands.filter((args) => args.includes("swiftc"))).toHaveLength(1);
        } finally {
            process.argv = argv;
            spawn.mockRestore();
            error.mockRestore();
        }
    });

    test("landing polls and merges the run-card repository for both merge methods", () => {
        for (const method of ["--rebase", "--squash"]) {
            const dir = fs.mkdtempSync(join(tmpdir(), "babysit-land-repo-"));
            fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/selected", main: dir }));
            const preload = join(dir, "preload.ts"),
                evidence = join(dir, "calls.json");
            fs.writeFileSync(
                preload,
                [
                    "import {mock} from 'bun:test';import * as fs from 'node:fs';const views=[];let merge;process.on('exit',()=>fs.writeFileSync(" +
                        SafeJSON.stringify(evidence) +
                        ",JSON.stringify({views,merge})));",
                    "mock.module(" +
                        SafeJSON.stringify(join(import.meta.dir, "../../../../src/utils/cli/index.ts")) +
                        ",()=>({execTool:async(args)=>{merge=args;return {success:true,exitCode:0,stdout:'sha: '+ 'a'.repeat(40),stderr:''};}}));",
                    "const ok=(out='')=>({exitCode:0,stdout:Buffer.from(out),stderr:Buffer.alloc(0)});Bun.spawnSync=(args)=>{if(args[0] === 'gh'){views.push(args);return ok(args.includes('headRefOid')?'fixture-head':'{\"headRefName\":\"fixture\",\"baseRefName\":\"main\",\"state\":\"OPEN\"}');}if(args[0] === 'git'){if(args.includes('push'))throw new Error('no pushes');return ok(args.includes('rev-parse')?'fixture-head':'');}if(args[0] === 'bun' && args[1] === 'scripts/git/check-commits.ts')return ok();throw new Error('unexpected command');};",
                ].join("\n")
            );
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "land.ts"),
                    "--run",
                    dir,
                    "--wt",
                    dir,
                    "--pr",
                    "1",
                    "--merge",
                    ...(method === "--squash" ? ["--squash"] : []),
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
            const calls = SafeJSON.parse(fs.readFileSync(evidence, "utf8"), { strict: true }) as {
                views: string[][];
                merge: string[];
            };
            expect(calls.views).toHaveLength(2);
            for (const args of calls.views) {
                expect(args[args.indexOf("--repo") + 1]).toBe("fixture/selected");
            }
            expect(calls.merge).toEqual(["github", "merge", method, "1", "--repo", "fixture/selected"]);
        }
    });
});

describe("round 25 review input and execution bounds", () => {
    test("prefetch retains human and bot findings with authors, excluding only own summaries and named noise", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-comment-input-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        const comments = [
            ["fixture-human", "human finding retained"],
            ["review-service", "bot finding retained"],
            ["fixture-lead", "# Review fixes\nour summary omitted"],
            ["another-human", "# Review fixes\nother summary retained"],
            ["fixture-lead", "our ordinary finding retained"],
            [
                "coderabbitai[bot]",
                "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\nrate notice omitted",
            ],
            [
                "coderabbitai[bot]",
                "<!-- This is an auto-generated reply by CodeRabbit -->\n<details><summary>✅ Action performed</summary>\naction notice omitted</details>",
            ],
            ["coderabbitai[bot]", "coderabbit finding retained"],
        ].map(([login, body]) => ({ user: { login }, body, created_at: "2026-01-01T00:00:00Z" }));
        const preload = join(dir, "preload.ts");
        fs.writeFileSync(
            preload,
            [
                "import {mock} from 'bun:test';mock.module(" +
                    SafeJSON.stringify(join(import.meta.dir, "../../../../src/utils/cli/index.ts")) +
                    ",()=>({execTool:async()=>({success:true,exitCode:0,stdout:'Stats: 0 threads',stderr:''})}));",
                "Bun.spawnSync=(args)=>{const out=args.includes('user')?'fixture-lead':args.some(a=>a.includes('/comments?'))?" +
                    SafeJSON.stringify(SafeJSON.stringify([comments])) +
                    ":'[]';return {exitCode:0,stdout:Buffer.from(out),stderr:Buffer.alloc(0)};};",
            ].join("\n")
        );
        const result = Bun.spawnSync(
            [
                process.execPath,
                "--preload",
                preload,
                join(import.meta.dir, "fetch-threads.ts"),
                "--run",
                dir,
                "--wt",
                dir,
                "--pr",
                "1",
                "--round",
                "1",
            ],
            { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
        );
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const body = fs.readFileSync(join(dir, ".claude/work/babysit/1-r1-pr-comments.md"), "utf8");
        for (const [author, text] of [
            ["fixture-human", "human finding retained"],
            ["review-service", "bot finding retained"],
            ["another-human", "other summary retained"],
            ["fixture-lead", "our ordinary finding retained"],
            ["coderabbitai[bot]", "coderabbit finding retained"],
        ]) {
            expect(body).toContain("### comment by " + author + " at ");
            expect(body).toContain(text);
        }
        for (const text of ["our summary omitted", "rate notice omitted", "action notice omitted"]) {
            expect(body).not.toContain(text);
        }
    });

    test("a run deadline kills and reaps the real child before a second waiter acquires the slot", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-slot-runtime-"));
        const preload = join(dir, "preload.ts"),
            evidence = join(dir, "child.json");
        fs.writeFileSync(
            preload,
            [
                "import {mock} from 'bun:test';import * as fs from 'node:fs';mock.module(" +
                    SafeJSON.stringify(join(import.meta.dir, "../../../../src/utils/process/processes.ts")) +
                    ",()=>({listProcesses:()=>[]}));const spawn=Bun.spawn;",
                "Bun.spawn=(...args)=>{const child=spawn(...args);fs.writeFileSync(" +
                    SafeJSON.stringify(evidence) +
                    ",JSON.stringify({pid:child.pid}));child.exited.then(()=>fs.writeFileSync(" +
                    SafeJSON.stringify(evidence) +
                    ",JSON.stringify({pid:child.pid,signal:child.signalCode})));return child;};",
            ].join("\n")
        );
        const run = (minutes: string, code: string) =>
            Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "swift-slot.ts"),
                    "--wait-minutes",
                    "1",
                    "--run-minutes",
                    minutes,
                    "--",
                    process.execPath,
                    "-e",
                    code,
                ],
                { stdout: "pipe", stderr: "pipe", env: { ...env.getProcessEnv(), TMPDIR: dir }, timeout: 4000 }
            );
        const first = run("0.005", "await Bun.sleep(1500)");
        expect(first.exitCode, first.stderr.toString()).toBe(124);
        expect(first.stderr.toString()).toContain("run deadline");
        const child = SafeJSON.parse(fs.readFileSync(evidence, "utf8"), { strict: true }) as {
            pid: number;
            signal: string;
        };
        expect(child.signal).toBe("SIGKILL");
        expect(isProcessAlive(child.pid)).toBe(false);
        const second = run("1", "console.log('second waiter acquired')");
        expect(second.exitCode, second.stderr.toString()).toBe(0);
        expect(second.stdout.toString()).toContain("second waiter acquired");
        const acquired = trySwiftSlot(join(dir, "genesis-swift-slot.lock"));
        expect(acquired).not.toBeNull();
        acquired?.();
    }, 10000);
});

describe("round 26 posting and answering-turn fences", () => {
    test("integration publishes only with explicit authorization, and no-post always wins", () => {
        for (const fixture of [
            { post: true, flags: [], allowed: true },
            { post: false, flags: [], allowed: false },
            { post: "ask", flags: [], allowed: false },
            { post: undefined, flags: [], allowed: false },
            { post: true, flags: ["--no-post"], allowed: false },
            { post: false, flags: ["--post"], allowed: true },
            { post: undefined, flags: ["--post"], allowed: true },
            { post: true, flags: ["--post", "--no-post"], allowed: false },
        ]) {
            const dir = fs.mkdtempSync(join(tmpdir(), "babysit-post-permission-"));
            fs.writeFileSync(
                join(dir, "run.json"),
                SafeJSON.stringify({
                    repo: "fixture/repo",
                    main: dir,
                    post: fixture.post,
                    reviewLoopScripts: join(dir, "scripts"),
                })
            );
            fs.writeFileSync(
                join(dir, "replies.json"),
                SafeJSON.stringify({ pr: 1, round: 1, model: "fixture", intro: "fixture", items: [] })
            );
            const preload = join(dir, "preload.ts"),
                callsFile = join(dir, "calls.json");
            fs.writeFileSync(
                preload,
                [
                    "import * as fs from 'node:fs';const mutations=[];process.on('exit',()=>fs.writeFileSync(" +
                        SafeJSON.stringify(callsFile) +
                        ",JSON.stringify(mutations)));const ok=(out='')=>({exitCode:0,stdout:Buffer.from(out),stderr:Buffer.alloc(0)});",
                    "Bun.spawnSync=(args)=>{if(args[0] === 'git'){if(args.includes('push'))throw new Error('no pushes');return ok(args.includes('rev-parse')?'fixture-head':'');}if(args[0] === 'gh'){if(args[1] === 'pr' && args[2] === 'view')return ok(JSON.stringify({headRefName:'fixture',baseRefName:'main'}));mutations.push(args);return ok();}if(args.some(a=>a.endsWith('round-summary.ts'))){fs.writeFileSync(args[args.indexOf('--out')+1],'fixture summary');return ok();}if(args.some(a=>a.endsWith('post-replies.ts'))){mutations.push(args);return ok();}throw new Error('unexpected command');};",
                ].join("\n")
            );
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "integrate.ts"),
                    "--run",
                    dir,
                    "--wt",
                    dir,
                    "--pr",
                    "1",
                    "--round",
                    "1",
                    "--replies",
                    join(dir, "replies.json"),
                    ...fixture.flags,
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
            const calls = SafeJSON.parse(fs.readFileSync(callsFile, "utf8"), { strict: true }) as string[][];
            expect(calls.length > 0, SafeJSON.stringify(fixture)).toBe(fixture.allowed);
            expect(fs.existsSync(join(dir, "vault/1-r1-replies.json"))).toBe(true);
            expect(fs.existsSync(join(dir, "vault/1-r1-summary.md"))).toBe(true);
            if (!fixture.allowed) {
                expect(result.stdout.toString()).toContain("held");
            }
        }
    });

    test("a steer fence excludes the previous finished turn and accepts a reply finished before waiting", () => {
        for (const mode of ["previous", "fast"]) {
            const dir = fs.mkdtempSync(join(tmpdir(), "babysit-answer-fence-"));
            fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
            const prompt = join(dir, "prompt.md");
            fs.writeFileSync(prompt, "new round");
            const preload = join(dir, "preload.ts");
            fs.writeFileSync(
                preload,
                [
                    "import {mock} from 'bun:test';import {turnAnswers} from " +
                        SafeJSON.stringify(join(import.meta.dir, "../../../../src/utils/ai/transcripts/turn-wait.ts")) +
                        ";Date.now=()=>1000;Bun.sleep=async()=>{};",
                    "mock.module(" +
                        SafeJSON.stringify(join(import.meta.dir, "../../../../src/ai/commands/agent/wait.ts")) +
                        ",()=>({readTurnBaseline:async()=>({sessionId:'fixture-thread',turnStartedAt:1000,transcriptBytes:100})}));",
                    "mock.module(" +
                        SafeJSON.stringify(join(import.meta.dir, "../../../../src/utils/cli/index.ts")) +
                        ",()=>({execTool:async()=>({success:true,exitCode:0,stdout:'',stderr:''})}));",
                    "Bun.spawnSync=(args)=>{if(args[0] === 'git')return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};if(!args.includes('wait'))throw new Error('unexpected child');const number=(flag)=>args.includes(flag)?Number(args[args.indexOf(flag)+1]):undefined;const window={turnStartedAfter:number('--sent-at'),turnNewerThan:number('--baseline-turn-started-at'),openedFromByte:number('--baseline-transcript-bytes')};const fast=" +
                        String(mode === "fast") +
                        ";const answers=turnAnswers(fast?2000:1000,window,fast?200:0);return {exitCode:answers?0:124,stdout:Buffer.from(JSON.stringify({outcome:answers?'done':'timeout',lastText:answers?(fast?'new round reply':'previous finished reply'):''})),stderr:Buffer.alloc(0)};};",
                ].join("\n")
            );
            const steer = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "steer.ts"),
                    "--run",
                    dir,
                    "--worker",
                    "fixture",
                    "--pr",
                    "1",
                    "--round",
                    "2",
                    "--file",
                    prompt,
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(steer.exitCode, steer.stderr.toString()).toBe(0);
            const sent = readEvents(dir).at(-1);
            expect(sent?.meta?.sentAt).toBe(1000);
            expect(sent?.meta?.baselineTurnStartedAt).toBe(1000);
            expect(sent?.meta?.baselineTranscriptBytes).toBe(100);
            const waited = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "wait-turn.ts"),
                    "--run",
                    dir,
                    "--worker",
                    "fixture",
                    "--thread",
                    "fixture-thread",
                    "--pr",
                    "1",
                    "--round",
                    "2",
                    "--timeout",
                    "1",
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(waited.exitCode, waited.stderr.toString()).toBe(mode === "fast" ? 0 : 124);
            const reply = readEvents(dir).at(-1);
            expect(reply?.text).not.toContain("previous finished reply");
            if (mode === "fast") {
                expect(reply?.text).toBe("new round reply");
            }
        }
    });
});

test("live turn waits refuse an absent fence or a different baseline session before reading a reply", () => {
    for (const mode of ["absent", "mismatch"]) {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-wait-missing-fence-"));
        fs.writeFileSync(join(dir, "run.json"), SafeJSON.stringify({ repo: "fixture/repo", main: dir }));
        if (mode === "mismatch") {
            appendEvent(dir, { kind: "steer", worker: "fixture", meta: { sentAt: 1000, sessionId: "another-thread" } });
        }
        const preload = join(dir, "preload.ts");
        fs.writeFileSync(
            preload,
            "Bun.spawnSync=(args)=>{if(args.includes('wait'))throw new Error('must not read an unfenced reply');return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};};"
        );
        const result = Bun.spawnSync(
            [
                process.execPath,
                "--preload",
                preload,
                join(import.meta.dir, "wait-turn.ts"),
                "--run",
                dir,
                "--worker",
                "fixture",
                "--thread",
                "fixture-thread",
            ],
            { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr.toString()).toContain(mode === "absent" ? "no answering-turn fence" : "--thread differs");
        expect(readEvents(dir).some((event) => event.kind === "turn")).toBe(false);
    }
});

describe("round 27 canonical fable edit targets", () => {
    test.each(["file link", "parent link", "new nested escape", "unscoped local link", "dangling link", "link loop"])(
        "refuses %s before approving an edit",
        (mode) => {
            const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-edit-canonical-")));
            const outside = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-edit-outside-")));
            const scratch = join(root, ".claude/work/babysit");
            fs.mkdirSync(scratch, { recursive: true });
            fs.writeFileSync(join(outside, "fixture.ts"), "old");
            fs.writeFileSync(join(root, "unscoped.ts"), "old");
            const link = join(scratch, "target");
            fs.symlinkSync(
                mode === "unscoped local link"
                    ? join(root, "unscoped.ts")
                    : mode === "dangling link"
                      ? join(outside, "missing.ts")
                      : mode === "link loop"
                        ? link
                        : mode === "file link"
                          ? join(outside, "fixture.ts")
                          : outside,
                link
            );
            const target =
                mode === "parent link"
                    ? link + "/fixture.ts"
                    : mode === "new nested escape"
                      ? link + "/new/deep/fixture.ts"
                      : link;
            const command = `bun ${trustedCli} <<'FR'\n@@ ${target}\n<<<\nold\n===\nnew\n>>>\nFR`;
            const worker = { ...entry, cwd: root };
            try {
                expect(allowedCommand(worker, command), mode).toBe(false);
                const decision = decide(worker, {
                    method: "item/commandExecution/requestApproval",
                    cwd: worker.cwd,
                    command,
                });
                expect(decision.ok).toBe(false);
                expect(fs.readFileSync(join(outside, "fixture.ts"), "utf8")).toBe("old");
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
                fs.rmSync(outside, { recursive: true, force: true });
            }
        }
    );

    test("approves ordinary and new in-scope targets through a symlinked worktree root", () => {
        const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-edit-positive-")));
        const root = join(dir, "real-worktree");
        const alias = join(dir, "worktree-alias");
        fs.mkdirSync(join(root, "src"), { recursive: true });
        fs.writeFileSync(join(root, "src/a.ts"), "old");
        fs.symlinkSync(root, alias);
        const worker = { ...entry, cwd: alias, scope: ["src/a.ts", "src/new/deep/file.ts"] };
        try {
            for (const target of ["src/a.ts", "src/new/deep/file.ts", ".claude/work/babysit/new/deep/file.ts"]) {
                const operation = target === "src/a.ts" ? "<<<\nold\n===\nnew\n>>>" : "<<< create\nfixture\n>>>";
                const command = `bun ${trustedCli} <<'FR'\n@@ ${target}\n${operation}\nFR`;
                expect(allowedCommand(worker, command), target).toBe(true);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("round 31 exclusive reclaim quarantines", () => {
    test.each(["directory", "symlink"])("preserves a pre-existing %s at the old quarantine name", (mode) => {
        const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "babysit-private-quarantine-")));
        const roots = [join(dir, "tmp"), join(dir, "user-tmp")];
        const outside = join(dir, "outside");
        for (const folder of [...roots, outside]) {
            fs.mkdirSync(folder);
        }
        fs.writeFileSync(join(outside, "keep.txt"), "external contents");
        const candidates = [
            join(roots[0], "fixture-first"),
            join(roots[0], "fixture-second"),
            join(roots[1], "fixture-third"),
        ];
        for (const file of candidates) {
            fs.writeFileSync(file, "planned contents");
        }
        const plan = join(dir, "plan.json");
        fs.writeFileSync(
            plan,
            SafeJSON.stringify({
                createdAt: Date.now(),
                minAgeHours: 0,
                candidates: candidates.map((path) => ({ path, ino: fs.lstatSync(path).ino, bytes: 0, newest: 0 })),
            })
        );
        const evidence = join(dir, "evidence.json");
        const preload = join(dir, "preload.ts");
        fs.writeFileSync(
            preload,
            [
                "import {mock} from 'bun:test';import * as fs from 'node:fs';import {join,dirname} from 'node:path';const original={...fs};",
                "const roots=" +
                    SafeJSON.stringify(roots) +
                    ", outside=" +
                    SafeJSON.stringify(outside) +
                    ", mode=" +
                    SafeJSON.stringify(mode) +
                    ";",
                "const old=roots.map(root=>{const path=join(root,'.tmp-reclaim-'+process.pid);if(mode==='symlink')original.symlinkSync(outside,path);else {original.mkdirSync(path);original.writeFileSync(join(path,'keep.txt'),'pre-existing contents');}return {path,ino:original.lstatSync(path).ino};});",
                "const created=[],moves=[],cleanups=[];const save=()=>original.writeFileSync(" +
                    SafeJSON.stringify(evidence) +
                    ",JSON.stringify({old,created,moves,cleanups}));save();",
                "mock.module('node:fs',()=>({...original,realpathSync:p=>p==='/tmp'?roots[0]:original.realpathSync(p),mkdtempSync:prefix=>{const path=original.mkdtempSync(prefix);created.push({path,mode:original.lstatSync(path).mode&511});save();return path;},renameSync:(from,to)=>{moves.push({from,to,mode:original.lstatSync(dirname(to)).mode&511});save();return original.renameSync(from,to);},rmSync:(path,opts)=>{cleanups.push(path);save();return original.rmSync(path,opts);}}));",
                "mock.module(" +
                    SafeJSON.stringify(join(import.meta.dir, "../../../../src/utils/providers/session-paths.ts")) +
                    ",()=>({nativeSessionRoots:()=>[],nativeTranscriptMaxDepth:()=>4}));",
                "Bun.spawnSync=args=>{if(args[0]!=='lsof')throw new Error('unexpected command');return {exitCode:0,stdout:Buffer.from('p1\\nn/unrelated-fixture\\n'),stderr:Buffer.alloc(0)};};",
            ].join("\n")
        );
        try {
            const result = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "tmp-reclaim.ts"),
                    "--apply",
                    "--plan",
                    plan,
                ],
                {
                    stdout: "pipe",
                    stderr: "pipe",
                    env: { ...env.getProcessEnv(), TMPDIR: roots[1] },
                    timeout: 5000,
                }
            );
            expect(result.exitCode, result.stderr.toString()).toBe(0);
            const seen = SafeJSON.parse(fs.readFileSync(evidence, "utf8"), { strict: true }) as {
                old: Array<{ path: string; ino: number }>;
                created: Array<{ path: string; mode: number }>;
                moves: Array<{ from: string; to: string; mode: number }>;
                cleanups: string[];
            };
            for (const old of seen.old) {
                expect(fs.existsSync(old.path), "pre-existing quarantine must survive").toBe(true);
                expect(fs.lstatSync(old.path).ino).toBe(old.ino);
                expect(fs.lstatSync(old.path).isSymbolicLink()).toBe(mode === "symlink");
                expect(fs.readFileSync(join(old.path, "keep.txt"), "utf8")).toBe(
                    mode === "symlink" ? "external contents" : "pre-existing contents"
                );
            }
            expect(fs.readdirSync(outside)).toEqual(["keep.txt"]);
            expect(seen.created).toHaveLength(2);
            expect(seen.created.map((folder) => dirname(folder.path)).sort()).toEqual([...roots].sort());
            expect(seen.created.every((folder) => folder.mode === 0o700)).toBe(true);
            expect(seen.moves.map((move) => move.from)).toEqual(candidates);
            for (const move of seen.moves) {
                expect(seen.created.map((folder) => folder.path)).toContain(dirname(move.to));
                expect(dirname(dirname(move.to))).toBe(dirname(move.from));
                expect(move.mode).toBe(0o700);
                expect(fs.existsSync(move.from)).toBe(false);
                expect(fs.existsSync(move.to)).toBe(false);
            }
            expect(seen.cleanups.sort()).toEqual(seen.created.map((folder) => folder.path).sort());
            expect(seen.created.every((folder) => !fs.existsSync(folder.path))).toBe(true);
            expect(result.stdout.toString()).toContain("removed 3 of 3 planned entries");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("round 32 dedicated review regressions", () => {
    test.each(["new", "noprefix", "colon", "ambiguous", "unicode", "old", "old-colon"])(
        "personal-data probe associates real filenames: %s",
        async (mode) => {
            const dir = fs.mkdtempSync(join(tmpdir(), "babysit-probe-paths-"));
            const repo = join(dir, "repo");
            fs.mkdirSync(repo);
            const markers = join(dir, "markers.txt"),
                config = join(dir, "gitconfig");
            fs.writeFileSync(markers, "fixture\tINVENTED_PRIVACY_NEEDLE\n");
            fs.writeFileSync(config, mode === "noprefix" ? "[diff]\n noprefix = true\n" : "");
            await env.testing.withOverrides(
                { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", PLACEHOLDER_MARKERS_FILE: markers },
                async () => {
                    const git = (args: string[], stdin?: string) => {
                        const p = Bun.spawnSync(["git", ...args], {
                            cwd: repo,
                            env: env.getProcessEnv(),
                            stdout: "pipe",
                            stderr: "pipe",
                            ...(stdin !== undefined ? { stdin: Buffer.from(stdin) } : {}),
                        });
                        expect(p.exitCode, p.stderr.toString()).toBe(0);
                        return p.stdout.toString().trim();
                    };
                    git(["init", "-q"]);
                    const file = ["colon", "ambiguous", "old-colon"].includes(mode)
                        ? "fixture:1:secret.txt"
                        : mode === "unicode"
                          ? "café.txt"
                          : "fixture.txt";
                    fs.writeFileSync(join(repo, file), "ordinary\nINVENTED_PRIVACY_NEEDLE\n");
                    git(["add", "--", file]);
                    const from = mode.startsWith("old")
                        ? git(["write-tree"])
                        : git(["hash-object", "-w", "-t", "tree", "--stdin"], "");
                    if (mode.startsWith("old")) {
                        fs.appendFileSync(join(repo, file), "new ordinary line\n");
                    }
                    if (mode === "ambiguous") {
                        fs.writeFileSync(join(repo, "fixture"), "ordinary\n");
                    }
                    git(["add", "--all"]);
                    const to = git(["write-tree"]);
                    expect(probeAddedLines({ wt: repo, from, to })).toBe(mode.startsWith("old"));
                }
            );
            fs.rmSync(dir, { recursive: true, force: true });
        }
    );

    test.each(["free", "lock", "external", "acquired-late"])(
        "Swift queue deadline fences %s before spawning",
        async (mode) => {
            const dir = fs.mkdtempSync(join(tmpdir(), "babysit-slot-queue-"));
            const preload = join(dir, "preload.ts");
            fs.writeFileSync(
                preload,
                "import {mock} from 'bun:test';const start=Date.now();mock.module(" +
                    SafeJSON.stringify(join(import.meta.dir, "../../../../src/utils/process/processes.ts")) +
                    ",()=>({listProcesses:()=> " +
                    String(mode === "external") +
                    " && Date.now()-start<400 ? [{name:'swift-test'}] : []}));" +
                    (mode === "acquired-late"
                        ? "const fs=await import('node:fs');const original={...fs};Date.now=()=>1000;mock.module('node:fs',()=>({...original,openSync:(...args)=>{const fd=original.openSync(...args);Date.now=()=>2000;return fd;}}));"
                        : "")
            );
            let release = mode === "lock" ? trySwiftSlot(join(dir, "genesis-swift-slot.lock")) : null;
            const timer = setTimeout(() => {
                release?.();
                release = null;
            }, 400);
            const started = Date.now();
            const child = Bun.spawn(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "swift-slot.ts"),
                    "--wait-minutes",
                    mode === "free" ? "1" : "0.0025",
                    "--",
                    process.execPath,
                    "-e",
                    "console.log('CHILD_STARTED')",
                ],
                {
                    env: { ...env.getProcessEnv(), TMPDIR: dir },
                    stdout: "pipe",
                    stderr: "pipe",
                    timeout: 1500,
                }
            );
            try {
                const code = await child.exited;
                const out = await new Response(child.stdout).text();
                expect(code).toBe(mode === "free" ? 0 : 124);
                expect(out.includes("CHILD_STARTED")).toBe(mode === "free");
                expect(Date.now() - started).toBeLessThan(1000);
            } finally {
                clearTimeout(timer);
                release?.();
                if (child.exitCode === null) {
                    child.kill("SIGKILL");
                }
                await child.exited;
            }
            const next = trySwiftSlot(join(dir, "genesis-swift-slot.lock"));
            expect(next).not.toBeNull();
            next?.();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    );
});

describe("round 32 policy and landing routing", () => {
    test("late security and dedicated reviews are always fixed, with one shared policy", async () => {
        const { roundPolicy, shouldFixFinding } = await import("./policy");
        const late = roundPolicy({ round: 32, changedFiles: 63 });
        expect(shouldFixFinding(late, "Low", true)).toBe(true);
        expect(shouldFixFinding(late, "High")).toBe(true);
        expect(shouldFixFinding(late, "Medium")).toBe(false);
        expect(shouldFixFinding(roundPolicy({ round: 32, changedFiles: 120, dedicatedReview: true }), "Low")).toBe(
            true
        );
        expect(roundPolicy({ round: 3, changedFiles: 100 }).fixAll).toBe(false);
        expect(roundPolicy({ round: 3, changedFiles: 101 }).fixAll).toBe(true);
        for (const template of ["brief-self-fetch.md", "brief-template.md"]) {
            const text = fs.readFileSync(join(import.meta.dir, "../references", template), "utf8");
            expect(text).toContain("{{ROUND_POLICY}}");
            expect(text).not.toContain("never defer");
        }
        const skill = fs.readFileSync(join(import.meta.dir, "../SKILL.md"), "utf8");
        expect(skill).not.toContain("the reviewer bot reviewed\nthe CURRENT head");
        expect(skill).toContain("Merge without waiting for eve");
        expect(skill).toContain("Judge against the same derived round policy");
    });

    test("integration posts deferred items only in the no-resolve batch", () => {
        const dir = fs.mkdtempSync(join(tmpdir(), "babysit-deferred-post-"));
        fs.writeFileSync(
            join(dir, "run.json"),
            SafeJSON.stringify({ repo: "fixture/repo", main: dir, post: true, reviewLoopScripts: join(dir, "scripts") })
        );
        fs.writeFileSync(
            join(dir, "replies.json"),
            SafeJSON.stringify({
                pr: 1,
                round: 32,
                model: "fixture",
                intro: "fixture",
                items: [
                    {
                        ref: "t1",
                        threadId: "fixed-thread",
                        reviewer: "eve-bot-lovinka",
                        verdict: "fixed",
                        reply: "fixed",
                    },
                    {
                        ref: "t2",
                        threadId: "open-thread",
                        reviewer: "coderabbitai",
                        verdict: "belongs-elsewhere",
                        deferred: true,
                        reply: "valid Medium, deferred under policy; stays OPEN",
                    },
                ],
            })
        );
        const preload = join(dir, "preload.ts"),
            evidence = join(dir, "batches.json");
        fs.writeFileSync(
            preload,
            [
                "import * as fs from 'node:fs';const batches=[];process.on('exit',()=>fs.writeFileSync(" +
                    SafeJSON.stringify(evidence) +
                    ",JSON.stringify(batches)));const ok=(out='')=>({exitCode:0,stdout:Buffer.from(out),stderr:Buffer.alloc(0)});",
                "Bun.spawnSync=(args)=>{if(args[0]==='git'){if(args.includes('push'))throw new Error('no pushes');return ok(args.includes('rev-parse')?'fixture-head':'');}if(args[0]==='gh'){if(args.includes('graphql'))throw new Error('unexpected direct mutation');return ok(JSON.stringify({headRefName:'fixture',baseRefName:'main'}));}if(args[1]?.endsWith('round-summary.ts')){fs.writeFileSync(args[args.indexOf('--out')+1],'summary');return ok();}if(args[1]?.endsWith('post-replies.ts')){const data=JSON.parse(fs.readFileSync(args[3],'utf8'));batches.push({args,ids:data.items.map(i=>i.threadId)});return ok();}throw new Error('unexpected command');};",
            ].join("\n")
        );
        const p = Bun.spawnSync(
            [
                process.execPath,
                "--preload",
                preload,
                join(import.meta.dir, "integrate.ts"),
                "--run",
                dir,
                "--wt",
                dir,
                "--pr",
                "1",
                "--round",
                "32",
                "--replies",
                join(dir, "replies.json"),
            ],
            { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
        );
        expect(p.exitCode, p.stderr.toString()).toBe(0);
        const batches = SafeJSON.parse(fs.readFileSync(evidence, "utf8"), { strict: true }) as Array<{
            args: string[];
            ids: string[];
        }>;
        expect(batches).toHaveLength(2);
        expect(batches.find((batch) => batch.ids.includes("open-thread"))?.args).toContain("--no-resolve");
        expect(batches.find((batch) => !batch.args.includes("--no-resolve"))?.ids).toEqual(["fixed-thread"]);
        expect(batches.find((batch) => batch.args.includes("--no-resolve"))?.ids).toEqual(["open-thread"]);
        const all = SafeJSON.parse(fs.readFileSync(join(dir, "vault/1-r32-replies.json"), "utf8"), { strict: true });
        expect(all.items).toHaveLength(2);
        expect(all.items.every((item: Record<string, unknown>) => !("deferred" in item))).toBe(true);
    });

    test.each(["prepare", "merge", "probe-blocks", "verify-fails"])(
        "other-repository landing uses run-card gates: %s",
        (mode) => {
            const dir = fs.mkdtempSync(join(tmpdir(), "babysit-other-land-"));
            const old = "a".repeat(40),
                head = mode === "prepare" ? old : "b".repeat(40);
            fs.writeFileSync(
                join(dir, "run.json"),
                SafeJSON.stringify({
                    repo: "fixture/other",
                    main: dir,
                    verify: [mode === "verify-fails" ? "exit 7" : "printf fixture-pass"],
                })
            );
            const preload = join(dir, "preload.ts"),
                evidence = join(dir, "evidence.json");
            fs.writeFileSync(
                preload,
                [
                    "import {mock} from 'bun:test';import * as fs from 'node:fs';import * as versions from " +
                        SafeJSON.stringify(join(import.meta.dir, "versions.ts")) +
                        ";const original={...versions};const calls=[],probes=[],merges=[];process.on('exit',()=>fs.writeFileSync(" +
                        SafeJSON.stringify(evidence) +
                        ",JSON.stringify({calls,probes,merges})));",
                    "mock.module(" +
                        SafeJSON.stringify(join(import.meta.dir, "versions.ts")) +
                        ",()=>({...original,ensureConfigHooks:()=> 'fixture hooks'}));",
                    "mock.module(" +
                        SafeJSON.stringify(join(import.meta.dir, "probe.ts")) +
                        ",()=>({probeAddedLines:input=>{probes.push(input);return " +
                        String(mode !== "probe-blocks") +
                        ";}}));",
                    "mock.module(" +
                        SafeJSON.stringify(join(import.meta.dir, "../../../../src/utils/cli/index.ts")) +
                        ",()=>({execTool:async(args)=>{merges.push(args);return {success:true,stdout:'sha: '+ 'b'.repeat(40),stderr:'',exitCode:0};}}));",
                    "const spawn=Bun.spawnSync,ok=(out='')=>({exitCode:0,stdout:Buffer.from(out),stderr:Buffer.alloc(0)});Bun.spawnSync=(args,opts)=>{calls.push(args);if(args[0]==='/bin/sh')return spawn(args,opts);if(args[0]==='gh')return ok(args.includes('headRefOid')?" +
                        SafeJSON.stringify(head) +
                        ":JSON.stringify({headRefName:'fixture',baseRefName:'main',state:'OPEN'}));if(args[0]==='git'){if(args.includes('rev-parse'))return ok(args.at(-1)==='origin/fixture'?" +
                        SafeJSON.stringify(old) +
                        ":" +
                        SafeJSON.stringify(head) +
                        ");return ok();}throw new Error('GenesisTools-only gate reached: '+args.join(' '));};",
                ].join("\n")
            );
            const p = Bun.spawnSync(
                [
                    process.execPath,
                    "--preload",
                    preload,
                    join(import.meta.dir, "land.ts"),
                    "--run",
                    dir,
                    "--wt",
                    dir,
                    "--pr",
                    "1",
                    ...(mode === "prepare" ? [] : ["--merge"]),
                ],
                { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv(), timeout: 5000 }
            );
            expect(p.exitCode, p.stderr.toString()).toBe(["probe-blocks", "verify-fails"].includes(mode) ? 1 : 0);
            const seen = SafeJSON.parse(fs.readFileSync(evidence, "utf8"), { strict: true }) as {
                calls: string[][];
                probes: Array<{ wt: string; from: string; to: string }>;
                merges: string[][];
            };
            expect(
                seen.calls.some(
                    (args) =>
                        args.includes("scripts/git/check-commits.ts") ||
                        args.includes("scripts/ci/placeholder-check.sh")
                )
            ).toBe(false);
            expect(seen.calls.some((args) => args[0] === "/bin/sh")).toBe(true);
            expect(seen.probes).toEqual(
                ["prepare", "verify-fails"].includes(mode) ? [] : [{ wt: dir, from: old, to: head }]
            );
            const pushes = seen.calls.filter((args) => args.includes("push"));
            expect(pushes).toHaveLength(mode === "merge" ? 1 : 0);
            if (mode === "merge") {
                expect(pushes[0]).toContain("--force-with-lease=refs/heads/fixture:" + old);
                expect(pushes[0]).toContain(head + ":refs/heads/fixture");
                expect(seen.merges).toHaveLength(1);
            } else {
                expect(seen.merges).toEqual([]);
            }
        }
    );
});

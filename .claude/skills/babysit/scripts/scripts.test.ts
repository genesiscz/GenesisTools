import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { execTool } from "@genesiscz/utils/cli";
import { toolsEntrypoint } from "@genesiscz/utils/cli/tools";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    allowedCommand,
    chainSegments,
    decide,
    innerCommand,
    type RunEntry,
    readOnlyChain,
    watchApprovals,
} from "./approve-codex";
import { type ConflictPick, resolutionProblems, resolveConflictText } from "./conflicts";
import { threadRefs } from "./fetch-threads";
import { PRE_PUSH_GUARDS, postingExitCode } from "./integrate";
import { recordLandingPush } from "./land";
import { appendEvent, readEvents } from "./ledger";
import { continueVersionPick } from "./pick-unified";
import { summarize, testEvidence } from "./plant";
import { hitsInAddedLines, probeAddedLines } from "./probe";
import { reviewBrief } from "./review-brief";
import { loadRun, runPaths } from "./run";
import { trySwiftSlot } from "./swift-slot";
import { typecheckPackage } from "./swift-typecheck";
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

const entry: RunEntry = {
    name: "fixture",
    cwd: "/fixture",
    scope: ["src/a.ts", "src/with space.ts"],
    subject: "fix(tools): #1 followup - subject",
    verify: ["bunx biome check src/a.ts"],
};

describe("read-only chains", () => {
    test("a chain of readers is approved without the lead", () => {
        for (const command of [
            "pwd; git status --short; git rev-parse --path-format=absolute --git-common-dir; wc -l CLAUDE.md",
            "git diff --stat origin/master...HEAD; rg --files .claude/rules",
            "rg --files Genesis -g CLAUDE.md | rg 'rules/'",
            "gh pr view 93 --json body --jq .body",
            "sed -n '40,80p' src/a.ts && git log --oneline -5",
            "cd sub && tools github review 93 --llm",
            "git diff --stat origin/master...HEAD; if test -f /x/AGENTS.md; then cat /x/AGENTS.md; fi",
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
        expect(PRE_PUSH_GUARDS).toEqual(fromHook);
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
    const cli = "/Users/x/.codex/plugins/cache/genesis-tools/genesis-tools/1.0.107/skills/fable-replace/scripts/cli.ts";
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
        ]) {
            expect({ command, ok: allowedCommand(entry, command) }).toEqual({ command, ok: false });
        }
    });
});

describe("reviewer reads", () => {
    test("the scratch folder by its absolute path, and the ts readers", () => {
        expect(allowedCommand(entry, `mkdir -p ${entry.cwd}/.claude/work/babysit`)).toBe(true);
        expect(allowedCommand(entry, "mkdir -p /tmp/elsewhere")).toBe(false);
        expect(readOnlyChain(entry, "./tools ts skeleton src/a.ts --top-level")).toBe(true);
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
        expect(source).toContain("toolsEntrypoint()");
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
            expect(text).toContain(postMerge ? "gh pr diff 498" : "git diff origin/master...HEAD");
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
        for (const out of [
            "error: No matching export",
            "0 pass\n0 fail\n[test] suite complete (exit 1)",
            failed.replace("[test] suite complete (exit 1)", ""),
            "1 fail\n[test] suite complete (exit 1)",
        ]) {
            expect(testEvidence({ code: 1, out }, true)).toBe(false);
        }
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
            fs.writeFileSync(join(pkg, target, "Fixture.swift"), "package func fixture() {}\n");
        }
        const original = Bun.spawnSync;
        const success = original([process.execPath, "-e", ""], { stdout: "pipe", stderr: "pipe", env: process.env });
        const commands: string[][] = [];
        const spawn = spyOn(Bun, "spawnSync").mockImplementation((command) => {
            const words = Array.from(command, String);
            if (words[0] === "xcrun" && words[1] === "swiftc") {
                commands.push(words);
                const good =
                    words.includes("-package-name") && words[words.indexOf("-package-name") + 1] === "fixture_kit";
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
            expect(commands.filter((words) => words.includes("-emit-module"))).toHaveLength(1);
            expect(commands.filter((words) => words.includes("-typecheck"))).toHaveLength(2);
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

import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { execTool } from "@genesiscz/utils/cli";
import { toolsEntrypoint } from "@genesiscz/utils/cli/tools";
import { SafeJSON } from "@genesiscz/utils/json";
import { allowedCommand, decide, type RunEntry, watchApprovals } from "./approve-codex";
import { type ConflictPick, resolutionProblems, resolveConflictText } from "./conflicts";
import { summarize } from "./plant";
import { hitsInAddedLines } from "./probe";
import { reviewBrief } from "./review-brief";
import { loadRun } from "./run";
import { conflictedFiles, higherVersionSide, prepGit, resolveVersionConflicts } from "./versions";
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
        write(file, manifest("1.0.80"));
        write("src/a.ts", "export const a = 1;\n");
        commit("base");
        git(["checkout", "-qb", "child"]);
        write(file, manifest("1.0.81"));
        commit("child bump");
        git(["checkout", "-q", "main"]);
        write(file, manifest("1.0.96"));
        commit("main bump");

        expect(git(["cherry-pick", "child"]).code).not.toBe(0);
        expect(resolveVersionConflicts(git, conflictedFiles(git))).toBe(true);
        expect(fs.readFileSync(join(dir, file), "utf8")).toContain('"1.0.96"');
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

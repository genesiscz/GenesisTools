import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { SHELL_RULES } from "@genesiscz/utils/shell/rules";
import { DEFAULT_HOOKS_CONFIG, lastConfigProblems, loadHooksConfig } from "./config";
import { recentBashCommands } from "./corpus";
import { type DetectFailure, expandRulePath, guardRules, loadCustomRules, loadRuleSet } from "./custom-rules";
import { evaluateCommand, evaluateGuard } from "./guard";
import { repoRoot } from "./install";
import { matchesGlob, resolveOutcome } from "./outcome";
import type { HookPayload } from "./payload";
import { checkRuleExamples, replayCorpus } from "./rules-check";
import { applyRuleSelection, applySetting, ruleEnabled, setRuleSelection } from "./set-config";
import { BUILT_IN_RULES } from "./tool-rules";

describe("resolveOutcome", () => {
    const longCommand = Array.from({ length: 35 }, (_, index) => `echo line ${index}`).join("\n");

    it("downgrades a long misread block to a warn", () => {
        const result = resolveOutcome({
            ruleId: "exit-code-after-pipeline",
            ruleSeverity: "block",
            kind: "misread",
            harness: "claude",
            model: "claude-opus-5",
            command: longCommand,
            config: DEFAULT_HOOKS_CONFIG.guard,
        });

        expect(result.outcome).toBe("warn");
        expect(result.trace.at(-1)?.[0]).toBe("long misread downgrade");
    });

    it("never downgrades a destructive rule, however long the command", () => {
        const result = resolveOutcome({
            ruleId: "git-checkout-overwrites-file",
            ruleSeverity: "block",
            kind: "destructive",
            harness: "claude",
            model: "claude-opus-5",
            command: longCommand,
            config: DEFAULT_HOOKS_CONFIG.guard,
        });

        expect(result.outcome).toBe("block");
    });

    it("lets a harness override win over the rule default", () => {
        const result = resolveOutcome({
            ruleId: "zsh-glob-qualifier",
            ruleSeverity: "block",
            kind: "misread",
            harness: "codex",
            model: "gpt-5",
            command: "ls *(N)",
            config: DEFAULT_HOOKS_CONFIG.guard,
        });

        expect(result.outcome).toBe("allow");
    });

    it("matches a model glob", () => {
        expect(matchesGlob("claude-opus-5", "claude-*")).toBe(true);
        expect(matchesGlob("gpt-5", "claude-*")).toBe(false);
    });
});

describe("evaluateGuard", () => {
    function payload(overrides: Partial<HookPayload> = {}): HookPayload {
        return {
            event: "PreToolUse",
            tool: "Bash",
            cwd: "/repo",
            command: "git status --porcelain",
            model: "claude-opus-5",
            harness: "claude",
            nativeDiffFiles: [],
            raw: {},
            ...overrides,
        };
    }

    it("blocks a destructive command and explains why", () => {
        const verdict = evaluateGuard(payload({ command: "git checkout -- src/app.ts" }), DEFAULT_HOOKS_CONFIG);

        expect(verdict?.outcome).toBe("block");
        expect(verdict?.message).toContain("git-checkout-overwrites-file");
        expect(verdict?.message.startsWith("Blocked:")).toBe(true);
    });

    it("hands the payload's cwd to the rules, so a rule that reads the project sees the right folder", () => {
        const root = mkdtempSync(join(tmpdir(), "guard-cwd-"));

        try {
            const app = join(root, "app");
            mkdirSync(app);
            writeFileSync(
                join(app, "Package.swift"),
                'let package = Package(name: "App", dependencies: [.package(path: "../kit")])\n'
            );

            const inPackage = evaluateGuard(payload({ command: "swift test", cwd: app }), DEFAULT_HOOKS_CONFIG);

            expect(inPackage?.outcome).toBe("block");
            expect(inPackage?.message).toContain("swiftpm-stale-plan");
            expect(evaluateGuard(payload({ command: "swift test", cwd: root }), DEFAULT_HOOKS_CONFIG)).toBeNull();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("passes a clean command", () => {
        expect(evaluateGuard(payload(), DEFAULT_HOOKS_CONFIG)).toBeNull();
    });

    it("says nothing for a tool that is not a shell", () => {
        expect(evaluateGuard(payload({ tool: "Edit", command: "git checkout -- x" }), DEFAULT_HOOKS_CONFIG)).toBeNull();
    });

    it("accepts the shell tool under codex and grok, not just Bash", () => {
        expect(
            evaluateGuard(payload({ tool: "shell", command: "git checkout -- x" }), DEFAULT_HOOKS_CONFIG)
        ).not.toBeNull();
        expect(
            evaluateGuard(payload({ tool: "run_terminal_command", command: "git checkout -- x" }), DEFAULT_HOOKS_CONFIG)
        ).not.toBeNull();
    });

    it("ignores an event that is not PreToolUse", () => {
        expect(
            evaluateGuard(payload({ event: "PostToolUse", command: "git checkout -- x" }), DEFAULT_HOOKS_CONFIG)
        ).toBeNull();
    });

    it("demotes a misread block on a long command and says so in the heading", () => {
        const long = `${Array.from({ length: 34 }, (_, index) => `echo line ${index}`).join("\n")}\ntsgo | tail -5; echo $?`;
        const verdict = evaluateGuard(payload({ command: long }), DEFAULT_HOOKS_CONFIG);

        expect(verdict?.outcome).toBe("warn");
        expect(verdict?.demoted).toContain("exit-code-after-pipeline");
        expect(verdict?.message).toContain("It was NOT blocked only because it is 35 lines long");
    });

    it("never demotes a destructive rule on a long command", () => {
        const long = `${Array.from({ length: 34 }, (_, index) => `echo line ${index}`).join("\n")}\ngit checkout -- x`;
        const verdict = evaluateGuard(payload({ command: long }), DEFAULT_HOOKS_CONFIG);

        expect(verdict?.outcome).toBe("block");
        expect(verdict?.demoted).toEqual([]);
    });

    it("goes quiet on a context rule once the session cap is reached", () => {
        const command = "ls x 2>/dev/null | head -3";
        const first = evaluateCommand(command, DEFAULT_HOOKS_CONFIG, { contextCounts: {} });
        const capped = evaluateCommand(command, DEFAULT_HOOKS_CONFIG, {
            contextCounts: { "stderr-discarded-then-read": 3 },
        });

        expect(first.outcome).toBe("context");
        expect(first.shownContextRules).toContain("stderr-discarded-then-read");
        expect(capped.outcome).toBe("allow");
        expect(capped.message).toBe("");
    });

    it("lets a harness override silence the zsh glob rule for codex", () => {
        expect(evaluateGuard(payload({ command: "ls *(N)", harness: "codex" }), DEFAULT_HOOKS_CONFIG)).toBeNull();
        expect(evaluateGuard(payload({ command: "ls *(N)", harness: "claude" }), DEFAULT_HOOKS_CONFIG)?.outcome).toBe(
            "block"
        );
    });
});

/** A self-contained rule module: fixtures live under /tmp, where `@genesiscz/utils` does not resolve. */
function ruleModule(rules: string): string {
    return `export const rules = [${rules}];\n`;
}

function fixtureRule(id: string, needle: string, extra = ""): string {
    return `{ id: "${id}", kind: "destructive", severity: "block", title: "fixture rule ${id}", why: "fixture", wrong: "${needle} now", right: "echo fine", detect(scan) { const at = scan.command.indexOf("${needle}"); return at === -1 ? null : { matched: "${needle}", index: at }; }${extra} }`;
}

function rulesDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "gt-custom-rules-"));

    for (const [name, body] of Object.entries(files)) {
        writeFileSync(join(dir, name), body);
    }

    return dir;
}

function withCustomRules(paths: string[]): typeof DEFAULT_HOOKS_CONFIG {
    return { ...DEFAULT_HOOKS_CONFIG, guard: { ...DEFAULT_HOOKS_CONFIG.guard, customRules: paths } };
}

describe("guard.customRules in the config", () => {
    const stored = (value: unknown): string => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-cfg-custom-")), "hooks.json");

        writeFileSync(path, SafeJSON.stringify(value));
        return path;
    };

    it("ships empty, so nothing is imported until a path is configured", () => {
        expect(DEFAULT_HOOKS_CONFIG.guard.customRules).toEqual([]);
    });

    it("keeps a list of paths and drops blank entries", () => {
        expect(loadHooksConfig(stored({ guard: { customRules: ["~/rules", " "] } })).guard.customRules).toEqual([
            "~/rules",
        ]);
    });

    it("a value that is not a list of strings falls back and is reported", () => {
        const config = loadHooksConfig(stored({ guard: { customRules: "~/rules" } }));

        expect(config.guard.customRules).toEqual([]);
        expect(lastConfigProblems().some((problem) => problem.startsWith("guard.customRules"))).toBe(true);
    });

    it("config set guard.customRules takes a comma list, and an empty value clears it", () => {
        const set = applySetting(DEFAULT_HOOKS_CONFIG, "guard.customRules", "~/a, /b/rules.ts");

        expect(set.guard.customRules).toEqual(["~/a", "/b/rules.ts"]);
        expect(applySetting(set, "guard.customRules", "").guard.customRules).toEqual([]);
    });

    it("expands ~ and resolves a relative path against the home folder", () => {
        expect(expandRulePath("~/rules")).toBe(join(homedirOf(), "rules"));
        expect(expandRulePath("rules")).toBe(join(homedirOf(), "rules"));
        expect(expandRulePath("/abs/rules")).toBe("/abs/rules");
    });
});

function homedirOf(): string {
    return expandRulePath("~");
}

describe("loadCustomRules", () => {
    it("loads every module of a folder in name order and skips tests, _drafts and dotfiles", async () => {
        const dir = rulesDir({
            "b.ts": ruleModule(fixtureRule("fixture-b", "zzb")),
            "a.ts": `export default [${fixtureRule("fixture-a", "zza")}];\n`,
            "a.test.ts": "throw new Error('a test file must never be imported');\n",
            "_draft.ts": "throw new Error('a draft must never be imported');\n",
            ".hidden.ts": "throw new Error('a dotfile must never be imported');\n",
            "notes.md": "# not a module\n",
        });
        const custom = await loadCustomRules([dir]);

        expect(custom.rules.map((rule) => rule.id)).toEqual(["fixture-a", "fixture-b"]);
        expect(custom.modules.map((module) => [module.status, module.ruleIds])).toEqual([
            ["loaded", ["fixture-a"]],
            ["loaded", ["fixture-b"]],
        ]);
        expect(custom.missing).toEqual([]);
    });

    it("a module that throws, exports no array or never finishes is failed with the reason, and the rest still load", async () => {
        const dir = rulesDir({
            "good.ts": ruleModule(fixtureRule("fixture-good", "zzg")),
            "throws.ts": "throw new Error('boom at import');\n",
            "shape.ts": "export const rules = { not: 'an array' };\n",
            "hangs.ts": "await new Promise(() => {});\nexport const rules = [];\n",
        });
        const custom = await loadCustomRules([dir], { timeoutMs: 300 });
        const byName = Object.fromEntries(custom.modules.map((module) => [module.file.split("/").pop(), module]));

        expect(custom.rules.map((rule) => rule.id)).toEqual(["fixture-good"]);
        expect(byName["throws.ts"]).toMatchObject({ status: "failed", reason: "boom at import" });
        expect(byName["shape.ts"]?.reason).toContain("no `rules` array");
        expect(byName["hangs.ts"]?.reason).toContain("did not finish within 300 ms");
    });

    it("refuses an invalid rule and an id that is already taken, and names why", async () => {
        const dir = rulesDir({
            "a.ts": ruleModule(
                [
                    fixtureRule("Bad_Id", "zz1"),
                    `{ id: "no-detect", kind: "misread", severity: "block", title: "t", why: "w", wrong: "x", right: "y" }`,
                    `{ id: "bad-severity", kind: "misread", severity: "deny", title: "t", why: "w", wrong: "x", right: "y", detect() { return null; } }`,
                    fixtureRule("find-from-root", "zz2"),
                    fixtureRule("fixture-dup", "zz3"),
                ].join(", ")
            ),
            "b.ts": ruleModule(fixtureRule("fixture-dup", "zz4")),
        });
        const custom = await loadCustomRules([dir]);
        const refused = custom.modules.flatMap((module) => module.refused);

        expect(custom.rules.map((rule) => rule.id)).toEqual(["fixture-dup"]);
        expect(refused).toEqual([
            { id: "Bad_Id", reason: "id must be a kebab-case string" },
            { id: "no-detect", reason: "detect must be a function" },
            { id: "bad-severity", reason: "severity must be one of block, context, warn" },
            { id: "find-from-root", reason: "the id is already used by a built-in rule" },
            { id: "fixture-dup", reason: `the id is already used by ${join(dir, "a.ts")}` },
        ]);
    });

    it("names a configured path that holds nothing loadable", async () => {
        const dir = rulesDir({ "notes.md": "x" });
        const custom = await loadCustomRules([join(dir, "missing"), join(dir, "notes.md")]);

        expect(custom.missing.map((entry) => entry.reason)).toEqual([
            expect.stringContaining("cannot read it"),
            "not a .ts, .mts, .js or .mjs file",
        ]);
    });

    it("a rule whose detect throws or returns garbage is skipped for that command and reported", async () => {
        const dir = rulesDir({
            "a.ts": ruleModule(
                [
                    `{ id: "fixture-throws", kind: "misread", severity: "block", title: "t", why: "w", wrong: "x", right: "y", detect() { throw new Error("detect boom"); } }`,
                    `{ id: "fixture-garbage", kind: "misread", severity: "block", title: "t", why: "w", wrong: "x", right: "y", detect() { return "yes"; } }`,
                ].join(", ")
            ),
        });
        const failures: DetectFailure[] = [];
        const { rules } = await guardRules(withCustomRules([dir]), {
            onDetectError: (failure) => failures.push(failure),
        });
        const verdict = evaluateCommand("git checkout -- a.ts", DEFAULT_HOOKS_CONFIG, { rules });

        expect(verdict.tags).toEqual(["git-checkout-overwrites-file"]);
        expect(failures.map((failure) => [failure.ruleId, (failure.err as Error).message])).toEqual([
            ["fixture-throws", "detect boom"],
            ["fixture-garbage", "detect returned a value that is not a ShellMatch"],
        ]);
    });
});

describe("the guard runs custom rules beside the built-in ones", () => {
    function payload(command: string): HookPayload {
        return {
            event: "PreToolUse",
            tool: "Bash",
            cwd: "/repo",
            command,
            model: "",
            harness: "claude",
            nativeDiffFiles: [],
            raw: {},
        };
    }

    it("imports nothing and returns the built-in registry while no custom rule is configured", async () => {
        const { rules, custom } = await guardRules(DEFAULT_HOOKS_CONFIG);

        expect(rules).toBe(BUILT_IN_RULES);
        expect(custom).toBeNull();
    });

    it("the rule set the hooks pass runs the GenesisTools rm rules, which the shared default lacks", async () => {
        const { rules } = await guardRules(DEFAULT_HOOKS_CONFIG);

        expect(evaluateGuard(payload("rm -rf build"), DEFAULT_HOOKS_CONFIG, rules)?.message).toContain(
            "rule rm-use-tools-rm"
        );
        expect(evaluateGuard(payload("tools rm approve k7m2qd"), DEFAULT_HOOKS_CONFIG, rules)?.message).toContain(
            "rule rm-user-verbs"
        );
        expect(evaluateGuard(payload("rm -rf build"), DEFAULT_HOOKS_CONFIG)).toBeNull();
    });

    it("a custom rule blocks, and `guard.default` switches it off like a built-in one", async () => {
        const dir = rulesDir({ "a.ts": ruleModule(fixtureRule("fixture-stop", "zzstop")) });
        const config = withCustomRules([dir]);
        const { rules } = await guardRules(config);

        expect(evaluateGuard(payload("echo zzstop"), config, rules)?.outcome).toBe("block");
        expect(evaluateGuard(payload("echo zzstop"), config, rules)?.message).toContain("rule fixture-stop");

        const off = { ...config, guard: { ...config.guard, default: { "fixture-stop": "allow" as const } } };

        expect(evaluateGuard(payload("echo zzstop"), off, rules)).toBeNull();
        // The negative control: without the custom rules the same command passes.
        expect(evaluateGuard(payload("echo zzstop"), config)).toBeNull();
    });

    it("loadRuleSet names each rule's source, and loads custom rules even while the guard is off", async () => {
        const dir = rulesDir({ "a.ts": ruleModule(fixtureRule("fixture-src", "zzsrc")) });
        const config = withCustomRules([dir]);
        const set = await loadRuleSet({ ...config, guard: { ...config.guard, enabled: false } });

        expect(set.sources.get("fixture-src")).toBe(join(dir, "a.ts"));
        expect(set.sources.get("find-from-root")).toBe("built-in");
        expect((await guardRules({ ...config, guard: { ...config.guard, enabled: false } })).custom).toBeNull();
    });

    it("config set rules.<id> accepts a custom id only when the caller passes the loaded ids", () => {
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "rules.fixture-x", "warn")).toThrow("no such rule");

        const next = applySetting(DEFAULT_HOOKS_CONFIG, "rules.fixture-x", "warn", {
            ruleIds: new Set(["fixture-x"]),
        });

        expect(next.guard.default["fixture-x"]).toBe("warn");
    });
});

describe("the rule picker's selection", () => {
    const ids = { ruleIds: new Set(["rule-a", "rule-b", "rule-c"]) };

    it("off is allow; on removes the allow and keeps any other outcome", () => {
        const config = {
            ...DEFAULT_HOOKS_CONFIG,
            guard: {
                ...DEFAULT_HOOKS_CONFIG.guard,
                default: { "rule-a": "allow" as const, "rule-b": "warn" as const },
            },
        };
        const result = applyRuleSelection(config, { enable: ["rule-a", "rule-b"], disable: ["rule-c"] }, ids);

        expect(result.config.guard.default).toEqual({ "rule-b": "warn", "rule-c": "allow" });
        expect(result.enabled).toEqual(["rule-a"]);
        expect(result.disabled).toEqual(["rule-c"]);
        expect(ruleEnabled(result.config, "rule-c")).toBe(false);
        expect(ruleEnabled(result.config, "rule-b")).toBe(true);
        // Pure: the input is untouched.
        expect(config.guard.default).toEqual({ "rule-a": "allow", "rule-b": "warn" });
    });

    it("refuses an unknown id and an id in both lists", () => {
        expect(() => applyRuleSelection(DEFAULT_HOOKS_CONFIG, { enable: ["nope"], disable: [] }, ids)).toThrow(
            "no such rule: nope"
        );
        expect(() =>
            applyRuleSelection(DEFAULT_HOOKS_CONFIG, { enable: ["rule-a"], disable: ["rule-a"] }, ids)
        ).toThrow("enabled and disabled at once");
    });

    it("writes the hooks file only with write, and only when something changed", () => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-picker-")), "hooks.json");

        writeFileSync(path, SafeJSON.stringify({ shadow: false }));

        expect(setRuleSelection({ enable: [], disable: ["rule-a"] }, { write: false, path, ...ids }).written).toBe(
            false
        );
        expect(loadHooksConfig(path).guard.default).toEqual({});
        expect(setRuleSelection({ enable: [], disable: ["rule-a"] }, { write: true, path, ...ids }).written).toBe(true);
        expect(loadHooksConfig(path).guard.default).toEqual({ "rule-a": "allow" });
        expect(loadHooksConfig(path).shadow).toBe(false);
        expect(setRuleSelection({ enable: [], disable: ["rule-a"] }, { write: true, path, ...ids }).written).toBe(
            false
        );
    });
});

describe("rules check", () => {
    it("every built-in rule passes its own examples", () => {
        const failed = checkRuleExamples(BUILT_IN_RULES, { cwd: repoRoot() }).filter((check) => !check.ok);

        expect(failed).toEqual([]);
    });

    it("a rule whose wrong example does not fire, or whose right one does, fails", async () => {
        const dir = rulesDir({
            "a.ts": ruleModule(
                [
                    fixtureRule("fixture-ok", "zzok"),
                    `{ id: "fixture-silent", kind: "misread", severity: "block", title: "t", why: "w", wrong: "echo nothing", right: "echo zzsilent", detect(scan) { const at = scan.command.indexOf("zzsilent"); return at === -1 ? null : { matched: "zzsilent", index: at }; } }`,
                ].join(", ")
            ),
        });
        const custom = await loadCustomRules([dir]);
        const checks = checkRuleExamples(custom.rules);

        expect(checks.map((check) => [check.ruleId, check.ok])).toEqual([
            ["fixture-ok", true],
            ["fixture-silent", false],
        ]);
    });

    it("replays a corpus: counts per rule and a few first-line samples", () => {
        const report = replayCorpus(
            ["git checkout -- a.ts", "ls", "git checkout -- b.ts\necho second line"],
            SHELL_RULES,
            {
                samples: 1,
            }
        );
        const row = report.rows.find((candidate) => candidate.ruleId === "git-checkout-overwrites-file");

        expect(report.commands).toBe(3);
        expect(row).toEqual({ ruleId: "git-checkout-overwrites-file", fired: 2, samples: ["git checkout -- a.ts"] });
        expect(report.rows.find((candidate) => candidate.ruleId === "find-from-root")?.fired).toBe(0);
    });

    it("reads the newest unique Bash commands from transcripts, newest first", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-corpus-"));
        const line = (command: string): string =>
            SafeJSON.stringify({
                message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
            });

        mkdirSync(join(root, "project"));
        writeFileSync(join(root, "project", "old.jsonl"), [line("echo old-1"), line("echo old-2")].join("\n"));
        writeFileSync(
            join(root, "project", "new.jsonl"),
            [line("echo new-1"), line("echo new-2"), line("echo new-1")].join("\n")
        );
        utimesSync(join(root, "project", "old.jsonl"), new Date(1_000_000), new Date(1_000_000));

        expect(recentBashCommands(3, root)).toEqual(["echo new-1", "echo new-2", "echo old-2"]);
    });
});

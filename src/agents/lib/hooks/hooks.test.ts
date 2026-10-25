import { describe, expect, it } from "bun:test";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSpawnCounter } from "@app/benchmark/lib";
import { postDecisions, readDecisions, updateDecision } from "@app/question/lib/decisions/store";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { SHELL_RULES } from "@genesiscz/utils/shell/rules";
import { codexEntriesFor, codexWiring, installCodexHooks, uninstallCodexHooks } from "./codex";
import {
    changedOnly,
    DEFAULT_HOOKS_CONFIG,
    type DecisionsHookConfig,
    decisionHooksWanted,
    defaultLogPath,
    diffFor,
    keepsCommand,
    lastConfigLoadError,
    lastConfigProblems,
    loadHooksConfig,
    SHIPPED_DEFAULTS_KEY,
    storedOverrides,
} from "./config";
import { recentBashCommands } from "./corpus";
import { type DetectFailure, expandRulePath, guardRules, loadCustomRules, loadRuleSet } from "./custom-rules";
import { finalReply, type PromptHookOutput, runDecisionInject, runDecisionStop } from "./decisions";
import { collectStaleCaptures, parseHorizon } from "./gc";
import { evaluateCommand, evaluateGuard } from "./guard";
import { lastSeenPerHarness } from "./harnesses";
import {
    entriesFor,
    hooksDistPath,
    installAndPoint,
    installHooks,
    pointDist,
    readSettings,
    repoRoot,
    subagentLineFor,
    uninstallHooks,
    wireSubagentLine,
    wiringStatus,
} from "./install";
import { logDecision, releaseRotationLock, setDiagLogPath, setMaxLogBytes, takeRotationLock } from "./log";
import {
    MODS_PLUGIN,
    modsPluginDisabled,
    modsPluginState,
    modsWatched,
    modsWatchState,
    pluginDirsOf,
    withModsWatch,
} from "./mods";
import { nativeDiffState } from "./native-diff";
import { matchesGlob, resolveOutcome } from "./outcome";
import { callDir, hookDataRoot, safeSegment, sessionDir } from "./paths";
import type { HookPayload } from "./payload";
import { parseHookPayload } from "./payload";
import { checkRuleExamples, replayCorpus } from "./rules-check";
import { applyRuleSelection, applySetting, ruleEnabled, setHooksConfig, setRuleSelection } from "./set-config";
import { unpushedReminders, unpushedState } from "./unpushed";
import { writeJsonFile } from "./write-json";

describe("DEFAULT_HOOKS_CONFIG", () => {
    it("ships the measured long-command thresholds", () => {
        expect(DEFAULT_HOOKS_CONFIG.guard.longCommand).toEqual({ lines: 30, chars: 2500 });
    });

    it("keeps the zsh glob rule off for codex and grok, which honour it", () => {
        expect(DEFAULT_HOOKS_CONFIG.guard.harnesses.codex?.["zsh-glob-qualifier"]).toBe("allow");
        expect(DEFAULT_HOOKS_CONFIG.guard.harnesses.grok?.["zsh-glob-qualifier"]).toBe("allow");
    });

    it("caps the diff so one command cannot flood the transcript", () => {
        expect(DEFAULT_HOOKS_CONFIG.diff.maxFiles).toBe(15);
        expect(DEFAULT_HOOKS_CONFIG.diff.maxLinesPerFile).toBe(30);
        expect(DEFAULT_HOOKS_CONFIG.diff.maxRoots).toBe(4);
    });
});

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

describe("parseHookPayload", () => {
    it("reads the snake_case wire shape Claude sends", () => {
        const payload = parseHookPayload(
            SafeJSON.stringify({
                hook_event_name: "PostToolUse",
                tool_name: "Bash",
                cwd: "/repo",
                session_id: "s1",
                tool_use_id: "t1",
                tool_input: { command: "ls" },
                tool_response: { stdout: "" },
            })
        );

        expect(payload?.harness).toBe("claude");
        expect(payload?.event).toBe("PostToolUse");
        expect(payload?.toolUseId).toBe("t1");
        expect(payload?.command).toBe("ls");
    });

    it("reads Grok's camelCase shape and labels the harness", () => {
        const payload = parseHookPayload(
            SafeJSON.stringify({
                hookEventName: "PreToolUse",
                toolName: "Bash",
                cwd: "/repo",
                toolInput: { command: "ls" },
            })
        );

        expect(payload?.harness).toBe("grok");
        expect(payload?.event).toBe("PreToolUse");
    });

    it("collects the native diff file list when the harness rendered one", () => {
        const payload = parseHookPayload(
            SafeJSON.stringify({
                hook_event_name: "PostToolUse",
                tool_name: "Bash",
                cwd: "/repo",
                tool_response: { bashEditDiff: { files: [{ filePath: "/repo/a.ts" }] } },
            })
        );

        expect(payload?.nativeDiffFiles).toEqual(["/repo/a.ts"]);
    });

    it("returns null for input that is not JSON", () => {
        expect(parseHookPayload("not json")).toBeNull();
    });
});

describe("hook data paths", () => {
    it("nests a call under its harness and session", () => {
        expect(callDir("claude", "sess", "call")).toBe(`${hookDataRoot()}/claude/sess/diff/call`);
    });

    it("exposes the session directory so cleanup is one delete", () => {
        expect(sessionDir("grok", "sess")).toBe(`${hookDataRoot()}/grok/sess`);
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

describe("installHooks", () => {
    function settingsFile(body: unknown): string {
        const path = join(mkdtempSync(join(tmpdir(), "gt-hooks-settings-")), "settings.json");

        writeFileSync(path, SafeJSON.stringify(body));

        return path;
    }

    it("adds one Bash entry per event and never touches the existing ones", () => {
        const path = settingsFile({
            hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "/existing.sh" }] }] },
            model: "keep-me",
        });

        installHooks({ dist: "/dist", settingsPath: path, write: true });

        const after = readSettings(path);

        expect(after.model).toBe("keep-me");
        expect(after.hooks?.PreToolUse?.[0]?.hooks[0]?.command).toBe("/existing.sh");
        expect(after.hooks?.PreToolUse?.[1]?.matcher).toBe("Bash");
        expect(after.hooks?.PreToolUse?.[1]?.hooks.map((hook) => hook.command)).toEqual([
            "bun '/dist/src/agents/bin/hook-pre.ts'",
        ]);
        expect(after.hooks?.PostToolUse?.[0]?.hooks[0]?.command).toBe("bun '/dist/src/agents/bin/hook-diff-post.ts'");
        // The file tools reach the post hook only for the session change log.
        expect(after.hooks?.PostToolUse?.[0]?.matcher).toBe("Bash|Edit|MultiEdit|Write");
    });

    it("wires subagentStatusLine while mods.agentRow is on, removes its own when off, and leaves another one", () => {
        const path = settingsFile({ hooks: {} });

        expect(installHooks({ dist: "/dist", settingsPath: path, write: true, agentRow: true }).added).toContain(
            "subagentStatusLine"
        );
        expect(readSettings(path).subagentStatusLine).toEqual({
            type: "command",
            command: "bun '/dist/src/agents/bin/hook-subagent-line.ts'",
        });

        expect(installHooks({ dist: "/dist", settingsPath: path, write: true, agentRow: false }).removed).toContain(
            "subagentStatusLine"
        );
        expect(readSettings(path).subagentStatusLine).toBeUndefined();

        const theirs = { type: "command", command: "/home/alice/rows.sh" };
        const other = settingsFile({ subagentStatusLine: theirs });

        expect(installHooks({ dist: "/dist", settingsPath: other, write: true, agentRow: true }).subagentLine).toBe(
            "theirs"
        );
        expect(wireSubagentLine({ on: false, write: true, dist: "/dist", settingsPath: other })).toBe("absent");
        expect(readSettings(other).subagentStatusLine).toEqual(theirs);
    });

    it("replaces another subagentStatusLine only when asked, and disable or uninstall puts it back", () => {
        const theirs = { type: "command", command: "/home/alice/rows.sh" };
        const path = settingsFile({ subagentStatusLine: theirs });
        const wire = (on: boolean, replace?: boolean) =>
            wireSubagentLine({ on, write: true, replace, dist: "/dist", settingsPath: path });

        expect(wire(true, true)).toBe("replaced");
        expect(readSettings(path).subagentStatusLine).toEqual(subagentLineFor("/dist"));
        expect(existsSync(`${path}.subagent-line-owned`)).toBe(true);
        // Enabling again finds our own command, so the kept one is not overwritten with ours.
        expect(wire(true, true)).toBe("unchanged");

        expect(wire(false)).toBe("restored");
        expect(readSettings(path).subagentStatusLine).toEqual(theirs);
        expect(existsSync(`${path}.subagent-line-owned`)).toBe(false);

        expect(wire(true, true)).toBe("replaced");
        expect(uninstallHooks({ settingsPath: path, write: true }).removed).toBe(1);
        expect(readSettings(path).subagentStatusLine).toEqual(theirs);
    });

    it("quotes the script path, so a dist under a directory with a space still runs", () => {
        const path = settingsFile({ hooks: {} });

        installHooks({ dist: "/My Home/dist", settingsPath: path, write: true });

        expect(readSettings(path).hooks?.PreToolUse?.[0]?.hooks[0]?.command).toBe(
            "bun '/My Home/dist/src/agents/bin/hook-pre.ts'"
        );
    });

    it("is idempotent: a second install reports unchanged and does not touch the file", () => {
        const path = settingsFile({ hooks: {} });

        installHooks({ dist: "/dist", settingsPath: path, write: true });

        const bytes = readFileSync(path, "utf8");
        const mtime = statSync(path).mtimeMs;
        const second = installHooks({ dist: "/dist", settingsPath: path, write: true });

        expect(second.added).toEqual([]);
        expect(second.updated).toEqual([]);
        expect(second.unchanged).toEqual(["Stop", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionEnd"]);
        expect(second.changed).toBe(false);
        expect(readFileSync(path, "utf8")).toBe(bytes);
        // A no-op must be a NO-OP: the earlier version rewrote the file every time.
        expect(statSync(path).mtimeMs).toBe(mtime);
    });

    it("converges on a new dist instead of reporting success and doing nothing", () => {
        const path = settingsFile({ hooks: {} });

        installHooks({ dist: "/dist-A", settingsPath: path, write: true });

        const moved = installHooks({ dist: "/dist-B", settingsPath: path, write: true });
        const after = readFileSync(path, "utf8");

        expect(moved.updated).toEqual(["Stop", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionEnd"]);
        expect(moved.changed).toBe(true);
        expect(after).toContain("/dist-B/src/agents/bin/hook-pre.ts");
        expect(after).not.toContain("/dist-A");
    });

    it("migrates an entry left over from an older layout", () => {
        // The two-command PreToolUse this port replaced with one merged entrypoint. The
        // marker-based check saw "something of ours is here" and never migrated it.
        const path = settingsFile({
            hooks: {
                PreToolUse: [
                    {
                        matcher: "Bash",
                        hooks: [
                            { type: "command", command: "bun /dist/src/agents/bin/hook-diff-pre.ts", timeout: 10 },
                            { type: "command", command: "bun /dist/src/agents/bin/hook-guard.ts", timeout: 10 },
                        ],
                    },
                ],
            },
        });
        const result = installHooks({ dist: "/dist", settingsPath: path, write: true });
        const commands = (readSettings(path).hooks?.PreToolUse ?? []).flatMap((entry) =>
            entry.hooks.map((hook) => hook.command)
        );

        expect(result.updated).toContain("PreToolUse");
        expect(commands).toEqual(["bun '/dist/src/agents/bin/hook-pre.ts'"]);
    });

    it("keeps an unrelated entry and its position", () => {
        const path = settingsFile({
            hooks: {
                PreToolUse: [
                    { hooks: [{ type: "command", command: "/first.sh" }] },
                    { hooks: [{ type: "command", command: "/second.sh" }] },
                ],
            },
        });

        installHooks({ dist: "/dist", settingsPath: path, write: true });
        installHooks({ dist: "/dist-B", settingsPath: path, write: true });

        const commands = (readSettings(path).hooks?.PreToolUse ?? []).flatMap((entry) =>
            entry.hooks.map((hook) => hook.command)
        );

        expect(commands).toEqual(["/first.sh", "/second.sh", "bun '/dist-B/src/agents/bin/hook-pre.ts'"]);
    });

    it("writes a backup once, before the first change", () => {
        const path = settingsFile({ hooks: {}, marker: "original" });
        const result = installHooks({ dist: "/dist", settingsPath: path, write: true });

        expect(result.backup).toBe(`${path}.pre-agents-hooks`);
        expect(SafeJSON.parse(readFileSync(result.backup as string, "utf8"))).toEqual({
            hooks: {},
            marker: "original",
        });
    });

    it("uninstall removes exactly what install added", () => {
        const path = settingsFile({
            hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "/existing.sh" }] }] },
        });

        installHooks({ dist: "/dist", settingsPath: path, write: true });

        const removed = uninstallHooks({ settingsPath: path, write: true });
        const after = readSettings(path);

        expect(removed.removed).toBe(5);
        expect(after.hooks?.PreToolUse).toEqual([{ hooks: [{ type: "command", command: "/existing.sh" }] }]);
        expect(after.hooks?.PostToolUse).toEqual([]);
        expect(after.hooks?.SessionEnd).toEqual([]);
    });

    it("doctor's wiring check calls an entry from an older install stale, not installed", () => {
        // What this machine had on 2026-09-24: the post hook on Bash only, from before Edit and
        // Write were recorded, so no file-tool call ever reached the session change log.
        const post = "bun /dist/src/agents/bin/hook-diff-post.ts";
        const path = settingsFile({
            hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: post, timeout: 15 }] }] },
        });

        expect(wiringStatus({ dist: "/dist", settingsPath: path, decisions: false, unpushed: false })).toEqual({
            state: "stale",
            events: ["PreToolUse", "PostToolUseFailure", "SessionEnd", "PostToolUse"],
        });

        installHooks({ dist: "/dist", settingsPath: path, write: true, decisions: false, unpushed: false });
        expect(wiringStatus({ dist: "/dist", settingsPath: path, decisions: false, unpushed: false })).toEqual({
            state: "installed",
            events: [],
        });
        expect(
            wiringStatus({ dist: "/dist", settingsPath: settingsFile({}), decisions: false, unpushed: false }).state
        ).toBe("missing");
        expect(readSettings(path).hooks?.PostToolUse?.[0]?.matcher).toBe("Bash|Edit|MultiEdit|Write");
    });

    it("keeps Claude Code's Bash diff on while shadow is on", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-hooks-shadow-"));
        const configDir = join(home, ".genesis-tools", "agents");

        mkdirSync(configDir, { recursive: true });

        try {
            await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
                const configPath = join(configDir, "hooks.json");

                writeFileSync(configPath, SafeJSON.stringify({ shadow: true }));

                const shadowed = settingsFile({ hooks: {}, bashEditDiffEnabled: true });
                const kept = installHooks({ dist: "/dist", settingsPath: shadowed, write: true });

                expect(kept.nativeDiff).toBe("kept");
                expect(readSettings(shadowed).bashEditDiffEnabled).toBe(true);

                writeFileSync(configPath, SafeJSON.stringify({ shadow: false }));

                const live = settingsFile({ hooks: {}, bashEditDiffEnabled: true });
                const turned = installHooks({ dist: "/dist", settingsPath: live, write: true });

                expect(turned.nativeDiff).toBe("turned-off");
                expect(readSettings(live).bashEditDiffEnabled).toBe(false);

                writeFileSync(configPath, SafeJSON.stringify({ shadow: false, diff: { replaceNative: false } }));

                const stood = settingsFile({ hooks: {}, bashEditDiffEnabled: true });
                const alone = installHooks({ dist: "/dist", settingsPath: stood, write: true });

                expect(alone.nativeDiff).toBe("kept");
                expect(readSettings(stood).bashEditDiffEnabled).toBe(true);
            });
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("restores the native diff uninstall took over, and leaves one the user changed", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-hooks-native-restore-"));
        const configDir = join(home, ".genesis-tools", "agents");

        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, "hooks.json"), SafeJSON.stringify({ shadow: false }));

        try {
            await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
                const turned = settingsFile({ hooks: {}, bashEditDiffEnabled: true });

                installHooks({ dist: "/dist", settingsPath: turned, write: true });
                expect(readSettings(turned).bashEditDiffEnabled).toBe(false);
                uninstallHooks({ settingsPath: turned, write: true });
                expect(readSettings(turned).bashEditDiffEnabled).toBe(true);

                const absent = settingsFile({ hooks: {} });

                installHooks({ dist: "/dist", settingsPath: absent, write: true });
                expect(readSettings(absent).bashEditDiffEnabled).toBe(false);
                uninstallHooks({ settingsPath: absent, write: true });
                expect(readSettings(absent).bashEditDiffEnabled).toBeUndefined();

                const owned = settingsFile({ hooks: {}, bashEditDiffEnabled: true });

                installHooks({ dist: "/dist", settingsPath: owned, write: true });

                const edited = readSettings(owned);
                edited.bashEditDiffEnabled = true;
                writeJsonFile(owned, edited);
                uninstallHooks({ settingsPath: owned, write: true });
                expect(readSettings(owned).bashEditDiffEnabled).toBe(true);

                const already = settingsFile({ hooks: {}, bashEditDiffEnabled: false });

                installHooks({ dist: "/dist", settingsPath: already, write: true });
                uninstallHooks({ settingsPath: already, write: true });
                expect(readSettings(already).bashEditDiffEnabled).toBe(false);
            });
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("dry run reports what it would add and writes nothing", () => {
        const path = settingsFile({ hooks: {} });
        const result = installHooks({ dist: "/dist", settingsPath: path, write: false });

        expect(result.added).toEqual(["Stop", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionEnd"]);
        expect(result.changed).toBe(true);
        expect(readSettings(path).hooks).toEqual({});
    });
});

describe("nativeDiffState", () => {
    it("reads a broken settings file as the default, and a real value as itself", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-native-diff-"));
        const broken = join(dir, "broken.json");
        const off = join(dir, "off.json");
        const on = join(dir, "on.json");
        const diag = join(dir, "diag.jsonl");

        writeFileSync(broken, "{");
        writeFileSync(off, SafeJSON.stringify({ bashEditDiffEnabled: false }));
        writeFileSync(on, SafeJSON.stringify({ bashEditDiffEnabled: true }));
        setDiagLogPath(diag);

        try {
            expect(nativeDiffState(broken)).toBe("default");
            expect(nativeDiffState(off)).toBe("off");
            expect(nativeDiffState(on)).toBe("on");
            expect(readFileSync(diag, "utf8")).toContain("Could not read the native diff setting");
        } finally {
            setDiagLogPath(defaultLogPath());
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("applySetting", () => {
    it("flips shadow and leaves everything else alone", () => {
        const next = applySetting(DEFAULT_HOOKS_CONFIG, "shadow", "false");

        expect(next.shadow).toBe(false);
        expect(next.guard.longCommand).toEqual(DEFAULT_HOOKS_CONFIG.guard.longCommand);
        expect(DEFAULT_HOOKS_CONFIG.shadow).toBe(true);
    });

    it("sets a per-rule outcome the resolver then honours", () => {
        const next = applySetting(DEFAULT_HOOKS_CONFIG, "rules.find-from-root", "allow");

        expect(next.guard.default["find-from-root"]).toBe("allow");
        expect(
            evaluateGuard(
                {
                    event: "PreToolUse",
                    tool: "Bash",
                    cwd: "/repo",
                    command: "find ~ -name x",
                    model: "",
                    harness: "claude",
                    nativeDiffFiles: [],
                    raw: {},
                },
                next
            )
        ).toBeNull();
    });

    it("sets a per-harness outcome", () => {
        const next = applySetting(DEFAULT_HOOKS_CONFIG, "harnesses.grok.find-from-root", "warn");

        expect(next.guard.harnesses.grok?.["find-from-root"]).toBe("warn");
        expect(next.guard.harnesses.grok?.["zsh-glob-qualifier"]).toBe("allow");
    });

    it("refuses an unknown rule, an unknown harness, an unknown key and a bad value", () => {
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "rules.nope", "allow")).toThrow("no such rule");
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "harnesses.nope.find-from-root", "allow")).toThrow(
            "no such harness"
        );
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "nonsense", "1")).toThrow("unknown key");
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "shadow", "maybe")).toThrow("true or false");
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "rules.find-from-root", "loud")).toThrow("takes one of");
    });

    it("diff.commandLines and mods.diff.fullDiff are set, checked and loaded", () => {
        expect(DEFAULT_HOOKS_CONFIG.diff.commandLines).toBe(3);
        expect(DEFAULT_HOOKS_CONFIG.mods.diff.fullDiff).toBe(true);
        expect(applySetting(DEFAULT_HOOKS_CONFIG, "diff.commandLines", "0").diff.commandLines).toBe(0);
        expect(applySetting(DEFAULT_HOOKS_CONFIG, "mods.diff.fullDiff", "false").mods.diff.fullDiff).toBe(false);
        // The flat key of before 2026-10-23 is an alias.
        expect(applySetting(DEFAULT_HOOKS_CONFIG, "mods.fullDiff", "false").mods.diff.fullDiff).toBe(false);
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "diff.commandLines", "-1")).toThrow();
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "mods.diff.fullDiff", "off")).toThrow("true or false");

        const path = join(mkdtempSync(join(tmpdir(), "gt-cfg-mods-")), "hooks.json");

        writeFileSync(path, SafeJSON.stringify({ diff: { commandLines: 5 }, mods: { diff: { fullDiff: false } } }));
        expect(loadHooksConfig(path).diff.commandLines).toBe(5);
        expect(loadHooksConfig(path).mods.diff.fullDiff).toBe(false);
    });

    it("mods.idleCompact.* are set, checked and loaded, and the flat keys of before still read", () => {
        expect(DEFAULT_HOOKS_CONFIG.mods.idleCompact.minutes).toBe(56);
        expect(applySetting(DEFAULT_HOOKS_CONFIG, "mods.idleCompact", "false").mods.idleCompact.enabled).toBe(false);
        expect(applySetting(DEFAULT_HOOKS_CONFIG, "mods.idleCompact.minutes", "50").mods.idleCompact.minutes).toBe(50);
        expect(applySetting(DEFAULT_HOOKS_CONFIG, "mods.idleCompactMinTokens", "0").mods.idleCompact.minTokens).toBe(0);
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "mods.idleCompact.minutes", "60")).toThrow("1 to 59");

        const path = join(mkdtempSync(join(tmpdir(), "gt-cfg-idle-")), "hooks.json");

        writeFileSync(
            path,
            SafeJSON.stringify({ mods: { idleCompact: false, idleCompactMinutes: 75, idleCompactMinTokens: 1000 } })
        );
        expect(loadHooksConfig(path).mods.idleCompact).toEqual({ enabled: false, minutes: 56, minTokens: 1000 });
    });

    it("the other mods keys are set and checked by the type of their default", () => {
        const set = (key: string, value: string) => applySetting(DEFAULT_HOOKS_CONFIG, key, value).mods;

        expect(set("mods.agentModel.format", "short").agentModel).toEqual({ enabled: false, format: "short" });
        expect(() => set("mods.agentModel.format", "tiny")).toThrow("label or short");
        expect(set("mods.git.labels", "minimal").git).toEqual({
            enabled: false,
            labels: "minimal",
            checkouts: 3,
            cwd: "touched",
            expand: "first",
            name: "repo-folder",
            earlier: "show",
        });
        expect(set("mods.git.expand", "all").git.expand).toBe("all");
        expect(set("mods.git.name", "folder").git.name).toBe("folder");
        expect(() => set("mods.git.name", "path")).toThrow("repo-folder, repo or folder");
        expect(set("mods.git.earlier", "hide").git.earlier).toBe("hide");
        expect(() => set("mods.git.earlier", "off")).toThrow("show or hide");
        expect(() => set("mods.git.expand", "some")).toThrow("first, all or none");
        expect(() => set("mods.git.labels", "short")).toThrow("full or minimal");
        expect(set("mods.decisions.chip", "waiting").decisions).toEqual({
            enabled: false,
            chip: "waiting",
            expand: "waiting",
        });
        expect(() => set("mods.decisions.expand", "unread")).toThrow("waiting, all or none");
        expect(set("mods.inbox", "true").inbox).toEqual({ enabled: true, chip: "any", expand: "none" });
        expect(set("mods.inbox.expand", "unread").inbox.expand).toBe("unread");
        expect(() => set("mods.inbox.chip", "waiting")).toThrow("any, unread or off");
        expect(set("mods.git.checkouts", "2").git.checkouts).toBe(2);
        expect(() => set("mods.git.checkouts", "9")).toThrow("1 to 6");
        expect(set("mods.git.cwd", "always").git.cwd).toBe("always");
        expect(() => set("mods.git.cwd", "never")).toThrow("touched or always");
        expect(set("mods.sidebar.hints", "false").sidebar).toEqual({
            hints: false,
            feedback: "line",
            focus: "command",
        });
        expect(set("mods.sidebar.focus", "never").sidebar.focus).toBe("never");
        expect(set("mods.stall.action", "auto").stall).toEqual({ enabled: false, action: "auto", minutes: 5 });
        expect(() => set("mods.stall.action", "nag")).toThrow("button or auto");
        expect(set("mods.stall.minutes", "15").stall.minutes).toBe(15);
        expect(() => set("mods.stall.minutes", "500")).toThrow("1 to 120");
        expect(() => set("mods.sidebar.focus", "sometimes")).toThrow("command, always or never");
        expect(set("mods.sidebar.feedback", "both").sidebar.feedback).toBe("both");
        expect(() => set("mods.sidebar.feedback", "popup")).toThrow("line, toast or both");
        expect(set("mods.links", "true").links.enabled).toBe(true);
        expect(set("mods.cacheBand.warnMinutes", "15").cacheBand.warnMinutes).toBe(15);
        expect(() => set("mods.cacheBand.warnMinutes", "75")).toThrow("1 to 59");
        expect(set("mods.cacheBand.cautionMinutes", "30").cacheBand.cautionMinutes).toBe(30);
        expect(set("mods.hooks.dedupe", "true").hooks).toEqual({ tokens: false, dedupe: true });
        expect(() => set("mods.nonsense.enabled", "true")).toThrow("Unknown mods key");
        expect(() => set("mods.links.colour", "red")).toThrow("Unknown mods key");
    });

    it("reads the mods plugin's row from claude plugin list --json", () => {
        const listed = SafeJSON.stringify([
            { id: "other@somewhere", enabled: true },
            { id: MODS_PLUGIN, enabled: false, scope: "user", version: "1.0.0", readFromFolder: "/repo/plugins/x" },
        ]);

        expect(modsPluginState(listed)).toEqual({
            installed: true,
            enabled: false,
            scope: "user",
            version: "1.0.0",
            readFrom: "/repo/plugins/x",
        });
        expect(modsPluginState("[]")).toEqual({ installed: false, enabled: false });
        expect(modsPluginState("not json")).toEqual({ installed: false, enabled: false });
    });

    it("lets only the strongest settings file that names the mods plugin turn it off", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-mods-settings-"));
        const local = join(dir, "settings.local.json");
        const user = join(dir, "settings.json");
        const named = (on: boolean) => SafeJSON.stringify({ enabledPlugins: { [MODS_PLUGIN]: on } });

        // A project, local or --plugin-dir load leaves the user settings silent: the session's mark decides.
        expect(modsPluginDisabled([local, user])).toBe(false);
        writeFileSync(user, named(true));
        writeFileSync(local, named(false));
        expect(modsPluginDisabled([local, user])).toBe(true);
        writeFileSync(local, named(true));
        writeFileSync(user, named(false));
        expect(modsPluginDisabled([local, user])).toBe(false);
        writeFileSync(local, "not json");
        expect(modsPluginDisabled([local, user])).toBe(true);
    });

    it("mods watch adds the mods folder to CLAUDE_CODE_PLUGIN_DIRS and takes it out again, keeping the rest", () => {
        const folder = "/repo/plugins/genesis-tools-mods";
        const settings = { model: "opus", env: { OTHER: "1", CLAUDE_CODE_PLUGIN_DIRS: "/a/one" } };
        const on = withModsWatch(settings, folder, true);

        expect(pluginDirsOf(on)).toEqual(["/a/one", folder]);
        expect(modsWatched(on)).toBe(true);
        expect(withModsWatch(on, folder, true)).toEqual(on);
        expect(on.model).toBe("opus");

        const off = withModsWatch(on, folder, false);

        expect(off).toEqual(settings);
        expect(withModsWatch({ env: { CLAUDE_CODE_PLUGIN_DIRS: `${folder}/` } }, folder, false)).toEqual({});
        expect(modsWatched({})).toBe(false);

        const dir = mkdtempSync(join(tmpdir(), "gt-mods-watch-"));
        const path = join(dir, "settings.json");

        // A watched load names no enabledPlugins entry, so it never turns the mod off.
        writeFileSync(path, SafeJSON.stringify(on));
        expect(modsPluginDisabled([path])).toBe(false);
    });

    it("mods status reads hot reload as unknown, not a crash, when the settings file is not JSON", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-mods-state-"));
        const path = join(dir, "settings.json");

        expect(modsWatchState(path)).toBe(false);
        writeFileSync(
            path,
            SafeJSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: "/repo/plugins/genesis-tools-mods" } })
        );
        expect(modsWatchState(path)).toBe(true);
        writeFileSync(path, "{not json");
        expect(modsWatchState(path)).toBeUndefined();
    });

    it("agentsTalk.hint is a boolean switch that ships on and survives a load", () => {
        expect(DEFAULT_HOOKS_CONFIG.agentsTalk.hint).toBe(true);
        expect(applySetting(DEFAULT_HOOKS_CONFIG, "agentsTalk.hint", "false").agentsTalk.hint).toBe(false);
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "agentsTalk.hint", "off")).toThrow("true or false");

        const path = join(mkdtempSync(join(tmpdir(), "gt-cfg-hint-")), "hooks.json");

        writeFileSync(path, SafeJSON.stringify({ agentsTalk: { hint: false } }));
        expect(loadHooksConfig(path).agentsTalk.hint).toBe(false);
        writeFileSync(path, SafeJSON.stringify({ agentsTalk: { hint: "no" } }));
        expect(loadHooksConfig(path).agentsTalk.hint).toBe(true);
    });

    it("refuses a count outside its domain, in set and on load alike", () => {
        for (const [key, value] of [
            ["diff.maxFiles", "-1"],
            ["diff.maxFiles", "2.5"],
            ["diff.maxMessageChars", "0"],
            ["guard.longCommand.lines", ""],
            ["guard.contextCapPerSession", "-1"],
        ]) {
            expect(() => applySetting(DEFAULT_HOOKS_CONFIG, key, value)).toThrow("whole number");
        }

        // An MB cap is a size, not a count: a fraction is valid, zero or less is not.
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "maxLogMB", "0")).toThrow("greater than 0");
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "diff.maxCaptureFileMB", "-1")).toThrow("greater than 0");
        expect(applySetting(DEFAULT_HOOKS_CONFIG, "diff.maxCaptureFileMB", "0.5").diff.maxCaptureFileMB).toBe(0.5);
        expect(applySetting(DEFAULT_HOOKS_CONFIG, "guard.contextCapPerSession", "0").guard.contextCapPerSession).toBe(
            0
        );

        const path = join(mkdtempSync(join(tmpdir(), "gt-cfg-domain-")), "hooks.json");

        writeFileSync(
            path,
            SafeJSON.stringify({ maxLogMB: -1, diff: { maxFiles: 2.5, contextLines: 0, maxCaptureFileMB: 0.5 } })
        );

        const loaded = loadHooksConfig(path);
        expect(loaded.maxLogMB).toBe(DEFAULT_HOOKS_CONFIG.maxLogMB);
        expect(loaded.diff.maxFiles).toBe(DEFAULT_HOOKS_CONFIG.diff.maxFiles);
        expect(loaded.diff.contextLines).toBe(0);
        expect(loaded.diff.maxCaptureFileMB).toBe(0.5);
    });
});

describe("collectStaleCaptures", () => {
    function tree(): string {
        const root = mkdtempSync(join(tmpdir(), "gt-hooks-gc-"));

        for (const call of ["old", "new"]) {
            const dir = join(root, "claude", "sess-a", "diff", call);

            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "1.tar"), "x".repeat(100));
        }

        const other = join(root, "claude", "sess-b", "diff", "call");

        mkdirSync(other, { recursive: true });
        writeFileSync(join(other, "1.tar"), "y".repeat(50));
        utimesSync(join(root, "claude", "sess-a", "diff", "old"), new Date(0), new Date(0));

        return root;
    }

    it("removes a capture past the horizon and keeps a live one", () => {
        const root = tree();
        const result = collectStaleCaptures({ now: Date.now(), horizonMs: 3_600_000, root, write: true });

        expect(result.removed.map((entry) => entry.path.split("/").at(-1))).toEqual(["old"]);
        expect(result.kept).toBe(2);
        expect(existsSync(join(root, "claude", "sess-a", "diff", "new"))).toBe(true);
        expect(existsSync(join(root, "claude", "sess-a", "diff", "old"))).toBe(false);

        rmSync(root, { recursive: true, force: true });
    });

    it("a dry run reports the same set and deletes nothing", () => {
        const root = tree();
        const result = collectStaleCaptures({ now: Date.now(), horizonMs: 3_600_000, root });

        expect(result.removed).toHaveLength(1);
        expect(result.bytes).toBe(100);
        expect(existsSync(join(root, "claude", "sess-a", "diff", "old"))).toBe(true);

        rmSync(root, { recursive: true, force: true });
    });

    it("a session sweep ignores age and touches only that session", () => {
        const root = tree();
        const result = collectStaleCaptures({ now: Date.now(), sessionId: "sess-a", root, write: true });

        expect(result.removed).toHaveLength(2);
        expect(existsSync(join(root, "claude", "sess-b", "diff", "call"))).toBe(true);

        rmSync(root, { recursive: true, force: true });
    });

    it("parses the durations the flag accepts and rejects the rest", () => {
        expect(parseHorizon("6h")).toBe(21_600_000);
        expect(parseHorizon("30m")).toBe(1_800_000);
        expect(parseHorizon("0s")).toBe(0);
        expect(parseHorizon("2d")).toBe(172_800_000);
        expect(parseHorizon("45")).toBe(45_000);
        expect(() => parseHorizon("soon")).toThrow("takes a duration");
    });
});

describe("keepsCommand", () => {
    it("records the command while shadowed, which is when the replay needs it", () => {
        expect(keepsCommand({ ...DEFAULT_HOOKS_CONFIG, shadow: true, logCommands: "shadow" })).toBe(true);
    });

    it("stops recording it once shadow is off, so the log is not a durable secret sink", () => {
        expect(keepsCommand({ ...DEFAULT_HOOKS_CONFIG, shadow: false, logCommands: "shadow" })).toBe(false);
    });

    it("honours the two explicit settings", () => {
        expect(keepsCommand({ ...DEFAULT_HOOKS_CONFIG, shadow: false, logCommands: "always" })).toBe(true);
        expect(keepsCommand({ ...DEFAULT_HOOKS_CONFIG, shadow: true, logCommands: "never" })).toBe(false);
    });

    it("is settable, and rejects a value that is not one of the three", () => {
        expect(applySetting(DEFAULT_HOOKS_CONFIG, "logCommands", "never").logCommands).toBe("never");
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "logCommands", "sometimes")).toThrow("shadow, always or never");
    });
});

describe("the decision log", () => {
    it("creates the log directory 0700 and the file 0600", () => {
        const dir = join(mkdtempSync(join(tmpdir(), "gt-log-mode-")), "nested");
        const path = join(dir, "agents-hooks.jsonl");

        logDecision(
            { at: new Date().toISOString(), phase: "guard", harness: "claude", decision: "allow", reason: "probe" },
            path
        );

        expect(statSync(dir).mode & 0o777).toBe(0o700);
        expect(statSync(path).mode & 0o777).toBe(0o600);

        rmSync(dir, { recursive: true, force: true });
    });
});

describe("the sweep leaves no empty shell behind", () => {
    it("removes the session and diff directories once their last capture is gone", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-hooks-shell-"));
        const call = join(root, "claude", "sess", "diff", "one");

        mkdirSync(call, { recursive: true });
        writeFileSync(join(call, "1.tar"), "x");

        collectStaleCaptures({ now: Date.now(), sessionId: "sess", root, write: true });

        expect(existsSync(call)).toBe(false);
        expect(existsSync(join(root, "claude", "sess", "diff"))).toBe(false);
        expect(existsSync(join(root, "claude", "sess"))).toBe(false);

        rmSync(root, { recursive: true, force: true });
    });

    it("keeps a session directory that still holds a live capture", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-hooks-shell-live-"));
        const stale = join(root, "claude", "sess", "diff", "old");
        const live = join(root, "claude", "sess", "diff", "new");

        mkdirSync(stale, { recursive: true });
        mkdirSync(live, { recursive: true });
        writeFileSync(join(stale, "1.tar"), "x");
        writeFileSync(join(live, "1.tar"), "y");
        utimesSync(stale, new Date(0), new Date(0));

        collectStaleCaptures({ now: Date.now(), horizonMs: 3_600_000, root, write: true });

        expect(existsSync(stale)).toBe(false);
        expect(existsSync(live)).toBe(true);
        expect(existsSync(join(root, "claude", "sess"))).toBe(true);

        rmSync(root, { recursive: true, force: true });
    });
});

describe("config read robustness", () => {
    it("merges the nested longCommand field by field", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-cfg-merge-"));

        mkdirSync(join(home, ".genesis-tools", "agents"), { recursive: true });
        writeFileSync(
            join(home, ".genesis-tools", "agents", "hooks.json"),
            SafeJSON.stringify({ guard: { longCommand: { lines: 12 } } })
        );

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            // A shallow spread replaced the whole object, so `chars` became undefined and
            // `chars >= undefined` is always false: the character threshold silently stopped.
            expect(loadHooksConfig().guard.longCommand).toEqual({ lines: 12, chars: 2500 });
        });

        rmSync(home, { recursive: true, force: true });
    });

    it("merges guard.harnesses per harness, keeping the shipped entries a stored one omits", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-cfg-harness-"));

        mkdirSync(join(home, ".genesis-tools", "agents"), { recursive: true });
        writeFileSync(
            join(home, ".genesis-tools", "agents", "hooks.json"),
            SafeJSON.stringify({ guard: { harnesses: { codex: { "find-from-root": "allow" } } } })
        );

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const guard = loadHooksConfig().guard;

            // A shallow spread replaced the whole harnesses map, so an override for one
            // harness deleted the shipped Grok entry and silently re-enabled a guard that
            // was deliberately turned off there.
            expect(guard.harnesses.grok?.["zsh-glob-qualifier"]).toBe("allow");
            expect(guard.harnesses.codex?.["zsh-glob-qualifier"]).toBe("allow");
            expect(guard.harnesses.codex?.["find-from-root"]).toBe("allow");
        });

        rmSync(home, { recursive: true, force: true });
    });

    it("merges guard.default and guard.models rather than replacing them", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-cfg-default-"));

        mkdirSync(join(home, ".genesis-tools", "agents"), { recursive: true });
        writeFileSync(
            join(home, ".genesis-tools", "agents", "hooks.json"),
            SafeJSON.stringify({ guard: { default: { "find-from-root": "allow" } } })
        );

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const guard = loadHooksConfig().guard;

            expect(guard.default["find-from-root"]).toBe("allow");
            expect(guard.contextCapPerSession).toBe(3);
            expect(guard.models).toEqual(DEFAULT_HOOKS_CONFIG.guard.models);
        });

        rmSync(home, { recursive: true, force: true });
    });

    it("reports a config file that exists but cannot be read", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-cfg-bad-"));

        mkdirSync(join(home, ".genesis-tools", "agents"), { recursive: true });
        writeFileSync(join(home, ".genesis-tools", "agents", "hooks.json"), "{ not json");

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            // The defaults still apply, and `doctor` can now say WHY rather than printing
            // "no config file" for a file that is plainly there.
            expect(loadHooksConfig().guard.longCommand).toEqual({ lines: 30, chars: 2500 });
            expect(lastConfigLoadError()).toBeDefined();
        });

        rmSync(home, { recursive: true, force: true });
    });

    it("puts a non-numeric cap back to its default and says so", async () => {
        // A hand-edited `"maxFiles": "15"` reached the hot path as a string, where
        // `blocks.length >= "15"` compares as text. Now it falls back and doctor names it.
        const home = mkdtempSync(join(tmpdir(), "gt-cfg-types-"));

        mkdirSync(join(home, ".genesis-tools", "agents"), { recursive: true });
        writeFileSync(
            join(home, ".genesis-tools", "agents", "hooks.json"),
            SafeJSON.stringify({ diff: { maxFiles: "15" }, guard: { longCommand: { lines: null } } })
        );

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const config = loadHooksConfig();

            expect(config.diff.maxFiles).toBe(DEFAULT_HOOKS_CONFIG.diff.maxFiles);
            expect(config.guard.longCommand.lines).toBe(DEFAULT_HOOKS_CONFIG.guard.longCommand.lines);
            expect(lastConfigProblems().join("\n")).toContain('diff.maxFiles is "15"');
            expect(lastConfigProblems().join("\n")).toContain("guard.longCommand.lines is null");
        });

        rmSync(home, { recursive: true, force: true });
    });

    it("drops a non-numeric cap in a per-harness override so the shared value applies", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-cfg-harness-types-"));

        mkdirSync(join(home, ".genesis-tools", "agents"), { recursive: true });
        writeFileSync(
            join(home, ".genesis-tools", "agents", "hooks.json"),
            SafeJSON.stringify({ diff: { maxFiles: 7, harnesses: { claude: { maxFiles: "15", enabled: true } } } })
        );

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const config = loadHooksConfig();

            expect(diffFor(config, "claude").maxFiles).toBe(7);
            expect(diffFor(config, "claude").enabled).toBe(true);
            expect(lastConfigProblems().join("\n")).toContain('diff.harnesses.claude.maxFiles is "15"');
        });

        rmSync(home, { recursive: true, force: true });
    });

    it("has no load error after reading a valid file", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-cfg-good-"));

        mkdirSync(join(home, ".genesis-tools", "agents"), { recursive: true });
        writeFileSync(join(home, ".genesis-tools", "agents", "hooks.json"), SafeJSON.stringify({ shadow: false }));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            expect(loadHooksConfig().shadow).toBe(false);
            expect(lastConfigLoadError()).toBeUndefined();
        });

        rmSync(home, { recursive: true, force: true });
    });
});

describe("parseHookPayload tolerates a malformed native payload", () => {
    it("ignores a bashEditDiff whose files is not an array", () => {
        for (const files of [7, { a: 1 }, "x", null]) {
            const payload = parseHookPayload(
                SafeJSON.stringify({
                    hook_event_name: "PostToolUse",
                    tool_name: "Bash",
                    cwd: "/repo",
                    tool_response: { bashEditDiff: { files } },
                })
            );

            expect(payload?.nativeDiffFiles).toEqual([]);
        }
    });

    it("skips a malformed element and keeps the valid ones", () => {
        const payload = parseHookPayload(
            SafeJSON.stringify({
                hook_event_name: "PostToolUse",
                tool_name: "Bash",
                cwd: "/repo",
                tool_response: { bashEditDiff: { files: [null, 3, "x", { filePath: "/repo/a.ts" }] } },
            })
        );

        expect(payload?.nativeDiffFiles).toEqual(["/repo/a.ts"]);
    });
});

describe("the stored config is merged over the shipped one, key by key", () => {
    const stored = (value: unknown): string => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-cfg-keys-")), "hooks.json");

        writeFileSync(path, SafeJSON.stringify(value));
        return path;
    };

    it("keeps the shipped codex and grok rules when only claude's are set", () => {
        const config = loadHooksConfig(stored({ guard: { harnesses: { claude: { "some-rule": "allow" } } } }));

        expect(config.guard.harnesses.claude).toEqual({ "some-rule": "allow" });
        expect(config.guard.harnesses.codex).toEqual({ "zsh-glob-qualifier": "allow" });
        expect(config.guard.harnesses.grok).toEqual({ "zsh-glob-qualifier": "allow" });
    });

    it("honours the byte caps an older hooks.json stored before they were renamed to MB", () => {
        const config = loadHooksConfig(stored({ maxLogBytes: 2_000_000, diff: { maxCaptureBytes: 3_000_000 } }));

        expect(config.maxLogMB).toBe(2);
        expect(config.diff.maxCaptureMB).toBe(3);

        const both = loadHooksConfig(
            stored({ maxLogMB: 5, maxLogBytes: 2_000_000, diff: { maxCaptureMB: 6, maxCaptureBytes: 3_000_000 } })
        );

        expect(both.maxLogMB).toBe(5);
        expect(both.diff.maxCaptureMB).toBe(6);
        expect(loadHooksConfig(stored({ shadow: false })).maxLogMB).toBe(DEFAULT_HOOKS_CONFIG.maxLogMB);
    });

    it("drops a guard number that is not a finite number", () => {
        const config = loadHooksConfig(
            stored({ guard: { contextCapPerSession: "5", longCommand: { lines: null, chars: 99 } } })
        );

        expect(config.guard.contextCapPerSession).toBe(DEFAULT_HOOKS_CONFIG.guard.contextCapPerSession);
        expect(config.guard.longCommand).toEqual({ lines: DEFAULT_HOOKS_CONFIG.guard.longCommand.lines, chars: 99 });
    });
});

describe("the config writers build on the file they write", () => {
    const stored = (value: unknown): string => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-cfg-write-")), "hooks.json");

        writeFileSync(path, typeof value === "string" ? value : SafeJSON.stringify(value));
        return path;
    };

    it("config set reads the --path it writes, so that file's other settings survive", () => {
        const path = stored({ shadow: false, diff: { maxFiles: 9 } });

        setHooksConfig("logCommands", "never", { write: true, path });

        const written = loadHooksConfig(path);
        expect(written.logCommands).toBe("never");
        expect(written.shadow).toBe(false);
        expect(written.diff.maxFiles).toBe(9);
    });

    it("refuses to overwrite a hooks.json that exists but cannot be parsed", () => {
        const path = stored("{ not json");

        expect(() => setHooksConfig("shadow", "false", { write: true, path })).toThrow("refusing to write");
        expect(readFileSync(path, "utf8")).toBe("{ not json");
    });

    it("a missing hooks.json is the normal first write and proceeds", () => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-cfg-first-")), "hooks.json");

        expect(setHooksConfig("shadow", "false", { write: true, path }).written).toBe(true);
        expect(loadHooksConfig(path).shadow).toBe(false);
    });

    it("hand-edited values of the wrong type fall back to the shipped defaults", () => {
        const config = loadHooksConfig(
            stored({
                shadow: "false",
                logCommands: "sometimes",
                maxLogMB: "big",
                diff: {
                    maxFiles: "3",
                    enabled: "no",
                    harnesses: { grok: { enabled: "true" }, codex: { maxFiles: "9", maxMessageChars: 4000 } },
                },
            })
        );

        expect(config.shadow).toBe(DEFAULT_HOOKS_CONFIG.shadow);
        expect(config.logCommands).toBe(DEFAULT_HOOKS_CONFIG.logCommands);
        expect(config.maxLogMB).toBe(DEFAULT_HOOKS_CONFIG.maxLogMB);
        expect(config.diff.maxFiles).toBe(DEFAULT_HOOKS_CONFIG.diff.maxFiles);
        expect(config.diff.enabled).toBe(DEFAULT_HOOKS_CONFIG.diff.enabled);
        // A per-harness override is checked the same way: the string "true" must not switch the
        // diff back on for Grok, and a string number must not reach Codex, while a valid one does.
        expect(diffFor(config, "grok").enabled).toBe(false);
        expect(diffFor(config, "codex").maxFiles).toBe(DEFAULT_HOOKS_CONFIG.diff.maxFiles);
        expect(diffFor(config, "codex").maxMessageChars).toBe(4000);
    });
});

describe("install moves the machine-wide dist link only once settings.json can take the change", () => {
    const inHome = async (run: (home: string) => void): Promise<void> => {
        const home = mkdtempSync(join(tmpdir(), "gt-install-order-"));

        try {
            await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => run(home));
        } finally {
            chmodSync(home, 0o755);
            rmSync(home, { recursive: true, force: true });
        }
    };

    it("leaves the link alone when settings.json cannot be parsed", async () => {
        await inHome((home) => {
            pointDist(join(home, "old-checkout"));
            const settingsPath = join(home, "settings.json");

            writeFileSync(settingsPath, "{ not json");

            expect(() => installAndPoint({ target: join(home, "new-checkout"), settingsPath, write: true })).toThrow();
            expect(readlinkSync(hooksDistPath())).toBe(join(home, "old-checkout"));
        });
    });

    it.skipIf(process.getuid?.() === 0)("puts the link back when the settings write fails", async () => {
        await inHome((home) => {
            pointDist(join(home, "old-checkout"));
            const locked = join(home, "locked");

            mkdirSync(locked);
            writeFileSync(join(locked, "settings.json"), SafeJSON.stringify({ hooks: {} }));
            chmodSync(locked, 0o555);

            try {
                expect(() =>
                    installAndPoint({
                        target: join(home, "new-checkout"),
                        settingsPath: join(locked, "settings.json"),
                        write: true,
                    })
                ).toThrow();
            } finally {
                chmodSync(locked, 0o755);
            }

            expect(readlinkSync(hooksDistPath())).toBe(join(home, "old-checkout"));
        });
    });

    it("repoints the link and wires the settings when both can be written", async () => {
        await inHome((home) => {
            pointDist(join(home, "old-checkout"));
            const settingsPath = join(home, "settings.json");

            writeFileSync(settingsPath, SafeJSON.stringify({ hooks: {} }));

            const result = installAndPoint({ target: join(home, "new-checkout"), settingsPath, write: true });

            expect(result.repointed).toBe(true);
            expect(readlinkSync(hooksDistPath())).toBe(join(home, "new-checkout"));
            expect(readSettings(settingsPath).hooks?.PreToolUse).toHaveLength(1);
        });
    });
});

describe("writeJsonFile edge cases", () => {
    it("keeps the permission bits of the file it replaces", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-json-mode-"));
        const path = join(dir, "hooks.json");

        writeFileSync(path, "{}");
        chmodSync(path, 0o600);
        writeJsonFile(path, { shadow: false });

        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(SafeJSON.parse(readFileSync(path, "utf8"))).toEqual({ shadow: false });

        rmSync(dir, { recursive: true, force: true });
    });

    it("writes through a DANGLING symlink to its target instead of replacing the link", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-json-dangling-"));
        const target = join(dir, "real", "hooks.json");
        const link = join(dir, "hooks.json");

        mkdirSync(join(dir, "real"));
        symlinkSync(target, link);
        writeJsonFile(link, { shadow: false });

        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(SafeJSON.parse(readFileSync(target, "utf8"))).toEqual({ shadow: false });

        rmSync(dir, { recursive: true, force: true });
    });
});

describe("installHooks writes settings.json safely", () => {
    it("keeps a symlinked settings.json a symlink and updates its target", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-settings-link-"));
        const target = join(dir, "real-settings.json");
        const link = join(dir, "settings.json");

        writeFileSync(target, SafeJSON.stringify({ model: "keep-me" }));
        symlinkSync(target, link);
        installHooks({ dist: "/dist", settingsPath: link, write: true });

        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readSettings(target).model).toBe("keep-me");
        expect(readSettings(target).hooks?.PreToolUse).toHaveLength(1);

        rmSync(dir, { recursive: true, force: true });
    });
});

describe("installHooks on a machine with no settings file", () => {
    it("writes a fresh one instead of throwing", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-no-settings-"));
        const path = join(dir, "nested", "settings.json");
        const result = installHooks({ dist: "/dist", settingsPath: path, write: true });

        expect(result.added).toEqual(["Stop", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionEnd"]);
        expect(result.backup).toBe(`${path}.pre-agents-hooks`);
        expect(existsSync(`${path}.pre-agents-hooks`)).toBe(false);
        expect(readSettings(path).hooks?.PreToolUse).toHaveLength(1);

        rmSync(dir, { recursive: true, force: true });
    });

    it("uninstall on a missing settings file removes nothing and does not throw", () => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-no-settings2-")), "settings.json");

        expect(uninstallHooks({ settingsPath: path, write: true }).removed).toBe(0);
    });
});

describe("capture paths refuse an unsafe identifier", () => {
    // The post phase ends in `rmSync(dir, { recursive: true, force: true })`, so a
    // `toolUseId` of `../../..` would resolve back up the tree and the sweep would delete it.
    const unsafe = ["../../..", "..", ".", "a/b", "", "with space", "x\u0000y", "-leading"];

    it.each(unsafe)("rejects %j", (value) => {
        expect(safeSegment(value)).toBeNull();
        expect(() => callDir("claude", "sess", value)).toThrow("unsafe tool call id");
    });

    it.each(unsafe)("rejects %j as a session id too", (value) => {
        expect(() => sessionDir("claude", value)).toThrow("unsafe session id");
    });

    const ok = ["toolu_01SXXfskEYtYHLfrtKWRopWL", "a503b06c-e677-45a8-b46e-ce1757edaa9f", "bench", "t1"];

    it.each(ok)("accepts the real shape %j", (value) => {
        expect(safeSegment(value)).toBe(value);
        expect(callDir("claude", "sess", value).endsWith(`/diff/${value}`)).toBe(true);
    });
});

describe("the decision log is bounded", () => {
    it("rotates to a single .1 generation once past the cap", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-log-rotate-"));
        // A path this process has never written, so the once-per-process size check runs.
        const path = join(dir, "agents-hooks.jsonl");
        const record = { at: new Date().toISOString(), phase: "guard" as const, harness: "claude", decision: "allow" };

        writeFileSync(path, `${"x".repeat(400)}\n`);
        setMaxLogBytes(200);

        try {
            logDecision({ ...record, reason: "after rotation" }, path);
        } finally {
            setMaxLogBytes(16_000_000);
        }

        // The old content moved aside; the new log holds only the record just written.
        expect(readFileSync(`${path}.1`, "utf8").startsWith("xxx")).toBe(true);
        expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
        expect(readFileSync(path, "utf8")).toContain("after rotation");

        rmSync(dir, { recursive: true, force: true });
    });

    describe("the rotation lock is released only by its holder", () => {
        it("does not delete a lock another process took over in the meantime", () => {
            const dir = mkdtempSync(join(tmpdir(), "gt-lock-token-"));
            const lock = join(dir, "log.rotating");
            const mine = takeRotationLock(lock);

            expect(mine).not.toBeNull();
            // Another process judged it stale and now holds a lock of its own at the same path.
            writeFileSync(lock, "999-theirs");
            releaseRotationLock(lock, mine ?? "");

            expect(readFileSync(lock, "utf8")).toBe("999-theirs");

            rmSync(dir, { recursive: true, force: true });
        });

        it("a second taker backs off while the lock is fresh", () => {
            const dir = mkdtempSync(join(tmpdir(), "gt-lock-fresh-"));
            const lock = join(dir, "log.rotating");
            const first = takeRotationLock(lock);

            expect(takeRotationLock(lock)).toBeNull();
            releaseRotationLock(lock, first ?? "");
            expect(existsSync(lock)).toBe(false);

            rmSync(dir, { recursive: true, force: true });
        });
    });

    describe("two hook processes crossing the cap together", () => {
        const record = { at: new Date().toISOString(), phase: "guard" as const, harness: "claude", decision: "allow" };

        const withCap = (bytes: number, run: () => void): void => {
            setMaxLogBytes(bytes);

            try {
                run();
            } finally {
                setMaxLogBytes(16_000_000);
            }
        };

        it("does not rotate a log another process already rotated since this one counted", () => {
            const dir = mkdtempSync(join(tmpdir(), "gt-log-race-"));
            const path = join(dir, "agents-hooks.jsonl");

            writeFileSync(path, `${"x".repeat(400)}\n`);
            // Seeds this process's cached size at about 500 bytes.
            logDecision({ ...record, reason: "seed" }, path);
            // Another process rotates: the old generation is in .1, a fresh log in place.
            writeFileSync(`${path}.1`, "OLD-GENERATION\n");
            writeFileSync(path, "fresh\n");

            withCap(520, () => logDecision({ ...record, reason: "late" }, path));

            expect(readFileSync(`${path}.1`, "utf8")).toBe("OLD-GENERATION\n");
            expect(readFileSync(path, "utf8")).toContain("late");

            rmSync(dir, { recursive: true, force: true });
        });

        it("leaves the rotation to the process holding the lock, and still writes the record", () => {
            const dir = mkdtempSync(join(tmpdir(), "gt-log-locked-"));
            const path = join(dir, "agents-hooks.jsonl");

            writeFileSync(path, `${"x".repeat(400)}\n`);
            writeFileSync(`${path}.rotating`, "");

            withCap(200, () => logDecision({ ...record, reason: "while locked" }, path));

            expect(existsSync(`${path}.1`)).toBe(false);
            expect(readFileSync(path, "utf8")).toContain("while locked");
            expect(existsSync(`${path}.rotating`)).toBe(true);

            rmSync(dir, { recursive: true, force: true });
        });

        it("clears a lock left by a crashed rotator and rotates", () => {
            const dir = mkdtempSync(join(tmpdir(), "gt-log-stale-"));
            const path = join(dir, "agents-hooks.jsonl");
            const old = new Date(Date.now() - 60_000);

            writeFileSync(path, `${"x".repeat(400)}\n`);
            writeFileSync(`${path}.rotating`, "");
            utimesSync(`${path}.rotating`, old, old);

            withCap(200, () => logDecision({ ...record, reason: "after stale lock" }, path));

            expect(readFileSync(`${path}.1`, "utf8").startsWith("xxx")).toBe(true);
            expect(existsSync(`${path}.rotating`)).toBe(false);

            rmSync(dir, { recursive: true, force: true });
        });
    });

    it("leaves a log under the cap alone", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-log-small-"));
        const path = join(dir, "agents-hooks.jsonl");

        writeFileSync(path, "small\n");
        logDecision(
            { at: new Date().toISOString(), phase: "guard", harness: "claude", decision: "allow", reason: "kept" },
            path
        );

        expect(existsSync(`${path}.1`)).toBe(false);
        expect(readFileSync(path, "utf8").split("\n")).toHaveLength(3);

        rmSync(dir, { recursive: true, force: true });
    });

    it("is settable and rejects a non-number", () => {
        expect(applySetting(DEFAULT_HOOKS_CONFIG, "maxLogMB", "500").maxLogMB).toBe(500);
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "maxLogMB", "lots")).toThrow("takes a number");
    });

    it("ships a cap rather than growing without bound", () => {
        expect(DEFAULT_HOOKS_CONFIG.maxLogMB).toBeGreaterThan(0);
    });
});

describe("log rotation holds for a long-lived writer", () => {
    it("rotates again once the cap is crossed a second time in the same process", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-log-longlived-"));
        const path = join(dir, "agents-hooks.jsonl");
        const record = { at: new Date().toISOString(), phase: "guard" as const, harness: "claude", decision: "allow" };

        setMaxLogBytes(400);

        try {
            // Many records in ONE process. The size check used to run once per process, so a
            // long-lived writer grew without bound past the cap after that first look.
            for (let index = 0; index < 40; index++) {
                logDecision({ ...record, reason: `record ${index} ${"x".repeat(60)}` }, path);
            }
        } finally {
            setMaxLogBytes(16_000_000);
        }

        expect(statSync(path).size).toBeLessThanOrEqual(400);
        expect(existsSync(`${path}.1`)).toBe(true);

        rmSync(dir, { recursive: true, force: true });
    });
});

describe("the stored config holds overrides only", () => {
    // 🛑 `applySetting` works on the fully RESOLVED config, so writing it verbatim froze every
    // current default into the file. Observed 2026-09-22: one `diff.maxFiles` change pinned
    // ten unrelated settings, and a later default would never have reached that machine.
    it("keeps only what differs, at any depth", () => {
        const base = { a: 1, deep: { kept: "same", moved: "before" }, list: [1, 2] };
        const next = { a: 1, deep: { kept: "same", moved: "after" }, list: [1, 2] };

        expect(changedOnly(next, base)).toEqual({ deep: { moved: "after" } });
    });

    it("returns undefined when nothing differs, so the file becomes {}", () => {
        expect(changedOnly(DEFAULT_HOOKS_CONFIG, DEFAULT_HOOKS_CONFIG)).toBeUndefined();
    });

    it("compares a list whole, so clearing one is not mistaken for leaving it", () => {
        expect(changedOnly({ list: [] }, { list: [1] })).toEqual({ list: [] });
        expect(changedOnly({ list: [1] }, { list: [1] })).toBeUndefined();
    });

    it("writes ONE key when one key was set", () => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-setcfg-")), "hooks.json");

        setHooksConfig("diff.maxFiles", "7", { write: true, path });

        const stored = SafeJSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

        expect(storedOverrides(stored)).toEqual({ diff: { maxFiles: 7 } });
    });

    it("lists every setting in the file, with the shipped defaults beside them", () => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-setcfg-")), "hooks.json");

        setHooksConfig("unpushed.maxCommits", "5", { write: true, path });

        const stored = SafeJSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

        expect(stored.unpushed).toEqual({ ...DEFAULT_HOOKS_CONFIG.unpushed, maxCommits: 5 });
        expect(stored.guard).toBeDefined();
        expect(stored[SHIPPED_DEFAULTS_KEY]).toEqual(SafeJSON.parse(SafeJSON.stringify(DEFAULT_HOOKS_CONFIG)));
    });

    it("lets a later default reach a listed setting the user never changed", () => {
        // The file was written when the default was 45 and lists 45; this build ships another value.
        const shippedThen = {
            ...DEFAULT_HOOKS_CONFIG,
            unpushed: { ...DEFAULT_HOOKS_CONFIG.unpushed, maxAgeMinutes: 45 },
        };
        const file = {
            ...shippedThen,
            unpushed: { ...shippedThen.unpushed, maxCommits: 9 },
            installed: { at: "2026-10-01T00:00:00.000Z" },
            [SHIPPED_DEFAULTS_KEY]: shippedThen,
        };

        expect(storedOverrides(file)).toEqual({ unpushed: { maxCommits: 9 } });
    });

    it("reads a file without the shipped copy as overrides, as before", () => {
        expect(storedOverrides({ shadow: false })).toEqual({ shadow: false });
    });

    it("keeps the install record when a setting is written", () => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-setcfg-")), "hooks.json");
        const installed = { at: "2026-10-01T00:00:00.000Z", claude: { state: "installed" } };

        writeJsonFile(path, { shadow: false, installed });
        setHooksConfig("diff.maxFiles", "7", { write: true, path });

        const stored = SafeJSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

        expect(stored.installed).toEqual(installed);
        expect(storedOverrides(stored)).toEqual({ shadow: false, diff: { maxFiles: 7 } });
    });
});

describe("the diff is resolved per harness", () => {
    // 🛑 Observed 2026-09-22 in Grok: the message arrives as literal escape text
    // (`[1mUpdated`) and is cut after about 200 characters with `-impo… [+7768 chars]`, so a
    // single file header already overflows it.
    it("ships OFF for grok and ON for the harnesses that can show it", () => {
        expect(diffFor(DEFAULT_HOOKS_CONFIG, "grok").enabled).toBe(false);
        expect(diffFor(DEFAULT_HOOKS_CONFIG, "claude").enabled).toBe(true);
        expect(diffFor(DEFAULT_HOOKS_CONFIG, "codex").enabled).toBe(true);
    });

    it("keeps every shared setting the override does not name", () => {
        const resolved = diffFor(DEFAULT_HOOKS_CONFIG, "grok");

        expect(resolved.maxFiles).toBe(DEFAULT_HOOKS_CONFIG.diff.maxFiles);
        expect(resolved.categories).toEqual(DEFAULT_HOOKS_CONFIG.diff.categories);
    });

    it("leaves an unlisted harness on the shared settings", () => {
        expect(diffFor(DEFAULT_HOOKS_CONFIG, undefined)).toBe(DEFAULT_HOOKS_CONFIG.diff);
    });

    it("lets a stored override for one harness keep the shipped one for another", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-cfg-harness-"));

        mkdirSync(join(home, ".genesis-tools", "agents"), { recursive: true });
        writeFileSync(
            join(home, ".genesis-tools", "agents", "hooks.json"),
            SafeJSON.stringify({ diff: { harnesses: { codex: { maxFiles: 3 } } } })
        );

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const config = loadHooksConfig();

            expect(diffFor(config, "codex").maxFiles).toBe(3);
            expect(diffFor(config, "grok").enabled).toBe(false);
        });

        rmSync(home, { recursive: true, force: true });
    });

    it("can be turned back on from the CLI, and overrides only that key", () => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-setcfg-grok-")), "hooks.json");

        setHooksConfig("diff.harnesses.grok.enabled", "true", { write: true, path });

        expect(storedOverrides(SafeJSON.parse(readFileSync(path, "utf8")))).toEqual({
            diff: { harnesses: { grok: { enabled: true } } },
        });
    });

    it("refuses a field that is not settable per harness", () => {
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "diff.harnesses.grok.contextLines", "1")).toThrow(
            /cannot set contextLines/
        );
    });

    it("does not write into the config it was handed", () => {
        applySetting(DEFAULT_HOOKS_CONFIG, "diff.harnesses.claude.enabled", "false");

        expect(DEFAULT_HOOKS_CONFIG.diff.harnesses.claude).toBeUndefined();
    });
});

describe("decision hub hooks", () => {
    const decisionsOn = (overrides: Partial<DecisionsHookConfig> = {}): DecisionsHookConfig => ({
        ...DEFAULT_HOOKS_CONFIG.decisions,
        stopHook: "block",
        ...overrides,
    });

    function stopPayload(reply: string, extra: Record<string, unknown> = {}): HookPayload {
        const parsed = parseHookPayload(
            SafeJSON.stringify({
                hook_event_name: "Stop",
                session_id: "sess-1",
                cwd: "/tmp",
                last_assistant_message: reply,
                ...extra,
            })
        );

        if (!parsed) {
            throw new Error("fixture payload did not parse");
        }

        return parsed;
    }

    function harness() {
        const dir = mkdtempSync(join(tmpdir(), "gt-decision-hooks-"));
        const log = { file: join(dir, "decisions.jsonl"), events: join(dir, "events.jsonl") };
        const blocks = new Map<string, number>();
        const counts = {
            read: (session: string) => blocks.get(session) ?? 0,
            bump: (session: string) => blocks.set(session, (blocks.get(session) ?? 0) + 1),
        };

        return { log, counts, deps: { log, counts } };
    }

    const asking = "Ready.\n\n❓ DECISION 1 — Cache\nKeep it?\n- a) yes\n- b) no";

    it("ships off: no Stop or prompt entry is wired and a reply with a marker is left alone", async () => {
        const { deps, log } = harness();

        expect(DEFAULT_HOOKS_CONFIG.decisions).toMatchObject({ stopHook: "off", harvest: false, injectAnswers: false });
        expect(decisionHooksWanted(DEFAULT_HOOKS_CONFIG)).toBe(false);
        expect(await runDecisionStop(stopPayload(asking), DEFAULT_HOOKS_CONFIG.decisions, deps)).toBeNull();
        expect(existsSync(log.file)).toBe(false);
    });

    it("leaves a normal turn with no ❓ untouched even in block mode with harvest on", async () => {
        const { deps, log } = harness();
        const output = await runDecisionStop(stopPayload("Done. Tests pass."), decisionsOn({ harvest: true }), deps);

        expect(output).toBeNull();
        expect(existsSync(log.file)).toBe(false);
    });

    it("blocks an unposted DECISION, counts it, and falls back to a warning past the loop guard", async () => {
        const { deps, counts } = harness();
        const config = decisionsOn({ maxBlocksPerSession: 1 });

        const first = await runDecisionStop(stopPayload(asking), config, deps);
        expect(first).toMatchObject({ decision: "block" });
        expect(counts.read("sess-1")).toBe(1);

        const second = await runDecisionStop(stopPayload(asking), config, deps);
        expect(second).toHaveProperty("systemMessage");
        expect(counts.read("sess-1")).toBe(1);
    });

    it("warn mode only tells the user, and a posted number passes", async () => {
        const { deps, log } = harness();
        const warn = await runDecisionStop(stopPayload(asking), decisionsOn({ stopHook: "warn" }), deps);

        expect(warn).toHaveProperty("systemMessage");

        await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Keep it?", options: [] }],
        });
        expect(await runDecisionStop(stopPayload(asking), decisionsOn(), deps)).toBeNull();
    });

    it("skips a harness that is not listed", async () => {
        const { deps } = harness();
        const codex = stopPayload(asking, { model: "gpt-5" });

        expect(codex.harness).toBe("codex");
        expect(await runDecisionStop(codex, decisionsOn({ harnesses: ["claude"] }), deps)).toBeNull();
    });

    it("harvest stores the unposted block under its number instead of blocking", async () => {
        const { deps, log } = harness();
        const output = await runDecisionStop(stopPayload(asking), decisionsOn({ harvest: true }), deps);

        expect(output).toEqual({ systemMessage: "Stored ❓ DECISION 1 from the reply so the hub shows it." });
        expect(readDecisions(log.file).map((row) => [row.id, row.options, row.harvested])).toEqual([
            ["d_1_sess-1", ["yes", "no"], true],
        ]);
    });

    it("reads the final reply from the transcript when the payload does not carry it", () => {
        const lines = [
            SafeJSON.stringify({ type: "user", message: { content: "go" } }),
            SafeJSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first" }] } }),
            SafeJSON.stringify({
                type: "assistant",
                message: {
                    content: [
                        { type: "tool_use", name: "Bash" },
                        { type: "text", text: "❓ DECISION 2" },
                    ],
                },
            }),
        ].join("\n");
        const payload = stopPayload("", { last_assistant_message: undefined, transcript_path: "/fixture.jsonl" });

        expect(finalReply(payload, () => `{"torn":${lines}`)).toBe("❓ DECISION 2");
        expect(finalReply(stopPayload("given"), () => lines)).toBe("given");
    });

    it("hands answered decisions to the next prompt once, and stays silent when off or nothing is due", async () => {
        const { log, counts } = harness();
        const emitted: PromptHookOutput[] = [];
        const deps = { log, counts, emit: (output: PromptHookOutput) => emitted.push(output) };
        const prompt = { ...stopPayload(""), event: "UserPromptSubmit" };
        const [row] = await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Keep it?", options: ["yes", "no"] }],
        });
        await updateDecision(log.file, log.events, row.id, { state: "answered", option: "a" });

        expect(await runDecisionInject(prompt, DEFAULT_HOOKS_CONFIG.decisions, deps)).toBeNull();
        expect(readDecisions(log.file)[0]?.state).toBe("answered");

        const output = await runDecisionInject(prompt, decisionsOn({ injectAnswers: true }), deps);
        expect(output?.hookSpecificOutput.additionalContext).toContain("DECISION 1: a) yes");
        expect(emitted).toEqual(output ? [output] : []);
        expect(emitted).toHaveLength(1);
        expect(readDecisions(log.file)[0]?.state).toBe("sent");
        // The hub and /qa read the delivery, not the state: it must not still say "queued".
        expect(readDecisions(log.file)[0]?.delivery?.route).toBe("prompt");
        expect(await runDecisionInject(prompt, decisionsOn({ injectAnswers: true }), deps)).toBeNull();
        expect(emitted).toHaveLength(1);
        // The agent then confirms it read the answer: answered → sent → acknowledged.
        expect((await updateDecision(log.file, log.events, row.id, { state: "acknowledged" })).state).toBe(
            "acknowledged"
        );
    });

    it("keeps the answers queued when the hook output cannot be written", async () => {
        const { log, counts } = harness();
        const prompt = { ...stopPayload(""), event: "UserPromptSubmit" };
        const [row] = await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Keep it?", options: ["yes", "no"] }],
        });
        await updateDecision(log.file, log.events, row.id, { state: "answered", option: "a" });
        const broken = {
            log,
            counts,
            emit: () => {
                throw new Error("EPIPE");
            },
        };

        await expect(runDecisionInject(prompt, decisionsOn({ injectAnswers: true }), broken)).rejects.toThrow("EPIPE");
        expect(readDecisions(log.file)[0]?.state).toBe("answered");

        const delivered: PromptHookOutput[] = [];
        const retried = await runDecisionInject(prompt, decisionsOn({ injectAnswers: true }), {
            log,
            counts,
            emit: (output: PromptHookOutput) => delivered.push(output),
        });
        expect(retried?.hookSpecificOutput.additionalContext).toContain("DECISION 1: a) yes");
        expect(delivered).toHaveLength(1);
    });

    it("install wires Stop and UserPromptSubmit only when asked, and removes them when turned off", () => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-hooks-settings-")), "settings.json");
        writeFileSync(
            path,
            SafeJSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/mine.sh" }] }] } })
        );

        const on = installHooks({ dist: "/dist", settingsPath: path, write: true, decisions: true, unpushed: false });
        expect(on.added).toEqual(expect.arrayContaining(["Stop", "UserPromptSubmit"]));
        expect(readSettings(path).hooks?.Stop?.map((entry) => entry.hooks[0]?.command)).toEqual([
            "/mine.sh",
            "bun '/dist/src/agents/bin/hook-stop.ts'",
        ]);

        const off = installHooks({ dist: "/dist", settingsPath: path, write: true, decisions: false, unpushed: false });
        expect(off.removed).toEqual(["Stop", "UserPromptSubmit"]);
        expect(readSettings(path).hooks?.Stop).toEqual([{ hooks: [{ type: "command", command: "/mine.sh" }] }]);
    });

    it("config set validates the decision keys", () => {
        const next = applySetting(DEFAULT_HOOKS_CONFIG, "decisions.stopHook", "warn");

        expect(next.decisions.stopHook).toBe("warn");
        expect(DEFAULT_HOOKS_CONFIG.decisions.stopHook).toBe("off");
        expect(applySetting(next, "decisions.harnesses", "claude,grok").decisions.harnesses).toEqual([
            "claude",
            "grok",
        ]);
        expect(() => applySetting(next, "decisions.stopHook", "loud")).toThrow(/off, warn or block/);
        expect(() => applySetting(next, "decisions.harnesses", "cursor")).toThrow(/no such harness/);
    });
});

describe("the unpushed reminder", () => {
    const config = DEFAULT_HOOKS_CONFIG.unpushed;
    const hour = 60 * 60_000;

    /** A clone of a bare "origin" with its branch pushed, so `@{u}` exists. */
    function pushedClone(): { work: string; run: (args: string[], extra?: Record<string, string>) => void } {
        const base = mkdtempSync(join(tmpdir(), "gt-unpushed-"));
        const origin = join(base, "origin.git");
        const work = join(base, "work");
        const run = (args: string[], extra: Record<string, string> = {}) => {
            const result = Bun.spawnSync(["git", "-C", work, ...args], { env: { ...process.env, ...extra } });

            if (result.exitCode !== 0) {
                throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
            }
        };

        Bun.spawnSync(["git", "init", "-q", "--bare", origin], { env: process.env });
        Bun.spawnSync(["git", "clone", "-q", origin, work], { env: process.env });
        run(["config", "user.email", "alice@example.com"]);
        run(["config", "user.name", "alice"]);
        run(["commit", "-q", "--allow-empty", "-m", "seed"]);
        run(["push", "-q", "-u", "origin", "HEAD"]);

        return { work: realpathSync(work), run };
    }

    function commit(run: (args: string[], extra?: Record<string, string>) => void, count: number, at?: Date): void {
        for (let index = 0; index < count; index += 1) {
            const stamp: Record<string, string> = at
                ? { GIT_COMMITTER_DATE: at.toISOString(), GIT_AUTHOR_DATE: at.toISOString() }
                : {};

            run(["commit", "-q", "--allow-empty", "-m", `work ${index}`], stamp);
        }
    }

    it("stays quiet at or under the thresholds, and fires past 3 commits", () => {
        const { work, run } = pushedClone();

        commit(run, 3);
        expect(unpushedReminders([work], config)).toEqual([]);

        commit(run, 1);
        const [line] = unpushedReminders([work], config);

        expect(line).toMatch(/^⬆ work \S+: 4 commits not pushed, oldest 0m, last push \d\d:\d\d\. Push when ready/);
    });

    it("fires for ONE commit older than an hour", () => {
        const { work, run } = pushedClone();

        commit(run, 1, new Date(Date.now() - 2 * hour));

        expect(unpushedReminders([work], config)[0]).toContain("1 commit not pushed, oldest 2h");
    });

    it("reminds once per repository per 30 minutes, across sessions", () => {
        const { work, run } = pushedClone();
        const now = Date.now();

        commit(run, 5);

        expect(unpushedReminders([work], config, now)).toHaveLength(1);
        expect(unpushedReminders([work], config, now + 10 * 60_000)).toEqual([]);
        expect(unpushedReminders([work], config, now + 29 * 60_000)).toEqual([]);
        expect(unpushedReminders([work], config, now + 61 * 60_000)).toHaveLength(1);
    });

    it("stays quiet on a branch with no upstream, and when turned off", () => {
        const { work, run } = pushedClone();

        commit(run, 6);
        expect(unpushedReminders([work], { ...config, enabled: false })).toEqual([]);

        run(["checkout", "-q", "-b", "local-only"]);
        expect(unpushedReminders([work], config)).toEqual([]);
    });

    it("spends two git processes on a new HEAD and one once it is cached", async () => {
        const { work, run } = pushedClone();

        commit(run, 2);

        const first = await withSpawnCounter(async () => unpushedState(work));
        const again = await withSpawnCounter(async () => unpushedState(work));

        expect(first.result?.count).toBe(2);
        expect(first.count).toBe(2);
        expect(again.count).toBe(1);
        expect(again.result?.count).toBe(2);
    });

    it("the installer wires Stop for it alone, and not UserPromptSubmit", () => {
        const events = entriesFor("/dist", { decisions: false, unpushed: true }).map((item) => item.event);

        expect(events).toContain("Stop");
        expect(events).not.toContain("UserPromptSubmit");
        expect(entriesFor("/dist", { decisions: false, unpushed: false }).map((item) => item.event)).not.toContain(
            "Stop"
        );
    });

    it("its thresholds are settable and validated", () => {
        const next = applySetting(DEFAULT_HOOKS_CONFIG, "unpushed.maxCommits", "5");

        expect(next.unpushed.maxCommits).toBe(5);
        expect(applySetting(next, "unpushed.enabled", "false").unpushed.enabled).toBe(false);
        expect(() => applySetting(next, "unpushed.maxAgeMinutes", "0")).toThrow(/at least 1/);
        expect(() => applySetting(next, "unpushed.often", "1")).toThrow(/unknown key/);
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

        expect(rules).toBe(SHELL_RULES);
        expect(custom).toBeNull();
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
        const failed = checkRuleExamples(SHELL_RULES, { cwd: repoRoot() }).filter((check) => !check.ok);

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

describe("Codex wiring", () => {
    const timing = {
        hooks: [{ type: "command", command: "/home/alice/.claude/hooks/timing.sh", timeout: 5 }],
        matcher: "Bash",
    };

    function codexFile(value: unknown): string {
        const path = join(mkdtempSync(join(tmpdir(), "gt-codex-")), "hooks.json");

        writeFileSync(path, SafeJSON.stringify(value));
        return path;
    }

    it("appends after every existing entry, so the entries Codex already trusts keep their index", () => {
        const path = codexFile({ hooks: { PreToolUse: [timing], PostToolUse: [timing] } });
        const result = installCodexHooks({ dist: "/dist", path, write: true, diff: true });
        const written = readSettings(path);

        expect(result.added).toEqual(["PreToolUse", "PostToolUse"]);
        expect(written.hooks?.PreToolUse?.[0]).toEqual(timing);
        expect(written.hooks?.PreToolUse?.[1]?.hooks[0]?.command).toBe("bun '/dist/src/agents/bin/hook-pre.ts'");
        expect(written.hooks?.PostToolUse?.[1]?.hooks[0]?.command).toBe("bun '/dist/src/agents/bin/hook-diff-post.ts'");
        expect(existsSync(`${path}.pre-agents-hooks`)).toBe(true);
    });

    it("a second run changes nothing; a new dist replaces our entry IN PLACE", () => {
        const path = codexFile({ hooks: { PreToolUse: [timing] } });

        installCodexHooks({ dist: "/dist", path, write: true, diff: false });
        expect(installCodexHooks({ dist: "/dist", path, write: true, diff: false }).changed).toBe(false);

        writeFileSync(
            path,
            SafeJSON.stringify({
                hooks: { PreToolUse: [codexEntriesFor("/old", { diff: false })[0]?.entry, timing] },
            })
        );

        const result = installCodexHooks({ dist: "/dist", path, write: true, diff: false });
        const list = readSettings(path).hooks?.PreToolUse ?? [];

        expect(result.updated).toEqual(["PreToolUse"]);
        expect(list[0]?.hooks[0]?.command).toBe("bun '/dist/src/agents/bin/hook-pre.ts'");
        expect(list[1]).toEqual(timing);
    });

    it("the diff off removes our post entry; uninstall removes only ours", () => {
        const path = codexFile({ hooks: { PreToolUse: [timing], PostToolUse: [timing] } });

        installCodexHooks({ dist: "/dist", path, write: true, diff: true });
        expect(installCodexHooks({ dist: "/dist", path, write: true, diff: false }).removed).toEqual(["PostToolUse"]);
        expect(uninstallCodexHooks({ path, write: true }).removed).toBe(1);
        expect(readSettings(path).hooks).toEqual({ PreToolUse: [timing], PostToolUse: [timing] });
    });

    it("reports which of our positions config.toml holds a trust entry for, and survives a broken file", () => {
        const path = codexFile({ hooks: { PreToolUse: [timing] } });
        const configPath = join(path, "..", "config.toml");

        expect(codexWiring({ dist: "/dist", path, configPath, diff: false }).state).toBe("missing");

        installCodexHooks({ dist: "/dist", path, write: true, diff: false });
        writeFileSync(configPath, `[hooks.state."${path}:pre_tool_use:1:0"]\ntrusted_hash = "sha256:x"\n`);

        expect(codexWiring({ dist: "/dist", path, configPath, diff: false })).toMatchObject({
            state: "installed",
            trust: [{ event: "PreToolUse", key: `${path}:pre_tool_use:1:0`, recorded: true }],
        });
        expect(codexWiring({ dist: "/dist", path, configPath, diff: true }).state).toBe("stale");

        writeFileSync(path, "{ not json");
        expect(codexWiring({ dist: "/dist", path, configPath }).error).toBeDefined();
    });
});

describe("lastSeenPerHarness", () => {
    it("takes the newest record per harness, and reads the rotated generation for a harness the current one lacks", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-seen-"));
        const log = join(dir, "agents-hooks.jsonl");
        const record = (harness: string, at: string): string => SafeJSON.stringify({ at, harness, phase: "guard" });

        writeFileSync(
            log,
            ["{cut in half", record("claude", "2026-10-12T10:00:00Z"), record("claude", "2026-10-12T11:00:00Z")].join(
                "\n"
            )
        );
        writeFileSync(`${log}.1`, record("grok", "2026-10-11T09:00:00Z"));

        expect(lastSeenPerHarness(log)).toEqual({ claude: "2026-10-12T11:00:00Z", grok: "2026-10-11T09:00:00Z" });
    });
});

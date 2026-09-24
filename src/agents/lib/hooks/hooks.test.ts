import { describe, expect, it } from "bun:test";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { DEFAULT_HOOKS_CONFIG, keepsCommand, lastConfigLoadError, loadHooksConfig } from "./config";
import { collectStaleCaptures, parseHorizon } from "./gc";
import { evaluateCommand, evaluateGuard } from "./guard";
import { guardFromLegacy, importedHooksConfig, importGuardConfig } from "./import-config";
import { hooksDistPath, installAndPoint, installHooks, pointDist, readSettings, uninstallHooks } from "./install";
import { logDecision, releaseRotationLock, setMaxLogBytes, takeRotationLock } from "./log";
import { matchesGlob, resolveOutcome } from "./outcome";
import { callDir, hookDataRoot, safeSegment, sessionDir } from "./paths";
import type { HookPayload } from "./payload";
import { parseHookPayload } from "./payload";
import { withPrivateTempDir } from "./private-temp";
import { applySetting, setHooksConfig } from "./set-config";
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
        expect(DEFAULT_HOOKS_CONFIG.diff.maxFiles).toBe(3);
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
        expect(second.unchanged).toEqual(["PreToolUse", "PostToolUse", "SessionEnd"]);
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

        expect(moved.updated).toEqual(["PreToolUse", "PostToolUse", "SessionEnd"]);
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

        expect(removed.removed).toBe(3);
        expect(after.hooks?.PreToolUse).toEqual([{ hooks: [{ type: "command", command: "/existing.sh" }] }]);
        expect(after.hooks?.PostToolUse).toEqual([]);
        expect(after.hooks?.SessionEnd).toEqual([]);
    });

    it("dry run reports what it would add and writes nothing", () => {
        const path = settingsFile({ hooks: {} });
        const result = installHooks({ dist: "/dist", settingsPath: path, write: false });

        expect(result.added).toEqual(["PreToolUse", "PostToolUse", "SessionEnd"]);
        expect(result.changed).toBe(true);
        expect(readSettings(path).hooks).toEqual({});
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

    it("refuses a count outside its domain, in set and on load alike", () => {
        for (const [key, value] of [
            ["diff.maxFiles", "-1"],
            ["diff.maxFiles", "2.5"],
            ["maxLogBytes", "0"],
            ["guard.longCommand.lines", ""],
            ["guard.contextCapPerSession", "-1"],
        ]) {
            expect(() => applySetting(DEFAULT_HOOKS_CONFIG, key, value)).toThrow("whole number");
        }

        expect(applySetting(DEFAULT_HOOKS_CONFIG, "guard.contextCapPerSession", "0").guard.contextCapPerSession).toBe(
            0
        );

        const path = join(mkdtempSync(join(tmpdir(), "gt-cfg-domain-")), "hooks.json");

        writeFileSync(path, SafeJSON.stringify({ maxLogBytes: -1, diff: { maxFiles: 2.5, contextLines: 0 } }));

        const loaded = loadHooksConfig(path);
        expect(loaded.maxLogBytes).toBe(DEFAULT_HOOKS_CONFIG.maxLogBytes);
        expect(loaded.diff.maxFiles).toBe(DEFAULT_HOOKS_CONFIG.diff.maxFiles);
        expect(loaded.diff.contextLines).toBe(0);
    });
});

describe("guardFromLegacy", () => {
    it("takes the legacy overrides and keeps the shipped default for what it omits", () => {
        const guard = guardFromLegacy({
            harnesses: { codex: { "zsh-glob-qualifier": "allow" } },
            longCommand: { lines: 12 },
        });

        expect(guard.harnesses.codex?.["zsh-glob-qualifier"]).toBe("allow");
        expect(guard.longCommand).toEqual({ lines: 12, chars: 2500 });
        expect(guard.contextCapPerSession).toBe(3);
        expect(guard.enabled).toBe(true);
    });

    it("an empty legacy file changes nothing", () => {
        expect(guardFromLegacy({})).toEqual(DEFAULT_HOOKS_CONFIG.guard);
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

    it("drops a guard number that is not a finite number", () => {
        const config = loadHooksConfig(
            stored({ guard: { contextCapPerSession: "5", longCommand: { lines: null, chars: 99 } } })
        );

        expect(config.guard.contextCapPerSession).toBe(DEFAULT_HOOKS_CONFIG.guard.contextCapPerSession);
        expect(config.guard.longCommand).toEqual({ lines: DEFAULT_HOOKS_CONFIG.guard.longCommand.lines, chars: 99 });
    });

    it("config import replaces only the guard and keeps every other setting", () => {
        const to = stored({ shadow: false, logCommands: "never", diff: { maxFiles: 7 } });
        const from = stored({ default: { "some-rule": "warn" } });
        const result = importGuardConfig({ from, to, write: true });
        const written = loadHooksConfig(to);

        expect(result.config.shadow).toBe(false);
        expect(written.shadow).toBe(false);
        expect(written.logCommands).toBe("never");
        expect(written.diff.maxFiles).toBe(7);
        expect(written.guard.default).toEqual({ "some-rule": "warn" });
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

        const from = stored({ default: {} });
        expect(() => importGuardConfig({ from, to: path, write: true })).toThrow("refusing to write");
        expect(readFileSync(path, "utf8")).toBe("{ not json");
    });

    it("a missing hooks.json is the normal first write and proceeds", () => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-cfg-first-")), "hooks.json");

        expect(setHooksConfig("shadow", "false", { write: true, path }).written).toBe(true);
        expect(loadHooksConfig(path).shadow).toBe(false);
    });

    it("config import keeps a guard the user turned off", () => {
        const to = stored({ guard: { enabled: false } });
        const from = stored({ default: { "some-rule": "warn" } });

        expect(importGuardConfig({ from, to, write: true }).config.guard.enabled).toBe(false);
        expect(loadHooksConfig(to).guard.enabled).toBe(false);
    });

    it("hand-edited values of the wrong type fall back to the shipped defaults", () => {
        const config = loadHooksConfig(
            stored({
                shadow: "false",
                logCommands: "sometimes",
                maxLogBytes: "big",
                diff: { maxFiles: "3", enabled: "no" },
            })
        );

        expect(config.shadow).toBe(DEFAULT_HOOKS_CONFIG.shadow);
        expect(config.logCommands).toBe(DEFAULT_HOOKS_CONFIG.logCommands);
        expect(config.maxLogBytes).toBe(DEFAULT_HOOKS_CONFIG.maxLogBytes);
        expect(config.diff.maxFiles).toBe(DEFAULT_HOOKS_CONFIG.diff.maxFiles);
        expect(config.diff.enabled).toBe(DEFAULT_HOOKS_CONFIG.diff.enabled);
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

describe("replay helpers the parity scripts share", () => {
    it("keeps replay files private and removes them, even when the work throws", () => {
        let seen = "";

        expect(() =>
            withPrivateTempDir("gt-replay-", (dir) => {
                seen = dir.path;
                const file = dir.write("input.json", "[]");

                expect(statSync(dir.path).mode & 0o777).toBe(0o700);
                expect(statSync(file).mode & 0o777).toBe(0o600);
                throw new Error("replay failed");
            })
        ).toThrow("replay failed");
        expect(existsSync(seen)).toBe(false);
    });

    it("importedHooksConfig carries a legacy override and keeps the shipped harness rules", () => {
        const config = importedHooksConfig({
            default: { "some-rule": "warn" },
            harnesses: { claude: { "x-rule": "allow" } },
        });

        expect(config.guard.default["some-rule"]).toBe("warn");
        expect(config.guard.harnesses.claude).toEqual({ "x-rule": "allow" });
        expect(config.guard.harnesses.codex).toEqual({ "zsh-glob-qualifier": "allow" });
    });
});

describe("writeJsonFile and config import edge cases", () => {
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

    it("config import treats a missing legacy file as the empty config it is documented to be", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-import-missing-"));
        const result = importGuardConfig({ from: join(dir, "nope.json"), to: join(dir, "hooks.json"), write: false });

        expect(result.config.guard.default).toEqual(DEFAULT_HOOKS_CONFIG.guard.default);

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

        expect(result.added).toEqual(["PreToolUse", "PostToolUse", "SessionEnd"]);
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
        expect(applySetting(DEFAULT_HOOKS_CONFIG, "maxLogBytes", "500").maxLogBytes).toBe(500);
        expect(() => applySetting(DEFAULT_HOOKS_CONFIG, "maxLogBytes", "lots")).toThrow("takes a whole number");
    });

    it("ships a cap rather than growing without bound", () => {
        expect(DEFAULT_HOOKS_CONFIG.maxLogBytes).toBeGreaterThan(0);
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

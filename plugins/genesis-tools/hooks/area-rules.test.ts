import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
    AREA_RULES_DEFAULTS,
    type AreaRulesLevels,
    agentTranscript,
    areaRulesSettings,
    canInject,
    compactedSince,
    contextFor,
    decide,
    frontmatterPaths,
    isBroadGlob,
    levelsFor,
    markCompaction,
    mergeAreaRules,
    pathTokens,
    readRules,
    scopeOf,
    shellSegments,
    tsconfigAliases,
    writeTargets,
} from "./area-rules.ts";

const root = mkdtempSync(join(tmpdir(), "area-rules-"));
mkdirSync(join(root, ".git"));
mkdirSync(join(root, ".claude", "rules"), { recursive: true });
mkdirSync(join(root, "src", "du", "lib"), { recursive: true });
mkdirSync(join(root, "src", "utils", "ai"), { recursive: true });
writeFileSync(join(root, ".claude", "rules", "code.md"), '---\npaths:\n  - "**/*.ts"\n---\n\n# Code\n');
writeFileSync(
    join(root, ".claude", "rules", "ai.md"),
    '---\npaths: ["src/utils/ai/**", "src/ask/**"]\n---\n\n# AI\n\nLoaded by Claude Code when you read, write or edit a file in the AI\nfolders. More text.\n'
);
writeFileSync(join(root, "src", "du", "CLAUDE.md"), "# du\n");
writeFileSync(join(root, "src", "du", "lib", "engine.ts"), "export {};\n");
writeFileSync(
    join(root, "tsconfig.json"),
    '{\n  // comments are allowed\n  "compilerOptions": { "paths": { "@lib/*": ["./src/utils/*"], "@lib": ["./src/utils/index.ts"] } },\n}\n'
);
const rules = readRules(root);

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("frontmatterPaths", () => {
    it("reads a block list, an inline list and a single value", () => {
        expect(frontmatterPaths('---\npaths:\n  - "src/**"\n  - docs/*.md\n---\nbody')).toEqual([
            "src/**",
            "docs/*.md",
        ]);
        expect(frontmatterPaths("---\npaths: [\"a/**\", 'b/**']\n---\n")).toEqual(["a/**", "b/**"]);
        expect(frontmatterPaths("---\npaths: src/**\n---\n")).toEqual(["src/**"]);
        expect(frontmatterPaths("# no frontmatter")).toEqual([]);
    });
});

describe("isBroadGlob", () => {
    it("treats a file type across a tree as broad and a folder as an area", () => {
        expect(isBroadGlob("**/*.ts")).toBe(true);
        expect(isBroadGlob("src/**/*.ts")).toBe(true);
        expect(isBroadGlob("src/utils/ai/**")).toBe(false);
        expect(isBroadGlob("**/*.test.ts")).toBe(false);
    });
});

describe("pathTokens", () => {
    it("keeps paths from commands and output, drops line suffixes and URLs", () => {
        expect(pathTokens("rg -n x src/du --heading\nsrc/du/lib/engine.ts:12:x https://example.com/a/b")).toEqual([
            "src/du",
            "src/du/lib/engine.ts",
        ]);
    });
});

describe("decide", () => {
    it("a search adds nothing, whatever its output names", () => {
        const decision = decide({
            payload: {
                cwd: root,
                tool_name: "Bash",
                tool_input: { command: "rg -n x src/du src/utils/ai" },
                tool_response: { stdout: "src/du/lib/engine.ts:1:x" },
            },
            root,
            rules,
            seen: [],
        });
        expect(decision).toEqual({ full: [], pointer: [], native: [] });
    });

    it("records what Claude Code loads by itself on Read, so a later write does not add it again", () => {
        const read = decide({
            payload: { cwd: root, tool_name: "Read", tool_input: { file_path: join(root, "src/du/lib/engine.ts") } },
            root,
            rules,
            seen: [],
        });
        expect(read.full).toEqual([]);
        expect(read.native.sort()).toEqual([".claude/rules/code.md", "src/du/CLAUDE.md"]);

        const write = decide({
            payload: { cwd: root, tool_name: "Bash", tool_input: { command: "touch src/du/x.ts" }, tool_response: "" },
            root,
            rules,
            seen: read.native,
        });
        expect(write).toEqual({ full: [], pointer: [], native: [] });
    });

    it("a write that prints its files (patch, git apply, fable-replace) adds the areas its output names", () => {
        const decision = decide({
            payload: {
                cwd: join(root, "src", "du"),
                tool_name: "Bash",
                tool_input: { command: "patch -p1 < fix.patch" },
                tool_response: { stdout: "patching file @lib/ai/providers/bind.ts" },
            },
            root,
            rules,
            seen: [],
            aliases: tsconfigAliases(root),
        });
        expect(decision.full).toContain(".claude/rules/ai.md");
    });

    it("adds nothing for paths outside the project or without an area", () => {
        const decision = decide({
            payload: {
                cwd: root,
                tool_name: "Bash",
                tool_input: { command: "cat /etc/hosts docs/notes.md" },
                tool_response: "",
            },
            root,
            rules,
            seen: [],
        });
        expect(decision).toEqual({ full: [], pointer: [], native: [] });
    });
});

const row = (fields: Record<string, unknown>) => `${JSON.stringify(fields)}\n`;

describe("compaction", () => {
    const transcripts = join(root, "transcripts");
    mkdirSync(join(transcripts, "s1", "subagents"), { recursive: true });
    const at = Date.parse("2026-10-13T18:12:20.000Z");
    const stamp = (offsetMs: number) => new Date(at + offsetMs).toISOString();

    it("maps a subagent to its own transcript and another harness to none", () => {
        const main = join(transcripts, "s1.jsonl");
        expect(agentTranscript({ transcript_path: main })).toBe(main);
        expect(agentTranscript({ transcript_path: main, agent_id: "a1" })).toBe(
            join(transcripts, "s1", "subagents", "agent-a1.jsonl")
        );
        expect(agentTranscript({ transcript_path: "/x/.codex/sessions/rollout-1.jsonl" })).toBeUndefined();
    });

    it("finds the agent's own boundary, and keeps state only when the transcript proves there was none", () => {
        const compacted = join(transcripts, "compacted.jsonl");
        writeFileSync(
            compacted,
            row({ type: "user", timestamp: stamp(-600_000) }) +
                row({ type: "system", subtype: "compact_boundary", timestamp: stamp(80) }) +
                row({ type: "user", timestamp: stamp(5_000) })
        );
        const other = join(transcripts, "other.jsonl");
        writeFileSync(
            other,
            row({ type: "user", timestamp: stamp(-600_000) }) + row({ type: "user", timestamp: stamp(5_000) })
        );
        const older = join(transcripts, "older.jsonl");
        writeFileSync(older, row({ type: "system", subtype: "compact_boundary", timestamp: stamp(-3_600_000) }));

        expect(compactedSince(compacted, at)).toBe(true);
        expect(compactedSince(other, at)).toBe(false);
        expect(compactedSince(older, at)).toBe(false);
        expect(compactedSince(join(transcripts, "missing.jsonl"), at)).toBe(true);
        expect(compactedSince(undefined, at)).toBe(true);
    });

    it("checks how far a truncated transcript tail reaches, including missing timestamps and newlines", () => {
        const transcript = join(transcripts, "truncated.jsonl");
        const filler = (offset: number) =>
            row({ type: "user", timestamp: stamp(offset), text: "x".repeat(1_000) }).repeat(4_100);
        for (const [contents, expected] of [
            [filler(-60_000), false],
            [filler(60_000), true],
            ["x".repeat(4_100_000), true],
            ["{}\n".repeat(1_400_000), true],
        ] as const) {
            writeFileSync(transcript, contents);
            expect(compactedSince(transcript, at)).toBe(expected);
        }
    });

    it("marks every agent once and keeps the earliest compaction", () => {
        const once = markCompaction({ main: ["a.md"], a1: ["b.md"] }, 1);
        expect(markCompaction(once, 2)).toEqual({
            main: ["a.md"],
            a1: ["b.md"],
            "@compact:main": ["1"],
            "@compact:a1": ["1"],
        });
    });

    it("a compaction re-adds the areas of the agent that compacted, and only of it (real hook processes)", async () => {
        const mainSearch = {
            hook_event_name: "PostToolUse",
            tool_name: "Bash",
            tool_input: { command: "touch src/du/x.md" },
        };
        const subSearch = { ...mainSearch, agent_id: "a1", tool_input: { command: "touch src/utils/ai/x.md" } };

        for (const compacting of ["subagent", "main"]) {
            const session = `s-${compacting}`;
            const main = join(transcripts, `${session}.jsonl`);
            const sub = join(transcripts, session, "subagents", "agent-a1.jsonl");
            mkdirSync(join(transcripts, session, "subagents"), { recursive: true });
            for (const file of [main, sub]) {
                writeFileSync(file, row({ type: "user", timestamp: new Date(Date.now() - 600_000).toISOString() }));
            }

            const run = async (payload: Record<string, unknown>) => {
                const child = Bun.spawn(["bun", join(import.meta.dir, "area-rules.ts")], {
                    stdin: new TextEncoder().encode(
                        JSON.stringify({ session_id: session, transcript_path: main, cwd: root, ...payload })
                    ),
                    stdout: "pipe",
                    env: { ...process.env, GENESIS_TOOLS_HOME: join(root, "home") },
                });
                const out = await new Response(child.stdout).text();
                await child.exited;
                return [...out.matchAll(/Contents of \S+?([^/\s]+\/CLAUDE\.md|[^/\s]+\.md) \(area rules\)/g)].map(
                    (m) => m[1]
                );
            };

            expect(await run(mainSearch)).toEqual(["du/CLAUDE.md"]);
            expect(await run(subSearch)).toEqual(["ai.md"]);
            await run({ hook_event_name: "SessionStart", source: "compact" });
            const boundary = row({ type: "system", subtype: "compact_boundary", timestamp: new Date().toISOString() });
            writeFileSync(compacting === "main" ? main : sub, boundary, { flag: "a" });

            expect(await run(mainSearch)).toEqual(compacting === "main" ? ["du/CLAUDE.md"] : []);
            expect(await run(subSearch)).toEqual(compacting === "main" ? [] : ["ai.md"]);
        }
    });
});

describe("writeTargets", () => {
    const writes: Array<[string, string[], boolean?]> = [
        ["echo x > src/a.ts", ["src/a.ts"]],
        ["echo x >> src/a.ts", ["src/a.ts"]],
        ["bun gen.ts &> logs/out.txt", ["logs/out.txt"]],
        ["cat > src/new.ts <<'EOF'\nmkdir not/a/command\nEOF\nls", ["src/new.ts"]],
        ["printf x | tee -a src/a.ts src/b.ts", ["src/a.ts", "src/b.ts"]],
        ["sed -i '' 's/a/b/' src/a.ts", ["src/a.ts"]],
        ["sed -i.bak -e 's/a/b/' -e 's/c/d/' src/a.ts src/b.ts", ["src/a.ts", "src/b.ts"]],
        ["perl -pi -e 's/a/b/' src/a.ts", ["src/a.ts"]],
        ["mv -f old.ts src/du/", ["src/du/"]],
        ["cp -t src/du a.ts b.ts", ["src/du"]],
        ["ln -s ../x src/du/link", ["src/du/link"]],
        ["git apply fix.patch", ["fix.patch"], true],
        ["git am 0001.patch", ["0001.patch"], true],
        ["patch -p1 < fix.patch", [], true],
        ["git checkout HEAD -- src/a.ts", ["src/a.ts"]],
        ["git -C src restore --source HEAD a.ts", ["src/a.ts"]],
        ["git mv src/a.ts src/du/a.ts", ["src/du/a.ts"]],
        ["bunx biome check --write src/a.ts", ["src/a.ts"]],
        ["prettier --write src/a.ts", ["src/a.ts"]],
        ["bun \"$ROOT/skills/fable-replace/scripts/cli.ts\" <<'FR'\nfile: src/du/x.ts\nFR", ["src/du/x.ts"], true],
        [
            "cd x && bun plugins/p/skills/fable-replace/scripts/cli.ts <<'FR'\nfile: src/du/x.ts\nFR",
            ["src/du/x.ts"],
            true,
        ],
        ["FOO=1 touch src/a.ts && mkdir -p src/du/new", ["src/a.ts", "src/du/new"]],
        ["echo x > ~/notes.txt", [join(homedir(), "notes.txt")]],
        [`python3 -c 'open("src/a.ts", "w").write("x")'`, ["src/a.ts"]],
        [`bun -e 'await Bun.write("src/du/a.ts", "x")'`, ["src/du/a.ts"]],
        ["python3 - <<'PY'\nopen('src/du/a.ts', 'w')\nPY", ["src/du/a.ts"]],
        ["cat > \"$S/x.ts\" <<'EOF'\nwriteFileSync('src/du/a.ts', s)\nEOF\nbun \"$S/x.ts\"", ["src/du/a.ts"]],
        // Only a whole-path literal in the code: not a path inside a message, not the next command's operands.
        [
            'cat > "$S/w.ts" <<\'EOF\'\nwriteFileSync("src/du/a.ts", "see src/x/README.md")\nEOF\nbun "$S/w.ts" && bun scripts/ci/x.ts',
            ["src/du/a.ts"],
        ],
    ];
    const reads = [
        "ls src/du",
        "rg -n x src > /dev/null",
        'echo "a > b" src/du',
        "bun test src 2>&1 | tail -5",
        "cmd >&2",
        "git checkout main",
        "git apply --check fix.patch",
        "git diff src/a.ts && git log -3",
        "sed -n '1,5p' src/a.ts",
        "perl -Mstrict -e 'print 1' src/a.ts",
        "bun scripts/test.ts src/du",
        "python3 scripts/x.py src/du",
        `python3 -c 'print(open("src/a.ts").read())'`,
        "cat > \"$S/p.ts\" <<'EOF'\nconsole.log(readFileSync('src/du/a.ts'))\nEOF\nbun \"$S/p.ts\"",
        "bunx biome check src/a.ts",
        "wc -l < src/a.ts",
        "cat src/a.ts # > not/a/write",
        'echo x > "$S/out.txt" && cp a.ts `pwd`/b.ts',
    ];

    it("finds the path each write shape writes", () => {
        for (const [command, paths, output = false] of writes) {
            expect({ command, ...writeTargets(command) }).toEqual({ command, paths, output });
        }
    });

    it("finds nothing in a read, a quoted `>`, `2>&1`, `>&2` or a comment; `/dev/null` is outside every project", () => {
        for (const command of reads) {
            const { paths } = writeTargets(command);
            expect({ command, paths: paths.filter((path) => path !== "/dev/null") }).toEqual({ command, paths: [] });
        }
    });

    it("splits at the shell operators and skips a here-document body", () => {
        expect(shellSegments("a 1; b && c || d | e\nf <<X\ng ; h\nX\ni").map((segment) => segment.length)).toEqual([
            2, 1, 1, 1, 1, 1, 1,
        ]);
    });
});

const LEVELS: AreaRulesLevels = { write: "full", agents: "same" };
const bash = (command: string, extra: Record<string, unknown> = {}) => ({
    cwd: root,
    tool_name: "Bash",
    tool_input: { command },
    tool_response: "",
    ...extra,
});

describe("levels", () => {
    const run = (input: {
        command: string;
        levels?: AreaRulesLevels;
        agent?: string;
        seen?: string[];
        pointed?: string[];
    }) =>
        decide({
            payload: bash(input.command, input.agent ? { agent_id: input.agent } : {}),
            root,
            rules,
            seen: input.seen ?? [],
            pointed: input.pointed ?? [],
            levels: input.levels ?? LEVELS,
        });

    it("a read gets nothing, a write into the area gets the text, and code.md only with the write", () => {
        expect(run({ command: "ls src/utils/ai" })).toEqual({ full: [], pointer: [], native: [] });
        expect(run({ command: "echo x > src/utils/ai/a.ts" }).full.sort()).toEqual([
            ".claude/rules/ai.md",
            ".claude/rules/code.md",
        ]);
        const copy = run({ command: "cp src/du/lib/engine.ts src/utils/ai/engine.ts" });
        expect(copy.full.sort()).toEqual([".claude/rules/ai.md", ".claude/rules/code.md"]);
        expect(copy.pointer).toEqual([]);
    });

    it("a pointer is given once, a later write upgrades it once, and the text is never repeated", () => {
        const pointerOnly = { ...LEVELS, write: "pointer" as const };
        const first = run({ command: "touch src/utils/ai/x.md", levels: pointerOnly });
        expect(first.pointer).toEqual([".claude/rules/ai.md"]);
        expect(
            run({ command: "touch src/utils/ai/y.md", levels: pointerOnly, pointed: first.pointer }).pointer
        ).toEqual([]);
        const upgrade = run({ command: "sed -i 's/a/b/' src/utils/ai/x.md", pointed: first.pointer });
        expect(upgrade.full).toEqual([".claude/rules/ai.md"]);
        const seen = upgrade.full;
        expect(run({ command: "sed -i 's/a/b/' src/utils/ai/x.md", seen, pointed: first.pointer }).full).toEqual([]);
    });

    it("honours each value of write and agents", () => {
        const write = "touch src/utils/ai/x.md";
        const ai = [".claude/rules/ai.md"];
        expect(run({ command: write, levels: { ...LEVELS, write: "pointer" } }).pointer).toEqual(ai);
        expect(run({ command: write, levels: { ...LEVELS, write: "off" } })).toEqual({
            full: [],
            pointer: [],
            native: [],
        });
        expect(run({ command: write, agent: "a1" }).full).toEqual(ai);
        expect(run({ command: write, agent: "a1", levels: { ...LEVELS, agents: "pointer" } }).pointer).toEqual(ai);
        expect(run({ command: write, agent: "a1", levels: { ...LEVELS, agents: "off" } })).toEqual({
            full: [],
            pointer: [],
            native: [],
        });
        expect(canInject({ ...LEVELS, agents: "off" }, true)).toBe(false);
        expect(canInject({ ...LEVELS, agents: "off" }, false)).toBe(true);
        expect(canInject({ ...LEVELS, write: "off" }, false)).toBe(false);
    });

    it("Grep and Glob get nothing", () => {
        for (const tool_name of ["Grep", "Glob"]) {
            const decision = decide({
                payload: { cwd: root, tool_name, tool_input: { pattern: "x", path: "src/utils/ai" } },
                root,
                rules,
                seen: [],
                levels: LEVELS,
            });
            expect(decision).toEqual({ full: [], pointer: [], native: [] });
        }
    });

    it("a write through every harness's shell tool name gets the text", () => {
        for (const tool_name of ["Bash", "shell", "run_terminal_command"]) {
            const decision = decide({
                payload: { ...bash("touch src/utils/ai/x.md"), tool_name },
                root,
                rules,
                seen: [],
                levels: LEVELS,
            });
            expect({ tool_name, full: decision.full }).toEqual({ tool_name, full: [".claude/rules/ai.md"] });
        }
    });
});

describe("the injection text", () => {
    it("keeps the first line, adds the instruction and one parseable pointer line per file", () => {
        const text = contextFor(root, { full: ["src/du/CLAUDE.md"], pointer: [".claude/rules/ai.md"] }, "Bash");
        const lines = text.split("\n");
        expect(lines[0]).toContain("rules were not in your context");
        expect(lines[1]).toBe("Read the named file before you change code in that area or state one of its rules.");
        expect(lines[2]).toBe(
            `Area rules (pointer): ${join(root, ".claude/rules/ai.md")} (8 lines): Loaded by Claude Code when you read, write or edit a file in the AI folders.`
        );
        expect(text).toContain(`Contents of ${join(root, "src/du/CLAUDE.md")} (area rules):\n\n# du`);
        expect(contextFor(root, { full: ["src/du/CLAUDE.md"], pointer: [] }, "Bash")).not.toContain("(pointer)");
    });

    it("names the paths globs, or the folder, when the file has no scope sentence", () => {
        expect(scopeOf('---\npaths: ["src/x/**"]\n---\n# X\n', ".claude/rules/x.md")).toBe("paths: src/x/**");
        expect(scopeOf("# du\n", "src/du/CLAUDE.md")).toBe("files under src/du/");
    });
});

describe("settings", () => {
    const dir = join(root, "settings");
    mkdirSync(dir, { recursive: true });

    it("ships the text on a write for every harness, Claude included", () => {
        expect(levelsFor(AREA_RULES_DEFAULTS, "claude")).toEqual(LEVELS);
        expect(levelsFor(AREA_RULES_DEFAULTS, "codex")).toEqual(LEVELS);
        expect(levelsFor(AREA_RULES_DEFAULTS, "grok")).toEqual(LEVELS);
    });

    it("keeps the defaults for a missing, a broken or a wrongly typed file", () => {
        expect(areaRulesSettings(join(dir, "missing.json"))).toEqual(AREA_RULES_DEFAULTS);
        writeFileSync(join(dir, "broken.json"), "{ areaRules: ");
        expect(areaRulesSettings(join(dir, "broken.json"))).toEqual(AREA_RULES_DEFAULTS);
        expect(mergeAreaRules({ areaRules: { read: "full", write: "loud", harnesses: { claude: "on" } } })).toEqual(
            AREA_RULES_DEFAULTS
        );
    });

    it("reads a hand-written file with comments, and a value equal to the stored shipped copy is no choice", () => {
        writeFileSync(
            join(dir, "hooks.json"),
            '{\n  // hand edit\n  "areaRules": { "agents": "off", "harnesses": { "claude": { "write": "pointer" } } },\n}\n'
        );
        const settings = areaRulesSettings(join(dir, "hooks.json"));
        expect(levelsFor(settings, "claude")).toEqual({ write: "pointer", agents: "off" });
        expect(
            mergeAreaRules({
                areaRules: { write: "pointer", harnesses: { claude: { write: "full", agents: "off" } } },
                _shippedDefaults: { areaRules: { write: "full", harnesses: { claude: { write: "full" } } } },
            })
        ).toEqual({
            ...AREA_RULES_DEFAULTS,
            write: "pointer",
            harnesses: { ...AREA_RULES_DEFAULTS.harnesses, claude: { agents: "off" } },
        });
    });

    it("the hook process: a search adds nothing, a write adds the text in Claude and Codex, a broken file keeps the defaults", async () => {
        const home = join(root, "home-defaults");
        const run = async (payload: Record<string, unknown>) => {
            const child = Bun.spawn(["bun", join(import.meta.dir, "area-rules.ts")], {
                stdin: new TextEncoder().encode(
                    JSON.stringify({ cwd: root, hook_event_name: "PostToolUse", ...payload })
                ),
                stdout: "pipe",
                env: { ...process.env, GENESIS_TOOLS_HOME: home },
            });
            const out = await new Response(child.stdout).text();
            expect(await child.exited).toBe(0);
            return out;
        };
        const call = { tool_name: "Bash", tool_input: { command: "rg x src/utils/ai" } };
        const codex = { ...call, transcript_path: join(root, ".codex", "sessions", "rollout-1.jsonl") };

        const write = { command: "touch src/utils/ai/y.md" };
        const ai = `Contents of ${join(root, ".claude/rules/ai.md")} (area rules)`;
        expect(await run({ ...call, session_id: "c1", transcript_path: join(root, "c1.jsonl") })).toBe("");
        expect(
            await run({ ...call, session_id: "c1", transcript_path: join(root, "c1.jsonl"), tool_input: write })
        ).toContain(ai);
        mkdirSync(join(home, ".genesis-tools", "agents"), { recursive: true });
        writeFileSync(join(home, ".genesis-tools", "agents", "hooks.json"), "not json");
        expect(await run({ ...call, session_id: "c2", transcript_path: join(root, "c2.jsonl") })).toBe("");
        expect(await run({ ...codex, session_id: "x1" })).toBe("");
        expect(await run({ ...codex, session_id: "x1", tool_input: write })).toContain(ai);
        expect(await run({ ...codex, session_id: "x1", tool_input: write })).toBe("");
    });
});

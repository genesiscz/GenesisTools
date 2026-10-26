import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    agentTranscript,
    compactedSince,
    decide,
    frontmatterPaths,
    isBroadGlob,
    markCompaction,
    pathTokens,
    readRules,
    tsconfigAliases,
} from "./area-rules.ts";

const root = mkdtempSync(join(tmpdir(), "area-rules-"));
mkdirSync(join(root, ".git"));
mkdirSync(join(root, ".claude", "rules"), { recursive: true });
mkdirSync(join(root, "src", "du", "lib"), { recursive: true });
mkdirSync(join(root, "src", "utils", "ai"), { recursive: true });
writeFileSync(join(root, ".claude", "rules", "code.md"), '---\npaths:\n  - "**/*.ts"\n---\n\n# Code\n');
writeFileSync(join(root, ".claude", "rules", "ai.md"), '---\npaths: ["src/utils/ai/**", "src/ask/**"]\n---\n\n# AI\n');
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
    it("adds a folder's CLAUDE.md and its area rule after a search, but not the broad code rule", () => {
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
        expect(decision.add.sort()).toEqual([".claude/rules/ai.md", "src/du/CLAUDE.md"]);
    });

    it("records what Claude Code loads by itself on Read, so a later search does not add it again", () => {
        const read = decide({
            payload: { cwd: root, tool_name: "Read", tool_input: { file_path: join(root, "src/du/lib/engine.ts") } },
            root,
            rules,
            seen: [],
        });
        expect(read.add).toEqual([]);
        expect(read.native.sort()).toEqual([".claude/rules/code.md", "src/du/CLAUDE.md"]);

        const search = decide({
            payload: { cwd: root, tool_name: "Bash", tool_input: { command: "rg x src/du" }, tool_response: "" },
            root,
            rules,
            seen: read.native,
        });
        expect(search.add).toEqual([]);
    });

    it("finds the area behind a tsconfig import name in search output", () => {
        const decision = decide({
            payload: {
                cwd: root,
                tool_name: "Bash",
                tool_input: { command: "rg -n resolve src/indexer" },
                tool_response: { stdout: 'src/indexer/store.ts:3:import { bind } from "@lib/ai/providers/bind";' },
            },
            root,
            rules,
            seen: [],
            aliases: tsconfigAliases(root),
        });
        expect(decision.add).toEqual([".claude/rules/ai.md"]);
    });

    it("resolves an import name from the project root when the session runs in a subfolder", () => {
        const decision = decide({
            payload: {
                cwd: join(root, "src", "du"),
                tool_name: "Bash",
                tool_input: { command: "rg -n bind ." },
                tool_response: { stdout: 'store.ts:3:import { bind } from "@lib/ai/providers/bind";' },
            },
            root,
            rules,
            seen: [],
            aliases: tsconfigAliases(root),
        });
        expect(decision.add).toEqual([".claude/rules/ai.md"]);
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
        expect(decision).toEqual({ add: [], native: [] });
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
            tool_input: { command: "rg x src/du" },
        };
        const subSearch = { ...mainSearch, agent_id: "a1", tool_input: { command: "rg x src/utils/ai" } };

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

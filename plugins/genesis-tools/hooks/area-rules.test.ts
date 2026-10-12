import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, frontmatterPaths, isBroadGlob, pathTokens, readRules } from "./area-rules.ts";

const root = mkdtempSync(join(tmpdir(), "area-rules-"));
mkdirSync(join(root, ".git"));
mkdirSync(join(root, ".claude", "rules"), { recursive: true });
mkdirSync(join(root, "src", "du", "lib"), { recursive: true });
mkdirSync(join(root, "src", "utils", "ai"), { recursive: true });
writeFileSync(join(root, ".claude", "rules", "code.md"), '---\npaths:\n  - "**/*.ts"\n---\n\n# Code\n');
writeFileSync(join(root, ".claude", "rules", "ai.md"), '---\npaths: ["src/utils/ai/**", "src/ask/**"]\n---\n\n# AI\n');
writeFileSync(join(root, "src", "du", "CLAUDE.md"), "# du\n");
writeFileSync(join(root, "src", "du", "lib", "engine.ts"), "export {};\n");
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

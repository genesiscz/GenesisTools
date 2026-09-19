import { describe, expect, test } from "bun:test";
import { blockEndLine, docCommentStart, locateBlock } from "./move-blocks";

const TRICKY = `import { a } from "b";

/**
 * Doc above the thing, with a brace { in the prose.
 */
export function tricky(input: string): string {
    // a comment with an unbalanced } brace
    const literal = "a { b";
    const other = 'c } d';
    const tpl = \`e { f\`;
    /* block comment with { and } */
    if (input.length > 0) {
        return literal + other + tpl;
    }

    return "";
}

export const after = 1;
`;

describe("locating a block to move", () => {
    test("braces inside strings, templates and comments never end the block early", () => {
        const lines = TRICKY.split("\n");
        const declared = lines.findIndex((line) => line.includes("export function tricky"));
        const end = blockEndLine(lines, declared);
        expect(lines[end].trim()).toBe("}");
        expect(lines[end + 1].trim()).toBe("");
        expect(lines[end + 2]).toContain("export const after");
    });

    test("a symbol move takes the doc comment above it and nothing after it", () => {
        const block = locateBlock(TRICKY, { from: "a.ts", to: "b.ts", symbol: "tricky" });
        expect(block.text.startsWith("/**")).toBe(true);
        expect(block.text).toContain("Doc above the thing");
        expect(block.text.trimEnd().endsWith("}")).toBe(true);
        expect(block.text).not.toContain("export const after");
        expect(block.text).toContain('const literal = "a { b";');
    });

    test("a one-line declaration with no braces ends on its own line", () => {
        const source = ["type Id = string;", "const next = 2;"].join("\n");
        const block = locateBlock(source, { from: "a.ts", to: "b.ts", symbol: "Id" });
        expect(block.text).toBe("type Id = string;");
    });

    test("an ambiguous or missing symbol is refused, never guessed", () => {
        expect(() => locateBlock(TRICKY, { from: "a.ts", to: "b.ts", symbol: "nope" })).toThrow(/no declaration/);

        const twice = ["function dup() {}", "function dup() {}"].join("\n");
        expect(() => locateBlock(twice, { from: "a.ts", to: "b.ts", symbol: "dup" })).toThrow(/more than once/);
    });

    test("lines and between address a block that is not one declaration", () => {
        const byLines = locateBlock(TRICKY, { from: "a.ts", to: "b.ts", lines: [1, 1] });
        expect(byLines.text).toBe('import { a } from "b";');

        const byMarkers = locateBlock(TRICKY, {
            from: "a.ts",
            to: "b.ts",
            between: { start: "export function tricky", end: 'return "";' },
        });
        expect(byMarkers.text.startsWith("export function tricky")).toBe(true);
        expect(byMarkers.text.trimEnd().endsWith('return "";')).toBe(true);
    });

    test("out-of-range lines are refused rather than clamped", () => {
        expect(() => locateBlock(TRICKY, { from: "a.ts", to: "b.ts", lines: [1, 9999] })).toThrow(/outside/);
    });

    test("a block with no comment above it starts at its own declaration", () => {
        const source = ["const x = 1;", "", "function plain() {", "    return 1;", "}"].join("\n");
        const lines = source.split("\n");
        expect(docCommentStart(lines, 2)).toBe(2);
    });

    test("Swift declarations locate the same way", () => {
        const swift = [
            "import Foundation",
            "",
            "/// Doc above",
            "func cmdActivate() {",
            '    let name = "a { b"',
            "    if name.isEmpty { return }",
            "}",
            "",
            "let after = 1",
        ].join("\n");
        const block = locateBlock(swift, { from: "a.swift", to: "b.swift", symbol: "cmdActivate" });
        expect(block.text).toContain("/// Doc above");
        expect(block.text.trimEnd().endsWith("}")).toBe(true);
        expect(block.text).not.toContain("let after");
    });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FableReplaceError } from "./internal";
import { blockEndLine, docCommentStart, expandMoves, locateBlock } from "./move-blocks";
import { parseSpec } from "./spec";
import { run } from "./sweep-many-files";

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

    test("a brace inside a regular-expression literal never ends the block early", () => {
        // Without regex-literal tracking the `}` in `/}/` decrements the depth and the block
        // closes on that line, so the move cuts a span that stops mid-declaration.
        const source = [
            "export function withRegex(input: string): string {",
            "    const pattern = /}/;",
            "    const klass = /[/}]/g;",
            "    return input.replace(pattern, klass.source);",
            "}",
            "",
            "export const after = 1;",
        ];

        expect(blockEndLine(source, 0)).toBe(4);
    });

    test("a JSX closing or self-closing slash is not read as a regular expression", () => {
        const source = [
            "export function Row(x: string, y: boolean) {",
            "    return <b>{x}</b>{y ? <i/> : null};",
            "}",
            "",
            "export function Cell(x: string) {",
            "    return <Input value={x} />;",
            "}",
        ];

        expect(blockEndLine(source, 0)).toBe(2);
        expect(blockEndLine(source, 4)).toBe(6);
    });

    test("a regular expression that starts with > is still skipped", () => {
        const source = ["export function escape(s: string): string {", '    return s.replace(/>}/g, "&gt;");', "}"];

        expect(blockEndLine(source, 0)).toBe(2);
    });

    test("a slash that divides is not read as a regular expression", () => {
        const source = ["export function ratio(a: number, b: number): number {", "    return a / b;", "}"];

        expect(blockEndLine(source, 0)).toBe(2);
    });

    test("a regex right after a keyword is still a regex, so its brace does not end the block", () => {
        const source = ["export function closer(): RegExp {", "    return /}/;", "}", "export const after = 1;"];

        expect(blockEndLine(source, 0)).toBe(2);
    });

    test("a blank line directly above a declaration means no doc comment is attached", () => {
        const source = ["/** not this one */", "", "export const x = 1;"];

        expect(docCommentStart(source, 2)).toBe(2);
    });

    test("a symbol move takes the doc comment above it and nothing after it", () => {
        const block = locateBlock(TRICKY, { from: "a.ts", to: "b.ts", symbol: "tricky" });
        expect(block.text.startsWith("/**")).toBe(true);
        expect(block.text).toContain("Doc above the thing");
        expect(block.text.trimEnd().endsWith("}")).toBe(true);
        expect(block.text).not.toContain("export const after");
        expect(block.text).toContain('const literal = "a { b";');
    });

    test("a brace inside a regex literal never ends the block early, and a division is still a division", () => {
        const source = [
            "function withRegex(s: string): number {",
            "    const re = /}/;",
            "    const half = s.length / 2 / 1;",
            "    return re.test(s) ? half : 0;",
            "}",
            "const after = 1;",
        ].join("\n");
        expect(blockEndLine(source.split("\n"), 0)).toBe(4);
    });

    test("a brace inside the parameter list never ends the block on the declaration line", () => {
        for (const signature of [
            "export function Card({ title }: Props) {",
            "function withDefault(opts = {}) {",
            "function typed(x: { a: number }): void {",
        ]) {
            const source = [signature, "    return 1;", "}", "const after = 1;"].join("\n");
            expect(blockEndLine(source.split("\n"), 0)).toBe(2);
        }
    });

    test("a call wrapping a callback ends on the line that closes it", () => {
        const source = ["export const handler = wrap(() => {", "    run();", "});", "const after = 1;"].join("\n");
        expect(blockEndLine(source.split("\n"), 0)).toBe(2);
    });

    test("stacked modifiers still name a declaration", () => {
        for (const [line, symbol] of [
            ["export abstract class Base {}", "Base"],
            ["export declare const flag: boolean;", "flag"],
            ["public final class Store {}", "Store"],
        ]) {
            expect(locateBlock(line, { from: "a.ts", to: "b.ts", symbol }).text).toBe(line);
        }
    });

    test("JSX closing tags and self-closing elements are not regex literals", () => {
        const tsx = [
            "export function List() {",
            "    return <ul>{xs.map((x) => <li>{x}</li>)}</ul>;",
            "}",
            "export function Row() {",
            "    return <Cell onClick={f} /><Cell />;",
            "}",
            "const after = 1;",
        ].join("\n");

        expect(blockEndLine(tsx.split("\n"), 0)).toBe(2);
        expect(blockEndLine(tsx.split("\n"), 3)).toBe(5);
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

    test("a } inside a Swift multiline string never ends the block early", () => {
        const swift = [
            "func banner() -> String {",
            '    let text = """',
            "    closing brace } in the text",
            "    and another }",
            '    """',
            "    return text",
            "}",
            "",
            "let after = 1",
        ].join("\n");
        const block = locateBlock(swift, { from: "a.swift", to: "b.swift", symbol: "banner" });

        expect(block.text.trimEnd().endsWith("}")).toBe(true);
        expect(block.text).toContain("return text");
        expect(block.text).not.toContain("let after");
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

describe("the spec language's move marker", () => {
    /** Only some ops carry `text`; a move's paste is one of them. Narrow rather than cast. */
    const pastedText = (op: unknown): string =>
        typeof op === "object" && op !== null && "text" in op && typeof op.text === "string" ? op.text : "";

    const fixture = (): string => {
        const dir = mkdtempSync(join(tmpdir(), "fr-move-"));
        writeFileSync(
            join(dir, "from.ts"),
            [
                "export const keep = 1;",
                "",
                "/** Doc. */",
                "export function moved(): string {",
                '    return "a { b";',
                "}",
                "",
            ].join("\n")
        );
        writeFileSync(join(dir, "to.ts"), "export const existing = 0;\n");
        return dir;
    };

    test("one marker produces the cut and the paste, and the body is never written", () => {
        const dir = fixture();
        const edits = parseSpec({ text: "@@ from.ts\n<<< move to=to.ts symbol=moved\n>>>\n", cwd: dir });

        expect(edits.map((edit) => edit.file).sort()).toEqual(["from.ts", "to.ts"]);
        const cut = edits.find((edit) => edit.file === "from.ts");
        const paste = edits.find((edit) => edit.file === "to.ts");
        expect(cut?.ops?.[0]).toMatchObject({ replace: "" });
        expect(pastedText(paste?.ops?.[0])).toContain("export function moved()");
        expect(pastedText(paste?.ops?.[0])).toContain("/** Doc. */");
    });

    test("a move and an ordinary edit on the same target arrive as ONE file edit", () => {
        const dir = fixture();
        const edits = parseSpec({
            text: [
                "@@ from.ts",
                "<<< move to=to.ts symbol=moved",
                ">>>",
                "@@ to.ts",
                "<<<",
                "export const existing = 0;",
                "===",
                "export const existing = 1;",
                ">>>",
                "",
            ].join("\n"),
            cwd: dir,
        });

        const target = edits.filter((edit) => edit.file === "to.ts");
        expect(target).toHaveLength(1);
        expect(target[0].ops).toHaveLength(2);
    });

    test("the marker refuses rather than guesses, naming the spec line", () => {
        const dir = fixture();
        const bad =
            (spec: string): (() => unknown) =>
            () =>
                parseSpec({ text: spec, cwd: dir });

        expect(bad("@@ from.ts\n<<< move symbol=moved\n>>>\n")).toThrow(/needs to=/);
        expect(bad("@@ from.ts\n<<< move to=to.ts\n>>>\n")).toThrow(/exactly one of symbol=/);
        expect(bad("@@ from.ts\n<<< move to=to.ts symbol=moved lines=1-2\n>>>\n")).toThrow(/exactly one of symbol=/);
        expect(bad("@@ from.ts\n<<< move to=to.ts symbol=nope\n>>>\n")).toThrow(/no declaration of nope/);
        expect(bad("@@ from.ts\n<<< move to=to.ts lines=oops\n>>>\n")).toThrow(/lines= must be/);
        expect(bad("@@ from.ts\n<<< symbol=moved\n===\nx\n>>>\n")).toThrow(/only applies to move/);
        expect(bad("@@ from.ts\n<<< move to=to.ts symbol=moved at=start\nx\n>>>\n")).toThrow(
            /at= must be before or after/
        );
        expect(bad("@@ from.ts\n<<< move to=to.ts symbol=moved at=after\n>>>\n")).toThrow(/needs the anchor text/);
        expect(bad("@@ from.ts\n<<< move to=to.ts symbol=moved\nexport const existing\n>>>\n")).toThrow(
            /only read as the anchor/
        );
        expect(bad("@@ from.ts\n<<< move to=to.ts symbol=moved before=x\n>>>\n")).toThrow(/before= is not a modifier/);
        expect(bad("@@ from.ts\n<<< move to=to.ts symbol=moved at=typo\nanchor\n>>>\n")).toThrow(/got "typo"/);
    });

    test("at=after with the anchor as the body pastes against that anchor", () => {
        const dir = fixture();
        const edits = parseSpec({
            text: "@@ from.ts\n<<< move to=to.ts symbol=moved at=after\nexport const existing = 0;\n>>>\n",
            cwd: dir,
        });
        const paste = edits.find((edit) => edit.file === "to.ts");
        expect(paste?.ops?.[0]).toMatchObject({ kind: "insertAfter", anchor: "export const existing = 0;" });
    });

    test("at= belongs to move alone, and before=/after= point at at=", () => {
        const dir = fixture();
        const bad =
            (spec: string): (() => unknown) =>
            () =>
                parseSpec({ text: spec, cwd: dir });

        // `at=` on another kind was accepted and its placement silently dropped.
        expect(bad("@@ from.ts\n<<< append at=before\nx\n>>>\n")).toThrow(/at= only applies to move/);
        expect(bad("@@ from.ts\n<<< regex at=after\na\n===\nb\n>>>\n")).toThrow(/at= only applies to move/);
        // `before=anchor` used to die as a bare unknown modifier, which never named at=.
        expect(bad("@@ from.ts\n<<< move to=to.ts symbol=moved before=anchor\n>>>\n")).toThrow(
            /write at=before and put the anchor text in the body/
        );
    });

    test("lines= addresses a block that is not one declaration", () => {
        const dir = fixture();
        const edits = parseSpec({ text: "@@ from.ts\n<<< move to=to.ts lines=1-1\n>>>\n", cwd: dir });
        const paste = edits.find((edit) => edit.file === "to.ts");
        expect(pastedText(paste?.ops?.[0])).toContain("export const keep = 1;");
        void readFileSync;
    });
});

describe("the cut left behind in the source", () => {
    /** Apply the cut op the way the runner does: a unique literal find replaced with nothing. */
    const afterCut = (source: string, lines: [number, number]): string => {
        const dir = mkdtempSync(join(tmpdir(), "fr-cut-"));
        writeFileSync(join(dir, "from.ts"), source);
        const [cut] = expandMoves([{ from: "from.ts", to: "to.ts", lines }], { cwd: dir });
        const op = cut.ops?.[0];
        const find =
            typeof op === "object" && op !== null && "find" in op && typeof op.find === "string" ? op.find : "";
        expect(source.split(find)).toHaveLength(2);
        return source.replace(find, "");
    };

    test("a block between blank lines leaves exactly one blank line, not two", () => {
        expect(afterCut("A\n\nBLOCK\n\nNEXT\n", [3, 3])).toBe("A\n\nNEXT\n");
    });

    test("a block with code right after it leaves no empty line behind", () => {
        expect(afterCut("A\nBLOCK\nNEXT\n", [2, 2])).toBe("A\nNEXT\n");
    });

    test("the last block of a file keeps the file's final newline", () => {
        expect(afterCut("A\nBLOCK\n", [2, 2])).toBe("A\n");
        expect(afterCut("A\nBLOCK", [2, 2])).toBe("A\n");
    });
});

describe("a move that cannot be expanded", () => {
    test("fails pre-flight with code 2, not as a bare Error", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fr-move-bad-"));
        writeFileSync(join(dir, "from.ts"), "export const keep = 1;\n");
        const failure = await run({
            cwd: dir,
            verbose: false,
            moves: [{ from: "from.ts", to: "to.ts", symbol: "nope" }],
        }).catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(FableReplaceError);
        expect(failure).toMatchObject({ code: 2 });
        expect(String(failure)).toContain("no declaration of nope");
    });
});

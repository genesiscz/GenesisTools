import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FableReplaceError } from "./internal";
import { blockEndLine, docCommentStart, expandMoves, locateBlock } from "./move-blocks";
import { selectTsReader } from "./move-imports-ts";
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

    test("the last block of a file takes the blank line above it, so the file does not end on one", () => {
        expect(afterCut("A\n\nBLOCK\n", [3, 3])).toBe("A\n");
        expect(afterCut("A\n  \nBLOCK", [3, 3])).toBe("A\n");
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
describe("a move with imports=fix", () => {
    const write = (dir: string, files: Record<string, string>): void => {
        for (const [file, content] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, file)), { recursive: true });
            writeFileSync(join(dir, file), content);
        }
    };
    const project = (): string => {
        const dir = mkdtempSync(join(tmpdir(), "fr-move-imports-"));
        write(dir, {
            "tsconfig.json":
                '{\n  // aliases\n  "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] }, },\n}\n',
            "src/lib/types.ts": "export interface Options {\n    name: string;\n}\n",
            "src/lib/utils.ts": [
                'import { readFileSync } from "node:fs";',
                'import { join } from "node:path";',
                'import type { Options } from "./types";',
                "",
                'export const root = "/";',
                "",
                "export function load(options: Options): string {",
                '    return readFileSync(join(root, options.name), "utf8");',
                "}",
                "",
                'export const keep = join(root, "x");',
                "",
            ].join("\n"),
            "src/feature/a.ts": 'import { keep, load } from "@app/lib/utils";\n\nexport const a = [keep, load];\n',
            "src/feature/b.ts": 'import { load } from "../lib/utils.js";\n\nexport const b = load;\n',
            "src/feature/c.ts":
                'import type { Options } from "@app/lib/types";\nimport { load } from "@app/lib/utils";\n\nexport const c: [Options?, typeof load?] = [];\n',
        });
        return dir;
    };
    const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");
    const MOVE_LOAD = "@@ src/lib/utils.ts\n<<< move to=src/lib/load.ts symbol=load imports=fix\n>>>\n";

    test("one spec splits a file: the target gets its imports, the source drops dead ones, importers follow", async () => {
        const dir = project();
        await run({ cwd: dir, verbose: false, edits: parseSpec({ text: MOVE_LOAD, cwd: dir }) });

        expect(read(dir, "src/lib/load.ts")).toBe(
            [
                'import { readFileSync } from "node:fs";',
                'import { join } from "node:path";',
                'import type { Options } from "./types";',
                'import { root } from "./utils";',
                "",
                "export function load(options: Options): string {",
                '    return readFileSync(join(root, options.name), "utf8");',
                "}",
                "",
            ].join("\n")
        );
        expect(read(dir, "src/lib/utils.ts")).toBe(
            'import { join } from "node:path";\n\nexport const root = "/";\n\nexport const keep = join(root, "x");\n'
        );
        // A mixed import splits, and the new line lands in alphabetical order by module path.
        expect(read(dir, "src/feature/a.ts")).toBe(
            'import { load } from "@app/lib/load";\nimport { keep } from "@app/lib/utils";\n\nexport const a = [keep, load];\n'
        );
        // A relative importer stays relative and keeps its .js spelling.
        expect(read(dir, "src/feature/b.ts")).toBe(
            'import { load } from "../lib/load.js";\n\nexport const b = load;\n'
        );
        // A statement whose every name moves keeps its line; only the module path changes.
        expect(read(dir, "src/feature/c.ts")).toStartWith(
            'import type { Options } from "@app/lib/types";\nimport { load } from "@app/lib/load";\n'
        );
    });

    test("a configured formatter width wraps a long new import; a disabled formatter keeps one line", async () => {
        const wide =
            "export function load(): string {\n    return [alphaAlphaAlpha, betaBetaBeta, gammaGammaGamma].join();\n}\n";
        const source = `import { alphaAlphaAlpha, betaBetaBeta, gammaGammaGamma } from "./words";\n\n${wide}`;
        const words =
            "export const alphaAlphaAlpha = 'a';\nexport const betaBetaBeta = 'b';\nexport const gammaGammaGamma = 'c';\n";
        const spec = "@@ src/a.ts\n<<< move to=src/b.ts symbol=load imports=fix\n>>>\n";

        const formatted = mkdtempSync(join(tmpdir(), "fr-move-width-"));
        write(formatted, {
            "biome.json": '{ "formatter": { "lineWidth": 60, "indentStyle": "space", "indentWidth": 4 } }\n',
            "src/a.ts": source,
            "src/words.ts": words,
        });
        await run({ cwd: formatted, verbose: false, edits: parseSpec({ text: spec, cwd: formatted }) });
        expect(read(formatted, "src/b.ts")).toStartWith(
            'import {\n    alphaAlphaAlpha,\n    betaBetaBeta,\n    gammaGammaGamma,\n} from "./words";\n'
        );

        const disabled = mkdtempSync(join(tmpdir(), "fr-move-width-off-"));
        write(disabled, {
            "biome.json": '{ "formatter": { "lineWidth": 60 }, "javascript": { "formatter": { "enabled": false } } }\n',
            "src/a.ts": source,
            "src/words.ts": words,
        });
        await run({ cwd: disabled, verbose: false, edits: parseSpec({ text: spec, cwd: disabled }) });
        expect(read(disabled, "src/b.ts")).toStartWith(
            'import { alphaAlphaAlpha, betaBetaBeta, gammaGammaGamma } from "./words";\n'
        );
    });

    test("a create and a move into the same file are one edit, however the path is spelled", async () => {
        const dir = project();
        const edits = parseSpec({ text: `@@ ./src/lib/load.ts\n<<< create\n// header\n>>>\n${MOVE_LOAD}`, cwd: dir });
        const target = resolve(dir, "src/lib/load.ts");

        expect(edits.filter((edit) => resolve(dir, edit.file) === target)).toHaveLength(1);
        await run({ cwd: dir, verbose: false, edits });
        expect(read(dir, "src/lib/load.ts")).toStartWith('import { readFileSync } from "node:fs";');
        expect(read(dir, "src/lib/load.ts")).toContain("// header\n\nexport function load(");
    });

    test("a cross-file dependency that cannot be imported is refused, naming the spec line", () => {
        const dir = project();
        write(dir, {
            "src/lib/hidden.ts": "const secret = 1;\n\nexport const uses = () => secret;\n",
            "src/lib/helper.ts": "const helper = () => 1;\n\nexport const user = () => helper();\n",
            "src/lib/two.ts": "export const one = 1;\n\nexport const two = 2;\n",
            "src/lib/def.ts": "export default function main() {\n    return 1;\n}\n",
        });
        const bad =
            (spec: string): (() => unknown) =>
            () =>
                parseSpec({ text: spec, cwd: dir });

        expect(bad("@@ src/lib/hidden.ts\n<<< move to=src/lib/x.ts symbol=uses imports=fix\n>>>\n")).toThrow(
            /spec line 2: move: the moved code uses secret, which stays in src\/lib\/hidden.ts and is not exported/
        );
        expect(bad("@@ src/lib/helper.ts\n<<< move to=src/lib/x.ts symbol=helper imports=fix\n>>>\n")).toThrow(
            /still uses helper after the move, and helper is not exported/
        );
        expect(
            bad(
                "@@ src/lib/two.ts\n<<< move to=src/lib/x.ts symbol=one imports=fix\n>>>\n<<< move to=src/lib/x.ts symbol=two\n>>>\n"
            )
        ).toThrow(/spec line 4: .*imports=fix must be on every move out of src\/lib\/two.ts/);
        expect(bad("@@ src/lib/def.ts\n<<< move to=src/lib/x.ts symbol=main imports=fix\n>>>\n")).toThrow(
            /export default/
        );
        expect(bad("@@ src/lib/two.ts\n<<< move to=src/lib/x.ts symbol=one imports=keep\n>>>\n")).toThrow(
            /imports= takes fix/
        );
    });
});
describe("imports=fix proposes the spec change that makes it pass", () => {
    const write = (dir: string, files: Record<string, string>): void => {
        for (const [file, content] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, file)), { recursive: true });
            writeFileSync(join(dir, file), content);
        }
    };
    const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");
    const parse = (dir: string, text: string): { edits: ReturnType<typeof parseSpec>; warnings: string[] } => {
        const warnings: string[] = [];
        const edits = parseSpec({ text, cwd: dir, onWarning: (message) => warnings.push(message) });
        return { edits, warnings };
    };

    test("a private name used across the cut: the refusal names visibility=widen, and with it the move exports", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fr-widen-"));
        write(dir, {
            "a.ts": "const helper = () => 1;\n\nexport const user = () => helper();\n",
        });
        const marker = "<<< move to=b.ts symbol=helper imports=fix";
        expect(() => parse(dir, `@@ a.ts\n${marker}\n>>>\n`)).toThrow(
            `Fix: let the move export it, or move its users along:\n    ${marker} visibility=widen`
        );

        const { edits } = parse(dir, `@@ a.ts\n${marker} visibility=widen\n>>>\n`);
        await run({ cwd: dir, verbose: false, edits });
        expect(read(dir, "b.ts")).toBe("export const helper = () => 1;\n");
        expect(read(dir, "a.ts")).toBe('import { helper } from "./b";\n\nexport const user = () => helper();\n');
    });

    test("a namespace or mock warning carries its op, and the warning is gone once that op is in the spec", () => {
        const dir = mkdtempSync(join(tmpdir(), "fr-warn-fix-"));
        write(dir, {
            "lib/utils.ts": "export const keep = 1;\n\nexport const moved = 2;\n",
            "ns.ts": 'import * as U from "./lib/utils";\n\nexport const x = [U.keep, U.moved];\n',
            "ns.test.ts": 'mock("./lib/utils", () => ({}));\n',
        });
        const move = "@@ lib/utils.ts\n<<< move to=lib/moved.ts symbol=moved imports=fix\n>>>\n";

        const first = parse(dir, move);
        expect(first.warnings).toHaveLength(2);
        const namespaceWarning = first.warnings.find((w) => w.includes("through the namespace U")) ?? "";
        const mockWarning = first.warnings.find((w) => w.includes("in a call")) ?? "";
        expect(namespaceWarning).toContain('import * as UMoved from "./lib/moved";');
        expect(mockWarning).toContain('mock("./lib/moved"');

        // Paste each proposed spec block (everything after the "Fix:" line) and parse again.
        const proposed = (warning: string): string =>
            warning
                .split("\n")
                .slice(2)
                .map((line) => line.slice(4))
                .join("\n");
        const second = parse(dir, `${move}${proposed(namespaceWarning)}\n${proposed(mockWarning)}\n`);
        expect(second.warnings).toEqual([]);
    });

    test("a comment inside an import list neither ends the statement nor survives as a name", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fr-comment-braces-"));
        write(dir, {
            "lib/utils.ts": "export const keep = 1;\n\nexport const moved = 2;\n",
            "user.ts":
                'import {\n    keep, // the one that } stays\n    moved,\n} from "./lib/utils";\n\nexport const y = [keep, moved];\n',
        });
        const { edits } = parse(dir, "@@ lib/utils.ts\n<<< move to=lib/moved.ts symbol=moved imports=fix\n>>>\n");
        await run({ cwd: dir, verbose: false, edits });
        // Without a formatter the split keeps the statement's own layout, and the comment stays on keep.
        expect(read(dir, "user.ts")).toStartWith(
            'import {\n    moved,\n} from "./lib/moved";\nimport {\n    keep, // the one that } stays\n} from "./lib/utils";\n'
        );
    });
});
describe("imports=fix in Swift", () => {
    const write = (dir: string, files: Record<string, string>): void => {
        for (const [file, content] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, file)), { recursive: true });
            writeFileSync(join(dir, file), content);
        }
    };
    const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");
    const packageSwift = (appDependencies: string): string =>
        [
            "// swift-tools-version: 5.9",
            "import PackageDescription",
            "",
            "let package = Package(",
            '    name: "Demo",',
            "    targets: [",
            '        .target(name: "Kit", path: "Kit"),',
            `        .executableTarget(name: "App", dependencies: [${appDependencies}], path: "App"),`,
            "    ]",
            ")",
            "",
        ].join("\n");
    const project = (appDependencies = '"Kit"'): string => {
        const dir = mkdtempSync(join(tmpdir(), "fr-swift-"));
        write(dir, {
            "Package.swift": packageSwift(appDependencies),
            "Kit/Kit.swift": "public let kitVersion = 1\n",
            "App/Helpers.swift": [
                "import Foundation",
                "",
                "private func secret() -> Int { 1 }",
                "",
                "func helper() -> Int {",
                "    secret()",
                "}",
                "",
                "struct Point {",
                "    let x: Int",
                "    var y: Int = 0",
                "",
                "    func sum() -> Int {",
                "        x + y",
                "    }",
                "}",
                "",
            ].join("\n"),
            "App/main.swift": "import Foundation\n\nlet p = Point(x: 1)\nprint(helper(), p.sum())\n",
        });
        return dir;
    };
    const parse = (dir: string, text: string): { edits: ReturnType<typeof parseSpec>; warnings: string[] } => {
        const warnings: string[] = [];
        return { edits: parseSpec({ text, cwd: dir, onWarning: (message) => warnings.push(message) }), warnings };
    };

    test("inside one module: the target gets the module imports, and a private helper across the cut is refused or made internal", async () => {
        const dir = project();
        const marker = "<<< move to=App/Other.swift symbol=helper imports=fix";
        expect(() => parse(dir, `@@ App/Helpers.swift\n${marker}\n>>>\n`)).toThrow(
            `<<< move to=App/Other.swift symbol=secret imports=fix\n    ${marker} visibility=widen`
        );

        const { edits } = parse(dir, `@@ App/Helpers.swift\n${marker} visibility=widen\n>>>\n`);
        await run({ cwd: dir, verbose: false, edits });
        expect(read(dir, "App/Other.swift")).toBe("import Foundation\n\nfunc helper() -> Int {\n    secret()\n}\n");
        expect(read(dir, "App/Helpers.swift")).toStartWith(
            "import Foundation\n\nfunc secret() -> Int { 1 }\n\nstruct Point {"
        );
        // Same module: no file gains an import of a module.
        expect(read(dir, "App/main.swift")).toStartWith("import Foundation\n\nlet p");
    });

    test("across modules: users import the target module, the moved type and its members turn public", async () => {
        const dir = project();
        const marker = "<<< move to=Kit/Point.swift symbol=Point imports=fix";
        expect(() => parse(dir, `@@ App/Helpers.swift\n${marker}\n>>>\n`)).toThrow(
            `Point moves into module Kit but is internal, and App still uses it`
        );

        const { edits, warnings } = parse(dir, `@@ App/Helpers.swift\n${marker} visibility=widen\n>>>\n`);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("public init(x: Int, y: Int = 0) {");
        await run({ cwd: dir, verbose: false, edits });
        expect(read(dir, "Kit/Point.swift")).toBe(
            [
                "import Foundation",
                "",
                "public struct Point {",
                "    public let x: Int",
                "    public var y: Int = 0",
                "",
                "    public func sum() -> Int {",
                "        x + y",
                "    }",
                "}",
                "",
            ].join("\n")
        );
        expect(read(dir, "App/main.swift")).toStartWith("import Foundation\nimport Kit\n\nlet p");
    });

    test("an init of another type in the moved block does not count as the struct's own (found by a real build)", () => {
        const dir = project();
        write(dir, {
            "App/Helpers.swift": [
                "import Foundation",
                "",
                "struct Point {",
                "    let x: Int",
                "}",
                "",
                "private final class Reader {",
                "    init(_ value: Int) {}",
                "}",
                "",
            ].join("\n"),
        });
        const { warnings } = parse(
            dir,
            "@@ App/Helpers.swift\n<<< move to=Kit/Point.swift lines=3-9 imports=fix visibility=widen\n>>>\n"
        );
        expect(warnings.some((w) => w.includes("public init(x: Int) {"))).toBe(true);
    });

    test("across modules without a dependency: the warning carries the Package.swift op, and the op clears it", () => {
        const dir = project("");
        const move =
            "@@ App/Helpers.swift\n<<< move to=Kit/Point.swift symbol=Point imports=fix visibility=widen\n>>>\n";
        const { warnings } = parse(dir, move);
        const dependency = warnings.find((w) => w.includes("does not list Kit")) ?? "";
        expect(dependency).toContain('name: "App", dependencies: ["Kit", ');

        const op = dependency
            .split("\n")
            .slice(2)
            .map((line) => line.slice(4))
            .join("\n");
        expect(parse(dir, `${move}${op}\n`).warnings.filter((w) => w.includes("does not list Kit"))).toEqual([]);
    });
});
describe("imports=fix in PHP", () => {
    const write = (dir: string, files: Record<string, string>): void => {
        for (const [file, content] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, file)), { recursive: true });
            writeFileSync(join(dir, file), content);
        }
    };
    const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");
    const parse = (dir: string, text: string): { edits: ReturnType<typeof parseSpec>; warnings: string[] } => {
        const warnings: string[] = [];
        return { edits: parseSpec({ text, cwd: dir, onWarning: (message) => warnings.push(message) }), warnings };
    };
    const project = (): string => {
        const dir = mkdtempSync(join(tmpdir(), "fr-php-"));
        write(dir, {
            "composer.json": '{ "autoload": { "psr-4": { "App\\\\": "app/" } } }\n',
            "app/Http/OrderController.php": [
                "<?php",
                "",
                "namespace App\\Http;",
                "",
                "use App\\Models\\Invoice;",
                "use Illuminate\\Support\\Collection;",
                "",
                "class OrderController",
                "{",
                "    public function show(Invoice $invoice): Invoice",
                "    {",
                "        return $invoice;",
                "    }",
                "",
                "    public function total(Collection $items): int",
                "    {",
                "        return $items->count();",
                "    }",
                "}",
                "",
            ].join("\n"),
            "app/Services/OrderService.php":
                "<?php\n\nnamespace App\\Services;\n\nclass OrderService\n{\n    // methods\n}\n",
            "app/Support/Legacy.php": [
                "<?php",
                "",
                "declare(strict_types=1);",
                "",
                "namespace App\\Support;",
                "",
                "final class Money",
                "{",
                "    public function __construct(public int $cents) {}",
                "}",
                "",
                "class Legacy",
                "{",
                "    public function price(): Money",
                "    {",
                "        return new Money(1);",
                "    }",
                "}",
                "",
            ].join("\n"),
            "app/Http/Checkout.php":
                "<?php\n\nnamespace App\\Http;\n\nuse App\\Support\\Money;\n\nclass Checkout\n{\n    public function pay(Money $m): void {}\n}\n",
            "app/Http/Grouped.php":
                "<?php\n\nnamespace App\\Http;\n\nuse App\\Support\\{Legacy, Money};\n\nclass Grouped\n{\n    public function x(Legacy $l, Money $m): void {}\n}\n",
            "app/Support/Sibling.php":
                "<?php\n\nnamespace App\\Support;\n\nclass Sibling\n{\n    public function m(): Money\n    {\n        return \\App\\Support\\Money::class === 'x' ? new Money(2) : new Money(3);\n    }\n}\n",
            "config/money.php": "<?php\n\nreturn ['class' => 'App\\Support\\Money'];\n",
        });
        return dir;
    };

    test("a method moved between classes takes the use lines it needs and the source drops the ones it no longer needs", async () => {
        const dir = project();
        const { edits } = parse(
            dir,
            "@@ app/Http/OrderController.php\n<<< move to=app/Services/OrderService.php lines=14-18 at=after imports=fix\n    // methods\n>>>\n"
        );
        await run({ cwd: dir, verbose: false, edits });
        expect(read(dir, "app/Services/OrderService.php")).toBe(
            [
                "<?php",
                "",
                "namespace App\\Services;",
                "",
                "use Illuminate\\Support\\Collection;",
                "",
                "class OrderService",
                "{",
                "    // methods",
                "",
                "    public function total(Collection $items): int",
                "    {",
                "        return $items->count();",
                "    }",
                "",
                "}",
                "",
            ].join("\n")
        );
        expect(read(dir, "app/Http/OrderController.php")).toStartWith(
            "<?php\n\nnamespace App\\Http;\n\nuse App\\Models\\Invoice;\n\nclass OrderController"
        );
    });

    test("a class moved to another namespace: a new file with its preamble, and every reference follows", async () => {
        const dir = project();
        const move = "@@ app/Support/Legacy.php\n<<< move to=app/Values/Money.php symbol=Money imports=fix\n>>>\n";
        const { edits, warnings } = parse(dir, move);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("config/money.php names App\\Support\\Money in a string");
        await run({ cwd: dir, verbose: false, edits });

        expect(read(dir, "app/Values/Money.php")).toBe(
            "<?php\n\ndeclare(strict_types=1);\n\nnamespace App\\Values;\n\nfinal class Money\n{\n    public function __construct(public int $cents) {}\n}\n"
        );
        expect(read(dir, "app/Support/Legacy.php")).toStartWith(
            "<?php\n\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n\nuse App\\Values\\Money;\n\nclass Legacy"
        );
        expect(read(dir, "app/Http/Checkout.php")).toContain("use App\\Values\\Money;\n");
        expect(read(dir, "app/Http/Grouped.php")).toContain("use App\\Support\\Legacy;\nuse App\\Values\\Money;\n");
        const sibling = read(dir, "app/Support/Sibling.php");
        expect(sibling).toContain("namespace App\\Support;\n\nuse App\\Values\\Money;\n");
        expect(sibling).toContain("\\App\\Values\\Money::class");
    });

    test("a class's trait, attribute and docblock types follow it into a new file (found by a real Laravel replay)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fr-php-real-"));
        write(dir, {
            "composer.json": '{ "autoload": { "psr-4": { "App\\\\": "app/" } } }\n',
            "app/Services/Factory.php": [
                "<?php",
                "",
                "declare(strict_types=1);",
                "",
                "namespace App\\Services;",
                "",
                "use App\\Container\\Lifecycle;",
                "use App\\Container\\Scoped;",
                "use App\\Models\\Tenant;",
                "use App\\Traits\\Backtraces;",
                "use Brick\\Money\\MoneyBag;",
                "",
                "#[Scoped(Lifecycle::Request)]",
                "class Factory",
                "{",
                "    use Backtraces;",
                "",
                "    /** @var array<int, Tenant> */",
                "    private array $cached = [];",
                "",
                "    /* $bag = new MoneyBag(); */",
                "}",
                "",
            ].join("\n"),
        });
        const { edits } = parse(
            dir,
            "@@ app/Services/Factory.php\n<<< move to=app/Support/Factory.php symbol=Factory imports=fix\n>>>\n"
        );
        await run({ cwd: dir, verbose: false, edits });
        expect(read(dir, "app/Support/Factory.php")).toStartWith(
            [
                "<?php",
                "",
                "declare(strict_types=1);",
                "",
                "namespace App\\Support;",
                "",
                "use App\\Container\\Lifecycle;",
                "use App\\Container\\Scoped;",
                "use App\\Models\\Tenant;",
                "use App\\Traits\\Backtraces;",
                "",
                "#[Scoped(Lifecycle::Request)]",
                "class Factory",
            ].join("\n")
        );
        // MoneyBag was unused before the move (only in a comment), so it stays where it was.
        expect(read(dir, "app/Services/Factory.php")).toBe(
            "<?php\n\ndeclare(strict_types=1);\n\nnamespace App\\Services;\n\nuse Brick\\Money\\MoneyBag;\n"
        );
    });

    test("a baseline or config that names the moved class is warned per escape level, and the ops clear it", () => {
        const dir = project();
        write(dir, {
            "phpstan-baseline.neon": [
                "parameters:",
                "\tignoreErrors:",
                "\t\t-",
                "\t\t\trawMessage: 'Call to App\\Support\\Money::x()'",
                "\t\t\tmessage: '#^Call to App\\\\Support\\\\Money\\:\\:x\\(\\)$#'",
                "",
            ].join("\n"),
        });
        const move = "@@ app/Support/Legacy.php\n<<< move to=app/Values/Money.php symbol=Money imports=fix\n>>>\n";
        const baseline = parse(dir, move).warnings.filter((w) => w.includes("phpstan-baseline.neon"));
        expect(baseline).toHaveLength(2);
        const ops = baseline
            .map((w) =>
                w
                    .split("\n")
                    .slice(2)
                    .map((line) => line.slice(4))
                    .join("\n")
            )
            .join("\n");
        expect(ops).toContain("App\\\\Values\\\\Money");
        expect(parse(dir, `${move}${ops}\n`).warnings.filter((w) => w.includes("phpstan-baseline.neon"))).toEqual([]);
    });

    test("the string warning's op clears it", () => {
        const dir = project();
        const move = "@@ app/Support/Legacy.php\n<<< move to=app/Values/Money.php symbol=Money imports=fix\n>>>\n";
        const [warning] = parse(dir, move).warnings;
        const op = warning
            .split("\n")
            .slice(2)
            .map((line) => line.slice(4))
            .join("\n");
        expect(parse(dir, `${move}${op}\n`).warnings).toEqual([]);
    });
});
describe("doc comments as units", () => {
    const fixture = (files: Record<string, string>): string => {
        const dir = mkdtempSync(join(tmpdir(), "fr-doc-"));
        for (const [file, content] of Object.entries(files)) {
            writeFileSync(join(dir, file), content);
        }
        return dir;
    };

    test("at=before lands above the anchor's doc comment, not between the comment and its line", async () => {
        const dir = fixture({
            "from.ts": "export function a(): number {\n    return 1;\n}\n",
            "to.ts": "/** Doc of b. */\nexport function b(): number {\n    return 2;\n}\n",
        });
        const edits = parseSpec({
            text: "@@ from.ts\n<<< move to=to.ts symbol=a at=before\nexport function b\n>>>\n",
            cwd: dir,
        });
        await run({ cwd: dir, verbose: false, edits });
        expect(readFileSync(join(dir, "to.ts"), "utf8")).toBe(
            "export function a(): number {\n    return 1;\n}\n\n/** Doc of b. */\nexport function b(): number {\n    return 2;\n}\n"
        );
    });

    test("delete symbol= removes the declaration with its doc comment; delete doc= removes only the comment", async () => {
        const source =
            "/** One. */\nexport const one = 1;\n\n/**\n * Two.\n */\nexport function two(): number {\n    return 2;\n}\n";
        const dir = fixture({ "a.ts": source });
        await run({
            cwd: dir,
            verbose: false,
            edits: parseSpec({ text: "@@ a.ts\n<<< delete symbol=one\n>>>\n<<< delete doc=two\n>>>\n", cwd: dir }),
        });
        expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("export function two(): number {\n    return 2;\n}\n");
        expect(() => parseSpec({ text: "@@ a.ts\n<<< delete doc=two\n>>>\n", cwd: dir })).toThrow(
            "delete: two has no doc comment directly above it"
        );
        expect(() => parseSpec({ text: "@@ a.ts\n<<< delete symbol=two\nbody\n>>>\n", cwd: dir })).toThrow(
            "takes an empty body"
        );
    });
});
describe("the post-edit syntax check covers PHP and Swift", () => {
    test("an op that breaks a PHP or Swift file fails the batch, and the same op on a broken file does not", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fr-syntax-"));
        writeFileSync(join(dir, "a.php"), "<?php\n\nfunction a(): int\n{\n    return 1;\n}\n");
        writeFileSync(join(dir, "a.swift"), "func a() -> Int {\n    return 1\n}\n");
        const breaking = (file: string, find: string): Promise<unknown> =>
            run({ cwd: dir, verbose: false, edits: [{ file, ops: [{ find, replace: `${find} {` }] }] }).catch(
                (error: unknown) => error
            );

        for (const [file, find, tool] of [
            ["a.php", "return 1;", "php"],
            ["a.swift", "return 1", "swiftc"],
        ] as const) {
            const failure = await breaking(file, find);
            if (Bun.which(tool) === null) {
                continue;
            }

            expect(
                String(
                    (failure as { report?: { files?: Array<{ postConditionFailures?: string[] }> } }).report?.files?.[0]
                        ?.postConditionFailures
                )
            ).toContain(`${tool}: `);
        }
    });
});
describe("attributes and decorators belong to their declaration", () => {
    test("a PHP attribute, a Swift attribute and a TS decorator move with the declaration", () => {
        const php = [
            "<?php",
            "",
            "/** Doc. */",
            "#[ContainerLifecycle(",
            "    Lifecycle::Scoped,",
            ")]",
            "#[Other]",
            "class Money",
            "{",
            "}",
            "",
        ];
        expect(docCommentStart(php, 7)).toBe(2);
        const swift = ["import Foundation", "", "@MainActor", "final class Model {", "}", ""];
        expect(docCommentStart(swift, 3)).toBe(2);
        const ts = ["const x = f()", "", '@Component({ selector: "a" })', "export class A {}", ""];
        expect(docCommentStart(ts, 3)).toBe(2);
        // A call statement ending in `)` above a declaration is not an attribute.
        expect(docCommentStart(["foo()", "export const a = 1;"], 1)).toBe(1);
    });
});
describe("imports=fix reads TypeScript with the compiler when GenesisTools is found", () => {
    const write = (dir: string, files: Record<string, string>): void => {
        for (const [file, content] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, file)), { recursive: true });
            writeFileSync(join(dir, file), content);
        }
    };
    const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");

    test("inside this repository the compiler reader is selected", () => {
        if (process.env.FABLE_REPLACE_PARSER === "text") {
            return;
        }

        expect(selectTsReader().reader.kind).toBe("compiler");
    });

    test("an import written without spaces is found and re-pointed", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fr-compact-import-"));
        write(dir, {
            "lib/utils.ts": "export const keep = 1;\n\nexport const moved = 2;\n",
            "user.ts": 'import{moved}from"./lib/utils";\n\nexport const y = moved;\n',
        });
        const edits = parseSpec({
            text: "@@ lib/utils.ts\n<<< move to=lib/moved.ts symbol=moved imports=fix\n>>>\n",
            cwd: dir,
        });
        await run({ cwd: dir, verbose: false, edits });
        const user = read(dir, "user.ts");
        if (selectTsReader().reader.kind === "compiler") {
            expect(user).toBe('import{moved}from"./lib/moved";\n\nexport const y = moved;\n');
        } else {
            // The pattern reader needs a space after `import`; this is the gap the compiler closes.
            expect(user).toBe('import{moved}from"./lib/utils";\n\nexport const y = moved;\n');
        }
    });

    test("a parameter that shadows an import does not keep the import alive", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fr-shadow-"));
        write(dir, {
            "a.ts": [
                'import { join } from "node:path";',
                "",
                'export const paths = (root: string): string => join(root, "x");',
                "",
                "export const length = (join: string[]): number => join.length;",
                "",
            ].join("\n"),
        });
        const edits = parseSpec({ text: "@@ a.ts\n<<< move to=b.ts symbol=paths imports=fix\n>>>\n", cwd: dir });
        await run({ cwd: dir, verbose: false, edits });
        expect(read(dir, "b.ts")).toStartWith('import { join } from "node:path";\n');
        const source = read(dir, "a.ts");
        if (selectTsReader().reader.kind === "compiler") {
            expect(source).toBe("export const length = (join: string[]): number => join.length;\n");
        } else {
            expect(source).toStartWith('import { join } from "node:path";');
        }
    });
});

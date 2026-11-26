import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FableReplaceError } from "./internal";
import { renameModuleParamsFromJson, renameModuleSymbol } from "./rename-module";
import { run } from "./sweep-many-files";

// renameModuleSymbol renames a symbol, its file and every import of it in one call that returns FileEdits only.
// These tests pin the merged module edit (rename op, renameTo, gitMove, full diff), one edit per importer, a dry run
// whose diffs show the new specifier, and the refusals (code 2) of both doors. One temp folder for the file; the git
// rename itself is checked by the CLI tests (P3).

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const CONSOLE_METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

let dir = "";

const put = (rel: string, content: string): void => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
};

const read = (rel: string): string => fs.readFileSync(path.join(dir, rel), "utf8");

/** Runs `fn` with every console method spied, and returns what it answered and every line the spies saw. */
const captured = async <T>(fn: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> => {
    const spies = CONSOLE_METHODS.map((method) => spyOn(console, method).mockImplementation(() => {}));
    try {
        const value = await fn();
        const lines = spies
            .flatMap((spy) => spy.mock.calls)
            .flatMap((call) => call.map(String).join(" ").split("\n"))
            // biome-ignore lint/suspicious/noControlCharactersInRegex: strips the colour codes run() may print
            .map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
        return { value, lines };
    } finally {
        for (const spy of spies) {
            spy.mockRestore();
        }
    }
};

const refusal = (fn: () => unknown): FableReplaceError => {
    try {
        fn();
    } catch (err) {
        if (err instanceof FableReplaceError) {
            return err;
        }

        throw err;
    }

    throw new Error("the call was accepted");
};

const MODULE = path.join("app", "Foo.ts");
const IMPORTERS = [path.join("app", "a.ts"), path.join("app", "nested", "b.tsx")];

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-module-"));
    put(
        "app/Foo.ts",
        "export interface FooProps {\n    name: string;\n}\n\nexport const Foo = (props: FooProps): string => props.name;\n"
    );
    put("app/a.ts", 'import { Foo } from "./Foo";\n\nexport const a = Foo({ name: "a" });\n');
    put(
        "app/nested/b.tsx",
        'import { Foo, type FooProps } from "../Foo";\n\nexport const b = (p: FooProps): string => Foo(p);\n'
    );
    // Word-bounded: FooBar is another identifier, so neither file is touched.
    put("app/FooBar.ts", "export const FooBar = 1;\n");
    put("app/near.ts", 'import { FooBar } from "./FooBar";\n\nexport const near = FooBar;\n');
    put("app/notes.md", "Foo is named in prose only.\n");
    // A local wrapper: it imports Foo AND declares Foo.
    put("wrapped/Foo.ts", "export const Foo = 1;\n");
    put("wrapped/wrap.ts", 'import { Foo as Base } from "./Foo";\n\nexport const Foo = Base + 1;\n');
    // Two modules named Foo: the specifier "../legacy/Foo" would become "../legacy/Bar" with no such file.
    put("twins/Foo.ts", "export const Foo = 1;\n");
    put("twins/legacy/Foo.ts", "export default 2;\n");
    put("twins/use.ts", 'import { Foo } from "./legacy/Foo";\n\nexport const use = Foo;\n');
});

afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("renameModuleSymbol", () => {
    test("one merged edit for the module (rename op, renameTo, gitMove, full diff) and one per importer", async () => {
        const { value: edits, lines } = await captured(() =>
            renameModuleSymbol({ file: MODULE, symbol: "Foo", to: "Bar", roots: ["app"], cwd: dir })
        );

        expect(lines).toEqual([]);
        expect(edits.map((edit) => edit.file)).toEqual([MODULE, ...IMPORTERS]);
        expect(edits[0]).toMatchObject({ renameTo: path.join("app", "Bar.ts"), gitMove: true, diff: "full" });
        expect(edits[0].ops?.map((op) => op.kind)).toEqual(["regex"]);
        for (const importer of edits.slice(1)) {
            expect(importer.ops?.map((op) => op.label)).toEqual(["rename Foo → Bar"]);
            expect(importer.renameTo).toBeUndefined();
            expect(importer.gitMove).toBeUndefined();
        }

        expect(edits.every((edit) => edit.diff === "full")).toBe(true);
    });

    test("a dry run() of the edits is ok, writes nothing, and each importer's diff shows /Bar", async () => {
        const edits = renameModuleSymbol({ file: MODULE, symbol: "Foo", to: "Bar", roots: ["app"], cwd: dir });
        const { value: report, lines } = await captured(() => run({ edits, dryRun: true, cwd: dir }));

        expect(report.ok).toBe(true);
        expect(report.written).toEqual([]);
        expect(report.files.map((result) => [result.file, result.action])).toEqual([
            [MODULE, "renamed"],
            [IMPORTERS[0], "edited"],
            [IMPORTERS[1], "edited"],
        ]);
        expect(report.files[0].renamedTo).toBe(path.join("app", "Bar.ts"));
        // Each file's rename op pins the count it found, so the report proves the contract on a green run too.
        const ops = report.files.flatMap((result) => result.ops);
        expect(ops).toHaveLength(3);
        expect(ops.every((op) => typeof op.found === "number" && op.found > 0 && op.expected === op.found)).toBe(true);
        // run() prints each file's header line, its op lines and then its diff, so a file's block runs up to the
        // next header.
        const headerAt = edits.map((edit) => lines.findIndex((line) => line.startsWith(`${edit.file} (`)));
        expect(headerAt.every((at) => at >= 0)).toBe(true);
        const blockOf = (index: number): string =>
            lines.slice(headerAt[index], index + 1 < headerAt.length ? headerAt[index + 1] : undefined).join("\n");
        expect(blockOf(0)).toContain("export const Bar = (props: FooProps)");
        expect(blockOf(1)).toContain('import { Bar } from "./Bar";');
        expect(blockOf(2)).toContain('import { Bar, type FooProps } from "../Bar";');
        expect(fs.existsSync(path.join(dir, "app", "Bar.ts"))).toBe(false);
        expect(read("app/a.ts")).toContain('from "./Foo"');
    });

    test("a local wrapper is refused unless includeShadowed is set", () => {
        const params = { file: "wrapped/Foo.ts", symbol: "Foo", to: "Bar", roots: ["wrapped"], cwd: dir };

        expect(refusal(() => renameModuleSymbol(params)).code).toBe(2);
        const edits = renameModuleSymbol({ ...params, includeShadowed: true });
        expect(edits.map((edit) => edit.file)).toEqual([
            path.join("wrapped", "Foo.ts"),
            path.join("wrapped", "wrap.ts"),
        ]);
    });

    test.each([
        ["a file whose name is not the symbol", { file: "app/a.ts" }, 'is not named after "Foo"'],
        ["a missing module file", { file: "app/missing/Foo.ts" }, "not found"],
        ["a missing root", { roots: ["app", "nope"] }, "root(s) not found"],
        ["no root", { roots: [] }, "no root to search"],
        ["a new name that is not an identifier", { to: "Bar-Baz" }, 'to "Bar-Baz" is not an identifier'],
        ["the same name twice", { to: "Foo" }, "nothing to rename"],
        ["a reserved binding", { to: "return" }, "is not an identifier"],
        ["a second file named after the symbol", { file: "twins/Foo.ts", roots: ["twins"] }, "is also named"],
    ])("refuses %s with code 2", (_name, change, message) => {
        const err = refusal(() =>
            renameModuleSymbol({ file: MODULE, symbol: "Foo", to: "Bar", roots: ["app"], cwd: dir, ...change })
        );

        expect(err.code).toBe(2);
        expect(err.message).toContain(message);
    });
});

test("a missing symbol is refused before a move is planned", () => {
    put("missing/Foo.ts", "export default 1;\n");
    expect(() =>
        renameModuleSymbol({ file: "missing/Foo.ts", symbol: "Foo", to: "Bar", roots: ["missing"], cwd: dir })
    ).toThrow("does not contain the symbol");
    expect(fs.existsSync(path.join(dir, "missing/Foo.ts"))).toBe(true);
});

describe("renameModuleParamsFromJson", () => {
    test("a parsed object round-trips into the params, and the edits match the direct call", () => {
        const text = JSON.stringify({
            file: MODULE,
            symbol: "Foo",
            to: "Bar",
            roots: ["app"],
            cwd: dir,
            includeShadowed: false,
        });
        const params = renameModuleParamsFromJson(JSON.parse(text));

        expect(params).toEqual({
            file: MODULE,
            symbol: "Foo",
            to: "Bar",
            roots: ["app"],
            cwd: dir,
            includeShadowed: false,
        });
        expect(renameModuleParamsFromJson({ file: "a/Foo.ts", symbol: "Foo", to: "Bar", roots: ["."] })).toEqual({
            file: "a/Foo.ts",
            symbol: "Foo",
            to: "Bar",
            roots: ["."],
        });
        expect(renameModuleSymbol(params).map((edit) => edit.file)).toEqual([MODULE, ...IMPORTERS]);
    });

    test.each([
        ["an array", [], "the top level"],
        ["a number as file", { file: 1, symbol: "Foo", to: "Bar", roots: ["."] }, "file must be a string"],
        ["a missing to", { file: "Foo.ts", symbol: "Foo", roots: ["."] }, "to is required"],
        [
            "an unknown key",
            { file: "Foo.ts", symbol: "Foo", to: "Bar", roots: ["."], rootz: ["."] },
            "rootz is not a known key",
        ],
        ["roots that is not an array", { file: "Foo.ts", symbol: "Foo", to: "Bar", roots: "." }, "roots is required"],
        [
            "a number in roots",
            { file: "Foo.ts", symbol: "Foo", to: "Bar", roots: [".", 2] },
            "roots[1] must be a string",
        ],
        [
            "includeShadowed as a string",
            { file: "Foo.ts", symbol: "Foo", to: "Bar", roots: ["."], includeShadowed: "yes" },
            "includeShadowed must be true or false",
        ],
    ])("refuses %s with code 2 naming the path", (_name, value, message) => {
        const err = refusal(() => renameModuleParamsFromJson(value));

        expect(err.code).toBe(2);
        expect(err.message).toContain(message);
    });
});

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FableReplaceError } from "./internal";
import { countMatches, recon } from "./recon";

// recon() answers --find --json and the MCP tool genesis_replace_find: one report as data and no printed line. These
// tests pin its counts against countMatches on the same files, `declares` from shadowedFiles, the paths relative to
// cwd, and the refusals that keep a typo in roots from reading as "nothing names it". One temp folder for the file.

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const CONSOLE_METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

let dir = "";

const put = (rel: string, content: string): void => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
};

/** Runs `fn` with every console method spied, and returns what it answered and every call the spies saw. */
const silently = <T>(fn: () => T): { value: T; printed: unknown[][] } => {
    const spies = CONSOLE_METHODS.map((method) => spyOn(console, method));
    try {
        const value = fn();
        return { value, printed: spies.flatMap((spy) => spy.mock.calls) };
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

    throw new Error("recon accepted the call");
};

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "recon-report-"));
    put("src/foo.ts", "export const Foo = 1;\nexport const twice = Foo + Foo;\n");
    put("src/use.ts", 'import { Foo } from "./foo";\nexport const one = Foo;\n');
    put("src/view.tsx", 'import { Foo } from "./foo";\n');
    // A literal hit for findFiles that is no identifier hit: countMatches gives 0, so the row is left out.
    put("src/near.ts", "export const FooBar = 1;\n");
    put("src/notes.md", "Foo is named in prose.\n");
    put("node_modules/pkg/index.ts", "export const Foo = 0;\n");
    put("wrap/foo.ts", 'import { Foo as Base } from "../src/foo";\nexport const Foo = Base;\n');
});

afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("recon", () => {
    test("three files naming Foo, one declaring it: total, per-file counts and declares, with nothing printed", () => {
        const { value: report, printed } = silently(() => recon({ roots: ["src"], pattern: "Foo", cwd: dir }));

        expect(printed).toEqual([]);
        expect(report).toEqual({
            v: 1,
            pattern: "Foo",
            roots: ["src"],
            total: 6,
            files: [
                { file: path.join("src", "foo.ts"), count: 3, declares: true },
                { file: path.join("src", "use.ts"), count: 2, declares: false },
                { file: path.join("src", "view.tsx"), count: 1, declares: false },
            ],
        });
        const absolute = report.files.map((row) => path.join(dir, row.file));
        const direct = countMatches({ files: absolute, pattern: "Foo", quiet: true });
        expect(report.files.map((row) => row.count)).toEqual(absolute.map((file) => direct[file]));
    });

    test("a RegExp counts as countMatches does, declares nothing, and names the pattern as /source/flags", () => {
        const pattern = /Foo\b/i;
        const { value: report, printed } = silently(() =>
            recon({ roots: ["."], pattern, exts: [".ts", ".tsx", ".md"], cwd: dir })
        );

        expect(printed).toEqual([]);
        expect(report.pattern).toBe("/Foo\\b/i");
        expect(report.files.map((row) => row.file)).toEqual([
            path.join("src", "foo.ts"),
            path.join("src", "notes.md"),
            path.join("src", "use.ts"),
            path.join("src", "view.tsx"),
            path.join("wrap", "foo.ts"),
        ]);
        expect(report.files.every((row) => !row.declares)).toBe(true);
        const absolute = report.files.map((row) => path.join(dir, row.file));
        const direct = countMatches({ files: absolute, pattern, quiet: true });
        expect(report.files.map((row) => row.count)).toEqual(absolute.map((file) => direct[file]));
        expect(report.total).toBe(report.files.reduce((sum, row) => sum + row.count, 0));
    });

    test("a file that imports and declares the name (a local wrapper) declares it too", () => {
        const report = recon({ roots: ["wrap"], pattern: "Foo", cwd: dir });

        expect(report.files).toEqual([{ file: path.join("wrap", "foo.ts"), count: 2, declares: true }]);
    });

    test("a root outside cwd keeps its files absolute", () => {
        const report = recon({ roots: [path.join(dir, "src")], pattern: "Foo", cwd: path.join(dir, "wrap") });

        expect(report.files.map((row) => row.file)).toEqual([
            path.join(dir, "src", "foo.ts"),
            path.join(dir, "src", "use.ts"),
            path.join(dir, "src", "view.tsx"),
        ]);
    });

    test("no root, a missing root and an empty pattern are refused with code 2", () => {
        expect(refusal(() => recon({ roots: [], pattern: "Foo", cwd: dir })).code).toBe(2);
        const missing = refusal(() => recon({ roots: ["src", "srcc"], pattern: "Foo", cwd: dir }));
        expect(missing.code).toBe(2);
        expect(missing.message).toContain("srcc");
        expect(refusal(() => recon({ roots: ["src"], pattern: "", cwd: dir })).code).toBe(2);
    });
});

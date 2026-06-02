import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { extractSymbols } from "./lib/extract";
import { packByBudget } from "./lib/pack";
import { rankFiles } from "./lib/rank";
import { renderJson, renderTree } from "./lib/render";
import { scanRepo } from "./lib/scanner";
import type { ScannedFile } from "./lib/types";

const TS_SAMPLE = `import { x } from "./other";

export function foo(a: number, b: string): string {
    return b + a;
}

export const bar = (n: number): number => {
    return n + 1;
};

export class Baz {
    method(x: string): void {}
}

export interface Q {
    a: number;
}

export type T = { a: number };

function notExported() {
    return 1;
}
`;

describe("extractSymbols (typescript)", () => {
    const syms = extractSymbols(TS_SAMPLE, "typescript");
    const byName = (name: string) => syms.find((s) => s.name === name);

    test("extracts exported function signature without body", () => {
        expect(byName("foo")).toEqual({
            kind: "function",
            name: "foo",
            signature: "export function foo(a: number, b: string): string",
        });
    });

    test("extracts exported arrow-const signature without body", () => {
        expect(byName("bar")).toEqual({
            kind: "const",
            name: "bar",
            signature: "export const bar = (n: number): number =>",
        });
    });

    test("extracts exported class signature without body", () => {
        expect(byName("Baz")).toEqual({
            kind: "class",
            name: "Baz",
            signature: "export class Baz",
        });
    });

    test("extracts interface and type-alias signatures", () => {
        expect(byName("Q")?.kind).toBe("interface");
        expect(byName("Q")?.signature).toBe("export interface Q { a: number; }");
        expect(byName("T")).toEqual({
            kind: "type",
            name: "T",
            signature: "export type T = { a: number };",
        });
    });

    test("ignores non-exported top-level declarations", () => {
        expect(byName("notExported")).toBeUndefined();
    });

    test("returns [] for unsupported languages", () => {
        expect(extractSymbols("def foo(): pass", "python")).toEqual([]);
    });
});

describe("rankFiles (deterministic, injected now)", () => {
    const now = 1_700_000_000_000;
    const base = { size: 1000, mtimeMs: now - 86_400_000 };

    test("higher fan-in ranks first when size+recency equal", () => {
        const ranked = rankFiles({
            files: [
                { path: "a", fanIn: 0, ...base },
                { path: "b", fanIn: 5, ...base },
            ],
            now,
        });
        expect(ranked[0].path).toBe("b");
        expect(ranked[1].path).toBe("a");
    });

    test("more recent file ranks higher when size+fanIn equal", () => {
        const ranked = rankFiles({
            files: [
                { path: "old", fanIn: 0, size: 1000, mtimeMs: now - 30 * 86_400_000 },
                { path: "new", fanIn: 0, size: 1000, mtimeMs: now - 1 * 86_400_000 },
            ],
            now,
        });
        expect(ranked[0].path).toBe("new");
    });

    test("does not read the system clock (stable across calls)", () => {
        const input = { files: [{ path: "a", fanIn: 1, ...base }], now };
        expect(rankFiles(input)[0].rank).toBe(rankFiles(input)[0].rank);
    });
});

describe("packByBudget (greedy, counts injected)", () => {
    const files = [
        { path: "a", rank: 0.9, tokens: 100 },
        { path: "b", rank: 0.5, tokens: 100 },
        { path: "c", rank: 0.1, tokens: 100 },
    ];

    test("includes files in rank order until budget exceeded", () => {
        const res = packByBudget({ files, budget: 250 });
        expect(res.included.map((f) => f.path)).toEqual(["a", "b"]);
        expect(res.elided.map((f) => f.path)).toEqual(["c"]);
    });

    test("never exceeds the budget", () => {
        const res = packByBudget({ files, budget: 250 });
        const sum = res.included.reduce((acc, f) => acc + f.tokens, 0);
        expect(sum).toBeLessThanOrEqual(250);
        expect(res.usedTokens).toBe(sum);
    });

    test("skips an over-budget high-rank file but keeps fitting lower ones", () => {
        const mixed = [
            { path: "big", rank: 0.9, tokens: 500 },
            { path: "small", rank: 0.5, tokens: 100 },
        ];
        const res = packByBudget({ files: mixed, budget: 200 });
        expect(res.included.map((f) => f.path)).toEqual(["small"]);
        expect(res.elided.map((f) => f.path)).toEqual(["big"]);
    });

    test("does not mutate input order", () => {
        const input = [...files];
        packByBudget({ files: input, budget: 100 });
        expect(input.map((f) => f.path)).toEqual(["a", "b", "c"]);
    });
});

function fakeScanned(path: string): ScannedFile {
    return {
        path,
        absPath: join(tmpdir(), path),
        language: "typescript",
        size: 100,
        mtimeMs: 0,
        imports: [],
        symbols: [{ kind: "function", name: "foo", signature: "export function foo(): void" }],
    };
}

describe("render", () => {
    const root = join(tmpdir(), "proj");
    const included = [{ file: fakeScanned("a.ts"), tokens: 20 }];
    const elided = [fakeScanned("b.ts")];
    const summary = { root, budget: 8000, usedTokens: 20, filesIncluded: 1, filesTotal: 2 };

    test("renderTree lists files, signatures, and an elision note", () => {
        const text = renderTree({ ...summary, included, elided, filesOnly: false });
        expect(text).toContain("a.ts");
        expect(text).toContain("export function foo(): void");
        expect(text).toContain("1 file");
    });

    test("renderTree files-only omits signatures", () => {
        const text = renderTree({ ...summary, included, elided, filesOnly: true });
        expect(text).not.toContain("export function foo(): void");
        expect(text).toContain("a.ts");
    });

    test("renderJson produces a SafeJSON-parseable object with required keys", () => {
        const obj = renderJson({ ...summary, included, elided });
        const parsed = SafeJSON.parse(SafeJSON.stringify(obj));
        expect(parsed.root).toBe(root);
        expect(parsed.filesIncluded).toBe(1);
        expect(parsed.files[0].path).toBe("a.ts");
        expect(parsed.elided).toEqual(["b.ts"]);
    });
});

async function makeTmpRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "repo-map-test-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), `export function aFn(): void {}\n`);
    writeFileSync(join(dir, "src", "b.ts"), `import { aFn } from "./a";\nexport const bVal = (): number => 1;\n`);
    writeFileSync(join(dir, "ignored.log"), "noise\n");
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    const git = (args: string[]) =>
        Bun.spawn(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited;
    await git(["init"]);
    await git(["add", "-A"]);
    return dir;
}

describe("scanRepo (hermetic tmp git repo)", () => {
    test("finds tracked source files, extracts symbols, computes fan-in, respects .gitignore", async () => {
        const dir = await makeTmpRepo();
        const result = await scanRepo({ dir, languages: null });
        const paths = result.files.map((f) => f.path).sort();

        expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
        const a = result.files.find((f) => f.path === "src/a.ts");
        const b = result.files.find((f) => f.path === "src/b.ts");
        expect(a?.symbols.some((s) => s.name === "aFn")).toBe(true);
        expect(b?.symbols.some((s) => s.name === "bVal")).toBe(true);
        expect(result.fanIn["src/a.ts"]).toBe(1);
        expect(result.fanIn["src/b.ts"] ?? 0).toBe(0);
        expect((a?.tokens ?? 0) > 0).toBe(true);
    });
});

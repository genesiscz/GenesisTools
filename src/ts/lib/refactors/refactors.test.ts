import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles } from "../collect";
import { type FileSymbols, findDuplicates } from "../duplicates";
import { parseModule } from "../parse";
import { enrichSymbols, extractSkeleton, parseSource } from "../skeleton";
import type { ParsedModule } from "../types";
import { godFilesAnalyser } from "./godFiles";
import { longFunctionsAnalyser } from "./longFunctions";
import { paramBloatAnalyser } from "./paramBloat";
import type { Analyser } from "./types";
import { resolveSpecifier, unusedExportsAnalyser } from "./unusedExports";

function entry(file: string, text: string): FileSymbols {
    return { file, text, symbols: enrichSymbols(extractSkeleton(parseSource(file, text)), text, { hash: true }) };
}

function run(analyser: Analyser, files: { file: string; text: string }[], options = {}) {
    const entries = files.map(({ file, text }) => entry(file, text));
    const modules = new Map<string, ParsedModule>(
        files.map(({ file, text }) => [file, parseModule(text, file)] as const)
    );

    return analyser.run({ entries, modules, options });
}

const CLIENT =
    "export function token(): string {\n\treturn 'x';\n}\nexport function other(): number {\n\treturn 1;\n}\n";

describe("unused-exports", () => {
    test("a namespace import uses the whole module", () => {
        // The parser reports `import * as ns` as the name `*`; the first version matched it
        // against nothing and called every export of the imported module dead.
        const found = run(unusedExportsAnalyser, [
            { file: "src/lib/client.ts", text: CLIENT },
            { file: "src/feature/use.ts", text: 'import * as client from "../lib/client";\nclient.token();\n' },
        ]);

        expect(found.some((recommendation) => recommendation.title.includes("client.ts"))).toBe(false);
    });

    test("a star re-export uses the whole module too", () => {
        const found = run(unusedExportsAnalyser, [
            { file: "src/lib/client.ts", text: CLIENT },
            { file: "src/lib/barrel.ts", text: 'export * from "./client";\n' },
        ]);

        expect(found.some((recommendation) => recommendation.title.includes("client.ts"))).toBe(false);
    });

    test("an export nobody reaches is still reported", () => {
        const found = run(unusedExportsAnalyser, [
            { file: "src/lib/client.ts", text: CLIENT },
            { file: "src/feature/use.ts", text: 'import { token } from "../lib/client";\ntoken();\n' },
        ]);

        expect(found[0]?.sites.map((site) => site.name)).toEqual(["other"]);
    });

    test("resolveSpecifier follows relative paths, index files and aliased tails", () => {
        const files = ["src/lib/client.ts", "src/lib/json2md/index.ts"];

        expect(resolveSpecifier("src/feature/use.ts", "../lib/client", files)).toEqual(["src/lib/client.ts"]);
        expect(resolveSpecifier("src/feature/use.ts", "../lib/json2md", files)).toEqual(["src/lib/json2md/index.ts"]);
        expect(resolveSpecifier("src/feature/use.ts", "@scope/pkg/lib/json2md", files)).toEqual([
            "src/lib/json2md/index.ts",
        ]);
        expect(resolveSpecifier("src/feature/use.ts", "node:fs", files)).toEqual([]);
    });
});

describe("the method pattern rule", () => {
    const store = (name: string) =>
        `export class ${name} {\n\tsave(): void {\n\t\tconst row = this.read();\n\t\tthis.db.write(row, "log");\n\t\tthis.db.flush();\n\t}\n}\n`;

    test("unrelated classes that pasted the same method are reported", () => {
        // 🛑 These sit in four directories under the scan root with unrelated names. The first
        // version hid them as a family because every file shares SOME parent.
        const report = findDuplicates([
            entry("src/billing/Invoices.ts", store("Invoices")),
            entry("src/orders/Baskets.ts", store("Baskets")),
            entry("src/users/Accounts.ts", store("Accounts")),
            entry("src/audit/Trail.ts", store("Trail")),
        ]);

        expect(report.groups.some((group) => group.names.includes("save"))).toBe(true);
    });

    test("a family named as one is still suppressed at the scan root", () => {
        const report = findDuplicates([
            entry("src/a/LandingScreen.ts", store("LandingScreen")),
            entry("src/b/BillingScreen.ts", store("BillingScreen")),
            entry("src/c/ProfileScreen.ts", store("ProfileScreen")),
            entry("src/d/SupportScreen.ts", store("SupportScreen")),
        ]);

        // Two families: the four `save()` methods and the four `*Screen` classes around them.
        expect(report.groups).toHaveLength(0);
        expect(report.suppressed.patterns).toBe(2);
    });
});

describe("--recommend", () => {
    const helper = "function parseLimit(raw: string): number {\n\tconst value = Number(raw);\n\treturn value;\n}\n";

    test("does not name a command file as the shared home", () => {
        const report = findDuplicates(
            [entry("src/tool/commands/a.ts", helper), entry("src/tool/commands/b.ts", helper)],
            { recommend: true }
        );

        expect(report.groups[0]?.action).toContain("no copy lives in a shared module");
        expect(report.groups[0]?.action).toContain("src/tool/commands/");
    });

    test("imports from the shared copy when one exists", () => {
        const report = findDuplicates(
            [entry("src/tool/lib/parse.ts", `export ${helper}`), entry("src/tool/commands/b.ts", helper)],
            { recommend: true }
        );

        expect(report.groups[0]?.action).toContain("from src/tool/lib/parse.ts");
    });
});

describe("long-functions, param-bloat, god-files", () => {
    test("long-functions reports a body over the budget with its nesting", () => {
        const body = Array.from({ length: 8 }, (_, index) => `\tconst v${index} = ${index};`).join("\n");
        const found = run(longFunctionsAnalyser, [{ file: "src/a.ts", text: `function big(): void {\n${body}\n}\n` }], {
            maxFunctionLines: 5,
        });

        expect(found[0]?.title).toContain("`big` runs 10 lines");
    });

    test("param-bloat flags two same-typed neighbours a caller can swap", () => {
        const found = run(paramBloatAnalyser, [
            {
                file: "src/a.ts",
                text: "function open(cwd: string, ref: string, path: string, depth: number, all: boolean): void {\n\treturn;\n}\n",
            },
        ]);

        expect(found[0]?.detail[1]).toContain("2 adjacent pairs share a type");
    });

    test("god-files reports only the outlier", () => {
        const many = Array.from({ length: 12 }, (_, index) => `export const c${index} = ${index};`).join("\n");
        const found = run(
            godFilesAnalyser,
            [
                { file: "src/big.ts", text: many },
                ...Array.from({ length: 10 }, (_, index) => ({
                    file: `src/s${index}.ts`,
                    text: "export const x = 1;\n",
                })),
            ],
            { maxDeclarations: 5 }
        );

        expect(found.map((recommendation) => recommendation.sites[0]?.file)).toEqual(["src/big.ts"]);
    });
});

describe("collectFiles --ignore", () => {
    test("skips any path containing the substring", () => {
        const root = mkdtempSync(join(tmpdir(), "ts-collect-"));

        mkdirSync(join(root, "vendor"));
        writeFileSync(join(root, "keep.ts"), "export const a = 1;\n");
        writeFileSync(join(root, "vendor", "copy.ts"), "export const b = 1;\n");

        const found = collectFiles(root, { ignore: ["vendor"] });

        expect(found.map((file) => file.slice(root.length + 1))).toEqual(["keep.ts"]);
    });
});

import { describe, expect, test } from "bun:test";
import { findAliasImports, shipsAndRuns } from "./check-plugin-standalone";

describe("findAliasImports", () => {
    test("a wrapped named import is caught: the specifier sits on its own line", () => {
        const text = [
            'import { readFileSync } from "node:fs";',
            "import {",
            "    SafeJSON,",
            "    type SafeJsonOptions,",
            '} from "@genesiscz/utils/json";',
            "",
            "export const x = 1;",
        ].join("\n");
        expect(findAliasImports(text)).toEqual([{ line: 5, specifier: "@genesiscz/utils/json" }]);
    });

    test("single-line, type, re-export, side-effect and dynamic imports of both aliases", () => {
        const text = [
            'import { a } from "@genesiscz/utils/format";',
            'import type { B } from "@app/youtube/lib/types";',
            "export * from '@genesiscz/utils/table';",
            'import "@app/side-effect";',
            'const lazy = await import("@genesiscz/utils/json");',
            'import { fine } from "node:path";',
            'import { alsoFine } from "./sibling";',
        ].join("\n");
        expect(findAliasImports(text).map((found) => `${found.line}:${found.specifier}`)).toEqual([
            "1:@genesiscz/utils/format",
            "2:@app/youtube/lib/types",
            "3:@genesiscz/utils/table",
            "4:@app/side-effect",
            "5:@genesiscz/utils/json",
        ]);
    });

    test("a file with only relative and package imports is clean", () => {
        const text = 'import { x } from "./x";\nimport { y } from "node:fs";\nimport {\n    z,\n} from "picocolors";\n';
        expect(findAliasImports(text)).toEqual([]);
    });
});

describe("shipsAndRuns", () => {
    test("tests and eval fixtures are exempt, runnable plugin files are not", () => {
        expect(shipsAndRuns("plugins/genesis-tools/hooks/announce.ts")).toBe(true);
        expect(shipsAndRuns("plugins/genesis-tools/hooks/announce.test.ts")).toBe(false);
        expect(shipsAndRuns("plugins/genesis-tools/skills/x/evals/fixture.ts")).toBe(false);
    });
});

describe("PR #422 review regressions", () => {
    test("a specifier inside a string or a comment is not an import", () => {
        const text = [
            "const doc = 'import { a } from \"@app/x\"';",
            '// import "@genesiscz/utils/json";',
            '/* export * from "@app/y"; */',
            'const tpl = `import("@app/z")`;',
        ].join("\n");
        expect(findAliasImports(text)).toEqual([]);
    });

    test("a dynamic import with a comment before the specifier, and a require, are caught", () => {
        const text = [
            'const a = await import(/* lazy */ "@app/lazy");',
            'const b = require("@genesiscz/utils/json");',
        ].join("\n");
        expect(findAliasImports(text)).toEqual([
            { line: 1, specifier: "@app/lazy" },
            { line: 2, specifier: "@genesiscz/utils/json" },
        ]);
    });
});

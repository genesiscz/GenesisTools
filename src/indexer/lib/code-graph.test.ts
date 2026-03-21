import { describe, expect, test } from "bun:test";
import { buildCodeGraph, getGraphStats, toMermaidDiagram } from "./code-graph";
import { extractImports } from "./graph-imports";

describe("extractImports", () => {
    describe("TypeScript/JavaScript", () => {
        test("extracts static imports", () => {
            const source = `
import { foo } from "./foo";
import bar from "../bar";
import * as baz from "./baz";
`;
            const imports = extractImports(source, "typescript");
            expect(imports).toHaveLength(3);
            expect(imports[0].specifier).toBe("./foo");
            expect(imports[0].isDynamic).toBe(false);
            expect(imports[1].specifier).toBe("../bar");
            expect(imports[2].specifier).toBe("./baz");
        });

        test("extracts require calls", () => {
            const source = `const x = require("./module");`;
            const imports = extractImports(source, "typescript");
            expect(imports.some((i) => i.specifier === "./module")).toBe(true);
        });

        test("extracts dynamic imports", () => {
            const source = `const mod = await import("./lazy");`;
            const imports = extractImports(source, "typescript");
            const dynImport = imports.find((i) => i.specifier === "./lazy");
            expect(dynImport).toBeTruthy();
            expect(dynImport!.isDynamic).toBe(true);
        });

        test("extracts re-exports", () => {
            const source = `export { default } from "./other";`;
            const imports = extractImports(source, "typescript");
            expect(imports.some((i) => i.specifier === "./other")).toBe(true);
        });
    });

    describe("Python", () => {
        test("extracts import statements", () => {
            const source = `
import os
import foo.bar
`;
            const imports = extractImports(source, "python");
            expect(imports).toHaveLength(2);
            expect(imports[0].specifier).toBe("os");
            expect(imports[1].specifier).toBe("foo.bar");
        });

        test("extracts from...import statements", () => {
            const source = `from mypackage.utils import helper`;
            const imports = extractImports(source, "python");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("mypackage.utils");
        });
    });

    describe("Go", () => {
        test("extracts single imports", () => {
            const source = `import "github.com/user/repo"`;
            const imports = extractImports(source, "go");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("github.com/user/repo");
        });

        test("extracts grouped imports", () => {
            const source = `
import (
    "fmt"
    "github.com/user/repo"
    "github.com/other/pkg"
)
`;
            const imports = extractImports(source, "go");
            // fmt is skipped (no dot = stdlib)
            expect(imports).toHaveLength(2);
            expect(imports[0].specifier).toBe("github.com/user/repo");
            expect(imports[1].specifier).toBe("github.com/other/pkg");
        });

        test("filters out stdlib imports", () => {
            const source = `import "fmt"`;
            const imports = extractImports(source, "go");
            expect(imports).toHaveLength(0);
        });
    });
});

describe("buildCodeGraph", () => {
    test("builds graph from TypeScript files", () => {
        const files = new Map<string, string>([
            ["src/index.ts", `import { helper } from "./utils/helper";`],
            ["src/utils/helper.ts", `import { format } from "./format";`],
            ["src/utils/format.ts", `export function format() {}`],
        ]);

        const graph = buildCodeGraph(files, "/project");

        expect(graph.nodes.length).toBeGreaterThanOrEqual(3);

        // index.ts -> utils/helper.ts
        const edge1 = graph.edges.find((e) => e.from === "src/index.ts" && e.to === "src/utils/helper.ts");
        expect(edge1).toBeTruthy();

        // utils/helper.ts -> utils/format.ts
        const edge2 = graph.edges.find((e) => e.from === "src/utils/helper.ts" && e.to === "src/utils/format.ts");
        expect(edge2).toBeTruthy();
    });

    test("skips unresolvable imports (external packages)", () => {
        const files = new Map<string, string>([
            ["src/app.ts", `import { something } from "lodash"; import { local } from "./local";`],
            ["src/local.ts", `export const local = 1;`],
        ]);

        const graph = buildCodeGraph(files, "/project");

        // Only the local import should be an edge
        expect(graph.edges).toHaveLength(1);
        expect(graph.edges[0].to).toBe("src/local.ts");
    });

    test("handles files with no imports", () => {
        const files = new Map<string, string>([["src/standalone.ts", `export const x = 42;`]]);

        const graph = buildCodeGraph(files, "/project");
        expect(graph.nodes.length).toBe(1);
        expect(graph.edges.length).toBe(0);
    });

    test("resolves index files", () => {
        const files = new Map<string, string>([
            ["src/app.ts", `import { util } from "./utils";`],
            ["src/utils/index.ts", `export const util = 1;`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        expect(graph.edges).toHaveLength(1);
        expect(graph.edges[0].to).toBe("src/utils/index.ts");
    });
});

describe("toMermaidDiagram", () => {
    test("produces valid Mermaid syntax", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `import { b } from "./b";`],
            ["src/b.ts", `export const b = 1;`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const mermaid = toMermaidDiagram(graph);

        expect(mermaid).toContain("graph LR");
        expect(mermaid).toContain("-->");
    });

    test("respects maxNodes limit", () => {
        const files = new Map<string, string>();

        for (let i = 0; i < 50; i++) {
            files.set(`src/file${i}.ts`, `export const x${i} = ${i};`);
        }

        const graph = buildCodeGraph(files, "/project");
        const mermaid = toMermaidDiagram(graph, { maxNodes: 5 });
        const nodeDeclarations = mermaid.split("\n").filter((l) => l.includes('["'));
        expect(nodeDeclarations.length).toBeLessThanOrEqual(5);
    });

    test("shows dynamic imports with dashed line", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `const mod = await import("./b");`],
            ["src/b.ts", `export const b = 1;`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const mermaid = toMermaidDiagram(graph, { showDynamic: true });
        expect(mermaid).toContain("-.->|dynamic|");
    });
});

describe("getGraphStats", () => {
    test("returns correct counts", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `import { b } from "./b"; import { c } from "./c";`],
            ["src/b.ts", `import { c } from "./c";`],
            ["src/c.ts", `export const c = 1;`],
            ["src/orphan.ts", `export const x = 42;`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const stats = getGraphStats(graph);

        expect(stats.totalNodes).toBe(4);
        expect(stats.totalEdges).toBe(3);
        expect(stats.orphanCount).toBe(1); // orphan.ts
        expect(stats.maxImported!.path).toBe("src/c.ts");
        expect(stats.maxImported!.count).toBe(2);
    });
});

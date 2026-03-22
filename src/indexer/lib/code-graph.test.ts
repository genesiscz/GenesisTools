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

        test("does not double-count nested require calls", () => {
            const source = `const x = foo(require("./module"));`;
            const imports = extractImports(source, "typescript");
            const moduleImports = imports.filter((i) => i.specifier === "./module");
            expect(moduleImports).toHaveLength(1);
        });

        test("does not match myrequire or similar", () => {
            const source = `const x = myrequire("./fake");`;
            const imports = extractImports(source, "typescript");
            expect(imports).toHaveLength(0);
        });
    });

    describe("TSX", () => {
        test("extracts imports from TSX files", () => {
            const source = `import React from "react";\nimport { Button } from "./Button";`;
            const imports = extractImports(source, "tsx");
            expect(imports).toHaveLength(2);
            expect(imports[0].specifier).toBe("react");
            expect(imports[1].specifier).toBe("./Button");
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

        test("extracts comma-separated imports", () => {
            const source = `import os, sys, json`;
            const imports = extractImports(source, "python");
            expect(imports).toHaveLength(3);
            expect(imports.map((i) => i.specifier)).toEqual(["os", "sys", "json"]);
        });

        test("extracts aliased imports", () => {
            const source = `import numpy as np\nimport pandas as pd`;
            const imports = extractImports(source, "python");
            expect(imports).toHaveLength(2);
            expect(imports[0].specifier).toBe("numpy");
            expect(imports[1].specifier).toBe("pandas");
        });

        test("extracts relative from-imports", () => {
            const source = `from . import utils\nfrom ..models import User`;
            const imports = extractImports(source, "python");
            expect(imports).toHaveLength(2);
            expect(imports[0].specifier).toBe(".");
            expect(imports[1].specifier).toBe("..models");
        });

        test("ignores imports inside comments and strings", () => {
            const source = `# import fake\nx = "import also_fake"\nimport real`;
            const imports = extractImports(source, "python");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("real");
        });
    });

    describe("Go", () => {
        test("extracts single imports", () => {
            const source = `import "github.com/user/repo"`;
            const imports = extractImports(source, "go");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("github.com/user/repo");
        });

        test("extracts grouped imports including stdlib", () => {
            const source = `
import (
    "fmt"
    "github.com/user/repo"
    "github.com/other/pkg"
)
`;
            const imports = extractImports(source, "go");
            expect(imports).toHaveLength(3);
            expect(imports[0].specifier).toBe("fmt");
            expect(imports[1].specifier).toBe("github.com/user/repo");
            expect(imports[2].specifier).toBe("github.com/other/pkg");
        });

        test("extracts stdlib imports (filtering is done at resolution layer)", () => {
            const source = `import "fmt"`;
            const imports = extractImports(source, "go");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("fmt");
        });

        test("extracts aliased imports", () => {
            const source = `import cfg "example.com/config"`;
            const imports = extractImports(source, "go");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("example.com/config");
        });

        test("extracts blank identifier imports", () => {
            const source = `import _ "modernc.org/sqlite"`;
            const imports = extractImports(source, "go");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("modernc.org/sqlite");
        });

        test("extracts all imports from grouped block including aliases", () => {
            const source = `
import (
    "fmt"
    _ "github.com/lib/pq"
    cfg "github.com/user/config"
    "github.com/user/repo"
)
`;
            const imports = extractImports(source, "go");
            expect(imports).toHaveLength(4);
            expect(imports.map((i) => i.specifier)).toContain("fmt");
            expect(imports.map((i) => i.specifier)).toContain("github.com/lib/pq");
            expect(imports.map((i) => i.specifier)).toContain("github.com/user/config");
            expect(imports.map((i) => i.specifier)).toContain("github.com/user/repo");
        });

        test("ignores imports inside comments", () => {
            const source = `
package main
// import "fake"
import "github.com/real/pkg"
`;
            const imports = extractImports(source, "go");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("github.com/real/pkg");
        });
    });

    describe("Java", () => {
        test("extracts import declarations", () => {
            const source = `import com.example.models.User;\nimport com.example.utils.Helper;`;
            const imports = extractImports(source, "java");
            expect(imports).toHaveLength(2);
            expect(imports[0].specifier).toBe("com.example.models.User");
            expect(imports[1].specifier).toBe("com.example.utils.Helper");
        });

        test("extracts static imports", () => {
            const source = `import static org.junit.Assert.assertEquals;`;
            const imports = extractImports(source, "java");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("org.junit.Assert.assertEquals");
        });

        test("extracts wildcard imports", () => {
            const source = `import java.util.*;`;
            const imports = extractImports(source, "java");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("java.util.*");
        });
    });

    describe("Rust", () => {
        test("extracts use declarations", () => {
            const source = `use std::collections::HashMap;\nuse crate::models::User;`;
            const imports = extractImports(source, "rust");
            expect(imports).toHaveLength(2);
            expect(imports[0].specifier).toBe("std::collections::HashMap");
            expect(imports[1].specifier).toBe("crate::models::User");
        });

        test("extracts mod declarations (external file references)", () => {
            const source = `mod config;\nmod utils;`;
            const imports = extractImports(source, "rust");
            expect(imports).toHaveLength(2);
            expect(imports[0].specifier).toBe("config");
            expect(imports[1].specifier).toBe("utils");
        });

        test("ignores inline mod definitions", () => {
            const source = `mod inline {\n    pub fn foo() {}\n}`;
            const imports = extractImports(source, "rust");
            expect(imports).toHaveLength(0);
        });

        test("extracts grouped use declarations", () => {
            const source = `use std::io::{self, Read, Write};`;
            const imports = extractImports(source, "rust");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("std::io::{self, Read, Write}");
        });
    });

    describe("C/C++", () => {
        test("extracts local includes (quoted)", () => {
            const source = `#include "myheader.h"\n#include "utils/helpers.h"`;
            const imports = extractImports(source, "c");
            expect(imports).toHaveLength(2);
            expect(imports[0].specifier).toBe("myheader.h");
            expect(imports[1].specifier).toBe("utils/helpers.h");
        });

        test("skips system includes (angle brackets)", () => {
            const source = `#include <stdio.h>\n#include <stdlib.h>\n#include "local.h"`;
            const imports = extractImports(source, "c");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("local.h");
        });

        test("works for C++ files", () => {
            const source = `#include "myclass.hpp"\n#include <iostream>`;
            const imports = extractImports(source, "cpp");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("myclass.hpp");
        });
    });

    describe("Ruby", () => {
        test("extracts require statements", () => {
            const source = `require "json"\nrequire "fileutils"`;
            const imports = extractImports(source, "ruby");
            expect(imports).toHaveLength(2);
            expect(imports[0].specifier).toBe("json");
            expect(imports[1].specifier).toBe("fileutils");
        });

        test("extracts require_relative statements", () => {
            const source = `require_relative "./helper"\nrequire_relative "../models/user"`;
            const imports = extractImports(source, "ruby");
            expect(imports).toHaveLength(2);
            expect(imports[0].specifier).toBe("./helper");
            expect(imports[1].specifier).toBe("../models/user");
        });

        test("handles parenthesized form", () => {
            const source = `require("net/http")`;
            const imports = extractImports(source, "ruby");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("net/http");
        });
    });

    describe("Swift", () => {
        test("extracts import declarations", () => {
            const source = `import Foundation\nimport UIKit`;
            const imports = extractImports(source, "swift");
            expect(imports).toHaveLength(2);
            expect(imports[0].specifier).toBe("Foundation");
            expect(imports[1].specifier).toBe("UIKit");
        });

        test("extracts submodule imports", () => {
            const source = `import struct Foundation.URL`;
            const imports = extractImports(source, "swift");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("struct Foundation.URL");
        });
    });

    describe("PHP", () => {
        test("extracts use declarations", () => {
            const source = `<?php\nuse App\\Models\\User;\nuse App\\Services\\AuthService;`;
            const imports = extractImports(source, "php");
            expect(imports).toHaveLength(2);
            expect(imports[0].specifier).toBe("App\\Models\\User");
            expect(imports[1].specifier).toBe("App\\Services\\AuthService");
        });

        test("extracts grouped use declarations", () => {
            const source = `<?php\nuse App\\Models\\{User, Post, Comment};`;
            const imports = extractImports(source, "php");
            expect(imports).toHaveLength(3);
            expect(imports[0].specifier).toBe("App\\Models\\User");
            expect(imports[1].specifier).toBe("App\\Models\\Post");
            expect(imports[2].specifier).toBe("App\\Models\\Comment");
        });

        test("extracts require/include statements", () => {
            const source = `<?php\nrequire_once './config.php';\ninclude 'helpers.php';`;
            const imports = extractImports(source, "php");
            expect(imports).toHaveLength(2);
            expect(imports[0].specifier).toBe("./config.php");
            expect(imports[1].specifier).toBe("helpers.php");
        });

        test("handles aliased use", () => {
            const source = `<?php\nuse App\\Models\\User as UserModel;`;
            const imports = extractImports(source, "php");
            expect(imports).toHaveLength(1);
            expect(imports[0].specifier).toBe("App\\Models\\User");
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

    test("builds graph from C files with includes", () => {
        const files = new Map<string, string>([
            ["src/main.c", `#include "utils.h"\n#include <stdio.h>`],
            ["src/utils.h", `void helper();`],
            ["src/utils.c", `#include "utils.h"\nvoid helper() {}`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const edge = graph.edges.find((e) => e.from === "src/main.c" && e.to === "src/utils.h");
        expect(edge).toBeTruthy();
    });

    test("builds graph from Rust files with mod", () => {
        const files = new Map<string, string>([
            ["src/main.rs", `mod config;\nfn main() {}`],
            ["src/config.rs", `pub fn load() {}`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const edge = graph.edges.find((e) => e.from === "src/main.rs" && e.to === "src/config.rs");
        expect(edge).toBeTruthy();
    });

    test("builds graph from Python files with relative imports", () => {
        const files = new Map<string, string>([
            ["app/main.py", `from .utils import helper`],
            ["app/utils.py", `def helper(): pass`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
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

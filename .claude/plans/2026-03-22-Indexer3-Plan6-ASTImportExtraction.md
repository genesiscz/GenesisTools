# Indexer v3 — Plan 6: AST-Based Import Extraction (Python, Go + More Languages)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace regex-based import extraction for Python and Go with robust ast-grep AST parsing, and add import extraction for 8+ additional languages already supported by our AST chunker.

**Architecture:** Rewrite `extractPythonImports()` and `extractGoImports()` to use `@ast-grep/napi` `findAll()` with language-specific node kinds. Add new extractors for Java, Rust, C/C++, Ruby, Swift, PHP using the same pattern. Wire all extractors into the central `extractImports()` dispatcher and update `code-graph.ts` to support the new languages. All grammars are already installed from Plan 2 and loaded via `ensureDynamicLanguages()` in `chunker.ts`.

**Tech Stack:** TypeScript/Bun, @ast-grep/napi, dynamic language grammars (already installed via `@ast-grep/lang-*`)

**Key files:**
- `src/indexer/lib/graph-imports.ts` — import extraction (main target)
- `src/indexer/lib/code-graph.ts` — graph builder, language detection, resolution
- `src/indexer/lib/code-graph.test.ts` — tests
- `src/indexer/lib/chunker.ts` — reference for `ensureDynamicLanguages()` pattern
- `.worktrees/socraticode/src/services/graph-imports.ts` — SocratiCode reference implementation
- `.worktrees/socraticode/src/services/graph-resolution.ts` — SocratiCode resolution reference

**PR threads to resolve:** PR #116 t5, t41, t42, t95, t96

---

## Task 1: Refactor graph-imports.ts — Add Dynamic Language Infrastructure

**Files:**
- Modify: `src/indexer/lib/graph-imports.ts`

**Steps:**

1. **Add dynamic language registration to graph-imports.ts**

   Import the `ensureDynamicLanguages` logic. Since `chunker.ts` already has this function but it's not exported, we need to extract it to a shared location or duplicate it. The cleanest approach: extract to a shared utility.

   In `src/indexer/lib/graph-imports.ts`, add imports and the registration call at the top:

   ```typescript
   import { createRequire } from "node:module";
   import { Lang, parse, registerDynamicLanguage } from "@ast-grep/napi";

   const esmRequire = createRequire(import.meta.url);

   let dynamicLangsRegistered = false;

   function ensureDynamicLanguages(): void {
       if (dynamicLangsRegistered) {
           return;
       }

       dynamicLangsRegistered = true;

       const langPackages: Array<[string, string]> = [
           ["python", "@ast-grep/lang-python"],
           ["go", "@ast-grep/lang-go"],
           ["rust", "@ast-grep/lang-rust"],
           ["java", "@ast-grep/lang-java"],
           ["c", "@ast-grep/lang-c"],
           ["cpp", "@ast-grep/lang-cpp"],
           ["ruby", "@ast-grep/lang-ruby"],
           ["php", "@ast-grep/lang-php"],
           ["swift", "@ast-grep/lang-swift"],
           ["kotlin", "@ast-grep/lang-kotlin"],
           ["scala", "@ast-grep/lang-scala"],
           ["csharp", "@ast-grep/lang-csharp"],
       ];

       const modules: Record<string, { libraryPath: string; extensions: string[]; languageSymbol?: string }> = {};

       for (const [name, pkg] of langPackages) {
           try {
               modules[name] = esmRequire(pkg);
           } catch {
               // Grammar not installed — skip
           }
       }

       if (Object.keys(modules).length > 0) {
           registerDynamicLanguage(modules);
       }
   }
   ```

   > **NOTE:** We duplicate this from chunker.ts rather than extracting to a shared file because the two registration calls are idempotent (the flag prevents double registration) and chunker.ts may already have registered them. The `registerDynamicLanguage` call in ast-grep is safe to call multiple times with the same names — it's a no-op for already-registered languages.

2. **Add a helper type alias for the AST root node**

   Keep the existing `AstRoot` type but ensure it works with dynamic languages too:

   ```typescript
   type AstRoot = ReturnType<ReturnType<typeof parse>["root"]>;
   ```

   This already exists — no change needed.

3. **Commit:** `refactor(indexer): add dynamic language registration to graph-imports`

---

## Task 2: Replace Python Regex with AST-grep

**Files:**
- Modify: `src/indexer/lib/graph-imports.ts`
- Modify: `src/indexer/lib/code-graph.test.ts`

**Context from PR reviews:**
- **t41:** Regex `^import\s+(\S+)` misses comma-separated imports like `import os, sys` — captures `"os,"` and loses `sys`
- **t5:** Gemini flagged regex approach as brittle, recommends ast-grep
- **t95:** `require()`/`import()` regex matching is imprecise

**SocratiCode reference** (`.worktrees/socraticode/src/services/graph-imports.ts` lines 141-159):
- `findAll({ rule: { kind: "import_statement" } })` for `import foo` — text regex to split comma-separated, strip aliases
- `findAll({ rule: { kind: "import_from_statement" } })` for `from foo import bar` — text regex to get module

**Steps:**

1. **Write failing tests for Python edge cases (the bugs from t41)**

   In `src/indexer/lib/code-graph.test.ts`, add inside the `describe("Python")` block:

   ```typescript
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
   ```

2. **Run tests — confirm they fail**

   ```bash
   bun test src/indexer/lib/code-graph.test.ts
   ```

3. **Rewrite `extractPythonImports` to use ast-grep**

   Replace the existing function body in `src/indexer/lib/graph-imports.ts`:

   ```typescript
   /** Extract Python imports via ast-grep AST parsing */
   function extractPythonImports(source: string): ImportInfo[] {
       ensureDynamicLanguages();
       const imports: ImportInfo[] = [];

       try {
           const root = parse("python" as Lang, source).root();

           // import foo / import foo, bar / import foo as f
           for (const node of root.findAll({ rule: { kind: "import_statement" } })) {
               const text = node.text();
               const match = text.match(/^import\s+(.+)/);

               if (match) {
                   for (const mod of match[1].split(",")) {
                       const cleaned = mod.trim().split(/\s+as\s+/)[0].trim();

                       if (cleaned) {
                           imports.push({ specifier: cleaned, isDynamic: false });
                       }
                   }
               }
           }

           // from foo import bar / from . import utils
           for (const node of root.findAll({ rule: { kind: "import_from_statement" } })) {
               const text = node.text();
               const match = text.match(/^from\s+(\S+)\s+import/);

               if (match) {
                   imports.push({ specifier: match[1], isDynamic: false });
               }
           }
       } catch {
           return [];
       }

       return imports;
   }
   ```

   > Key differences from regex version:
   > - AST parsing means imports inside comments/strings are ignored
   > - `import_statement` kind matches only real import nodes
   > - Comma-separated imports handled by splitting the text after "import"
   > - Aliases stripped via `split(/\s+as\s+/)[0]`

4. **Update the `extractImports` switch to call the AST version**

   The switch case for `"python"` already calls `extractPythonImports(source)` — no change needed since the function signature is the same.

5. **Run tests — confirm they pass**

   ```bash
   cd /Users/Martin/Tresors/Projects/GenesisTools && bun test src/indexer/lib/code-graph.test.ts
   ```

6. **Commit:** `feat(indexer): replace Python regex import extraction with ast-grep AST parsing`

---

## Task 3: Replace Go Regex with AST-grep

**Files:**
- Modify: `src/indexer/lib/graph-imports.ts`
- Modify: `src/indexer/lib/code-graph.test.ts`

**Context from PR reviews:**
- **t96:** Regex misses aliased imports (`import cfg "example.com/cfg"`) and blank imports (`import _ "modernc.org/sqlite"`)
- **t5:** Same as Python — ast-grep recommended over regex

**SocratiCode reference** (`.worktrees/socraticode/src/services/graph-imports.ts` lines 200-208):
- `findAll({ rule: { kind: "import_spec" } })` for each import spec
- Navigate to child: `find({ rule: { kind: "interpreted_string_literal" } })` to extract the path string

**Steps:**

1. **Write failing tests for Go edge cases**

   In `src/indexer/lib/code-graph.test.ts`, add inside `describe("Go")`:

   ```typescript
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
   ```

   > **Design decision:** The old regex skipped stdlib by checking `spec.includes(".")`. With AST-based extraction, we extract ALL imports (including stdlib like `"fmt"`) and let the resolution layer in `code-graph.ts` decide what to skip. This is cleaner separation of concerns and matches SocratiCode's approach. Update the existing tests accordingly.

   Update the existing test "filters out stdlib imports":
   ```typescript
   test("extracts stdlib imports (filtering is done at resolution layer)", () => {
       const source = `import "fmt"`;
       const imports = extractImports(source, "go");
       expect(imports).toHaveLength(1);
       expect(imports[0].specifier).toBe("fmt");
   });
   ```

   And update the existing grouped imports test:
   ```typescript
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
   ```

2. **Run tests — confirm new tests fail**

   ```bash
   cd /Users/Martin/Tresors/Projects/GenesisTools && bun test src/indexer/lib/code-graph.test.ts
   ```

3. **Rewrite `extractGoImports` to use ast-grep**

   Replace in `src/indexer/lib/graph-imports.ts`:

   ```typescript
   /** Extract Go imports via ast-grep AST parsing */
   function extractGoImports(source: string): ImportInfo[] {
       ensureDynamicLanguages();
       const imports: ImportInfo[] = [];

       try {
           const root = parse("go" as Lang, source).root();

           // Each import_spec contains the actual import path
           // Works for both single imports and grouped import blocks
           for (const node of root.findAll({ rule: { kind: "import_spec" } })) {
               const pathNode = node.find({ rule: { kind: "interpreted_string_literal" } });

               if (pathNode) {
                   const spec = pathNode.text().replace(/"/g, "");
                   imports.push({ specifier: spec, isDynamic: false });
               }
           }
       } catch {
           return [];
       }

       return imports;
   }
   ```

   > Key improvements over regex:
   > - Handles aliased imports (`import cfg "..."`) — `import_spec` contains both alias and path, we just extract the string literal
   > - Handles blank imports (`import _ "..."`) — same mechanism
   > - Handles grouped imports naturally — each spec in the group is its own `import_spec` node
   > - Comments are ignored by the AST parser

4. **Run tests — confirm they pass**

   ```bash
   cd /Users/Martin/Tresors/Projects/GenesisTools && bun test src/indexer/lib/code-graph.test.ts
   ```

5. **Commit:** `feat(indexer): replace Go regex import extraction with ast-grep AST parsing`

---

## Task 4: Fix tsx/jsx Language Detection (PR t42)

**Files:**
- Modify: `src/indexer/lib/code-graph.ts`
- Modify: `src/indexer/lib/code-graph.test.ts`

**Context from PR t42:** `.tsx`/`.jsx` files are mapped to `"typescript"` by `getLanguage()`, so they never reach the `"tsx"` branch in `extractImports()`.

**Steps:**

1. **Write a failing test**

   ```typescript
   test("extracts imports from TSX files", () => {
       const source = `import React from "react";\nimport { Button } from "./Button";`;
       const imports = extractImports(source, "tsx");
       expect(imports).toHaveLength(2);
       expect(imports[0].specifier).toBe("react");
       expect(imports[1].specifier).toBe("./Button");
   });
   ```

2. **Fix `getLanguage()` in code-graph.ts**

   Update the switch to return `"tsx"` for `.tsx`/`.jsx` and add all new language extensions:

   ```typescript
   function getLanguage(filePath: string): string | null {
       const ext = extname(filePath).toLowerCase();

       switch (ext) {
           case ".ts":
           case ".js":
           case ".mjs":
           case ".cjs":
               return "typescript";
           case ".tsx":
           case ".jsx":
               return "tsx";
           case ".py":
           case ".pyw":
           case ".pyi":
               return "python";
           case ".go":
               return "go";
           case ".java":
               return "java";
           case ".rs":
               return "rust";
           case ".c":
           case ".h":
               return "c";
           case ".cpp":
           case ".hpp":
           case ".cc":
           case ".hh":
           case ".cxx":
               return "cpp";
           case ".rb":
               return "ruby";
           case ".php":
               return "php";
           case ".swift":
               return "swift";
           case ".kt":
           case ".kts":
               return "kotlin";
           case ".scala":
               return "scala";
           case ".cs":
               return "csharp";
           default:
               return null;
       }
   }
   ```

3. **Run tests — confirm they pass**

4. **Commit:** `fix(indexer): fix tsx/jsx language detection in code graph builder`

---

## Task 5: Add Java Import Extraction

**Files:**
- Modify: `src/indexer/lib/graph-imports.ts`
- Modify: `src/indexer/lib/code-graph.test.ts`

**SocratiCode reference** (lines 177-184): Node kind `import_declaration`, regex `^import\s+(?:static\s+)?([^;]+)`

**Steps:**

1. **Write tests**

   ```typescript
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
   ```

2. **Run tests — confirm they fail**

3. **Add `extractJavaImports` to graph-imports.ts**

   ```typescript
   /** Extract Java imports via ast-grep AST parsing */
   function extractJavaImports(source: string): ImportInfo[] {
       ensureDynamicLanguages();
       const imports: ImportInfo[] = [];

       try {
           const root = parse("java" as Lang, source).root();

           for (const node of root.findAll({ rule: { kind: "import_declaration" } })) {
               const text = node.text();
               const match = text.match(/^import\s+(?:static\s+)?([^;]+)/);

               if (match) {
                   imports.push({ specifier: match[1].trim(), isDynamic: false });
               }
           }
       } catch {
           return [];
       }

       return imports;
   }
   ```

4. **Add `"java"` case to `extractImports` switch**

   ```typescript
   case "java":
       return extractJavaImports(source);
   ```

5. **Run tests — confirm they pass**

6. **Commit:** `feat(indexer): add Java import extraction via ast-grep`

---

## Task 6: Add Rust Import Extraction

**Files:**
- Modify: `src/indexer/lib/graph-imports.ts`
- Modify: `src/indexer/lib/code-graph.test.ts`

**SocratiCode reference** (lines 212-228): Node kinds `use_declaration` and `mod_item`

**Steps:**

1. **Write tests**

   ```typescript
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
   ```

2. **Run tests — confirm they fail**

3. **Add `extractRustImports`**

   ```typescript
   /** Extract Rust imports via ast-grep AST parsing */
   function extractRustImports(source: string): ImportInfo[] {
       ensureDynamicLanguages();
       const imports: ImportInfo[] = [];

       try {
           const root = parse("rust" as Lang, source).root();

           // use std::collections::HashMap;
           for (const node of root.findAll({ rule: { kind: "use_declaration" } })) {
               const text = node.text();
               const match = text.match(/^use\s+(.+);?\s*$/);

               if (match) {
                   imports.push({ specifier: match[1].trim().replace(/;$/, ""), isDynamic: false });
               }
           }

           // mod foo; (external file reference, not inline mod { ... })
           for (const node of root.findAll({ rule: { kind: "mod_item" } })) {
               const text = node.text();

               if (text.includes("{")) {
                   continue;
               }

               const match = text.match(/^mod\s+(\w+)\s*;/);

               if (match) {
                   imports.push({ specifier: match[1], isDynamic: false });
               }
           }
       } catch {
           return [];
       }

       return imports;
   }
   ```

4. **Add `"rust"` case to `extractImports` switch**

5. **Run tests — confirm they pass**

6. **Commit:** `feat(indexer): add Rust import extraction via ast-grep`

---

## Task 7: Add C/C++ Include Extraction

**Files:**
- Modify: `src/indexer/lib/graph-imports.ts`
- Modify: `src/indexer/lib/code-graph.test.ts`

**SocratiCode reference** (lines 283-295): Node kind `preproc_include`, only track local includes (quoted `"..."`)

**Steps:**

1. **Write tests**

   ```typescript
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
   ```

2. **Run tests — confirm they fail**

3. **Add `extractCCppIncludes`**

   ```typescript
   /** Extract C/C++ #include directives via ast-grep AST parsing */
   function extractCCppIncludes(source: string, lang: "c" | "cpp"): ImportInfo[] {
       ensureDynamicLanguages();
       const imports: ImportInfo[] = [];

       try {
           const root = parse(lang as Lang, source).root();

           for (const node of root.findAll({ rule: { kind: "preproc_include" } })) {
               const text = node.text();
               // Only track local includes (quoted), not system includes (angle brackets)
               const localMatch = text.match(/#include\s+"([^"]+)"/);

               if (localMatch) {
                   imports.push({ specifier: localMatch[1], isDynamic: false });
               }
           }
       } catch {
           return [];
       }

       return imports;
   }
   ```

4. **Add `"c"` and `"cpp"` cases to `extractImports` switch**

   ```typescript
   case "c":
       return extractCCppIncludes(source, "c");
   case "cpp":
       return extractCCppIncludes(source, "cpp");
   ```

5. **Run tests — confirm they pass**

6. **Commit:** `feat(indexer): add C/C++ include extraction via ast-grep`

---

## Task 8: Add Ruby Require Extraction

**Files:**
- Modify: `src/indexer/lib/graph-imports.ts`
- Modify: `src/indexer/lib/code-graph.test.ts`

**SocratiCode reference** (lines 247-258): Node kind `call`, match `require` and `require_relative`

**Steps:**

1. **Write tests**

   ```typescript
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
   ```

2. **Run tests — confirm they fail**

3. **Add `extractRubyImports`**

   ```typescript
   /** Extract Ruby require/require_relative via ast-grep AST parsing */
   function extractRubyImports(source: string): ImportInfo[] {
       ensureDynamicLanguages();
       const imports: ImportInfo[] = [];

       try {
           const root = parse("ruby" as Lang, source).root();

           for (const node of root.findAll({ rule: { kind: "call" } })) {
               const text = node.text();
               const reqMatch = text.match(/^require(?:_relative)?\s*[(]?\s*['"]([^'"]+)['"]/);

               if (reqMatch) {
                   imports.push({
                       specifier: reqMatch[1],
                       isDynamic: false,
                   });
               }
           }
       } catch {
           return [];
       }

       return imports;
   }
   ```

4. **Add `"ruby"` case to `extractImports` switch**

5. **Run tests — confirm they pass**

6. **Commit:** `feat(indexer): add Ruby require extraction via ast-grep`

---

## Task 9: Add Swift Import Extraction

**Files:**
- Modify: `src/indexer/lib/graph-imports.ts`
- Modify: `src/indexer/lib/code-graph.test.ts`

**SocratiCode reference** (lines 260-269): Node kind `import_declaration`

**Steps:**

1. **Write tests**

   ```typescript
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
   ```

2. **Run tests — confirm they fail**

3. **Add `extractSwiftImports`**

   ```typescript
   /** Extract Swift imports via ast-grep AST parsing */
   function extractSwiftImports(source: string): ImportInfo[] {
       ensureDynamicLanguages();
       const imports: ImportInfo[] = [];

       try {
           const root = parse("swift" as Lang, source).root();

           for (const node of root.findAll({ rule: { kind: "import_declaration" } })) {
               const text = node.text();
               const match = text.match(/^import\s+(.+)/);

               if (match) {
                   imports.push({ specifier: match[1].trim(), isDynamic: false });
               }
           }
       } catch {
           return [];
       }

       return imports;
   }
   ```

4. **Add `"swift"` case to `extractImports` switch**

5. **Run tests — confirm they pass**

6. **Commit:** `feat(indexer): add Swift import extraction via ast-grep`

---

## Task 10: Add PHP Import Extraction

**Files:**
- Modify: `src/indexer/lib/graph-imports.ts`
- Modify: `src/indexer/lib/code-graph.test.ts`

**SocratiCode reference** (lines 297-334): Node kind `namespace_use_declaration` for `use` statements, `expression_statement` for `require`/`include`

**Steps:**

1. **Write tests**

   ```typescript
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
   ```

2. **Run tests — confirm they fail**

3. **Add `extractPhpImports`**

   ```typescript
   /** Extract PHP use/require/include via ast-grep AST parsing */
   function extractPhpImports(source: string): ImportInfo[] {
       ensureDynamicLanguages();
       const imports: ImportInfo[] = [];

       try {
           const root = parse("php" as Lang, source).root();

           // use App\Models\User; / use App\Models\{User, Post};
           for (const node of root.findAll({ rule: { kind: "namespace_use_declaration" } })) {
               const text = node.text();

               // Grouped use: use App\Models\{User, Post};
               const groupMatch = text.match(/^use\s+(?:function\s+|const\s+)?([\w\\]+)\\\{([^}]+)\}/);

               if (groupMatch) {
                   const prefix = groupMatch[1];
                   const members = groupMatch[2].split(",");

                   for (const member of members) {
                       const name = member.trim().split(/\s+as\s+/)[0].trim();

                       if (name) {
                           imports.push({ specifier: `${prefix}\\${name}`, isDynamic: false });
                       }
                   }

                   continue;
               }

               // Single use: use App\Models\User; or use App\Models\User as Alias;
               const singleMatch = text.match(/^use\s+(?:function\s+|const\s+)?([\w\\]+)/);

               if (singleMatch) {
                   imports.push({ specifier: singleMatch[1].trim(), isDynamic: false });
               }
           }

           // require/require_once/include/include_once
           for (const node of root.findAll({ rule: { kind: "expression_statement" } })) {
               const text = node.text();
               const match = text.match(/(?:require|include)(?:_once)?\s*[(]?\s*['"]([^'"]+)['"]/);

               if (match) {
                   imports.push({ specifier: match[1], isDynamic: false });
               }
           }
       } catch {
           return [];
       }

       return imports;
   }
   ```

4. **Add `"php"` case to `extractImports` switch**

5. **Run tests — confirm they pass**

6. **Commit:** `feat(indexer): add PHP import extraction via ast-grep`

---

## Task 11: Update code-graph.ts to Support All New Languages

**Files:**
- Modify: `src/indexer/lib/code-graph.ts`
- Modify: `src/indexer/lib/code-graph.test.ts`

**Steps:**

1. **Add language-specific extension map and resolution functions**

   Add to `src/indexer/lib/code-graph.ts`:

   ```typescript
   const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
       typescript: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
       tsx: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
       python: [".py"],
       go: [".go"],
       java: [".java"],
       rust: [".rs"],
       c: [".c", ".h"],
       cpp: [".cpp", ".hpp", ".cc", ".hh", ".cxx", ".h"],
       ruby: [".rb"],
       php: [".php"],
       swift: [".swift"],
       kotlin: [".kt", ".kts"],
       scala: [".scala"],
       csharp: [".cs"],
   };
   ```

2. **Add resolution functions for each language**

   ```typescript
   /** Resolve a C/C++ local include to a file path */
   function resolveCInclude(specifier: string, importerPath: string, fileSet: Set<string>): string | null {
       const importerDir = dirname(importerPath);
       const candidate = join(importerDir, specifier);

       if (fileSet.has(candidate)) {
           return candidate;
       }

       return null;
   }

   /** Resolve a Rust mod declaration to a file path */
   function resolveRustMod(specifier: string, importerPath: string, fileSet: Set<string>): string | null {
       if (specifier.includes("::")) {
           return null;
       }

       const importerDir = dirname(importerPath);
       const asFile = join(importerDir, `${specifier}.rs`);

       if (fileSet.has(asFile)) {
           return asFile;
       }

       const asDir = join(importerDir, specifier, "mod.rs");

       if (fileSet.has(asDir)) {
           return asDir;
       }

       return null;
   }

   /** Resolve a JVM (Java/Kotlin/Scala) import to a file path */
   function resolveJvmImport(specifier: string, fileSet: Set<string>, language: string): string | null {
       const filePath = specifier.replace(/\./g, "/");
       const exts = language === "java" ? [".java"] : language === "kotlin" ? [".kt", ".kts"] : [".scala"];

       for (const ext of exts) {
           const candidate = `${filePath}${ext}`;

           if (fileSet.has(candidate)) {
               return candidate;
           }
       }

       const srcDirs = [`src/main/${language}`, "src/main", "src"];

       for (const dir of srcDirs) {
           for (const ext of exts) {
               const candidate = join(dir, `${filePath}${ext}`);

               if (fileSet.has(candidate)) {
                   return candidate;
               }
           }
       }

       return null;
   }

   /** Resolve a PHP namespace import to a file path */
   function resolvePhpImport(specifier: string, importerPath: string, fileSet: Set<string>): string | null {
       if (specifier.startsWith("./") || specifier.startsWith("../")) {
           const importerDir = dirname(importerPath);
           const candidate = join(importerDir, specifier);

           if (fileSet.has(candidate)) {
               return candidate;
           }

           return null;
       }

       if (specifier.includes("\\")) {
           const filePath = specifier.replace(/\\/g, "/");
           const exact = `${filePath}.php`;

           if (fileSet.has(exact)) {
               return exact;
           }

           const segments = filePath.split("/");

           if (segments.length > 1) {
               segments[0] = segments[0].toLowerCase();
               const lowered = `${segments.join("/")}.php`;

               if (fileSet.has(lowered)) {
                   return lowered;
               }
           }

           const withoutRoot = segments.slice(1).join("/");

           if (withoutRoot) {
               const inSrc = `src/${withoutRoot}.php`;

               if (fileSet.has(inSrc)) {
                   return inSrc;
               }
           }
       }

       return null;
   }

   /** Resolve a Ruby require to a file path */
   function resolveRubyImport(specifier: string, importerPath: string, fileSet: Set<string>): string | null {
       if (specifier.startsWith("./") || specifier.startsWith("../")) {
           const importerDir = dirname(importerPath);
           const base = join(importerDir, specifier);

           if (fileSet.has(base)) {
               return base;
           }

           const withExt = `${base}.rb`;

           if (fileSet.has(withExt)) {
               return withExt;
           }
       }

       const fromRoot = `${specifier}.rb`;

       if (fileSet.has(fromRoot)) {
           return fromRoot;
       }

       const underLib = `lib/${specifier}.rb`;

       if (fileSet.has(underLib)) {
           return underLib;
       }

       return null;
   }
   ```

3. **Update the resolution block in `buildCodeGraph()`**

   Make `resolveRelativeImport` accept an optional `language` parameter, and expand the resolution branching:

   ```typescript
   for (const imp of imports) {
       let resolved: string | null = null;

       if (imp.specifier.startsWith(".") || imp.specifier.startsWith("/")) {
           resolved = resolveRelativeImport(imp.specifier, filePath, fileSet, language);
       } else if (language === "python") {
           resolved = resolvePythonImport(imp.specifier, fileSet);
       } else if (language === "c" || language === "cpp") {
           resolved = resolveCInclude(imp.specifier, filePath, fileSet);
       } else if (language === "rust") {
           resolved = resolveRustMod(imp.specifier, filePath, fileSet);
       } else if (language === "java" || language === "kotlin" || language === "scala") {
           resolved = resolveJvmImport(imp.specifier, fileSet, language);
       } else if (language === "php") {
           resolved = resolvePhpImport(imp.specifier, filePath, fileSet);
       } else if (language === "ruby") {
           resolved = resolveRubyImport(imp.specifier, filePath, fileSet);
       }

       if (!resolved) {
           continue;
       }

       edges.push({
           from: filePath,
           to: resolved,
           isDynamic: imp.isDynamic,
       });

       importCounts.set(filePath, (importCounts.get(filePath) ?? 0) + 1);
       importedByCounts.set(resolved, (importedByCounts.get(resolved) ?? 0) + 1);
   }
   ```

4. **Update `resolveRelativeImport` signature to accept optional language**

   ```typescript
   function resolveRelativeImport(
       specifier: string,
       importerPath: string,
       fileSet: Set<string>,
       language?: string,
   ): string | null {
       const importerDir = dirname(importerPath);
       const basePath = join(importerDir, specifier);

       if (fileSet.has(basePath)) {
           return basePath;
       }

       const extensions = language ? (LANGUAGE_EXTENSIONS[language] ?? TS_EXTENSIONS) : TS_EXTENSIONS;

       for (const ext of extensions) {
           const withExt = basePath + ext;

           if (fileSet.has(withExt)) {
               return withExt;
           }
       }

       // Directory index files (TS/JS only)
       if (!language || language === "typescript" || language === "tsx") {
           for (const indexFile of INDEX_FILES) {
               const withIndex = join(basePath, indexFile);

               if (fileSet.has(withIndex)) {
                   return withIndex;
               }
           }
       }

       // Python __init__.py
       if (language === "python") {
           const initFile = join(basePath, "__init__.py");

           if (fileSet.has(initFile)) {
               return initFile;
           }
       }

       return null;
   }
   ```

5. **Write integration tests for multi-language graph building**

   ```typescript
   describe("buildCodeGraph multi-language", () => {
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
   ```

6. **Run all tests**

   ```bash
   cd /Users/Martin/Tresors/Projects/GenesisTools && bun test src/indexer/lib/code-graph.test.ts
   ```

7. **Commit:** `feat(indexer): wire all new language extractors into code graph builder with resolution`

---

## Task 12: Fix JS/TS require/import() Matching (PR t95)

**Files:**
- Modify: `src/indexer/lib/graph-imports.ts`
- Modify: `src/indexer/lib/code-graph.test.ts`

**Context from PR t95:** Running regex against every `call_expression` node text means:
- `foo(require("x"))` records `x` twice (outer call_expression contains inner)
- `myrequire("x")` also falsely matches

**Steps:**

1. **Write failing tests**

   ```typescript
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
   ```

2. **Fix `extractJsTsImports` to inspect the callee node**

   Replace the `call_expression` matching block with callee inspection:

   ```typescript
   // require("...") and dynamic import("...")
   for (const node of root.findAll({ rule: { kind: "call_expression" } })) {
       const funcNode = node.child(0);
       const funcName = funcNode?.text();

       if (funcName === "require") {
           const args = node.find({ rule: { kind: "string" } });

           if (args) {
               const spec = args.text().replace(/['"]/g, "");
               imports.push({ specifier: spec, isDynamic: false });
           }

           continue;
       }

       if (funcName === "import") {
           const args = node.find({ rule: { kind: "string" } });

           if (args) {
               const spec = args.text().replace(/['"]/g, "");
               imports.push({ specifier: spec, isDynamic: true });
           }
       }
   }
   ```

3. **Run tests — confirm they pass**

4. **Commit:** `fix(indexer): inspect callee node for require/import instead of regex on full text`

---

## Task 13: TypeScript Type Check and Final Validation

**Files:**
- All modified files

**Steps:**

1. **Run TypeScript check**

   ```bash
   cd /Users/Martin/Tresors/Projects/GenesisTools && bunx tsgo --noEmit 2>&1 | rg "graph-imports|code-graph"
   ```

2. **Run all indexer tests**

   ```bash
   cd /Users/Martin/Tresors/Projects/GenesisTools && bun test src/indexer/
   ```

3. **Fix any type errors or test failures**

4. **Commit if fixes were needed:** `fix(indexer): address type errors from plan 6 implementation`

---

## Task 14: Reply to PR #116 Review Threads

**Steps:**

1. **Reply to t5 (Gemini — regex for Python/Go is brittle)**

   ```bash
   tools github review respond 116 2969649160 \
     "Addressed in Plan 6. Both Python and Go extractors now use \`@ast-grep/napi\` AST parsing instead of regex. Python uses \`import_statement\` and \`import_from_statement\` node kinds; Go uses \`import_spec\` with \`interpreted_string_literal\` child navigation. Added extractors for 6 more languages (Java, Rust, C/C++, Ruby, Swift, PHP) following the same AST pattern."
   ```

2. **Reply to t41 (comma-separated Python imports)**

   ```bash
   tools github review respond 116 2970152736 \
     "Fixed. \`extractPythonImports\` now uses ast-grep to find \`import_statement\` nodes, then splits the text on commas and strips \`as\` aliases. \`import os, sys\` correctly yields both \`os\` and \`sys\`. Added test case for this exact scenario."
   ```

3. **Reply to t42 (tsx/jsx files never reach TSX parser)**

   ```bash
   tools github review respond 116 2970152739 \
     "Fixed. Updated \`getLanguage()\` in \`code-graph.ts\` to return \`\"tsx\"\` for \`.tsx\` and \`.jsx\` extensions instead of \`\"typescript\"\`. The \`\"tsx\"\` branch in \`extractImports()\` now correctly receives these files and parses them with \`Lang.Tsx\`."
   ```

4. **Reply to t95 (require/import matching on callee)**

   ```bash
   tools github review respond 116 2970205666 \
     "Fixed. \`extractJsTsImports\` now inspects the callee node (\`node.child(0).text()\`) instead of running regex on the full \`call_expression\` text. This prevents double-counting from nested calls like \`foo(require(\"x\"))\` and false matches from \`myrequire(\"x\")\`."
   ```

5. **Reply to t96 (aliased and blank Go imports)**

   ```bash
   tools github review respond 116 2970205669 \
     "Fixed. Go extraction now uses ast-grep \`import_spec\` nodes with \`interpreted_string_literal\` child navigation. This naturally handles aliased imports (\`import cfg \"example.com/cfg\"\`), blank identifier imports (\`import _ \"modernc.org/sqlite\"\`), and grouped imports — the alias/blank token is a separate child node, so the string literal extraction gets just the path."
   ```

6. **Commit:** no code change, just PR replies

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/indexer/lib/graph-imports.ts` | Rewrite Python/Go extractors to use ast-grep; add Java, Rust, C/C++, Ruby, Swift, PHP extractors; fix require/import callee matching; add dynamic language registration |
| `src/indexer/lib/code-graph.ts` | Fix tsx/jsx language detection; expand `getLanguage()` to all 14 languages; add resolution functions for C, Rust, JVM, PHP, Ruby; make `resolveRelativeImport` language-aware |
| `src/indexer/lib/code-graph.test.ts` | Add tests for all new languages, edge cases from PR review, multi-language graph building |

**PR threads resolved:** t5, t41, t42, t95, t96

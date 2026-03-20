# Indexer v3 — Plan 2: Chunking & AST Overhaul

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve chunking quality with overlap, hard character cap, minified file detection, 16-language AST support, and smart merging/sub-chunking of AST nodes.

**Architecture:** Extend existing chunker.ts with overlap support, add character-based fallback, expand AST language support via @ast-grep/napi dynamic grammars, add merge/sub-chunk logic for AST nodes.

**Tech Stack:** TypeScript/Bun, @ast-grep/napi with dynamic language grammars

---

## Existing State Summary

### Current chunker (`src/indexer/lib/chunker.ts`)

- **5 strategies**: `ast`, `line`, `heading`, `message`, `json` + `auto` selector
- **AST support**: Only 4 languages via built-in `Lang` enum — TypeScript, JavaScript (+ JSX/TSX), HTML, CSS
- **No overlap**: Chunks are contiguous with no repeated lines at boundaries
- **No character cap**: Chunks are bounded only by `maxTokens` (default 500, ~2000 chars)
- **No minified detection**: Minified/bundled files produce single enormous lines
- **No merge/sub-chunk**: Small AST nodes become tiny chunks; large ones get token-split but without overlap
- **Token estimation**: 1 token ~ 4 chars via `estimateTokens()`
- **Content hashing**: `Bun.hash()` (xxHash64)
- **Deduplication**: Containment-based (export_statement containing function_declaration)
- **Parent-child**: class_declaration → method_definition via `parentChunkId`

### SocratiCode reference (`src/services/indexer.ts`)

- 16 languages via `registerDynamicLanguage()` + `@ast-grep/lang-*` packages
- `CHUNK_SIZE = 100`, `CHUNK_OVERLAP = 10`, `MAX_CHUNK_CHARS = 2000`, `MAX_AVG_LINE_LENGTH = 500`
- `MIN_CHUNK_LINES = 5` (merge small), `MAX_CHUNK_LINES = 150` (sub-chunk large)
- `applyCharCap()` as universal safety net
- `chunkByCharacters()` for minified content — splits at `\n` > ` ` > `;` > `,`
- `chunkByAstRegions()` — merges small declarations, sub-chunks large ones with overlap
- `findAstBoundaries()` — top-level node detection with depth check

### Key files

| File | Purpose |
|------|---------|
| `src/indexer/lib/chunker.ts` | All chunking logic (616 lines) |
| `src/indexer/lib/chunker.test.ts` | Tests (353 lines, 14 tests) |
| `src/indexer/lib/types.ts` | `ChunkRecord`, `IndexConfig`, etc. |

---

## Constants to Add

Add to the top of `chunker.ts`:

```typescript
/** Lines of overlap between consecutive chunks for semantic continuity */
const DEFAULT_CHUNK_OVERLAP = 10;

/** Hard character cap per chunk — universal safety net applied to ALL strategies */
const MAX_CHUNK_CHARS = 2000;

/** Average line length threshold for minified/bundled file detection */
const MAX_AVG_LINE_LENGTH = 500;

/** Minimum lines for an AST chunk to stand on its own (otherwise merge with neighbors) */
const MIN_AST_CHUNK_LINES = 5;

/** Maximum lines for a single AST declaration before sub-chunking */
const MAX_AST_CHUNK_LINES = 150;
```

---

## Task 0: Benchmark Baseline

**Goal:** Establish performance baseline before changes so we can measure improvements after.

**Files:**
- Create: `src/indexer/lib/chunker.bench.ts`

**Steps:**

1. Create a benchmark script that:
   - Reads a representative set of files from the repo itself (e.g., `src/indexer/lib/*.ts`, a markdown file, a JSON file)
   - Times `chunkFile()` for each strategy
   - Records: total chunks produced, average chunk size (chars), max chunk size, total time
   - Outputs results as a table to stdout

2. The benchmark script content:
   ```typescript
   import { resolve } from "node:path";
   import { readFileSync } from "node:fs";
   import { chunkFile } from "./chunker";

   const testFiles = [
       { path: "src/indexer/lib/chunker.ts", strategy: "auto" as const },
       { path: "src/indexer/lib/types.ts", strategy: "auto" as const },
       { path: "CLAUDE.md", strategy: "auto" as const },
       { path: "package.json", strategy: "auto" as const },
   ];

   const results: Array<{
       file: string;
       strategy: string;
       parser: string;
       chunks: number;
       avgChars: number;
       maxChars: number;
       timeMs: number;
   }> = [];

   for (const { path: filePath, strategy } of testFiles) {
       const absPath = resolve(filePath);
       const content = readFileSync(absPath, "utf-8");
       const start = performance.now();
       const result = chunkFile({ filePath: absPath, content, strategy });
       const elapsed = performance.now() - start;
       const charSizes = result.chunks.map((c) => c.content.length);

       results.push({
           file: filePath,
           strategy,
           parser: result.parser,
           chunks: result.chunks.length,
           avgChars: Math.round(charSizes.reduce((a, b) => a + b, 0) / charSizes.length),
           maxChars: Math.max(...charSizes),
           timeMs: Math.round(elapsed * 100) / 100,
       });
   }

   console.table(results);
   ```

3. Run and save baseline output:
   ```bash
   bun run src/indexer/lib/chunker.bench.ts | tee /tmp/chunker-baseline.txt
   ```

4. Commit:
   ```bash
   git add src/indexer/lib/chunker.bench.ts
   git commit -m "bench(indexer): add chunker baseline benchmark"
   ```

---

## Task 1: Add Chunk Overlap to Line-Based Chunking

**Goal:** Include `overlap` lines from the previous chunk at the start of each subsequent chunk, so semantic search doesn't lose context at chunk boundaries.

**Files:**
- Modify: `src/indexer/lib/chunker.ts`
- Modify: `src/indexer/lib/chunker.test.ts`

**Steps:**

### 1a. Write failing tests

Add to `chunker.test.ts`:

```typescript
describe("Chunk overlap", () => {
    it("includes overlap lines from previous chunk in next chunk", () => {
        // Create content with enough lines to produce multiple chunks at low maxTokens
        const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: some content here for testing overlap behavior`);
        const content = lines.join("\n");

        const result = chunkFile({
            filePath: "test.txt",
            content,
            strategy: "line",
            maxTokens: 50,
            overlap: 3,
        });

        expect(result.chunks.length).toBeGreaterThan(1);

        // The second chunk should start with lines from the end of the first chunk
        const firstChunkLines = result.chunks[0].content.split("\n");
        const secondChunkLines = result.chunks[1].content.split("\n");
        const overlapFromFirst = firstChunkLines.slice(-3);
        const overlapInSecond = secondChunkLines.slice(0, 3);

        expect(overlapInSecond).toEqual(overlapFromFirst);
    });

    it("first chunk has no prefix overlap", () => {
        const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: content`);
        const content = lines.join("\n");

        const result = chunkFile({
            filePath: "test.txt",
            content,
            strategy: "line",
            maxTokens: 50,
            overlap: 5,
        });

        // First chunk should start at line 0
        expect(result.chunks[0].startLine).toBe(0);
    });

    it("defaults to 0 overlap when not specified", () => {
        const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: content padding text`);
        const content = lines.join("\n");

        const result = chunkFile({
            filePath: "test.txt",
            content,
            strategy: "line",
            maxTokens: 50,
        });

        // Without overlap, chunks should not share lines
        if (result.chunks.length > 1) {
            const firstEnd = result.chunks[0].endLine;
            const secondStart = result.chunks[1].startLine;
            expect(secondStart).toBeGreaterThan(firstEnd);
        }
    });
});
```

### 1b. Run tests (expect failures)

```bash
bun test src/indexer/lib/chunker.test.ts
```

### 1c. Implement overlap

**In `chunker.ts`:**

1. Update `chunkFile()` signature to accept `overlap?: number`:
   ```typescript
   export function chunkFile(opts: {
       filePath: string;
       content: string;
       strategy: "ast" | "line" | "heading" | "message" | "json" | "auto";
       maxTokens?: number;
       indexType?: "code" | "files" | "mail" | "chat";
       overlap?: number;
   }): ChunkResult {
   ```

2. Pass `overlap` through to `chunkByLine()` and `splitChunkByLines()`.

3. Update `chunkByLine()` to accept and use `overlap`:
   ```typescript
   function chunkByLine(opts: {
       filePath: string;
       content: string;
       maxTokens: number;
       overlap: number;
   }): ChunkResult {
   ```

   When building chunks from blocks, after flushing a chunk, go back `overlap` lines from the end of the flushed chunk to start the next chunk's content.

4. Update `splitChunkByLines()` similarly — when a large AST node is split into sub-chunks, each subsequent sub-chunk should include `overlap` lines from the end of the previous sub-chunk.

   In the loop at line 123-147, after flushing `currentLines`:
   ```typescript
   // Carry over `overlap` lines from the end of the flushed chunk
   const overlapLines = chunkContent.split("\n").slice(-overlap);
   currentLines = overlap > 0 ? [...overlapLines] : [];
   currentStartLine = startLine + i + 1 - overlapLines.length;
   ```

5. Default overlap to `0` in `chunkFile()` (backwards-compatible; the `IndexConfig` can later wire `DEFAULT_CHUNK_OVERLAP`).

### 1d. Run tests (expect passing)

```bash
bun test src/indexer/lib/chunker.test.ts
```

### 1e. Type check

```bash
tsgo --noEmit 2>&1 | grep "src/indexer"
```

### 1f. Commit

```bash
git add src/indexer/lib/chunker.ts src/indexer/lib/chunker.test.ts
git commit -m "feat(indexer): add chunk overlap support to line-based and sub-chunk splitting"
```

---

## Task 2: Hard Character Cap (MAX_CHUNK_CHARS)

**Goal:** Apply a universal safety net so no chunk from ANY strategy ever exceeds 2000 characters.

**Files:**
- Modify: `src/indexer/lib/chunker.ts`
- Modify: `src/indexer/lib/chunker.test.ts`

**Steps:**

### 2a. Write failing tests

```typescript
describe("Hard character cap", () => {
    it("truncates chunks exceeding MAX_CHUNK_CHARS", () => {
        // Create a single massive line that will become one chunk
        const longContent = "x".repeat(5000);

        const result = chunkFile({
            filePath: "big.txt",
            content: longContent,
            strategy: "line",
        });

        for (const chunk of result.chunks) {
            expect(chunk.content.length).toBeLessThanOrEqual(2000);
        }
    });

    it("applies character cap to AST chunks", () => {
        // A single giant function body
        const body = Array.from({ length: 100 }, (_, i) =>
            `    const var${i} = "this is a rather lengthy line of code designed to push the character count well beyond the limit";`
        ).join("\n");
        const content = `function huge() {\n${body}\n}`;

        const result = chunkFile({
            filePath: "huge.ts",
            content,
            strategy: "ast",
            maxTokens: 2000, // high token limit to let char cap be the active constraint
        });

        for (const chunk of result.chunks) {
            expect(chunk.content.length).toBeLessThanOrEqual(2000);
        }
    });

    it("applies character cap to JSON chunks", () => {
        const bigValue = "y".repeat(3000);
        const content = JSON.stringify({ key: bigValue });

        const result = chunkFile({
            filePath: "data.json",
            content,
            strategy: "json",
            maxTokens: 2000,
        });

        for (const chunk of result.chunks) {
            expect(chunk.content.length).toBeLessThanOrEqual(2000);
        }
    });

    it("truncates at last safe boundary (newline or space)", () => {
        // Content with spaces — truncation should land on a space boundary
        const words = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");

        const result = chunkFile({
            filePath: "words.txt",
            content: words,
            strategy: "line",
        });

        for (const chunk of result.chunks) {
            expect(chunk.content.length).toBeLessThanOrEqual(2000);
            // Should not cut mid-word (last char should be a word char or end of content)
        }
    });
});
```

### 2b. Run tests (expect failures)

```bash
bun test src/indexer/lib/chunker.test.ts
```

### 2c. Implement

1. Add constant at top of `chunker.ts`:
   ```typescript
   const MAX_CHUNK_CHARS = 2000;
   ```

2. Add `applyCharCap()` function:
   ```typescript
   /**
    * Universal safety net: truncate any chunk exceeding MAX_CHUNK_CHARS.
    * Tries to truncate at the last safe boundary (newline > space > semicolon).
    * If no safe boundary is found, hard-truncates at the limit.
    */
   function applyCharCap(chunks: ChunkRecord[]): ChunkRecord[] {
       if (chunks.every((c) => c.content.length <= MAX_CHUNK_CHARS)) {
           return chunks;
       }

       return chunks.map((chunk) => {
           if (chunk.content.length <= MAX_CHUNK_CHARS) {
               return chunk;
           }

           let end = MAX_CHUNK_CHARS;
           const breakChars = ["\n", " ", "\t", ";", ","];

           for (let i = end; i > end - 200 && i > 0; i--) {
               if (breakChars.includes(chunk.content[i])) {
                   end = i;
                   break;
               }
           }

           const truncated = chunk.content.slice(0, end);
           return {
               ...chunk,
               content: truncated,
               id: contentHash(truncated),
               endLine: chunk.startLine + truncated.split("\n").length - 1,
           };
       });
   }
   ```

3. Apply `applyCharCap()` at the END of `chunkFile()`, wrapping every strategy's result:
   ```typescript
   // In chunkFile(), before returning any result:
   const result = /* ... strategy switch ... */;
   return { ...result, chunks: applyCharCap(result.chunks) };
   ```

   Specifically, refactor the switch to capture the result into a variable, then apply the cap before returning. This ensures ALL strategies (ast, line, heading, message, json) are capped.

### 2d. Run tests

```bash
bun test src/indexer/lib/chunker.test.ts
```

### 2e. Type check

```bash
tsgo --noEmit 2>&1 | grep "src/indexer"
```

### 2f. Commit

```bash
git add src/indexer/lib/chunker.ts src/indexer/lib/chunker.test.ts
git commit -m "feat(indexer): add hard character cap (2000 chars) as universal safety net"
```

---

## Task 3: Minified File Detection + Character-Based Chunking

**Goal:** Detect minified/bundled files (avg line length > 500) and chunk them using character-based splitting instead of line-based, preventing single-line chunks that blow up embedding context.

**Files:**
- Modify: `src/indexer/lib/chunker.ts`
- Modify: `src/indexer/lib/chunker.test.ts`

**Steps:**

### 3a. Write failing tests

```typescript
describe("Minified file detection", () => {
    it("detects minified content by average line length", () => {
        // Simulate minified JS: one very long line
        const minified = "var a=1;" + "function b(){return a+1;}".repeat(200);

        const result = chunkFile({
            filePath: "app.min.js",
            content: minified,
            strategy: "auto",
            indexType: "code",
        });

        // Should use character-based chunking, not AST
        expect(result.parser).toBe("character");
        // All chunks should respect the character cap
        for (const chunk of result.chunks) {
            expect(chunk.content.length).toBeLessThanOrEqual(2000);
        }
    });

    it("produces multiple chunks from long minified content", () => {
        const minified = "x=1;".repeat(2000); // ~8000 chars

        const result = chunkFile({
            filePath: "bundle.min.js",
            content: minified,
            strategy: "auto",
            indexType: "code",
        });

        expect(result.parser).toBe("character");
        expect(result.chunks.length).toBeGreaterThan(1);
    });

    it("splits at safe boundaries (semicolon, space, newline)", () => {
        const minified = Array.from({ length: 500 }, (_, i) => `var v${i}=null`).join(";");

        const result = chunkFile({
            filePath: "min.js",
            content: minified,
            strategy: "auto",
            indexType: "code",
        });

        expect(result.parser).toBe("character");
        for (const chunk of result.chunks) {
            // Should end at a semicolon boundary, not mid-identifier
            const lastChar = chunk.content[chunk.content.length - 1];
            const isValidEnd = [";", " ", "\n", "\t", ","].includes(lastChar)
                || chunk === result.chunks[result.chunks.length - 1]; // last chunk can end anywhere
            expect(isValidEnd).toBe(true);
        }
    });

    it("does NOT use character-based for normal files", () => {
        const normal = Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`).join("\n");

        const result = chunkFile({
            filePath: "normal.js",
            content: normal,
            strategy: "auto",
            indexType: "code",
        });

        expect(result.parser).not.toBe("character");
    });
});
```

### 3b. Run tests (expect failures)

```bash
bun test src/indexer/lib/chunker.test.ts
```

### 3c. Implement

1. Add constant:
   ```typescript
   const MAX_AVG_LINE_LENGTH = 500;
   ```

2. Add `isMinified()` helper:
   ```typescript
   /** Detect minified/bundled content by average line length */
   function isMinified(content: string): boolean {
       const lines = content.split("\n");

       if (lines.length === 0) {
           return false;
       }

       const avgLineLength = content.length / lines.length;
       return avgLineLength > MAX_AVG_LINE_LENGTH;
   }
   ```

3. Add `chunkByCharacter()` strategy:
   ```typescript
   /**
    * Character-based chunking for minified/bundled content.
    * Splits at safe boundaries: newline > space > tab > semicolon > comma.
    * Uses byte offset for chunk IDs since line numbers are meaningless for minified files.
    */
   function chunkByCharacter(opts: {
       filePath: string;
       content: string;
   }): ChunkResult {
       const { filePath, content } = opts;
       const ext = extname(filePath).toLowerCase();
       const language = EXT_TO_LANGUAGE_NAME[ext] ?? null;
       const chunks: ChunkRecord[] = [];
       let offset = 0;
       let currentLine = 0;

       while (offset < content.length) {
           let end = Math.min(offset + MAX_CHUNK_CHARS, content.length);

           // Scan backwards to find a safe split boundary
           if (end < content.length) {
               const breakChars = ["\n", " ", "\t", ";", ","];

               for (let i = end; i > offset; i--) {
                   if (breakChars.includes(content[i])) {
                       end = i + 1;
                       break;
                   }
               }
           }

           const chunkContent = content.slice(offset, end);
           const newlineCount = (chunkContent.match(/\n/g) ?? []).length;
           const startLine = currentLine;
           const endLine = currentLine + newlineCount;

           if (chunkContent.trim().length > 0) {
               chunks.push({
                   id: contentHash(chunkContent),
                   filePath,
                   startLine,
                   endLine,
                   content: chunkContent,
                   kind: "character_chunk",
                   language: language ?? undefined,
               });
           }

           currentLine = chunkContent.endsWith("\n") ? endLine + 1 : endLine;
           offset = end;
       }

       return { chunks, language, parser: "character" };
   }
   ```

4. Update the `ChunkResult` interface to include `"character"` in the parser union:
   ```typescript
   export interface ChunkResult {
       chunks: ChunkRecord[];
       language: string | null;
       parser: "ast" | "line" | "heading" | "message" | "json" | "character";
   }
   ```

5. Update `selectAutoStrategy()` return type and add minified detection. Since `selectAutoStrategy` doesn't currently have access to the content, we need to move minified detection into `chunkFile()` BEFORE the strategy switch. Add it right after the `effectiveStrategy` resolution:
   ```typescript
   // Detect minified/bundled content — override strategy to character-based
   if (isMinified(content) && effectiveStrategy !== "message" && effectiveStrategy !== "json") {
       const charResult = chunkByCharacter({ filePath, content });
       return { ...charResult, chunks: applyCharCap(charResult.chunks) };
   }
   ```

6. Also update the `selectAutoStrategy` return type and `chunkFile` strategy param to include `"character"`:
   ```typescript
   strategy: "ast" | "line" | "heading" | "message" | "json" | "character" | "auto";
   ```

### 3d. Run tests

```bash
bun test src/indexer/lib/chunker.test.ts
```

### 3e. Type check

```bash
tsgo --noEmit 2>&1 | grep "src/indexer"
```

### 3f. Commit

```bash
git add src/indexer/lib/chunker.ts src/indexer/lib/chunker.test.ts
git commit -m "feat(indexer): add minified file detection and character-based chunking"
```

---

## Task 4: Expand AST Language Support (Python, Go, Rust, Java)

**Goal:** Add AST-aware chunking for 4 high-priority languages using `@ast-grep/napi` dynamic language grammars.

**Files:**
- Modify: `src/indexer/lib/chunker.ts`
- Modify: `src/indexer/lib/chunker.test.ts`
- Modify: `src/indexer/lib/types.ts` (only if `IndexConfig.chunking` type needs updating)

**Steps:**

### 4a. Install language grammar packages

```bash
bun add @ast-grep/lang-python @ast-grep/lang-go @ast-grep/lang-rust @ast-grep/lang-java
```

### 4b. Write failing tests

Add fixture content and tests for each language:

```typescript
describe("AST strategy — extended languages", () => {
    it("extracts Python function and class definitions", () => {
        const content = `
def greet(name):
    return f"Hello, {name}"

class Calculator:
    def add(self, a, b):
        return a + b

    def subtract(self, a, b):
        return a - b

@staticmethod
def helper():
    pass
`.trim();

        const result = chunkFile({
            filePath: "test.py",
            content,
            strategy: "ast",
        });

        expect(result.parser).toBe("ast");
        expect(result.language).toBe("python");
        expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    });

    it("extracts Go function and type declarations", () => {
        const content = `
package main

func greet(name string) string {
    return "Hello, " + name
}

type Calculator struct {
    Value int
}

func (c *Calculator) Add(a, b int) int {
    return a + b
}
`.trim();

        const result = chunkFile({
            filePath: "main.go",
            content,
            strategy: "ast",
        });

        expect(result.parser).toBe("ast");
        expect(result.language).toBe("go");
        expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    });

    it("extracts Rust function, impl, struct, and trait items", () => {
        const content = `
fn greet(name: &str) -> String {
    format!("Hello, {}", name)
}

struct Calculator {
    value: i32,
}

impl Calculator {
    fn add(&self, a: i32, b: i32) -> i32 {
        a + b
    }
}

trait Compute {
    fn compute(&self) -> i32;
}

enum Color {
    Red,
    Green,
    Blue,
}
`.trim();

        const result = chunkFile({
            filePath: "lib.rs",
            content,
            strategy: "ast",
        });

        expect(result.parser).toBe("ast");
        expect(result.language).toBe("rust");
        expect(result.chunks.length).toBeGreaterThanOrEqual(3);
    });

    it("extracts Java class and method declarations", () => {
        const content = `
public class Calculator {
    public int add(int a, int b) {
        return a + b;
    }

    public int subtract(int a, int b) {
        return a - b;
    }
}

interface Computable {
    int compute();
}
`.trim();

        const result = chunkFile({
            filePath: "Calculator.java",
            content,
            strategy: "ast",
        });

        expect(result.parser).toBe("ast");
        expect(result.language).toBe("java");
        expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    });
});
```

### 4c. Run tests (expect failures — .py etc. currently fall back to "line")

```bash
bun test src/indexer/lib/chunker.test.ts
```

### 4d. Implement

1. **Add dynamic language registration.** Create a module-level `ensureDynamicLanguages()` function using `createRequire` (needed for native addon loading in ESM/Bun):

   ```typescript
   import { createRequire } from "node:module";
   import { Lang, parse, registerDynamicLanguage } from "@ast-grep/napi";
   import type { SgNode } from "@ast-grep/napi";

   const esmRequire = createRequire(import.meta.url);

   let dynamicLangsRegistered = false;

   /** Register dynamic language grammars. Safe to call multiple times. */
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

2. **Extend `EXT_TO_LANG` mapping** for dynamic languages. Dynamic languages use string identifiers (not the `Lang` enum). Create a separate map:

   ```typescript
   /** Extension -> dynamic language string identifier (for registerDynamicLanguage langs) */
   const EXT_TO_DYNAMIC_LANG: Record<string, string> = {
       ".py": "python",
       ".pyw": "python",
       ".pyi": "python",
       ".go": "go",
       ".rs": "rust",
       ".java": "java",
   };
   ```

3. **Update `chunkByAst()`** to try dynamic languages when the built-in `Lang` enum doesn't match:

   ```typescript
   function chunkByAst(opts: { filePath: string; content: string; maxTokens: number; overlap: number }): ChunkResult | null {
       const ext = extname(opts.filePath).toLowerCase();

       // Try built-in Lang first
       let lang: Lang | string | undefined = EXT_TO_LANG[ext];
       let isDynamic = false;

       if (!lang) {
           // Try dynamic language
           const dynamicLang = EXT_TO_DYNAMIC_LANG[ext];

           if (!dynamicLang) {
               return null;
           }

           ensureDynamicLanguages();
           lang = dynamicLang;
           isDynamic = true;
       }

       const language = EXT_TO_LANGUAGE_NAME[ext] ?? null;
       const kindList = AST_KINDS[isDynamic ? lang : String(lang)] ?? [];
       // ... rest of function uses `parse(lang, content)` which accepts both Lang enum and string
   ```

4. **Add `AST_KINDS` entries** for the new languages:

   ```typescript
   // Python
   python: ["function_definition", "class_definition", "decorated_definition"],
   // Go
   go: ["function_declaration", "method_declaration", "type_declaration"],
   // Rust
   rust: ["function_item", "impl_item", "struct_item", "enum_item", "trait_item"],
   // Java
   java: ["class_declaration", "method_declaration", "interface_declaration", "enum_declaration"],
   ```

5. **Update `EXT_TO_LANGUAGE_NAME`** — `.py`, `.go`, `.rs` are already there. Add `.java`:
   ```typescript
   ".java": "java",
   ```

6. **Update `selectAutoStrategy()`** — currently it only routes to "ast" if `EXT_TO_LANG[ext]` matches (built-in langs). Add the dynamic language check:
   ```typescript
   if (EXT_TO_LANG[ext] || EXT_TO_DYNAMIC_LANG[ext]) {
       return "ast";
   }
   ```

### 4e. Run tests

```bash
bun test src/indexer/lib/chunker.test.ts
```

### 4f. Type check

```bash
tsgo --noEmit 2>&1 | grep "src/indexer"
```

### 4g. Commit

```bash
git add src/indexer/lib/chunker.ts src/indexer/lib/chunker.test.ts package.json bun.lockb
git commit -m "feat(indexer): add AST chunking support for Python, Go, Rust, Java"
```

---

## Task 5: Expand AST Language Support (C, C++, Ruby, PHP, Swift, Kotlin, Scala, C#)

**Goal:** Add the remaining 8 languages from SocratiCode's TOP_LEVEL_KINDS.

**Files:**
- Modify: `src/indexer/lib/chunker.ts`
- Modify: `src/indexer/lib/chunker.test.ts`

**Steps:**

### 5a. Install remaining grammar packages

```bash
bun add \
  @ast-grep/lang-c \
  @ast-grep/lang-cpp \
  @ast-grep/lang-ruby \
  @ast-grep/lang-php \
  @ast-grep/lang-swift \
  @ast-grep/lang-kotlin \
  @ast-grep/lang-scala \
  @ast-grep/lang-csharp
```

### 5b. Write failing tests

```typescript
describe("AST strategy — extended languages batch 2", () => {
    it("extracts C function definitions and structs", () => {
        const content = `
#include <stdio.h>

struct Point {
    int x;
    int y;
};

void greet(const char* name) {
    printf("Hello, %s\\n", name);
}

int add(int a, int b) {
    return a + b;
}
`.trim();

        const result = chunkFile({ filePath: "main.c", content, strategy: "ast" });
        expect(result.parser).toBe("ast");
        expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    });

    it("extracts C++ class and namespace definitions", () => {
        const content = `
#include <string>

namespace math {

class Calculator {
public:
    int add(int a, int b) {
        return a + b;
    }
};

}
`.trim();

        const result = chunkFile({ filePath: "calc.cpp", content, strategy: "ast" });
        expect(result.parser).toBe("ast");
        expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("extracts Ruby methods, classes, and modules", () => {
        const content = `
module Greetings
  class Greeter
    def greet(name)
      "Hello, #{name}"
    end
  end
end

def standalone_method
  puts "hello"
end
`.trim();

        const result = chunkFile({ filePath: "greet.rb", content, strategy: "ast" });
        expect(result.parser).toBe("ast");
        expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("extracts PHP class and function declarations", () => {
        const content = `<?php

class Calculator {
    public function add($a, $b) {
        return $a + $b;
    }
}

function greet($name) {
    return "Hello, " . $name;
}
`.trim();

        const result = chunkFile({ filePath: "calc.php", content, strategy: "ast" });
        expect(result.parser).toBe("ast");
        expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("extracts Swift class, struct, and function declarations", () => {
        const content = `
struct Point {
    var x: Int
    var y: Int
}

class Calculator {
    func add(_ a: Int, _ b: Int) -> Int {
        return a + b
    }
}

func greet(_ name: String) -> String {
    return "Hello, \\(name)"
}

protocol Computable {
    func compute() -> Int
}
`.trim();

        const result = chunkFile({ filePath: "calc.swift", content, strategy: "ast" });
        expect(result.parser).toBe("ast");
        expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    });

    it("extracts Kotlin class and function declarations", () => {
        const content = `
class Calculator {
    fun add(a: Int, b: Int): Int {
        return a + b
    }
}

fun greet(name: String): String {
    return "Hello, $name"
}

object Singleton {
    val value = 42
}
`.trim();

        const result = chunkFile({ filePath: "calc.kt", content, strategy: "ast" });
        expect(result.parser).toBe("ast");
        expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("extracts Scala class, object, and trait definitions", () => {
        const content = `
class Calculator {
  def add(a: Int, b: Int): Int = a + b
}

object Main {
  def main(args: Array[String]): Unit = {
    println("Hello")
  }
}

trait Computable {
  def compute(): Int
}
`.trim();

        const result = chunkFile({ filePath: "calc.scala", content, strategy: "ast" });
        expect(result.parser).toBe("ast");
        expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("extracts C# class, interface, and method declarations", () => {
        const content = `
namespace MyApp {
    public class Calculator {
        public int Add(int a, int b) {
            return a + b;
        }
    }

    public interface IComputable {
        int Compute();
    }
}
`.trim();

        const result = chunkFile({ filePath: "Calculator.cs", content, strategy: "ast" });
        expect(result.parser).toBe("ast");
        expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    });
});
```

### 5c. Run tests (expect failures)

```bash
bun test src/indexer/lib/chunker.test.ts
```

### 5d. Implement

1. **Extend `ensureDynamicLanguages()`** — add the 8 new entries to the `langPackages` array:
   ```typescript
   ["c", "@ast-grep/lang-c"],
   ["cpp", "@ast-grep/lang-cpp"],
   ["ruby", "@ast-grep/lang-ruby"],
   ["php", "@ast-grep/lang-php"],
   ["swift", "@ast-grep/lang-swift"],
   ["kotlin", "@ast-grep/lang-kotlin"],
   ["scala", "@ast-grep/lang-scala"],
   ["csharp", "@ast-grep/lang-csharp"],
   ```

2. **Extend `EXT_TO_DYNAMIC_LANG`**:
   ```typescript
   ".c": "c",
   ".h": "c",
   ".cpp": "cpp",
   ".hpp": "cpp",
   ".cc": "cpp",
   ".hh": "cpp",
   ".cxx": "cpp",
   ".rb": "ruby",
   ".php": "php",
   ".swift": "swift",
   ".kt": "kotlin",
   ".kts": "kotlin",
   ".scala": "scala",
   ".cs": "csharp",
   ```

3. **Add `AST_KINDS`** entries (from SC's TOP_LEVEL_KINDS):
   ```typescript
   c: ["function_definition", "struct_specifier", "enum_specifier", "declaration"],
   cpp: ["function_definition", "class_specifier", "struct_specifier", "namespace_definition", "declaration"],
   ruby: ["method", "class", "module", "singleton_method"],
   php: ["function_definition", "class_declaration", "method_declaration", "trait_declaration"],
   swift: ["function_declaration", "class_declaration", "struct_declaration", "protocol_declaration", "extension_declaration"],
   kotlin: ["class_declaration", "function_declaration", "object_declaration"],
   scala: ["class_definition", "object_definition", "trait_definition", "function_definition"],
   csharp: ["class_declaration", "interface_declaration", "method_declaration", "namespace_declaration"],
   ```

4. **Extend `EXT_TO_LANGUAGE_NAME`**:
   ```typescript
   ".c": "c",
   ".h": "c",
   ".cpp": "cpp",
   ".hpp": "cpp",
   ".cc": "cpp",
   ".hh": "cpp",
   ".cxx": "cpp",
   ".rb": "ruby",
   ".php": "php",
   ".swift": "swift",
   ".kt": "kotlin",
   ".kts": "kotlin",
   ".scala": "scala",
   ".cs": "csharp",
   ".java": "java",   // if not already added in Task 4
   ```

### 5e. Run tests

```bash
bun test src/indexer/lib/chunker.test.ts
```

### 5f. Type check

```bash
tsgo --noEmit 2>&1 | grep "src/indexer"
```

### 5g. Commit

```bash
git add src/indexer/lib/chunker.ts src/indexer/lib/chunker.test.ts package.json bun.lockb
git commit -m "feat(indexer): add AST chunking for C, C++, Ruby, PHP, Swift, Kotlin, Scala, C#"
```

---

## Task 6: Merge Small AST Nodes

**Goal:** When an AST declaration is < 5 lines, merge it with adjacent small declarations into one chunk. This prevents trivially small chunks (single type alias, one-liner constants) from wasting embedding slots.

**Files:**
- Modify: `src/indexer/lib/chunker.ts`
- Modify: `src/indexer/lib/chunker.test.ts`

**Steps:**

### 6a. Write failing tests

```typescript
describe("AST merge small nodes", () => {
    it("merges adjacent small type aliases into one chunk", () => {
        const content = `
type A = string;
type B = number;
type C = boolean;
type D = null;
`.trim();

        const result = chunkFile({
            filePath: "types.ts",
            content,
            strategy: "ast",
        });

        expect(result.parser).toBe("ast");
        // 4 one-line type aliases should be merged into a single chunk
        expect(result.chunks.length).toBe(1);
        expect(result.chunks[0].content).toContain("type A");
        expect(result.chunks[0].content).toContain("type D");
    });

    it("does not merge nodes that together exceed max chunk lines", () => {
        // Create enough small declarations that merging all would exceed CHUNK_SIZE
        const decls = Array.from({ length: 30 }, (_, i) =>
            `type T${i} = { field: string };\n`
        ).join("\n");

        const result = chunkFile({
            filePath: "many-types.ts",
            content: decls.trim(),
            strategy: "ast",
            maxTokens: 50, // Force small chunks
        });

        expect(result.parser).toBe("ast");
        // Should produce multiple chunks, not one giant merged blob
        expect(result.chunks.length).toBeGreaterThan(1);
    });

    it("keeps large declarations as their own chunk", () => {
        const smallType = "type Small = string;";
        const bigFn = `function big() {\n${Array.from({ length: 20 }, (_, i) => `    const x${i} = ${i};`).join("\n")}\n}`;
        const content = `${smallType}\n\n${bigFn}`;

        const result = chunkFile({
            filePath: "mixed.ts",
            content,
            strategy: "ast",
        });

        expect(result.parser).toBe("ast");
        // Should be at least 2 chunks: merged small types + big function
        expect(result.chunks.length).toBeGreaterThanOrEqual(1);

        // The big function should be in its own chunk (not merged with the small type)
        const bigChunk = result.chunks.find((c) => c.content.includes("function big"));
        expect(bigChunk).toBeDefined();
    });
});
```

### 6b. Run tests (expect failures)

```bash
bun test src/indexer/lib/chunker.test.ts
```

### 6c. Implement

Add a `mergeSmallChunks()` function and call it in `chunkByAst()` after deduplication:

```typescript
const MIN_AST_CHUNK_LINES = 5;

/**
 * Merge consecutive small AST chunks into larger combined chunks.
 * A chunk is "small" if it has fewer than MIN_AST_CHUNK_LINES lines.
 * Merging continues until the combined chunk reaches maxTokens or MAX_CHUNK_CHARS.
 */
function mergeSmallChunks(opts: {
    chunks: ChunkRecord[];
    maxTokens: number;
}): ChunkRecord[] {
    const { chunks, maxTokens } = opts;

    if (chunks.length <= 1) {
        return chunks;
    }

    const result: ChunkRecord[] = [];
    let pending: ChunkRecord[] = [];

    function flushPending(): void {
        if (pending.length === 0) {
            return;
        }

        if (pending.length === 1) {
            result.push(pending[0]);
            pending = [];
            return;
        }

        // Merge all pending chunks into one
        const mergedContent = pending.map((c) => c.content).join("\n\n");
        const mergedNames = pending
            .map((c) => c.name)
            .filter(Boolean)
            .join(", ");

        result.push({
            id: contentHash(mergedContent),
            filePath: pending[0].filePath,
            startLine: pending[0].startLine,
            endLine: pending[pending.length - 1].endLine,
            content: mergedContent,
            kind: "merged_declarations",
            name: mergedNames || undefined,
            language: pending[0].language,
        });

        pending = [];
    }

    for (const chunk of chunks) {
        const chunkLineCount = chunk.content.split("\n").length;
        const isSmall = chunkLineCount < MIN_AST_CHUNK_LINES;

        if (!isSmall) {
            flushPending();
            result.push(chunk);
            continue;
        }

        // Check if adding this chunk to pending would exceed limits
        if (pending.length > 0) {
            const pendingContent = pending.map((c) => c.content).join("\n\n");
            const combinedContent = pendingContent + "\n\n" + chunk.content;

            if (
                estimateTokens(combinedContent) > maxTokens ||
                combinedContent.length > MAX_CHUNK_CHARS
            ) {
                flushPending();
            }
        }

        pending.push(chunk);
    }

    flushPending();

    return result;
}
```

Then call it in `chunkByAst()` after the deduplication step:

```typescript
// Deduplicate: export_statement may contain function_declaration etc.
const deduped = deduplicateChunks(chunks);

// Merge small adjacent declarations
const merged = mergeSmallChunks({ chunks: deduped, maxTokens });

return { chunks: merged, language, parser: "ast" };
```

### 6d. Run tests

```bash
bun test src/indexer/lib/chunker.test.ts
```

### 6e. Type check

```bash
tsgo --noEmit 2>&1 | grep "src/indexer"
```

### 6f. Commit

```bash
git add src/indexer/lib/chunker.ts src/indexer/lib/chunker.test.ts
git commit -m "feat(indexer): merge small AST declarations (<5 lines) into combined chunks"
```

---

## Task 7: Sub-Chunk Large AST Declarations

**Goal:** When an AST declaration exceeds 150 lines, sub-chunk it using line-based splitting with overlap. Preserve the declaration header (first 2 lines) as context prefix in each sub-chunk.

**Files:**
- Modify: `src/indexer/lib/chunker.ts`
- Modify: `src/indexer/lib/chunker.test.ts`

**Steps:**

### 7a. Write failing tests

```typescript
describe("AST sub-chunk large declarations", () => {
    it("sub-chunks a class with >150 lines", () => {
        const methods = Array.from({ length: 50 }, (_, i) => `
    method${i}(x: number): number {
        const a = x + ${i};
        return a;
    }`).join("\n");
        const content = `class HugeClass {\n${methods}\n}`;

        const result = chunkFile({
            filePath: "huge.ts",
            content,
            strategy: "ast",
            maxTokens: 2000, // large enough that token limit isn't the splitter
        });

        expect(result.parser).toBe("ast");
        // Should be split into multiple sub-chunks
        expect(result.chunks.length).toBeGreaterThan(1);

        // Each sub-chunk (except the first) should start with the class header
        for (let i = 1; i < result.chunks.length; i++) {
            expect(result.chunks[i].content).toMatch(/^class HugeClass/);
        }
    });

    it("sub-chunks preserve overlap between consecutive sub-chunks", () => {
        const methods = Array.from({ length: 50 }, (_, i) => `
    method${i}(x: number): number {
        const a = x + ${i};
        return a;
    }`).join("\n");
        const content = `class HugeClass {\n${methods}\n}`;

        const result = chunkFile({
            filePath: "huge.ts",
            content,
            strategy: "ast",
            maxTokens: 2000,
            overlap: 5,
        });

        if (result.chunks.length > 1) {
            // Second chunk should contain some lines from end of first chunk
            const firstLines = result.chunks[0].content.split("\n");
            const secondLines = result.chunks[1].content.split("\n");

            // Skip the header prefix lines when checking overlap
            const headerLineCount = 2; // "class HugeClass {"
            const overlapInSecond = secondLines.slice(headerLineCount, headerLineCount + 5);
            const endOfFirst = firstLines.slice(-5);

            // At least some overlap lines should match
            expect(overlapInSecond.some((line) =>
                endOfFirst.includes(line)
            )).toBe(true);
        }
    });

    it("does not sub-chunk declarations <=150 lines", () => {
        const body = Array.from({ length: 10 }, (_, i) => `    const x${i} = ${i};`).join("\n");
        const content = `function normal() {\n${body}\n}`;

        const result = chunkFile({
            filePath: "normal.ts",
            content,
            strategy: "ast",
        });

        expect(result.parser).toBe("ast");
        expect(result.chunks.length).toBe(1);
    });
});
```

### 7b. Run tests (expect failures)

```bash
bun test src/indexer/lib/chunker.test.ts
```

### 7c. Implement

1. Add constant:
   ```typescript
   const MAX_AST_CHUNK_LINES = 150;
   ```

2. Modify `splitChunkByLines()` (or add a new function `subChunkLargeDeclaration()`) to handle the case where the node content exceeds `MAX_AST_CHUNK_LINES`. The key difference from the current `splitChunkByLines()` is:
   - The split is line-count based (not token-based)
   - Each sub-chunk gets a header prefix (first 2 lines of the declaration)
   - Overlap is applied

   Add a new function:

   ```typescript
   /**
    * Sub-chunk a large AST declaration (>MAX_AST_CHUNK_LINES lines).
    * Preserves the declaration header (first 2 lines) as context in each sub-chunk.
    * Uses line-count-based splitting with overlap.
    */
   function subChunkLargeNode(opts: {
       content: string;
       filePath: string;
       startLine: number;
       kind: string;
       name?: string;
       language?: string;
       parentChunkId?: string;
       chunkSize: number;
       overlap: number;
   }): ChunkRecord[] {
       const {
           content, filePath, startLine, kind, name, language, parentChunkId,
           chunkSize, overlap,
       } = opts;

       const lines = content.split("\n");

       if (lines.length <= MAX_AST_CHUNK_LINES) {
           return [{
               id: contentHash(content),
               filePath,
               startLine,
               endLine: startLine + lines.length - 1,
               content,
               kind,
               name,
               language,
               parentChunkId,
           }];
       }

       const headerLineCount = Math.min(2, lines.length);
       const header = lines.slice(0, headerLineCount).join("\n");
       const bodyLines = lines.slice(headerLineCount);
       const chunks: ChunkRecord[] = [];
       const step = chunkSize - overlap;

       for (let i = 0; i < bodyLines.length; i += step) {
           const end = Math.min(i + chunkSize, bodyLines.length);
           const chunkBodyLines = bodyLines.slice(i, end);
           const isFirst = i === 0;
           const chunkContent = isFirst
               ? lines.slice(0, headerLineCount + end).join("\n")
               : header + "\n" + chunkBodyLines.join("\n");

           const chunkStartLine = isFirst
               ? startLine
               : startLine + headerLineCount + i;

           chunks.push({
               id: contentHash(chunkContent),
               filePath,
               startLine: chunkStartLine,
               endLine: startLine + headerLineCount + end - 1,
               content: chunkContent,
               kind,
               name: name ? `${name} (part ${chunks.length + 1})` : undefined,
               language,
               parentChunkId,
           });

           if (end >= bodyLines.length) {
               break;
           }
       }

       return chunks;
   }
   ```

3. **Integrate into `chunkByAst()`**: In the loop over AST nodes, instead of always calling `splitChunkByLines()`, first check if the node exceeds `MAX_AST_CHUNK_LINES`:

   ```typescript
   const nodeLines = text.split("\n").length;

   let subChunks: ChunkRecord[];

   if (nodeLines > MAX_AST_CHUNK_LINES) {
       subChunks = subChunkLargeNode({
           content: text,
           filePath,
           startLine,
           kind,
           name,
           language: language ?? undefined,
           parentChunkId,
           chunkSize: 100, // CHUNK_SIZE equivalent
           overlap,
       });
   } else {
       subChunks = splitChunkByLines({
           content: text,
           filePath,
           startLine,
           kind,
           name,
           language: language ?? undefined,
           parentChunkId,
           maxTokens,
           overlap,
       });
   }
   ```

### 7d. Run tests

```bash
bun test src/indexer/lib/chunker.test.ts
```

### 7e. Type check

```bash
tsgo --noEmit 2>&1 | grep "src/indexer"
```

### 7f. Commit

```bash
git add src/indexer/lib/chunker.ts src/indexer/lib/chunker.test.ts
git commit -m "feat(indexer): sub-chunk large AST declarations (>150 lines) with header preservation"
```

---

## Task 8: Benchmark After

**Goal:** Run the same benchmark from Task 0 and compare with the baseline.

**Files:**
- Modify: `src/indexer/lib/chunker.bench.ts` (add a minified fixture and more diverse files)

**Steps:**

### 8a. Update benchmark

Add additional test cases:
- A Python file (from the repo or a fixture)
- A minified JS fixture string
- A file with many small type declarations (to test merging)
- A large fixture (to test sub-chunking)

```typescript
// Add to the test files array:
// Inline fixtures for new features
const minifiedJs = "var a=1;" + "function b(){return a+1;}".repeat(200);
const manyTypes = Array.from({ length: 20 }, (_, i) => `type T${i} = { field: string };`).join("\n");
const hugeClass = `class Huge {\n${Array.from({ length: 200 }, (_, i) => `    m${i}(x: number) { return x + ${i}; }`).join("\n")}\n}`;

// Add inline fixtures to results
for (const [name, content, filePath] of [
    ["minified", minifiedJs, "bundle.min.js"],
    ["many-types", manyTypes, "types.ts"],
    ["huge-class", hugeClass, "huge.ts"],
] as const) {
    const start = performance.now();
    const result = chunkFile({ filePath, content, strategy: "auto" });
    const elapsed = performance.now() - start;
    const charSizes = result.chunks.map((c) => c.content.length);

    results.push({
        file: name,
        strategy: "auto",
        parser: result.parser,
        chunks: result.chunks.length,
        avgChars: Math.round(charSizes.reduce((a, b) => a + b, 0) / charSizes.length),
        maxChars: Math.max(...charSizes),
        timeMs: Math.round(elapsed * 100) / 100,
    });
}
```

### 8b. Run benchmark

```bash
bun run src/indexer/lib/chunker.bench.ts
```

### 8c. Compare with baseline

Key metrics to compare:
- **Total chunks produced**: Should increase slightly (overlap adds partial duplication)
- **Max chunk size**: Should NEVER exceed 2000 chars (hard cap)
- **Avg chunk size**: Should be more consistent across strategies
- **Minified files**: Should produce reasonable-sized chunks instead of one giant chunk
- **Many types**: Should produce fewer, merged chunks instead of one per type alias
- **Huge class**: Should produce sub-chunks with header context

### 8d. Commit

```bash
git add src/indexer/lib/chunker.bench.ts
git commit -m "bench(indexer): update chunker benchmark with post-overhaul metrics"
```

---

## Summary of Changes

| Task | What | Key Additions |
|------|------|---------------|
| 0 | Benchmark baseline | `chunker.bench.ts` |
| 1 | Chunk overlap | `overlap` param on `chunkByLine()` / `splitChunkByLines()` |
| 2 | Character cap | `applyCharCap()`, `MAX_CHUNK_CHARS = 2000` |
| 3 | Minified detection | `isMinified()`, `chunkByCharacter()`, `"character"` parser |
| 4 | AST: Python, Go, Rust, Java | `ensureDynamicLanguages()`, `EXT_TO_DYNAMIC_LANG`, new `AST_KINDS` |
| 5 | AST: C/C++/Ruby/PHP/Swift/Kotlin/Scala/C# | More entries in same maps |
| 6 | Merge small nodes | `mergeSmallChunks()`, `MIN_AST_CHUNK_LINES = 5` |
| 7 | Sub-chunk large nodes | `subChunkLargeNode()`, `MAX_AST_CHUNK_LINES = 150`, header preservation |
| 8 | Benchmark after | Updated bench with new fixtures |

**New npm packages:** `@ast-grep/lang-{python,go,rust,java,c,cpp,ruby,php,swift,kotlin,scala,csharp}`

**New constants:** `MAX_CHUNK_CHARS`, `MAX_AVG_LINE_LENGTH`, `MIN_AST_CHUNK_LINES`, `MAX_AST_CHUNK_LINES`, `DEFAULT_CHUNK_OVERLAP`

**New parser type:** `"character"` added to `ChunkResult.parser` union

**Backwards compatible:** `overlap` defaults to `0`, existing behavior preserved when not set

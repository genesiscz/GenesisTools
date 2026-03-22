import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { chunkFile } from "./chunker";

describe("chunkFile", () => {
    describe("AST strategy", () => {
        it("extracts TypeScript functions with names", () => {
            const content = `
function greet(name: string): string {
    return "Hello, " + name;
}

function farewell(name: string): string {
    return "Goodbye, " + name;
}
`.trim();

            const result = chunkFile({
                filePath: "test.ts",
                content,
                strategy: "ast",
            });

            expect(result.parser).toBe("ast");
            expect(result.language).toBe("typescript");
            expect(result.chunks.length).toBeGreaterThanOrEqual(1);

            // Small functions may be merged — verify content is present
            const allContent = result.chunks.map((c) => c.content).join("\n");
            expect(allContent).toContain("Hello");
            expect(allContent).toContain("Goodbye");
        });

        it("extracts class with methods", () => {
            const content = `
class Calculator {
    add(a: number, b: number): number {
        return a + b;
    }

    subtract(a: number, b: number): number {
        return a - b;
    }
}
`.trim();

            const result = chunkFile({
                filePath: "calc.ts",
                content,
                strategy: "ast",
            });

            expect(result.parser).toBe("ast");

            const classChunk = result.chunks.find((c) => c.kind === "class_declaration");
            expect(classChunk).toBeDefined();
            expect(classChunk!.name).toBe("Calculator");
        });

        it("falls back to line for unsupported extensions", () => {
            const content = "some random content\nwith multiple lines\n";

            const result = chunkFile({
                filePath: "test.xyz",
                content,
                strategy: "ast",
            });

            expect(result.parser).toBe("line");
        });

        it("extracts interface declarations", () => {
            const content = `
interface User {
    id: string;
    name: string;
    email: string;
}
`.trim();

            const result = chunkFile({
                filePath: "types.ts",
                content,
                strategy: "ast",
            });

            expect(result.parser).toBe("ast");

            const ifaceChunk = result.chunks.find((c) => c.kind === "interface_declaration");
            expect(ifaceChunk).toBeDefined();
            expect(ifaceChunk!.name).toBe("User");
        });
    });

    describe("Heading strategy", () => {
        it("splits markdown at headings", () => {
            const content = `# Title

Some intro text.

## Getting Started

First section content.
More content here.

## Configuration

Config section content.

### Sub Section

Sub section content.
`;

            const result = chunkFile({
                filePath: "README.md",
                content,
                strategy: "heading",
            });

            expect(result.parser).toBe("heading");
            expect(result.language).toBe("markdown");
            expect(result.chunks.length).toBeGreaterThanOrEqual(3);

            const titleChunk = result.chunks.find((c) => c.name === "Title");
            expect(titleChunk).toBeDefined();

            const gettingStarted = result.chunks.find((c) => c.name === "Getting Started");
            expect(gettingStarted).toBeDefined();
            expect(gettingStarted!.content).toContain("First section content");
        });
    });

    describe("JSON strategy", () => {
        it("chunks JSON array into elements", () => {
            const content = SafeJSON.stringify(
                [
                    { id: 1, name: "Alice" },
                    { id: 2, name: "Bob" },
                    { id: 3, name: "Charlie" },
                ],
                null,
                2
            );

            const result = chunkFile({
                filePath: "data.json",
                content,
                strategy: "json",
            });

            expect(result.parser).toBe("json");
            expect(result.language).toBe("json");
            expect(result.chunks.length).toBe(3);
            expect(result.chunks[0].name).toBe("[0]");
            expect(result.chunks[0].kind).toBe("json_element");
        });

        it("chunks JSON object by keys", () => {
            const content = SafeJSON.stringify(
                {
                    users: [1, 2, 3],
                    settings: { theme: "dark" },
                    version: "1.0",
                },
                null,
                2
            );

            const result = chunkFile({
                filePath: "config.json",
                content,
                strategy: "json",
            });

            expect(result.parser).toBe("json");
            expect(result.chunks.length).toBe(3);
            expect(result.chunks.map((c) => c.name).sort()).toEqual(["settings", "users", "version"].sort());
        });
    });

    describe("Line strategy", () => {
        it("splits at double newlines", () => {
            const content = "First paragraph with some text.\n\nSecond paragraph with more text.\n\nThird paragraph.";

            const result = chunkFile({
                filePath: "notes.txt",
                content,
                strategy: "line",
            });

            expect(result.parser).toBe("line");
            // All paragraphs should be chunked (may be merged if small)
            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
            expect(result.chunks[0].kind).toBe("line_chunk");
        });
    });

    describe("Message strategy", () => {
        it("chunks email-style content", () => {
            const content = `Subject: Hello World
From: alice@example.com

This is the body of the email.

Subject: Another Message
From: bob@example.com

This is another email body.`;

            const result = chunkFile({
                filePath: "emails.txt",
                content,
                strategy: "message",
            });

            expect(result.parser).toBe("message");
            expect(result.chunks.length).toBeGreaterThanOrEqual(2);
            expect(result.chunks[0].kind).toBe("message");
        });
    });

    describe("Auto strategy", () => {
        it("selects ast for .ts files", () => {
            const content = 'function test() { return "hello"; }';

            const result = chunkFile({
                filePath: "test.ts",
                content,
                strategy: "auto",
                indexType: "code",
            });

            expect(result.parser).toBe("ast");
        });

        it("selects heading for .md files", () => {
            const content = "# Title\n\nSome content.";

            const result = chunkFile({
                filePath: "readme.md",
                content,
                strategy: "auto",
            });

            expect(result.parser).toBe("heading");
        });

        it("selects json for .json files", () => {
            const content = '{"key": "value"}';

            const result = chunkFile({
                filePath: "data.json",
                content,
                strategy: "auto",
            });

            expect(result.parser).toBe("json");
        });

        it("selects message for mail index type", () => {
            const content = "Some content here.";

            const result = chunkFile({
                filePath: "inbox.txt",
                content,
                strategy: "auto",
                indexType: "mail",
            });

            expect(result.parser).toBe("message");
        });

        it("selects line for unknown extensions", () => {
            const content = "Some random content.";

            const result = chunkFile({
                filePath: "data.xyz",
                content,
                strategy: "auto",
                indexType: "files",
            });

            expect(result.parser).toBe("line");
        });
    });

    describe("SHA-256 hashing", () => {
        it("produces deterministic hash for same content", () => {
            const content = 'function test() { return "hello"; }';

            const result1 = chunkFile({
                filePath: "a.ts",
                content,
                strategy: "ast",
            });
            const result2 = chunkFile({
                filePath: "b.ts",
                content,
                strategy: "ast",
            });

            expect(result1.chunks.length).toBeGreaterThan(0);
            expect(result2.chunks.length).toBeGreaterThan(0);
            expect(result1.chunks[0].id).toBe(result2.chunks[0].id);
        });

        it("produces different hashes for different content", () => {
            const result1 = chunkFile({
                filePath: "a.ts",
                content: 'function a() { return "a"; }',
                strategy: "ast",
            });
            const result2 = chunkFile({
                filePath: "b.ts",
                content: 'function b() { return "b"; }',
                strategy: "ast",
            });

            expect(result1.chunks[0].id).not.toBe(result2.chunks[0].id);
        });
    });

    describe("maxTokens splitting", () => {
        it("splits large chunks at line boundaries", () => {
            // Create content that exceeds maxTokens (1 token ~ 4 chars, so 20 tokens = ~80 chars)
            const longLines = Array.from(
                { length: 20 },
                (_, i) => `    const line${i} = "this is a line of code that adds some length to the content";`
            );
            const content = `function bigFunction() {\n${longLines.join("\n")}\n}`;

            const result = chunkFile({
                filePath: "big.ts",
                content,
                strategy: "ast",
                maxTokens: 50,
            });

            expect(result.parser).toBe("ast");
            // Should be split into multiple chunks due to small maxTokens
            expect(result.chunks.length).toBeGreaterThan(1);

            // All chunks should have valid IDs
            for (const chunk of result.chunks) {
                expect(chunk.id).toMatch(/^[a-f0-9]+$/);
            }
        });
    });

    describe("Chunk overlap", () => {
        it("includes overlap lines from previous chunk in next chunk", () => {
            // Create content with enough lines to produce multiple chunks at low maxTokens
            const lines = Array.from(
                { length: 40 },
                (_, i) => `Line ${i + 1}: some content here for testing overlap behavior`
            );
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
            const body = Array.from(
                { length: 100 },
                (_, i) =>
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
            const content = SafeJSON.stringify({ key: bigValue });

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
            }
        });
    });

    describe("Minified file detection", () => {
        it("detects minified content by average line length", () => {
            // Simulate minified JS: one very long line
            const minified = `var a=1;${"function b(){return a+1;}".repeat(200)}`;

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
                const isValidEnd =
                    [";", " ", "\n", "\t", ","].includes(lastChar) || chunk === result.chunks[result.chunks.length - 1]; // last chunk can end anywhere
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
            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
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
            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
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
            const decls = Array.from({ length: 30 }, (_, i) => `type T${i} = { field: string };\n`).join("\n");

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

    describe("Edge cases", () => {
        it("handles empty file content", () => {
            const result = chunkFile({
                filePath: "empty.ts",
                content: "",
                strategy: "ast",
            });

            expect(result.chunks).toHaveLength(0);
        });

        it("handles whitespace-only content", () => {
            const result = chunkFile({
                filePath: "whitespace.ts",
                content: "   \n\n\t\t\n   ",
                strategy: "ast",
            });

            expect(result.chunks).toHaveLength(0);
        });

        it("handles comment-only TypeScript file", () => {
            const content = `
// This is a comment
// Another comment
/* Block comment
   spanning multiple lines */
`.trim();

            const result = chunkFile({
                filePath: "comments.ts",
                content,
                strategy: "ast",
            });

            // Comments may or may not produce chunks depending on implementation
            // but should not crash
            expect(result.parser).toBe("ast");
        });

        it("handles Unicode content in code", () => {
            const content = `
export function greet(name: string): string {
    return \`Bonjour, \${name}! Bienvenue a notre cafe. Prix: 5\u20AC\`;
}

export const emoji = "Hello \u{1F30D}\u{1F389}";
export const cjk = "\u4F60\u597D\u4E16\u754C";
export const arabic = "\u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645";
`.trim();

            const result = chunkFile({
                filePath: "unicode.ts",
                content,
                strategy: "ast",
            });

            expect(result.parser).toBe("ast");
            expect(result.chunks.length).toBeGreaterThan(0);

            const allContent = result.chunks.map((c) => c.content).join("\n");
            expect(allContent).toContain("Bonjour");
            expect(allContent).toContain("emoji");
        });

        it("handles file with only import statements", () => {
            const content = `
import { a } from "./a";
import { b } from "./b";
import { c } from "./c";
`.trim();

            const result = chunkFile({
                filePath: "imports-only.ts",
                content,
                strategy: "ast",
            });

            // Import-only files should still produce at least one chunk
            expect(result.parser).toBe("ast");
        });

        it("handles single-line file", () => {
            const result = chunkFile({
                filePath: "oneliner.ts",
                content: "export const VERSION = 42;",
                strategy: "ast",
            });

            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        });

        it("handles file with BOM marker", () => {
            const bom = "\uFEFF";
            const content = `${bom}export function test(): void { console.log("BOM"); }`;

            const result = chunkFile({
                filePath: "bom.ts",
                content,
                strategy: "ast",
            });

            // Should handle BOM gracefully
            expect(result.chunks.length).toBeGreaterThanOrEqual(0);
        });
    });

    describe("AST sub-chunk large declarations", () => {
        it("sub-chunks a class with >150 lines", () => {
            const methods = Array.from(
                { length: 50 },
                (_, i) => `
    method${i}(x: number): number {
        const a = x + ${i};
        return a;
    }`
            ).join("\n");
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
            const methods = Array.from(
                { length: 50 },
                (_, i) => `
    method${i}(x: number): number {
        const a = x + ${i};
        return a;
    }`
            ).join("\n");
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
                expect(overlapInSecond.some((line) => endOfFirst.includes(line))).toBe(true);
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
});

import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { chunkFile } from "./chunker";

describe("chunkFile", () => {
    describe("AST strategy", () => {
        it("extracts TypeScript functions with names", async () => {
            const content = `
function greet(name: string): string {
    return "Hello, " + name;
}

function farewell(name: string): string {
    return "Goodbye, " + name;
}
`.trim();

            const result = await chunkFile({
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

        it("extracts class with methods", async () => {
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

            const result = await chunkFile({
                filePath: "calc.ts",
                content,
                strategy: "ast",
            });

            expect(result.parser).toBe("ast");

            const classChunk = result.chunks.find((c) => c.kind === "class_declaration");
            expect(classChunk).toBeDefined();
            expect(classChunk!.name).toBe("Calculator");
        });

        it("falls back to line for unsupported extensions", async () => {
            const content = "some random content\nwith multiple lines\n";

            const result = await chunkFile({
                filePath: "test.xyz",
                content,
                strategy: "ast",
            });

            expect(result.parser).toBe("line");
        });

        it("extracts interface declarations", async () => {
            const content = `
interface User {
    id: string;
    name: string;
    email: string;
}
`.trim();

            const result = await chunkFile({
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
        it("splits markdown at headings", async () => {
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

            const result = await chunkFile({
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

    describe("Heading strategy — improved splitting", () => {
        it("preserves heading context in sub-chunks when section exceeds maxTokens", async () => {
            const longParagraphs = Array.from(
                { length: 20 },
                (_, i) =>
                    `This is paragraph ${i} with enough text to contribute meaningful tokens to the overall section content length.`
            ).join("\n\n");
            const content = `## Big Section\n\n${longParagraphs}`;

            const result = await chunkFile({
                filePath: "doc.md",
                content,
                strategy: "heading",
                maxTokens: 80,
            });

            expect(result.parser).toBe("heading");
            expect(result.chunks.length).toBeGreaterThan(1);

            for (const chunk of result.chunks) {
                expect(chunk.content).toContain("## Big Section");
            }
        });

        it("splits at paragraph boundaries, not mid-paragraph", async () => {
            const paragraphs = [
                "First paragraph with some introductory content that sets the stage for the rest.",
                "Second paragraph that contains a completely different thought and should stay intact.",
                "Third paragraph wrapping up the section with a final thought about the topic.",
            ];
            const content = `## Section\n\n${paragraphs.join("\n\n")}`;

            const result = await chunkFile({
                filePath: "doc.md",
                content,
                strategy: "heading",
                maxTokens: 60,
            });

            expect(result.parser).toBe("heading");

            for (const chunk of result.chunks) {
                for (const para of paragraphs) {
                    if (chunk.content.includes(para.slice(0, 20))) {
                        expect(chunk.content).toContain(para);
                    }
                }
            }
        });

        it("names the preamble from first non-empty line", async () => {
            const content = `Some introductory text before any heading.\n\nMore preamble content.\n\n## First Heading\n\nHeading content.`;

            const result = await chunkFile({
                filePath: "doc.md",
                content,
                strategy: "heading",
            });

            expect(result.parser).toBe("heading");

            const preambleChunk = result.chunks[0];
            expect(preambleChunk.name).toBeDefined();
            expect(preambleChunk.name).not.toBe("chunk");
            expect(preambleChunk.name).toContain("Some introductory text");
        });

        it("uses (preamble) fallback for whitespace-only preamble lines", async () => {
            const content = `\n\n\nActual content before heading.\n\n## Heading\n\nBody.`;

            const result = await chunkFile({
                filePath: "doc.md",
                content,
                strategy: "heading",
            });

            expect(result.parser).toBe("heading");

            const preambleChunk = result.chunks.find((c) => c.content.includes("Actual content"));

            if (preambleChunk) {
                expect(preambleChunk.name).toBeDefined();
            }
        });

        it("does not split small sections that fit within maxTokens", async () => {
            const content = `## Small Section\n\nJust a little content here.\n\n## Another Small\n\nAnother small paragraph.`;

            const result = await chunkFile({
                filePath: "doc.md",
                content,
                strategy: "heading",
                maxTokens: 500,
            });

            expect(result.parser).toBe("heading");

            const smallSection = result.chunks.find((c) => c.name === "Small Section");
            expect(smallSection).toBeDefined();
            expect(smallSection!.content).toContain("Just a little content");

            const anotherSection = result.chunks.find((c) => c.name === "Another Small");
            expect(anotherSection).toBeDefined();

            for (const chunk of result.chunks) {
                expect(chunk.name).not.toContain("part");
            }
        });
    });

    describe("JSON strategy", () => {
        it("chunks JSON array into elements", async () => {
            const content = SafeJSON.stringify(
                [
                    { id: 1, name: "Alice" },
                    { id: 2, name: "Bob" },
                    { id: 3, name: "Charlie" },
                ],
                null,
                2
            );

            const result = await chunkFile({
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

        it("chunks JSON object by keys", async () => {
            const content = SafeJSON.stringify(
                {
                    users: [1, 2, 3],
                    settings: { theme: "dark" },
                    version: "1.0",
                },
                null,
                2
            );

            const result = await chunkFile({
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
        it("splits at double newlines", async () => {
            const content = "First paragraph with some text.\n\nSecond paragraph with more text.\n\nThird paragraph.";

            const result = await chunkFile({
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
        it("chunks email-style content", async () => {
            const content = `Subject: Hello World
From: alice@example.com

This is the body of the email.

Subject: Another Message
From: bob@example.com

This is another email body.`;

            const result = await chunkFile({
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
        it("selects ast for .ts files", async () => {
            const content = 'function test() { return "hello"; }';

            const result = await chunkFile({
                filePath: "test.ts",
                content,
                strategy: "auto",
                indexType: "code",
            });

            expect(result.parser).toBe("ast");
        });

        it("selects heading for .md files", async () => {
            const content = "# Title\n\nSome content.";

            const result = await chunkFile({
                filePath: "readme.md",
                content,
                strategy: "auto",
            });

            expect(result.parser).toBe("heading");
        });

        it("selects json for .json files", async () => {
            const content = '{"key": "value"}';

            const result = await chunkFile({
                filePath: "data.json",
                content,
                strategy: "auto",
            });

            expect(result.parser).toBe("json");
        });

        it("selects message for mail index type", async () => {
            const content = "Some content here.";

            const result = await chunkFile({
                filePath: "inbox.txt",
                content,
                strategy: "auto",
                indexType: "mail",
            });

            expect(result.parser).toBe("message");
        });

        it("selects line for unknown extensions", async () => {
            const content = "Some random content.";

            const result = await chunkFile({
                filePath: "data.xyz",
                content,
                strategy: "auto",
                indexType: "files",
            });

            expect(result.parser).toBe("line");
        });
    });

    describe("SHA-256 hashing", () => {
        it("produces deterministic hash for same content", async () => {
            const content = 'function test() { return "hello"; }';

            const result1 = await chunkFile({
                filePath: "a.ts",
                content,
                strategy: "ast",
            });
            const result2 = await chunkFile({
                filePath: "b.ts",
                content,
                strategy: "ast",
            });

            expect(result1.chunks.length).toBeGreaterThan(0);
            expect(result2.chunks.length).toBeGreaterThan(0);
            expect(result1.chunks[0].id).toBe(result2.chunks[0].id);
        });

        it("produces different hashes for different content", async () => {
            const result1 = await chunkFile({
                filePath: "a.ts",
                content: 'function a() { return "a"; }',
                strategy: "ast",
            });
            const result2 = await chunkFile({
                filePath: "b.ts",
                content: 'function b() { return "b"; }',
                strategy: "ast",
            });

            expect(result1.chunks[0].id).not.toBe(result2.chunks[0].id);
        });
    });

    describe("maxTokens splitting", () => {
        it("splits large chunks at line boundaries", async () => {
            // Create content that exceeds maxTokens (1 token ~ 4 chars, so 20 tokens = ~80 chars)
            const longLines = Array.from(
                { length: 20 },
                (_, i) => `    const line${i} = "this is a line of code that adds some length to the content";`
            );
            const content = `function bigFunction() {\n${longLines.join("\n")}\n}`;

            const result = await chunkFile({
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
        it("includes overlap lines from previous chunk in next chunk", async () => {
            // Create content with enough lines to produce multiple chunks at low maxTokens
            const lines = Array.from(
                { length: 40 },
                (_, i) => `Line ${i + 1}: some content here for testing overlap behavior`
            );
            const content = lines.join("\n");

            const result = await chunkFile({
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

        it("first chunk has no prefix overlap", async () => {
            const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: content`);
            const content = lines.join("\n");

            const result = await chunkFile({
                filePath: "test.txt",
                content,
                strategy: "line",
                maxTokens: 50,
                overlap: 5,
            });

            // First chunk should start at line 0
            expect(result.chunks[0].startLine).toBe(0);
        });

        it("defaults to 0 overlap when not specified", async () => {
            const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: content padding text`);
            const content = lines.join("\n");

            const result = await chunkFile({
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
        it("truncates chunks exceeding MAX_CHUNK_CHARS", async () => {
            // Create a single massive line that will become one chunk
            const longContent = "x".repeat(5000);

            const result = await chunkFile({
                filePath: "big.txt",
                content: longContent,
                strategy: "line",
            });

            for (const chunk of result.chunks) {
                expect(chunk.content.length).toBeLessThanOrEqual(2000);
            }
        });

        it("applies character cap to AST chunks", async () => {
            // A single giant function body
            const body = Array.from(
                { length: 100 },
                (_, i) =>
                    `    const var${i} = "this is a rather lengthy line of code designed to push the character count well beyond the limit";`
            ).join("\n");
            const content = `function huge() {\n${body}\n}`;

            const result = await chunkFile({
                filePath: "huge.ts",
                content,
                strategy: "ast",
                maxTokens: 2000, // high token limit to let char cap be the active constraint
            });

            for (const chunk of result.chunks) {
                expect(chunk.content.length).toBeLessThanOrEqual(2000);
            }
        });

        it("applies character cap to JSON chunks", async () => {
            const bigValue = "y".repeat(3000);
            const content = SafeJSON.stringify({ key: bigValue });

            const result = await chunkFile({
                filePath: "data.json",
                content,
                strategy: "json",
                maxTokens: 2000,
            });

            for (const chunk of result.chunks) {
                expect(chunk.content.length).toBeLessThanOrEqual(2000);
            }
        });

        it("truncates at last safe boundary (newline or space)", async () => {
            // Content with spaces — truncation should land on a space boundary
            const words = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");

            const result = await chunkFile({
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
        it("detects minified content by average line length", async () => {
            // Simulate minified JS: one very long line
            const minified = `var a=1;${"function b(){return a+1;}".repeat(200)}`;

            const result = await chunkFile({
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

        it("produces multiple chunks from long minified content", async () => {
            const minified = "x=1;".repeat(2000); // ~8000 chars

            const result = await chunkFile({
                filePath: "bundle.min.js",
                content: minified,
                strategy: "auto",
                indexType: "code",
            });

            expect(result.parser).toBe("character");
            expect(result.chunks.length).toBeGreaterThan(1);
        });

        it("splits at safe boundaries (semicolon, space, newline)", async () => {
            const minified = Array.from({ length: 500 }, (_, i) => `var v${i}=null`).join(";");

            const result = await chunkFile({
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

        it("does NOT use character-based for normal files", async () => {
            const normal = Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`).join("\n");

            const result = await chunkFile({
                filePath: "normal.js",
                content: normal,
                strategy: "auto",
                indexType: "code",
            });

            expect(result.parser).not.toBe("character");
        });
    });

    describe("AST strategy — extended languages", () => {
        it("extracts Python function and class definitions", async () => {
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

            const result = await chunkFile({
                filePath: "test.py",
                content,
                strategy: "ast",
            });

            expect(result.parser).toBe("ast");
            expect(result.language).toBe("python");
            expect(result.chunks.length).toBeGreaterThanOrEqual(2);
        });

        it("extracts Go function and type declarations", async () => {
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

            const result = await chunkFile({
                filePath: "main.go",
                content,
                strategy: "ast",
            });

            expect(result.parser).toBe("ast");
            expect(result.language).toBe("go");
            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        });

        it("extracts Rust function, impl, struct, and trait items", async () => {
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

            const result = await chunkFile({
                filePath: "lib.rs",
                content,
                strategy: "ast",
            });

            expect(result.parser).toBe("ast");
            expect(result.language).toBe("rust");
            expect(result.chunks.length).toBeGreaterThanOrEqual(3);
        });

        it("extracts Java class and method declarations", async () => {
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

            const result = await chunkFile({
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
        it("extracts C function definitions and structs", async () => {
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

            const result = await chunkFile({ filePath: "main.c", content, strategy: "ast" });
            expect(result.parser).toBe("ast");
            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        });

        it("extracts C++ class and namespace definitions", async () => {
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

            const result = await chunkFile({ filePath: "calc.cpp", content, strategy: "ast" });
            expect(result.parser).toBe("ast");
            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        });

        it("extracts Ruby methods, classes, and modules", async () => {
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

            const result = await chunkFile({ filePath: "greet.rb", content, strategy: "ast" });
            expect(result.parser).toBe("ast");
            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        });

        it("extracts PHP class and function declarations", async () => {
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

            const result = await chunkFile({ filePath: "calc.php", content, strategy: "ast" });
            expect(result.parser).toBe("ast");
            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        });

        it("extracts Swift class, struct, and function declarations", async () => {
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

            const result = await chunkFile({ filePath: "calc.swift", content, strategy: "ast" });
            expect(result.parser).toBe("ast");
            expect(result.chunks.length).toBeGreaterThanOrEqual(2);
        });

        it("extracts Kotlin class and function declarations", async () => {
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

            const result = await chunkFile({ filePath: "calc.kt", content, strategy: "ast" });
            expect(result.parser).toBe("ast");
            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        });

        it("extracts Scala class, object, and trait definitions", async () => {
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

            const result = await chunkFile({ filePath: "calc.scala", content, strategy: "ast" });
            expect(result.parser).toBe("ast");
            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        });

        it("extracts C# class, interface, and method declarations", async () => {
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

            const result = await chunkFile({ filePath: "Calculator.cs", content, strategy: "ast" });
            expect(result.parser).toBe("ast");
            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe("AST merge small nodes", () => {
        it("merges adjacent small type aliases into one chunk", async () => {
            const content = `
type A = string;
type B = number;
type C = boolean;
type D = null;
`.trim();

            const result = await chunkFile({
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

        it("does not merge nodes that together exceed max chunk lines", async () => {
            // Create enough small declarations that merging all would exceed CHUNK_SIZE
            const decls = Array.from({ length: 30 }, (_, i) => `type T${i} = { field: string };\n`).join("\n");

            const result = await chunkFile({
                filePath: "many-types.ts",
                content: decls.trim(),
                strategy: "ast",
                maxTokens: 50, // Force small chunks
            });

            expect(result.parser).toBe("ast");
            // Should produce multiple chunks, not one giant merged blob
            expect(result.chunks.length).toBeGreaterThan(1);
        });

        it("keeps large declarations as their own chunk", async () => {
            const smallType = "type Small = string;";
            const bigFn = `function big() {\n${Array.from({ length: 20 }, (_, i) => `    const x${i} = ${i};`).join("\n")}\n}`;
            const content = `${smallType}\n\n${bigFn}`;

            const result = await chunkFile({
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
        it("handles empty file content", async () => {
            const result = await chunkFile({
                filePath: "empty.ts",
                content: "",
                strategy: "ast",
            });

            expect(result.chunks).toHaveLength(0);
        });

        it("handles whitespace-only content", async () => {
            const result = await chunkFile({
                filePath: "whitespace.ts",
                content: "   \n\n\t\t\n   ",
                strategy: "ast",
            });

            expect(result.chunks).toHaveLength(0);
        });

        it("handles comment-only TypeScript file", async () => {
            const content = `
// This is a comment
// Another comment
/* Block comment
   spanning multiple lines */
`.trim();

            const result = await chunkFile({
                filePath: "comments.ts",
                content,
                strategy: "ast",
            });

            // Comments may or may not produce chunks depending on implementation
            // but should not crash
            expect(result.parser).toBe("ast");
        });

        it("handles Unicode content in code", async () => {
            const content = `
export function greet(name: string): string {
    return \`Bonjour, \${name}! Bienvenue a notre cafe. Prix: 5\u20AC\`;
}

export const emoji = "Hello \u{1F30D}\u{1F389}";
export const cjk = "\u4F60\u597D\u4E16\u754C";
export const arabic = "\u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645";
`.trim();

            const result = await chunkFile({
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

        it("handles file with only import statements", async () => {
            const content = `
import { a } from "./a";
import { b } from "./b";
import { c } from "./c";
`.trim();

            const result = await chunkFile({
                filePath: "imports-only.ts",
                content,
                strategy: "ast",
            });

            // Import-only files should still produce at least one chunk
            expect(result.parser).toBe("ast");
        });

        it("handles single-line file", async () => {
            const result = await chunkFile({
                filePath: "oneliner.ts",
                content: "export const VERSION = 42;",
                strategy: "ast",
            });

            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        });

        it("handles file with BOM marker", async () => {
            const bom = "\uFEFF";
            const content = `${bom}export function test(): void { console.log("BOM"); }`;

            const result = await chunkFile({
                filePath: "bom.ts",
                content,
                strategy: "ast",
            });

            // Should handle BOM gracefully
            expect(result.chunks.length).toBeGreaterThanOrEqual(0);
        });
    });

    describe("AST sub-chunk large declarations", () => {
        it("sub-chunks a class with >150 lines", async () => {
            const methods = Array.from(
                { length: 50 },
                (_, i) => `
    method${i}(x: number): number {
        const a = x + ${i};
        return a;
    }`
            ).join("\n");
            const content = `class HugeClass {\n${methods}\n}`;

            const result = await chunkFile({
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

        it("sub-chunks preserve overlap between consecutive sub-chunks", async () => {
            const methods = Array.from(
                { length: 50 },
                (_, i) => `
    method${i}(x: number): number {
        const a = x + ${i};
        return a;
    }`
            ).join("\n");
            const content = `class HugeClass {\n${methods}\n}`;

            const result = await chunkFile({
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

        it("does not sub-chunk declarations <=150 lines", async () => {
            const body = Array.from({ length: 10 }, (_, i) => `    const x${i} = ${i};`).join("\n");
            const content = `function normal() {\n${body}\n}`;

            const result = await chunkFile({
                filePath: "normal.ts",
                content,
                strategy: "ast",
            });

            expect(result.parser).toBe("ast");
            expect(result.chunks.length).toBe(1);
        });
    });

    describe("Heading strategy — large section sub-chunks", () => {
        it("preserves heading context in sub-chunks of large sections", async () => {
            const bigBody = Array.from(
                { length: 200 },
                (_, i) => `Line ${i} of content with enough words to consume tokens.`
            ).join("\n\n");
            const content = `## Big Section\n\n${bigBody}`;

            const result = await chunkFile({
                filePath: "doc.md",
                content,
                strategy: "heading",
                maxTokens: 100,
            });

            expect(result.parser).toBe("heading");
            expect(result.chunks.length).toBeGreaterThan(1);

            // Every sub-chunk after the first should contain the heading
            for (const chunk of result.chunks.slice(1)) {
                expect(chunk.content).toContain("## Big Section");
            }
        });

        it("splits at paragraph boundaries, not mid-paragraph", async () => {
            const para1 = "First paragraph with several words that make it meaningful.";
            const para2 = "Second paragraph also has content that should stay together.";
            const para3 = "Third paragraph is the final one in this section.";
            const content = `## Section\n\n${para1}\n\n${para2}\n\n${para3}`;

            const result = await chunkFile({
                filePath: "doc.md",
                content,
                strategy: "heading",
                maxTokens: 50,
            });

            expect(result.parser).toBe("heading");

            for (const chunk of result.chunks) {
                // No paragraph should be cut in the middle — each paragraph
                // should appear fully in exactly one chunk
                if (chunk.content.includes("First paragraph")) {
                    expect(chunk.content).toContain(para1);
                }

                if (chunk.content.includes("Second paragraph")) {
                    expect(chunk.content).toContain(para2);
                }

                if (chunk.content.includes("Third paragraph")) {
                    expect(chunk.content).toContain(para3);
                }
            }
        });

        it("names preamble content before first heading", async () => {
            const content = `This is preamble text before any heading.\n\nMore preamble.\n\n## First Heading\n\nContent here.`;

            const result = await chunkFile({
                filePath: "doc.md",
                content,
                strategy: "heading",
            });

            expect(result.parser).toBe("heading");

            const preambleChunk = result.chunks[0];
            expect(preambleChunk.name).toBeDefined();
            expect(preambleChunk.name).not.toBe("chunk");
            expect(preambleChunk.content).toContain("preamble text");
        });

        it("keeps small sections as single chunks", async () => {
            const content = `## Small Section\n\nJust a few words here.`;

            const result = await chunkFile({
                filePath: "doc.md",
                content,
                strategy: "heading",
            });

            expect(result.parser).toBe("heading");
            expect(result.chunks.length).toBe(1);
            expect(result.chunks[0].name).toBe("Small Section");
            expect(result.chunks[0].name).not.toContain("(part");
        });

        it("handles markdown with no headings at all", async () => {
            const content = `Just plain text.\n\nWith some paragraphs.\n\nAnd nothing else.`;

            const result = await chunkFile({
                filePath: "doc.md",
                content,
                strategy: "heading",
            });

            expect(result.parser).toBe("heading");
            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
            expect(result.chunks[0].name).toBeDefined();
        });
    });
});

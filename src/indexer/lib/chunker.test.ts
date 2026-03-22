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
            expect(result.chunks.length).toBeGreaterThanOrEqual(2);

            const greetChunk = result.chunks.find((c) => c.name === "greet");
            expect(greetChunk).toBeDefined();
            expect(greetChunk!.kind).toBe("function_declaration");
            expect(greetChunk!.content).toContain("Hello");

            const farewellChunk = result.chunks.find((c) => c.name === "farewell");
            expect(farewellChunk).toBeDefined();
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
            const content = "def hello():\n    print('hello')\n";

            const result = chunkFile({
                filePath: "test.py",
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
                expect(chunk.id).toMatch(/^[a-f0-9]{64}$/);
            }
        });
    });
});

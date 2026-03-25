import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@app/utils/string";
import { type FormattedSearchResult, formatSearchResults } from "./search-output";

function makeResult(overrides?: Partial<FormattedSearchResult>): FormattedSearchResult {
    return {
        filePath: "/Users/dev/project/src/services/telegram/notification-handler.ts",
        displayName: "sendNotification:45-72",
        language: "typescript",
        content: "export async function sendNotification(userId: string) {\n    const client = getClient();\n    await client.send(userId, 'hello');\n}",
        confidence: 87,
        method: "cosine",
        indexName: "my-index",
        startLine: 45,
        endLine: 48,
        ...overrides,
    };
}

describe("formatSearchResults", () => {
    describe("empty results", () => {
        it("returns 'No results found.' for empty array", () => {
            const result = formatSearchResults({
                results: [],
                format: "pretty",
                query: "telegram",
                mode: "hybrid",
            });
            expect(result).toBe("No results found.");
        });

        it("returns same message regardless of format", () => {
            for (const format of ["pretty", "simple", "table"] as const) {
                const result = formatSearchResults({
                    results: [],
                    format,
                    query: "test",
                    mode: "bm25",
                });
                expect(result).toBe("No results found.");
            }
        });
    });

    describe("pretty format", () => {
        it("contains fenced code block with language marker", () => {
            const result = formatSearchResults({
                results: [makeResult({ language: "php" })],
                format: "pretty",
                query: "notification",
                mode: "hybrid",
            });
            const plain = stripAnsi(result);
            expect(plain).toContain("```php");
            expect(plain).toMatch(/```\n|```$/);
        });

        it("contains confidence as percentage", () => {
            const result = formatSearchResults({
                results: [makeResult({ confidence: 87 })],
                format: "pretty",
                query: "notification",
                mode: "hybrid",
            });
            const plain = stripAnsi(result);
            expect(plain).toContain("87%");
        });

        it("contains file path and display name", () => {
            const result = formatSearchResults({
                results: [makeResult()],
                format: "pretty",
                query: "notification",
                mode: "hybrid",
            });
            const plain = stripAnsi(result);
            expect(plain).toContain("notification-handler.ts");
            expect(plain).toContain("sendNotification:45-72");
        });

        it("shows result count and query in header", () => {
            const result = formatSearchResults({
                results: [makeResult(), makeResult({ displayName: "other:10-20" })],
                format: "pretty",
                query: "telegram bot",
                mode: "cosine",
            });
            const plain = stripAnsi(result);
            expect(plain).toContain("2 results");
            expect(plain).toContain('"telegram bot"');
            expect(plain).toContain("cosine");
        });

        it("groups multiple results from the same file", () => {
            const r1 = makeResult({ displayName: "funcA:10-20", startLine: 10, endLine: 20 });
            const r2 = makeResult({ displayName: "funcB:30-40", startLine: 30, endLine: 40 });
            const result = formatSearchResults({
                results: [r1, r2],
                format: "pretty",
                query: "test",
                mode: "hybrid",
            });
            const plain = stripAnsi(result);
            const pathOccurrences = plain.split("notification-handler.ts").length - 1;
            expect(pathOccurrences).toBe(1);
        });

        it("highlights query words in content", () => {
            const result = formatSearchResults({
                results: [makeResult()],
                format: "pretty",
                query: "sendNotification",
                mode: "hybrid",
                highlightWords: ["sendNotification"],
            });
            const plain = stripAnsi(result);
            expect(result.length).toBeGreaterThan(plain.length);
        });
    });

    describe("simple format", () => {
        it("contains file path", () => {
            const result = formatSearchResults({
                results: [makeResult()],
                format: "simple",
                query: "notification",
                mode: "hybrid",
            });
            const plain = stripAnsi(result);
            expect(plain).toContain("notification-handler.ts");
        });

        it("contains line numbers", () => {
            const result = formatSearchResults({
                results: [makeResult({ startLine: 45 })],
                format: "simple",
                query: "notification",
                mode: "hybrid",
            });
            const plain = stripAnsi(result);
            expect(plain).toContain("45|");
        });

        it("contains confidence percentage", () => {
            const result = formatSearchResults({
                results: [makeResult({ confidence: 92 })],
                format: "simple",
                query: "notification",
                mode: "hybrid",
            });
            const plain = stripAnsi(result);
            expect(plain).toContain("92%");
        });

        it("highlighted words produce ANSI codes", () => {
            const result = formatSearchResults({
                results: [makeResult()],
                format: "simple",
                query: "sendNotification",
                mode: "hybrid",
                highlightWords: ["sendNotification"],
            });
            const plain = stripAnsi(result);
            expect(result.length).toBeGreaterThan(plain.length);
        });
    });

    describe("table format", () => {
        it("contains column headers", () => {
            const result = formatSearchResults({
                results: [makeResult()],
                format: "table",
                query: "notification",
                mode: "hybrid",
            });
            const plain = stripAnsi(result);
            expect(plain).toContain("File");
            expect(plain).toContain("Symbol");
            expect(plain).toContain("Confidence");
            expect(plain).toContain("Method");
        });

        it("contains percentage in confidence column", () => {
            const result = formatSearchResults({
                results: [makeResult({ confidence: 87 })],
                format: "table",
                query: "notification",
                mode: "hybrid",
            });
            const plain = stripAnsi(result);
            expect(plain).toContain("87%");
        });

        it("contains display name", () => {
            const result = formatSearchResults({
                results: [makeResult()],
                format: "table",
                query: "notification",
                mode: "hybrid",
            });
            const plain = stripAnsi(result);
            expect(plain).toContain("sendNotification:45-72");
        });

        it("truncates long file paths with ellipsis", () => {
            const result = formatSearchResults({
                results: [
                    makeResult({
                        filePath:
                            "/Users/dev/project/src/very/deeply/nested/directory/structure/handlers/notification-handler.ts",
                    }),
                ],
                format: "table",
                query: "notification",
                mode: "hybrid",
            });
            const plain = stripAnsi(result);
            expect(plain).toContain("...");
        });

        it("contains separator line", () => {
            const result = formatSearchResults({
                results: [makeResult()],
                format: "table",
                query: "notification",
                mode: "hybrid",
            });
            expect(result).toContain("─");
        });
    });

    describe("edge cases", () => {
        it("single-line chunk renders in all formats", () => {
            const singleLine = makeResult({
                content: "const x = 42;",
                startLine: 1,
                endLine: 1,
            });

            for (const format of ["pretty", "simple", "table"] as const) {
                const result = formatSearchResults({
                    results: [singleLine],
                    format,
                    query: "test",
                    mode: "bm25",
                });
                expect(result.length).toBeGreaterThan(0);
            }
        });

        it("content with special chars does not crash", () => {
            const special = makeResult({
                content: "const regex = /[.*+?^${}()|[\\]\\\\]/g;\nconst tmpl = `${foo}<bar>&amp;`;",
            });

            for (const format of ["pretty", "simple", "table"] as const) {
                expect(() =>
                    formatSearchResults({
                        results: [special],
                        format,
                        query: "regex",
                        mode: "hybrid",
                    })
                ).not.toThrow();
            }
        });

        it("all three formats produce different output shapes", () => {
            const r = makeResult();
            const outputs = (["pretty", "simple", "table"] as const).map((format) =>
                stripAnsi(
                    formatSearchResults({
                        results: [r],
                        format,
                        query: "test",
                        mode: "hybrid",
                    })
                )
            );

            expect(outputs[0]).not.toBe(outputs[1]);
            expect(outputs[1]).not.toBe(outputs[2]);
            expect(outputs[0]).not.toBe(outputs[2]);
        });

        it("null language uses plain code block in pretty format", () => {
            const result = formatSearchResults({
                results: [makeResult({ language: null })],
                format: "pretty",
                query: "test",
                mode: "hybrid",
            });
            const plain = stripAnsi(result);
            expect(plain).toContain("```\n");
            expect(plain).not.toContain("```null");
        });
    });
});

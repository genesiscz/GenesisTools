import { describe, expect, it } from "bun:test";
import { WebSearchTool } from "../websearch";

describe("WebSearchTool", () => {
    describe("createSearchTool()", () => {
        it("returns null when BRAVE_API_KEY is not set", () => {
            // Save and clear
            const saved = process.env.BRAVE_API_KEY;
            delete process.env.BRAVE_API_KEY;

            const tool = new WebSearchTool();
            const result = tool.createSearchTool();
            expect(result).toBeNull();

            // Restore
            if (saved) {
                process.env.BRAVE_API_KEY = saved;
            }
        });

        it("returns tool definition when BRAVE_API_KEY is set", () => {
            const saved = process.env.BRAVE_API_KEY;
            process.env.BRAVE_API_KEY = "test-key-xxx";

            const tool = new WebSearchTool();
            const result = tool.createSearchTool();

            expect(result).not.toBeNull();
            expect(result!.description).toContain("Search the web");
            expect(result!.parameters).toBeDefined();
            expect(typeof result!.execute).toBe("function");

            // Restore
            if (saved) {
                process.env.BRAVE_API_KEY = saved;
            } else {
                delete process.env.BRAVE_API_KEY;
            }
        });

        it("uses Zod schema for parameters", () => {
            const saved = process.env.BRAVE_API_KEY;
            process.env.BRAVE_API_KEY = "test-key-xxx";

            const tool = new WebSearchTool();
            const result = tool.createSearchTool();

            // Verify it's a Zod schema by checking it has parse/safeParse
            const schema = result!.parameters;
            expect(schema).toBeDefined();
            expect(typeof schema.parse).toBe("function");
            expect(typeof schema.safeParse).toBe("function");

            // Validate a correct input
            const valid = schema.safeParse({ query: "test query" });
            expect(valid.success).toBe(true);

            // Validate with all fields
            const fullValid = schema.safeParse({
                query: "test",
                numResults: 3,
                safeSearch: "moderate",
            });
            expect(fullValid.success).toBe(true);

            // Validate missing required field
            const invalid = schema.safeParse({});
            expect(invalid.success).toBe(false);

            // Validate wrong safeSearch enum
            const wrongEnum = schema.safeParse({
                query: "test",
                safeSearch: "invalid-value",
            });
            expect(wrongEnum.success).toBe(false);

            // Restore
            if (saved) {
                process.env.BRAVE_API_KEY = saved;
            } else {
                delete process.env.BRAVE_API_KEY;
            }
        });

        it("execute returns a string", async () => {
            const saved = process.env.BRAVE_API_KEY;
            process.env.BRAVE_API_KEY = "test-key-xxx";

            const tool = new WebSearchTool();
            const result = tool.createSearchTool();

            // Execute will fail because the API key is fake, but it should return a string error
            const output = await result!.execute({
                query: "test",
                numResults: 1,
            });
            expect(typeof output).toBe("string");
            // Should contain error message since key is fake
            expect(output).toContain("Search failed");

            // Restore
            if (saved) {
                process.env.BRAVE_API_KEY = saved;
            } else {
                delete process.env.BRAVE_API_KEY;
            }
        });
    });

    describe("formatSearchResults()", () => {
        it("returns 'no results' for empty array", () => {
            const tool = new WebSearchTool();
            const result = tool.formatSearchResults([]);
            expect(result).toContain("No search results found");
        });

        it("formats results with title, url, snippet", () => {
            const tool = new WebSearchTool();
            const result = tool.formatSearchResults([
                {
                    title: "Test Title",
                    url: "https://example.com",
                    snippet: "A test snippet",
                },
            ]);
            expect(result).toContain("Test Title");
            expect(result).toContain("https://example.com");
            expect(result).toContain("A test snippet");
        });

        it("includes published date when available", () => {
            const tool = new WebSearchTool();
            const result = tool.formatSearchResults([
                {
                    title: "Dated",
                    url: "https://example.com",
                    snippet: "Has date",
                    publishedDate: "2026-01-15",
                },
            ]);
            expect(result).toContain("2026-01-15");
        });
    });

    describe("isAvailable()", () => {
        it("returns true when BRAVE_API_KEY is set", () => {
            const saved = process.env.BRAVE_API_KEY;
            process.env.BRAVE_API_KEY = "xxx";
            const tool = new WebSearchTool();
            expect(tool.isAvailable()).toBe(true);
            if (saved) {
                process.env.BRAVE_API_KEY = saved;
            } else {
                delete process.env.BRAVE_API_KEY;
            }
        });

        it("returns false when BRAVE_API_KEY is not set", () => {
            const saved = process.env.BRAVE_API_KEY;
            delete process.env.BRAVE_API_KEY;
            const tool = new WebSearchTool();
            expect(tool.isAvailable()).toBe(false);
            if (saved) {
                process.env.BRAVE_API_KEY = saved;
            }
        });
    });
});

import { describe, expect, it } from "bun:test";
import { QueryParser } from "../QueryParser";

describe("QueryParser", () => {
    it("parses natural language fields", () => {
        const parser = new QueryParser();
        const parsed = parser.parseNaturalLanguage('messages from Alice since 2025-01-01 until 2025-01-31 text "calm"');

        expect(parsed.from).toBe("Alice");
        expect(parsed.since).toBe("2025-01-01");
        expect(parsed.until).toBe("2025-01-31");
        expect(parsed.text).toBe("calm");
    });

    it("merges NL values into flag query", () => {
        const parser = new QueryParser();
        const result = parser.parseFromFlags({
            from: "bob",
            nl: "since 2025-02-01 until 2025-02-28",
        });

        expect(result.from).toBe("bob");
        expect(result.since).toBe("2025-02-01");
        expect(result.until).toBe("2025-02-28");
        expect(result.sender).toBe("any");
    });

    it("supports natural-language date phrases", () => {
        const parser = new QueryParser();
        const reference = new Date("2026-03-01T12:00:00.000Z");
        const parsed = parser.parseNaturalLanguage("messages from Alice since last week until yesterday", reference);

        expect(parsed.from).toBe("Alice");
        expect(parsed.since).toBeTruthy();
        expect(parsed.until).toBeTruthy();
    });
});

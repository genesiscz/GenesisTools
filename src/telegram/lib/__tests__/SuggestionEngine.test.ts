import { describe, expect, it } from "bun:test";
import { SuggestionEngine } from "../SuggestionEngine";

describe("SuggestionEngine", () => {
    it("builds suggestion system prompt with style and corrections", () => {
        const prompt = SuggestionEngine.buildSuggestionPrompt({
            contactName: "Alice",
            myName: "Martin",
            stylePrompt: "Short messages, lowercase, uses emoji",
            recentCorrections: [{ suggested: "Hey, how are you?", sent: "hey wyd" }],
            count: 3,
        });

        expect(prompt).toContain("Alice");
        expect(prompt).toContain("3");
        expect(prompt).toContain("lowercase");
        expect(prompt).toContain("hey wyd");
    });

    it("parseSuggestions extracts numbered list", () => {
        const raw = `Here are 3 suggestions:

1. hey whats up
2. yo how was your day
3. lol yea that sounds fun`;

        const suggestions = SuggestionEngine.parseSuggestions(raw);
        expect(suggestions.length).toBe(3);
        expect(suggestions[0]).toBe("hey whats up");
        expect(suggestions[2]).toBe("lol yea that sounds fun");
    });
});

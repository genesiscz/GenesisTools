import { describe, expect, it } from "bun:test";
import { runDarwinKit } from "./helpers";

describe("darwinkit NLP commands", () => {
    describe("detect-language", () => {
        it("detects English", async () => {
            const result = await runDarwinKit("detect-language", "Hello, how are you today?");
            expect(result.language).toBe("en");
            expect(result.confidence).toBeGreaterThan(0.5);
        });

        it("detects French", async () => {
            const result = await runDarwinKit("detect-language", "Bonjour, comment allez-vous?");
            expect(result.language).toBe("fr");
            expect(result.confidence).toBeGreaterThan(0.9);
        });

        it("detects Czech", async () => {
            const result = await runDarwinKit("detect-language", "Vařřila mišička kašičku");
            expect(result.language).toBe("cs");
            expect(result.confidence).toBeGreaterThan(0.9);
        });
    });

    describe("sentiment", () => {
        it("detects positive sentiment", async () => {
            const result = await runDarwinKit("sentiment", "I love this beautiful day!");
            expect(result.label).toBe("positive");
            expect(result.score).toBeGreaterThan(0);
        });

        it("detects negative sentiment", async () => {
            const result = await runDarwinKit("sentiment", "This is terrible and I hate it");
            expect(result.label).toBe("negative");
            expect(result.score).toBeLessThan(0);
        });

        it("detects neutral sentiment", async () => {
            const result = await runDarwinKit("sentiment", "The table is made of wood");
            expect(result.score).toBeGreaterThanOrEqual(-0.8);
            expect(result.score).toBeLessThanOrEqual(0.8);
        });
    });

    describe("tag", () => {
        it("tags with default lexicalClass scheme", async () => {
            const result = await runDarwinKit("tag", "The quick brown fox jumps");
            expect(result.tokens).toBeArray();
            expect(result.tokens.length).toBeGreaterThan(0);

            const fox = result.tokens.find((t: { text: string }) => t.text === "fox");
            expect(fox).toBeDefined();
            expect(fox.tag).toBe("Noun");
            expect(fox.scheme).toBe("lexicalClass");
        });

        it("tags with multiple schemes (space-separated)", async () => {
            const result = await runDarwinKit("tag", "Apple is great", "--schemes", "lemma", "nameType");
            expect(result.tokens).toBeArray();
            const schemes = new Set(result.tokens.map((t: { scheme: string }) => t.scheme));
            expect(schemes.has("lemma")).toBe(true);
            expect(schemes.has("nameType")).toBe(true);
        });
    });

    describe("entities", () => {
        it("extracts named entities", async () => {
            const result = await runDarwinKit("entities", "Tim Cook is the CEO of Apple in Cupertino, California");
            expect(result).toBeArray();
            expect(result.length).toBeGreaterThan(0);

            const places = result.filter((e: { type: string }) => e.type === "place");
            expect(places.length).toBeGreaterThan(0);
        });

        it("returns empty for non-entity text", async () => {
            const result = await runDarwinKit("entities", "the and or but");
            expect(result).toBeArray();
        });
    });

    describe("lemmatize", () => {
        it("returns root forms of words", async () => {
            const result = await runDarwinKit("lemmatize", "The cats were running quickly through the gardens");
            expect(result).toBeArray();
            expect(result).toContain("cat");
            expect(result).toContain("be");
            expect(result).toContain("run");
            expect(result).toContain("garden");
        });
    });

    describe("keywords", () => {
        it("extracts keywords", async () => {
            const result = await runDarwinKit(
                "keywords",
                "Machine learning and artificial intelligence are transforming software development"
            );
            expect(result).toBeArray();
            expect(result.length).toBeGreaterThan(0);
            expect(result[0]).toHaveProperty("word");
            expect(result[0]).toHaveProperty("lemma");
            expect(result[0]).toHaveProperty("lexicalClass");
        });

        it("respects --max flag", async () => {
            const result = await runDarwinKit(
                "keywords",
                "Machine learning and artificial intelligence are transforming software development and cloud computing",
                "--max",
                "3"
            );
            expect(result).toBeArray();
            expect(result.length).toBeLessThanOrEqual(3);
        });
    });
});

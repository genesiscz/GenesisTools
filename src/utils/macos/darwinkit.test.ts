import { afterAll, describe, expect, it } from "bun:test";
import { closeDarwinKit } from "./darwinkit";
import { analyzeSentiment, detectLanguage, embedText, tagText, textDistance } from "./nlp";

afterAll(() => {
    closeDarwinKit();
});

describe("darwinkit language detection", () => {
    it("detects Czech", async () => {
        const r = await detectLanguage("Dobrý den, jak se máte? Dnes je krásný den.");
        expect(r.language).toBe("cs");
        expect(r.confidence).toBeGreaterThan(0.5);
    });

    it("detects Slovak", async () => {
        const r = await detectLanguage("Dobrý deň, ako sa máte? Dnes je krásny deň.");
        expect(r.language).toBe("sk");
        expect(r.confidence).toBeGreaterThan(0.5);
    });

    it("detects Polish", async () => {
        const r = await detectLanguage("Dzień dobry, jak się masz? Dzisiaj jest piękny dzień.");
        expect(r.language).toBe("pl");
        expect(r.confidence).toBeGreaterThan(0.5);
    });

    it("detects German", async () => {
        const r = await detectLanguage("Guten Tag, wie geht es Ihnen? Heute ist ein schöner Tag.");
        expect(r.language).toBe("de");
        expect(r.confidence).toBeGreaterThan(0.5);
    });

    it("detects English", async () => {
        const r = await detectLanguage("Hello, how are you? Today is a beautiful day.");
        expect(r.language).toBe("en");
        expect(r.confidence).toBeGreaterThan(0.8);
    });

    it("detects French", async () => {
        const r = await detectLanguage("Bonjour, comment allez-vous? Aujourd'hui est un beau jour.");
        expect(r.language).toBe("fr");
        expect(r.confidence).toBeGreaterThan(0.8);
    });
});

describe("darwinkit sentiment analysis", () => {
    it("positive text", async () => {
        const r = await analyzeSentiment("I absolutely love this product! It's amazing!");
        expect(r.label).toBe("positive");
        expect(r.score).toBeGreaterThan(0);
    });

    it("negative text", async () => {
        const r = await analyzeSentiment("This is terrible and disappointing. I hate it.");
        expect(r.label).toBe("negative");
        expect(r.score).toBeLessThan(0);
    });

    it("neutral text has low absolute score", async () => {
        const r = await analyzeSentiment("Water boils at one hundred degrees Celsius.");
        expect(Math.abs(r.score)).toBeLessThan(0.8);
    });
});

describe("darwinkit text tagging", () => {
    it("POS tags English text", async () => {
        const r = await tagText("The cat sat on the mat", ["lexicalClass"]);
        expect(r.tokens.length).toBeGreaterThan(0);
        expect(r.tokens.some((t) => t.tag === "Noun")).toBe(true);
        expect(r.tokens.some((t) => t.tag === "Verb")).toBe(true);
    });

    it("extracts named entities", async () => {
        const r = await tagText("Steve Jobs founded Apple in Cupertino", ["nameType"]);
        const tags = r.tokens.map((t) => t.tag);
        expect(tags).toContain("PersonalName");
        expect(tags).toContain("PlaceName");
        // Verify scheme is camelCase (normalized from package's PascalCase)
        expect(r.tokens.every((t) => t.scheme === "nameType")).toBe(true);
    });

    it("returns flattened token format with scheme field", async () => {
        const r = await tagText("Hello world", ["lexicalClass"]);
        for (const token of r.tokens) {
            expect(token).toHaveProperty("text");
            expect(token).toHaveProperty("tag");
            expect(token).toHaveProperty("scheme");
            expect(token.scheme).toBe("lexicalClass");
        }
    });
});

describe("darwinkit embeddings", () => {
    it("returns 512-dim sentence embeddings", async () => {
        const r = await embedText("Hello world", "en", "sentence");
        expect(r.dimension).toBe(512);
        expect(r.vector.length).toBe(512);
    });

    it("similar texts have low distance", async () => {
        const r = await textDistance("budget planning session", "financial review meeting", "en");
        expect(r.distance).toBeLessThan(1.0);
        expect(r.type).toBe("cosine");
    });

    it("dissimilar texts have high distance", async () => {
        const r = await textDistance("budget planning", "cute puppies playing", "en");
        expect(r.distance).toBeGreaterThan(0.5);
    });
});

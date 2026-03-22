import { afterEach, describe, expect, it } from "bun:test";
import { Embedder } from "./Embedder";

const isDarwin = process.platform === "darwin";

describe("Embedder", () => {
    let embedder: Embedder | null = null;

    afterEach(() => {
        if (embedder) {
            embedder.dispose();
            embedder = null;
        }
    });

    it.skipIf(!isDarwin)("Embedder.create() resolves without error", async () => {
        embedder = await Embedder.create({ provider: "darwinkit" });
        expect(embedder).toBeTruthy();
    });

    it.skipIf(!isDarwin)("embedder.dimensions returns a positive number", async () => {
        embedder = await Embedder.create({ provider: "darwinkit" });
        expect(embedder.dimensions).toBeGreaterThan(0);
    });

    it.skipIf(!isDarwin)("embedder.embed() returns { vector: Float32Array, dimensions: number }", async () => {
        embedder = await Embedder.create({ provider: "darwinkit" });
        const result = await embedder.embed("test text");

        expect(result).toHaveProperty("vector");
        expect(result).toHaveProperty("dimensions");
        expect(result.vector).toBeInstanceOf(Float32Array);
        expect(result.dimensions).toBeGreaterThan(0);
        expect(result.vector.length).toBe(result.dimensions);
    });

    it.skipIf(!isDarwin)("embedder.embedMany() returns array of results", async () => {
        embedder = await Embedder.create({ provider: "darwinkit" });
        const results = await embedder.embedMany(["hello", "world"]);

        expect(results).toBeArrayOfSize(2);

        for (const result of results) {
            expect(result.vector).toBeInstanceOf(Float32Array);
            expect(result.dimensions).toBeGreaterThan(0);
        }
    });

    it.skipIf(!isDarwin)("embedder.dispose() doesn't throw", async () => {
        embedder = await Embedder.create({ provider: "darwinkit" });
        expect(() => embedder!.dispose()).not.toThrow();
        embedder = null; // Already disposed
    });
});

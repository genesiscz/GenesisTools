import { describe, expect, it } from "bun:test";
import { runDarwinKit } from "./helpers";

describe("darwinkit embedding commands", () => {
    describe("embed", () => {
        it("computes 512-dim sentence embedding", async () => {
            const result = await runDarwinKit("embed", "Hello world");
            expect(result.dimension).toBe(512);
            expect(result.vector).toBeArray();
            expect((result.vector as number[]).length).toBe(512);
        });

        it("supports --type sentence", async () => {
            const result = await runDarwinKit("embed", "Hello world", "--type", "sentence");
            expect(result.dimension).toBe(512);
        });
    });

    describe("distance", () => {
        it("computes cosine distance between texts", async () => {
            const result = await runDarwinKit("distance", "Hello world", "Hi there");
            expect(result.distance).toBeNumber();
            expect(result.distance).toBeGreaterThanOrEqual(0);
            expect(result.distance).toBeLessThanOrEqual(2);
            expect(result.type).toBe("cosine");
        });

        it("returns ~0 for identical texts", async () => {
            const result = await runDarwinKit("distance", "Hello world", "Hello world");
            expect(result.distance).toBeLessThan(0.01);
        });
    });

    describe("similar", () => {
        it("returns boolean", async () => {
            const result = await runDarwinKit("similar", "I love cats", "I adore kittens");
            expect(typeof result).toBe("boolean");
        });

        it("returns true with high threshold for related texts", async () => {
            const result = await runDarwinKit("similar", "I love cats", "I adore kittens", "--threshold", "1.5");
            expect(result).toBe(true);
        });
    });

    describe("relevance", () => {
        it("scores relevance between 0 and 1", async () => {
            const result = await runDarwinKit(
                "relevance",
                "machine learning",
                "This paper discusses neural networks and deep learning"
            );
            expect(typeof result).toBe("number");
            expect(result as unknown as number).toBeGreaterThan(0);
            expect(result as unknown as number).toBeLessThanOrEqual(1);
        });
    });

    describe("neighbors", () => {
        it("finds semantically similar words", async () => {
            const result = await runDarwinKit("neighbors", "computer", "--count", "3");
            expect(result.neighbors).toBeArray();
            expect((result.neighbors as unknown[]).length).toBeLessThanOrEqual(3);

            const first = (result.neighbors as { text: string; distance: number }[])[0];
            expect(first).toHaveProperty("text");
            expect(first).toHaveProperty("distance");
        });
    });
});

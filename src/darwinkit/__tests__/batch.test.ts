import { describe, expect, it } from "bun:test";
import { runDarwinKit } from "./helpers";

describe("darwinkit batch/text-analysis commands", () => {
    describe("rank", () => {
        it("ranks texts by similarity to query", async () => {
            const result = await runDarwinKit(
                "rank",
                "cooking",
                "--items",
                "baking bread",
                "riding a bike",
                "making pasta"
            );
            expect(result).toBeArray();
            expect((result as unknown[]).length).toBe(3);

            const first = (result as { item: { text: string }; score: number }[])[0];
            expect(first).toHaveProperty("item");
            expect(first).toHaveProperty("score");
            expect(first.item.text).toBeDefined();
        });

        it("splits comma-separated items correctly", async () => {
            const result = await runDarwinKit("rank", "cooking", "--items", "baking bread,riding a bike,making pasta");
            expect(result).toBeArray();
            expect((result as unknown[]).length).toBe(3);
        });
    });

    describe("batch-sentiment", () => {
        it("analyzes sentiment for multiple texts", async () => {
            const result = await runDarwinKit("batch-sentiment", "--items", "I love this", "I hate that", "It is okay");
            expect(result).toBeArray();
            expect((result as unknown[]).length).toBe(3);

            const items = result as { id: string; label: string; score: number }[];
            expect(items[0].label).toBe("positive");
            expect(items[1].label).toBe("negative");
        });

        it("splits comma-separated items correctly", async () => {
            const result = await runDarwinKit("batch-sentiment", "--items", "I love this,I hate that,It is okay");
            expect(result).toBeArray();
            expect((result as unknown[]).length).toBe(3);
        });
    });

    describe("group-by-language", () => {
        it("groups texts by detected language", async () => {
            const result = await runDarwinKit(
                "group-by-language",
                "--items",
                "Hello world",
                "Bonjour le monde",
                "Hola mundo",
                "Ahoj světe"
            );
            expect(typeof result).toBe("object");

            const groups = result as Record<string, unknown[]>;
            const allLangs = Object.keys(groups);
            expect(allLangs.length).toBeGreaterThan(1);
        });

        it("splits comma-separated items correctly", async () => {
            const result = await runDarwinKit(
                "group-by-language",
                "--items",
                "Hello world,Bonjour le monde,Hola mundo"
            );
            const groups = result as Record<string, unknown[]>;
            const totalItems = Object.values(groups).flat().length;
            expect(totalItems).toBe(3);
        });
    });

    describe("deduplicate", () => {
        it("removes semantically duplicate texts", async () => {
            const result = await runDarwinKit(
                "deduplicate",
                "--items",
                "I love cats",
                "I adore kittens",
                "The weather is nice",
                "It is sunny today",
                "Dogs are great"
            );
            expect(result).toBeArray();
        });

        it("splits comma-separated items correctly", async () => {
            const result = await runDarwinKit("deduplicate", "--items", "cats are great,dogs are great,the weather");
            expect(result).toBeArray();
            expect((result as unknown[]).length).toBeGreaterThanOrEqual(2);
        });
    });

    describe("cluster", () => {
        it("groups similar texts into clusters", async () => {
            const result = await runDarwinKit(
                "cluster",
                "--items",
                "I love cats",
                "I adore kittens",
                "The weather is nice",
                "It is sunny today"
            );
            expect(result).toBeArray();

            const clusters = result as { items: { text: string }[]; centroid: string }[];
            expect(clusters.length).toBeGreaterThan(0);
            expect(clusters[0]).toHaveProperty("items");
            expect(clusters[0]).toHaveProperty("centroid");
        });

        it("splits comma-separated items correctly", async () => {
            const result = await runDarwinKit("cluster", "--items", "cats,dogs,weather");
            expect(result).toBeArray();
            const clusters = result as { items: unknown[] }[];
            const totalItems = clusters.reduce((sum, c) => sum + c.items.length, 0);
            expect(totalItems).toBe(3);
        });
    });
});

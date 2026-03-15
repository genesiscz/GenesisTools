import { describe, expect, it } from "bun:test";
import { runDarwinKit } from "./helpers";

describe("darwinkit classification commands", () => {
    describe("classify", () => {
        it("classifies text into categories", async () => {
            const result = await runDarwinKit(
                "classify",
                "This stock is going up",
                "--categories",
                "finance",
                "sports",
                "technology"
            );
            expect(result.category).toBeDefined();
            expect(result.confidence).toBeNumber();
            expect(result.scores).toBeArray();
        });

        it("returns scores for all categories", async () => {
            const result = await runDarwinKit(
                "classify",
                "Goal scored!",
                "--categories",
                "finance",
                "sports",
                "technology"
            );
            const scores = result.scores as { category: string; score: number }[];
            const categories = scores.map((s) => s.category);
            expect(categories).toContain("finance");
            expect(categories).toContain("sports");
            expect(categories).toContain("technology");
        });

        it("splits comma-separated categories correctly", async () => {
            const result = await runDarwinKit("classify", "Goal scored!", "--categories", "finance,sports,technology");
            const scores = result.scores as { category: string }[];
            expect(scores.length).toBe(3);
        });
    });

    describe("classify-batch", () => {
        it("classifies multiple texts", async () => {
            const result = await runDarwinKit(
                "classify-batch",
                "--items",
                "The game was exciting",
                "The stock fell",
                "New CPU released",
                "--categories",
                "finance",
                "sports",
                "technology"
            );
            expect(result).toBeArray();
            expect((result as unknown[]).length).toBe(3);

            const items = result as { id: string; category: string; confidence: number }[];
            expect(items[0]).toHaveProperty("category");
            expect(items[0]).toHaveProperty("confidence");
        });
    });

    describe("group-by-category", () => {
        it("groups texts by classified category", async () => {
            const result = await runDarwinKit(
                "group-by-category",
                "--items",
                "The game was exciting",
                "The stock fell",
                "New CPU released",
                "Goal scored",
                "--categories",
                "finance",
                "sports",
                "technology"
            );
            expect(typeof result).toBe("object");

            const groups = result as Record<string, { text: string }[]>;
            const totalItems = Object.values(groups).flat().length;
            expect(totalItems).toBe(4);
        });
    });
});

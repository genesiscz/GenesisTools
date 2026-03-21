import { describe, expect, test } from "bun:test";

describe("AICloudProvider", () => {
    test("embedBatch method exists and has correct signature", async () => {
        const { AICloudProvider } = await import("./AICloudProvider");
        const provider = new AICloudProvider();

        expect(typeof provider.embedBatch).toBe("function");
        expect(provider.dimensions).toBe(1536);
        expect(provider.type).toBe("cloud");
    });

    test("embedBatch returns empty array for empty input", async () => {
        const { AICloudProvider } = await import("./AICloudProvider");
        const provider = new AICloudProvider();

        const results = await provider.embedBatch([]);

        expect(results).toEqual([]);
    });
});

import { describe, expect, test } from "bun:test";

describe("AILocalProvider", () => {
    test("embedBatch method exists and has correct signature", async () => {
        const { AILocalProvider } = await import("./AILocalProvider");
        const provider = new AILocalProvider();

        expect(typeof provider.embedBatch).toBe("function");
        expect(provider.dimensions).toBe(384);
        expect(provider.type).toBe("local-hf");
    });

    test("embedBatch returns empty array for empty input", async () => {
        const { AILocalProvider } = await import("./AILocalProvider");
        const provider = new AILocalProvider();

        const results = await provider.embedBatch([]);

        expect(results).toEqual([]);
    });
});

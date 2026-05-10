import { describe, expect, it } from "bun:test";
import { formatSummary, runGoldenHarness } from "@app/shops/lib/golden-harness";

describe("matcher golden pairs", () => {
    it("achieves F1 >= 0.95 on the durable product set", async () => {
        const result = await runGoldenHarness();
        if (result.f1 < 0.95) {
            console.log(formatSummary(result));
        }

        expect(result.f1).toBeGreaterThanOrEqual(0.95);
    }, 60_000);
});

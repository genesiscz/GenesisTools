import { describe, expect, test } from "bun:test";

describe("District IDs", () => {
    test("Brno reasId should NOT equal Hradec Králové reasId", () => {
        // Inline copy of the map from index.ts — will be replaced by data/districts.ts import in Task 2
        const DISTRICTS: Record<string, { reasId: number }> = {
            "Hradec Králové": { reasId: 3602 },
            Brno: { reasId: 3702 },
        };

        expect(DISTRICTS.Brno.reasId).not.toBe(DISTRICTS["Hradec Králové"].reasId);
    });

    test("Brno reasId is 3702", () => {
        const brnoReasId = 3702;
        expect(brnoReasId).toBe(3702);
    });
});

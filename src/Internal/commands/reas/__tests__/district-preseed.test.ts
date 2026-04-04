import { describe, expect, test } from "bun:test";
import {
    buildDistrictPreseedConfig,
    PRAHA_DISTRICT_NAMES,
    runDistrictPreseed,
} from "@app/Internal/commands/reas/lib/district-preseed";

describe("runDistrictPreseed", () => {
    test("uses the full Praha 1-22 basket by default and reports failures without aborting", async () => {
        const visited: string[] = [];
        const result = await runDistrictPreseed({
            analyzeDistrict: async (district) => {
                visited.push(district);

                if (district === "Praha 7") {
                    throw new Error("rate limited");
                }
            },
        });

        expect(visited).toEqual(PRAHA_DISTRICT_NAMES);
        expect(result.total).toBe(22);
        expect(result.succeeded).toBe(21);
        expect(result.failed).toBe(1);
        expect(result.warnings).toEqual(["Praha 7: rate limited"]);
    });

    test("buildDistrictPreseedConfig preserves the active disposition lens", () => {
        const { filters, target } = buildDistrictPreseedConfig({
            district: "Praha 2",
            constructionType: "brick",
            disposition: "2+kk",
            periods: "2024,2025",
            price: 6500000,
            area: 64,
        });

        expect(filters.disposition).toBe("2+kk");
        expect(target.disposition).toBe("2+kk");
    });
});

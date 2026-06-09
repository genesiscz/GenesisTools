import { describe, expect, test } from "bun:test";
import chartsList from "./__fixtures__/charts-list.json";
import chartsSources from "./__fixtures__/charts-sources.json";
import { mapLayoutList, mapLayoutStudies } from "./charts-storage";

describe("mapLayoutList", () => {
    test("maps the captured charts-list fixture", () => {
        const layouts = mapLayoutList(chartsList);
        expect(layouts.length).toBeGreaterThan(0);
        expect(layouts[0]).toEqual({
            id: "YLjdL7wq",
            name: "Main",
            symbol: "BATS:MSTR",
            resolution: "1D",
            modified: "2026-06-09",
        });
    });
});

describe("mapLayoutStudies", () => {
    test("maps the captured layout detail fixture into studies with pine ids and inputs", () => {
        const studies = mapLayoutStudies(chartsSources);
        expect(studies.length).toBeGreaterThan(0);

        const mdx = studies.find((s) => s.name.includes("MDX Free"));
        expect(mdx?.pineId).toBe("PUB;0u4crLN8uj6zMzf6TJ0lhIuiKOKlHd7G");
        expect(mdx?.pineVersion).toBe("1.0");

        const macd = studies.find((s) => s.pineId === "STD;MACD");
        expect(macd?.inputs.in_0).toBe(12);
        expect(macd?.inputs.in_3).toBe(9);
    });
});

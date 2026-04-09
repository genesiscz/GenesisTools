import { describe, expect, test } from "bun:test";
import { normalizeTrendChartData } from "@app/Internal/commands/reas/ui/src/components/history/trend-chart-utils";

describe("normalizeTrendChartData", () => {
    test("keeps the latest point for the same district and date", () => {
        expect(
            normalizeTrendChartData([
                { district: "Praha 2", date: "2026-04-01", value: 150000 },
                { district: "Praha 2", date: "2026-04-01", value: 151000 },
                { district: "Praha 2", date: "2026-04-02", value: 152000 },
                { district: "Praha 3", date: "2026-04-01", value: 149000 },
            ])
        ).toEqual([
            { district: "Praha 2", date: "2026-04-01", value: 151000 },
            { district: "Praha 2", date: "2026-04-02", value: 152000 },
            { district: "Praha 3", date: "2026-04-01", value: 149000 },
        ]);
    });

    test("drops incomplete or invalid points", () => {
        expect(
            normalizeTrendChartData([
                { district: "Praha 2", date: "2026-04-01", value: 150000 },
                { district: "", date: "2026-04-02", value: 151000 },
                { district: "Praha 3", date: "", value: 149000 },
                { district: "Praha 4", date: "2026-04-03", value: Number.NaN },
            ])
        ).toEqual([{ district: "Praha 2", date: "2026-04-01", value: 150000 }]);
    });
});

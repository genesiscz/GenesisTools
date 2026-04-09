import { describe, expect, test } from "bun:test";
import {
    collapseDistrictSnapshots,
    serializeDistrictSnapshot,
} from "@app/Internal/commands/reas/lib/district-snapshot";
import type { DistrictSnapshotRow } from "@app/Internal/commands/reas/lib/store";

describe("serializeDistrictSnapshot", () => {
    test("maps database snapshot rows to the camelCase API contract", () => {
        const row: DistrictSnapshotRow = {
            id: 7,
            district: "Praha 2",
            construction_type: "brick",
            disposition: "2+kk",
            median_price_per_m2: 145000,
            comparables_count: 42,
            trend_direction: "rising",
            yoy_change: 6.4,
            market_gross_yield: 4.3,
            market_net_yield: 3.6,
            snapshot_date: "2026-04-01",
            created_at: "2026-04-02 04:00:00",
        };

        expect(serializeDistrictSnapshot(row)).toEqual({
            id: 7,
            district: "Praha 2",
            constructionType: "brick",
            disposition: "2+kk",
            medianPricePerM2: 145000,
            comparablesCount: 42,
            trendDirection: "rising",
            yoyChange: 6.4,
            marketGrossYield: 4.3,
            marketNetYield: 3.6,
            snapshotDate: "2026-04-01",
            snapshotMonth: "2026-04",
        });
    });

    test("collapses daily snapshots to the latest snapshot per month", () => {
        const januaryEarly: DistrictSnapshotRow = {
            id: 1,
            district: "Praha 2",
            construction_type: "brick",
            disposition: "2+kk",
            median_price_per_m2: 140000,
            comparables_count: 18,
            trend_direction: "rising",
            yoy_change: 4.1,
            market_gross_yield: 4.2,
            market_net_yield: 3.5,
            snapshot_date: "2026-01-03",
            created_at: "2026-01-03 08:00:00",
        };
        const januaryLate: DistrictSnapshotRow = {
            ...januaryEarly,
            id: 2,
            median_price_per_m2: 143500,
            comparables_count: 22,
            snapshot_date: "2026-01-28",
            created_at: "2026-01-28 18:30:00",
        };
        const februaryEarly: DistrictSnapshotRow = {
            ...januaryEarly,
            id: 3,
            median_price_per_m2: 145100,
            comparables_count: 25,
            snapshot_date: "2026-02-10",
            created_at: "2026-02-10 09:00:00",
        };
        const februaryLate: DistrictSnapshotRow = {
            ...januaryEarly,
            id: 4,
            median_price_per_m2: 146200,
            comparables_count: 27,
            snapshot_date: "2026-02-26",
            created_at: "2026-02-26 20:15:00",
        };

        const collapsed = collapseDistrictSnapshots({
            rows: [januaryEarly, februaryEarly, januaryLate, februaryLate],
            resolution: "monthly",
        });

        expect(collapsed).toEqual([
            {
                id: 2,
                district: "Praha 2",
                constructionType: "brick",
                disposition: "2+kk",
                medianPricePerM2: 143500,
                comparablesCount: 22,
                trendDirection: "rising",
                yoyChange: 4.1,
                marketGrossYield: 4.2,
                marketNetYield: 3.5,
                snapshotDate: "2026-01-28",
                snapshotMonth: "2026-01",
            },
            {
                id: 4,
                district: "Praha 2",
                constructionType: "brick",
                disposition: "2+kk",
                medianPricePerM2: 146200,
                comparablesCount: 27,
                trendDirection: "rising",
                yoyChange: 4.1,
                marketGrossYield: 4.2,
                marketNetYield: 3.5,
                snapshotDate: "2026-02-26",
                snapshotMonth: "2026-02",
            },
        ]);
    });
});

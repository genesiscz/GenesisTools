import { describe, expect, test } from "bun:test";
import { serializeDistrictSnapshot } from "@app/Internal/commands/reas/lib/district-snapshot";
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
            snapshotDate: "2026-04-01",
        });
    });
});

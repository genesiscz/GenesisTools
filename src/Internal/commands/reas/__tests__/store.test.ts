import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SavePropertyInput } from "@app/Internal/commands/reas/lib/store";
import { ReasDatabase } from "@app/Internal/commands/reas/lib/store";
import type { FullAnalysis } from "@app/Internal/commands/reas/types";
import { SafeJSON } from "@app/utils/json";

function makeAnalysis(overrides?: Partial<Pick<FullAnalysis, "target" | "filters">>): FullAnalysis {
    return {
        comparables: {
            pricePerM2: { median: 85000, mean: 87000, p25: 75000, p75: 95000, min: 60000, max: 120000 },
            targetPercentile: 45,
            listings: [
                {
                    _id: "1",
                    formattedAddress: "Test 1",
                    formattedLocation: "HK",
                    soldPrice: 3500000,
                    price: 3600000,
                    originalPrice: 3700000,
                    disposition: "3+1",
                    utilityArea: 70,
                    displayArea: 72,
                    soldAt: "2025-06-01",
                    firstVisibleAt: "2025-04-01",
                    point: { type: "Point", coordinates: [15.83, 50.21] },
                    cadastralAreaSlug: "hradec-kralove",
                    municipalitySlug: "hradec-kralove",
                    link: "https://example.com/1",
                    pricePerM2: 50000,
                    daysOnMarket: 61,
                    discount: -5.4,
                },
            ],
        },
        trends: {
            periods: [{ label: "Q1 2025", medianPerM2: 85000, count: 10, change: null }],
            yoyChange: 3.5,
            direction: "rising",
        },
        yield: {
            grossYield: 5.5,
            netYield: 4.2,
            paybackYears: 23.8,
            atMarketPrice: { price: 5950000, grossYield: 4.8, netYield: 3.6, paybackYears: 27.8 },
            benchmarks: [{ name: "Czech govt bonds", yield: 4.2 }],
        },
        timeOnMarket: { median: 35, mean: 42, min: 5, max: 120, count: 10 },
        discount: {
            avgDiscount: -4.5,
            medianDiscount: -3.8,
            maxDiscount: -12,
            noDiscountCount: 2,
            totalCount: 10,
            discounts: [],
        },
        rentalListings: [],
        mfBenchmarks: [],
        target: overrides?.target ?? {
            price: 4000000,
            area: 65,
            disposition: "3+1",
            constructionType: "brick",
            monthlyRent: 18000,
            monthlyCosts: 4000,
            district: "Hradec Kralove",
            districtId: 1,
            srealityDistrictId: 100,
        },
        filters: overrides?.filters ?? {
            estateType: "flat",
            constructionType: "brick",
            disposition: "3+1",
            periods: [{ label: "2025", from: new Date("2025-01-01"), to: new Date("2025-12-31") }],
            district: { name: "Hradec Kralove", reasId: 1, srealityId: 100, srealityLocality: "district" },
        },
        investmentScore: {
            overall: 72,
            grade: "B",
            factors: { yieldScore: 65, discountScore: 70, trendScore: 80, marketVelocityScore: 75 },
            reasoning: ["Solid yield above bonds"],
            recommendation: "buy",
        },
        momentum: {
            priceVelocity: 2.5,
            direction: "rising",
            momentum: "accelerating",
            confidence: "high",
            interpretation: "Market momentum is accelerating",
        },
    };
}

let db: ReasDatabase;

beforeEach(() => {
    db = new ReasDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

describe("analysis_history", () => {
    test("saveAnalysis returns inserted row id", () => {
        const id = db.saveAnalysis(makeAnalysis());
        expect(id).toBe(1);
    });

    test("getHistory returns saved analyses in descending order", () => {
        db.saveAnalysis(makeAnalysis());
        db.saveAnalysis(
            makeAnalysis({
                target: {
                    price: 5000000,
                    area: 80,
                    disposition: "2+kk",
                    constructionType: "panel",
                    monthlyRent: 15000,
                    monthlyCosts: 3500,
                    district: "Praha",
                    districtId: 2,
                    srealityDistrictId: 200,
                },
                filters: {
                    estateType: "flat",
                    constructionType: "panel",
                    disposition: "2+kk",
                    periods: [{ label: "2025", from: new Date("2025-01-01"), to: new Date("2025-12-31") }],
                    district: { name: "Praha", reasId: 2, srealityId: 200, srealityLocality: "district" },
                },
            })
        );

        const rows = db.getHistory();
        expect(rows).toHaveLength(2);
        expect(rows[0].district).toBe("Praha");
        expect(rows[1].district).toBe("Hradec Kralove");
    });

    test("getHistory filters by district", () => {
        db.saveAnalysis(makeAnalysis());
        db.saveAnalysis(
            makeAnalysis({
                target: {
                    price: 5000000,
                    area: 80,
                    disposition: "2+kk",
                    constructionType: "panel",
                    monthlyRent: 15000,
                    monthlyCosts: 3500,
                    district: "Praha",
                    districtId: 2,
                    srealityDistrictId: 200,
                },
            })
        );

        const rows = db.getHistory({ district: "Hradec Kralove" });
        expect(rows).toHaveLength(1);
        expect(rows[0].district).toBe("Hradec Kralove");
    });

    test("saveAnalysis extracts key metrics into indexed columns", () => {
        db.saveAnalysis(makeAnalysis());
        const row = db.getHistory()[0];

        expect(row.median_price_per_m2).toBe(85000);
        expect(row.investment_score).toBe(72);
        expect(row.investment_grade).toBe("B");
        expect(row.net_yield).toBe(4.2);
        expect(row.gross_yield).toBe(5.5);
        expect(row.median_days_on_market).toBe(35);
        expect(row.median_discount).toBe(-3.8);
        expect(row.comparables_count).toBe(1);
    });

    test("getHistory respects limit option", () => {
        for (let i = 0; i < 5; i++) {
            db.saveAnalysis(makeAnalysis());
        }

        const rows = db.getHistory({ limit: 3 });
        expect(rows).toHaveLength(3);
    });
});

describe("saved_properties", () => {
    const input: SavePropertyInput = {
        name: "My flat in HK",
        district: "Hradec Kralove",
        constructionType: "brick",
        disposition: "3+1",
        targetPrice: 4000000,
        targetArea: 65,
        monthlyRent: 18000,
        monthlyCosts: 4000,
        periods: "2024,2025",
        providers: "reas,sreality",
        listingUrl: "https://www.sreality.cz/detail/101",
        alertYieldFloor: 4.5,
        alertGradeChange: true,
        notes: "Near the park",
    };

    test("saveProperty and getProperty round-trips data", () => {
        const id = db.saveProperty(input);
        expect(id).toBeGreaterThan(0);

        const row = db.getProperty(id);
        expect(row).not.toBeNull();
        expect(row!.name).toBe("My flat in HK");
        expect(row!.district).toBe("Hradec Kralove");
        expect(row!.construction_type).toBe("brick");
        expect(row!.target_price).toBe(4000000);
        expect(row!.listing_url).toBe("https://www.sreality.cz/detail/101");
        expect(row!.alert_yield_floor).toBe(4.5);
        expect(row!.alert_grade_change).toBe(1);
        expect(row!.notes).toBe("Near the park");
    });

    test("getProperties returns all saved properties", () => {
        db.saveProperty(input);
        db.saveProperty({ ...input, name: "Another flat" });

        const rows = db.getProperties();
        expect(rows).toHaveLength(2);
    });

    test("updatePropertyAnalysis updates last_* fields", () => {
        const id = db.saveProperty(input);
        db.updatePropertyAnalysis(id, makeAnalysis());

        const row = db.getProperty(id);
        expect(row!.last_score).toBe(72);
        expect(row!.last_grade).toBe("B");
        expect(row!.last_net_yield).toBe(4.2);
        expect(row!.last_gross_yield).toBe(5.5);
        expect(row!.comparable_count).toBe(1);
        expect(row!.rental_count).toBe(0);
        expect(row!.last_analysis_json).toContain('"grossYield":5.5');
        expect(row!.last_median_price_per_m2).toBe(85000);
        expect(row!.last_analyzed_at).not.toBeNull();

        const history = db.getPropertyAnalysisHistory(id);
        expect(history).toHaveLength(1);
        expect(history[0].property_id).toBe(id);
        expect(history[0].grade).toBe("B");
        expect(history[0].score).toBe(72);
    });

    test("updatePropertySettings persists alert thresholds for an existing property", () => {
        const id = db.saveProperty(input);

        db.updatePropertySettings(id, {
            alertYieldFloor: 3.8,
            alertGradeChange: false,
        });

        const row = db.getProperty(id);
        expect(row).not.toBeNull();
        expect(row!.alert_yield_floor).toBe(3.8);
        expect(row!.alert_grade_change).toBe(0);
    });

    test("deleteProperty removes the property", () => {
        const id = db.saveProperty(input);
        expect(db.getProperty(id)).not.toBeNull();

        db.deleteProperty(id);
        expect(db.getProperty(id)).toBeNull();
    });

    test("getProperty returns null for non-existent id", () => {
        expect(db.getProperty(999)).toBeNull();
    });
});

describe("district_snapshots", () => {
    test("saveDistrictSnapshot and getDistrictHistory round-trips data", () => {
        db.saveDistrictSnapshot(makeAnalysis());

        const rows = db.getDistrictHistory("Hradec Kralove", "brick", 365, "3+1");
        expect(rows).toHaveLength(1);
        expect(rows[0].median_price_per_m2).toBe(85000);
        expect(rows[0].comparables_count).toBe(1);
        expect(rows[0].trend_direction).toBe("rising");
        expect(rows[0].yoy_change).toBe(3.5);
        expect(rows[0].market_gross_yield).toBe(4.8);
        expect(rows[0].market_net_yield).toBe(3.6);
    });

    test("getDistrictHistory filters by construction type", () => {
        db.saveDistrictSnapshot(makeAnalysis());
        db.saveDistrictSnapshot(
            makeAnalysis({
                target: {
                    price: 4000000,
                    area: 65,
                    disposition: "3+1",
                    constructionType: "panel",
                    monthlyRent: 18000,
                    monthlyCosts: 4000,
                    district: "Hradec Kralove",
                    districtId: 1,
                    srealityDistrictId: 100,
                },
            })
        );

        const brickRows = db.getDistrictHistory("Hradec Kralove", "brick", 365, "3+1");
        expect(brickRows).toHaveLength(1);

        const panelRows = db.getDistrictHistory("Hradec Kralove", "panel", 365, "3+1");
        expect(panelRows).toHaveLength(1);
    });

    test("getDistrictHistory prefers matching disposition snapshots and falls back to generic history", () => {
        db.saveDistrictSnapshot(makeAnalysis());
        db.saveDistrictSnapshot(
            makeAnalysis({
                filters: {
                    estateType: "flat",
                    constructionType: "brick",
                    disposition: undefined,
                    periods: [],
                    district: { name: "Hradec Kralove", reasId: 1, srealityId: 100, srealityLocality: "district" },
                    providers: ["reas"],
                },
                target: {
                    price: 4000000,
                    area: 65,
                    disposition: "all",
                    constructionType: "brick",
                    monthlyRent: 18000,
                    monthlyCosts: 4000,
                    district: "Hradec Kralove",
                    districtId: 1,
                    srealityDistrictId: 100,
                },
            })
        );

        const exactRows = db.getDistrictHistory("Hradec Kralove", "brick", 365, "3+1");
        expect(exactRows).toHaveLength(1);
        expect(exactRows[0].disposition).toBe("3+1");

        const fallbackRows = db.getDistrictHistory("Hradec Kralove", "brick", 365, "2+kk");
        expect(fallbackRows).toHaveLength(1);
        expect(fallbackRows[0].disposition).toBeNull();

        const genericRows = db.getDistrictHistory("Hradec Kralove", "brick", 365);
        expect(genericRows).toHaveLength(1);
        expect(genericRows[0].disposition).toBeNull();
    });
});

describe("listings", () => {
    test("upsertListings saves and updates normalized listings", () => {
        db.upsertListings(
            [
                {
                    source: "sreality",
                    sourceContract: "sreality-v2",
                    type: "rental",
                    sourceId: "101",
                    district: "Praha 2",
                    disposition: "2+kk",
                    area: 60,
                    price: 15000,
                    pricePerM2: 250,
                    address: "Praha 2, Vinohrady",
                    link: "https://sreality.cz/101",
                    status: "active",
                    fetchedAt: "2026-04-02T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ id: 101 }),
                },
            ],
            "Praha 2"
        );

        db.upsertListings(
            [
                {
                    source: "sreality",
                    sourceContract: "sreality-v2",
                    type: "rental",
                    sourceId: "101",
                    district: "Praha 2",
                    disposition: "2+kk",
                    area: 60,
                    price: 16000,
                    pricePerM2: 267,
                    address: "Praha 2, Vinohrady",
                    link: "https://sreality.cz/101",
                    status: "active",
                    fetchedAt: "2026-04-03T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ id: 101, updated: true }),
                },
            ],
            "Praha 2"
        );

        const listings = db.getListings({ type: "rental", district: "Praha 2" });
        expect(listings).toHaveLength(1);
        expect(listings[0].price).toBe(16000);
        expect(listings[0].source).toBe("sreality");
        expect(listings[0].source_contract).toBe("sreality-v2");
        expect(listings[0].raw_json).toContain('"updated":true');

        const listing = db.getListing(listings[0].id);
        expect(listing).not.toBeNull();
        expect(listing!.source_id).toBe("101");
    });

    test("finds a listing by its source url", () => {
        db.upsertListings(
            [
                {
                    source: "sreality",
                    sourceContract: "sreality-v2",
                    type: "rental",
                    sourceId: "101",
                    district: "Praha 2",
                    disposition: "2+kk",
                    area: 60,
                    price: 15000,
                    pricePerM2: 250,
                    address: "Praha 2, Vinohrady",
                    link: "https://sreality.cz/101",
                    status: "active",
                    fetchedAt: "2026-04-02T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ id: 101 }),
                },
            ],
            "Praha 2"
        );

        const listing = db.getListingByUrl("https://sreality.cz/101");

        expect(listing).not.toBeNull();
        expect(listing!.district).toBe("Praha 2");
    });

    test("estimates rent from matching rental listings", () => {
        db.upsertListings(
            [
                {
                    source: "sreality",
                    sourceContract: "sreality-v2",
                    type: "rental",
                    sourceId: "101",
                    district: "Praha 2",
                    disposition: "2+kk",
                    area: 58,
                    price: 18000,
                    pricePerM2: 310,
                    address: "Praha 2, Vinohrady",
                    link: "https://sreality.cz/101",
                    status: "active",
                    fetchedAt: "2026-04-02T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ id: 101 }),
                },
                {
                    source: "bezrealitky",
                    sourceContract: "bezrealitky-graphql",
                    type: "rental",
                    sourceId: "102",
                    district: "Praha 2",
                    disposition: "2+kk",
                    area: 62,
                    price: 20000,
                    pricePerM2: 322,
                    address: "Praha 2, Nusle",
                    link: "https://bezrealitky.cz/102",
                    status: "active",
                    fetchedAt: "2026-04-02T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ id: 102 }),
                },
            ],
            "Praha 2"
        );

        const estimate = db.estimateMonthlyRent({ district: "Praha 2", disposition: "2+kk", area: 60 });

        expect(estimate).not.toBeNull();
        expect(estimate!.medianRent).toBe(19000);
        expect(estimate!.listingCount).toBe(2);
    });

    test("returns listings overview counts and freshness by type", () => {
        db.upsertListings(
            [
                {
                    source: "sreality",
                    sourceContract: "sreality-v2",
                    type: "sale",
                    sourceId: "201",
                    district: "Praha 2",
                    disposition: "2+kk",
                    area: 60,
                    price: 6500000,
                    pricePerM2: 108333,
                    address: "Praha 2, Vinohrady",
                    link: "https://sreality.cz/201",
                    status: "active",
                    fetchedAt: "2026-04-02T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ id: 201 }),
                },
                {
                    source: "bezrealitky",
                    sourceContract: "bezrealitky-graphql",
                    type: "rental",
                    sourceId: "202",
                    district: "Praha 2",
                    disposition: "2+kk",
                    area: 58,
                    price: 19000,
                    pricePerM2: 328,
                    address: "Praha 2, Nusle",
                    link: "https://bezrealitky.cz/202",
                    status: "active",
                    fetchedAt: "2026-04-03T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ id: 202 }),
                },
                {
                    source: "reas",
                    sourceContract: "reas-catalog",
                    type: "sold",
                    sourceId: "203",
                    district: "Praha 2",
                    disposition: "2+kk",
                    area: 55,
                    price: 6200000,
                    pricePerM2: 112727,
                    address: "Praha 2, Vinohrady",
                    link: "https://reas.cz/203",
                    status: "sold",
                    fetchedAt: "2026-04-04T00:00:00.000Z",
                    soldAt: "2026-03-01T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ id: 203 }),
                },
            ],
            "Praha 2"
        );

        const overview = db.getListingsOverview();

        expect(overview.saleCount).toBe(1);
        expect(overview.rentalCount).toBe(1);
        expect(overview.soldCount).toBe(1);
        expect(overview.saleLastFetchedAt).toBe("2026-04-02T00:00:00.000Z");
        expect(overview.rentalLastFetchedAt).toBe("2026-04-03T00:00:00.000Z");
        expect(overview.soldLastFetchedAt).toBe("2026-04-04T00:00:00.000Z");
        expect(overview.sourceCount).toBe(3);
        expect(overview.lastFetchedAt).toBe("2026-04-04T00:00:00.000Z");
        expect(overview.sources).toHaveLength(3);
        expect(overview.sources[0]).toMatchObject({
            source: "reas",
            count: 1,
            lastFetchedAt: "2026-04-04T00:00:00.000Z",
        });
    });

    test("filters listings by multiple dispositions, sources, and seen date range", () => {
        db.upsertListings(
            [
                {
                    source: "sreality",
                    sourceContract: "sreality-v2",
                    type: "sale",
                    sourceId: "301",
                    district: "Praha 2",
                    disposition: "2+kk",
                    area: 61,
                    price: 6400000,
                    pricePerM2: 104918,
                    address: "Praha 2, Vinohrady 1",
                    link: "https://sreality.cz/301",
                    status: "active",
                    fetchedAt: "2026-04-02T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ id: 301 }),
                },
                {
                    source: "bezrealitky",
                    sourceContract: "bezrealitky-graphql",
                    type: "sale",
                    sourceId: "302",
                    district: "Praha 2",
                    disposition: "3+kk",
                    area: 74,
                    price: 8200000,
                    pricePerM2: 110811,
                    address: "Praha 2, Vinohrady 2",
                    link: "https://bezrealitky.cz/302",
                    status: "active",
                    fetchedAt: "2026-04-03T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ id: 302 }),
                },
                {
                    source: "reas",
                    sourceContract: "reas-catalog",
                    type: "sold",
                    sourceId: "303",
                    district: "Praha 2",
                    disposition: "2+kk",
                    area: 58,
                    price: 6100000,
                    pricePerM2: 105172,
                    address: "Praha 2, Vinohrady 3",
                    link: "https://reas.cz/303",
                    status: "sold",
                    fetchedAt: "2026-04-04T00:00:00.000Z",
                    soldAt: "2026-03-15T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ id: 303 }),
                },
            ],
            "Praha 2"
        );

        const listings = db.getListings({
            district: "Praha 2",
            dispositions: ["2+kk", "3+kk"],
            sources: ["bezrealitky", "reas"],
            seenFrom: "2026-03-10",
            seenTo: "2026-04-03",
        });

        expect(listings).toHaveLength(2);
        expect(listings.map((listing) => listing.source)).toEqual(["reas", "bezrealitky"]);
    });

    test("replaces a district snapshot for the same source and type so stale rows are removed", () => {
        db.upsertListings(
            [
                {
                    source: "sreality",
                    sourceContract: "sreality-v2",
                    type: "sale",
                    sourceId: "old-1",
                    district: "Praha 4",
                    price: 6400000,
                    address: "Varšavská, Praha 2 - Vinohrady",
                    link: "https://sreality.cz/old-1",
                    status: "active",
                    fetchedAt: "2026-04-02T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ id: "old-1" }),
                },
                {
                    source: "sreality",
                    sourceContract: "sreality-v2",
                    type: "sale",
                    sourceId: "old-2",
                    district: "Praha 4",
                    price: 8200000,
                    address: "Baranova, Praha 3 - Žižkov",
                    link: "https://sreality.cz/old-2",
                    status: "active",
                    fetchedAt: "2026-04-02T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ id: "old-2" }),
                },
            ],
            "Praha 4"
        );

        db.replaceListingsSnapshot({
            district: "Praha 4",
            type: "sale",
            source: "sreality",
            sourceContract: "sreality-v2",
        });

        db.upsertListings(
            [
                {
                    source: "sreality",
                    sourceContract: "sreality-v2",
                    type: "sale",
                    sourceId: "new-1",
                    district: "Praha 4",
                    price: 14210000,
                    address: "Mečislavova, Praha 4 - Nusle",
                    link: "https://sreality.cz/new-1",
                    status: "active",
                    fetchedAt: "2026-04-03T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ id: "new-1" }),
                },
            ],
            "Praha 4"
        );

        const listings = db.getListings({ district: "Praha 4", type: "sale", source: "sreality" });

        expect(listings).toHaveLength(1);
        expect(listings[0]?.address).toBe("Mečislavova, Praha 4 - Nusle");
    });

    test("repairListingDistricts backfills stale districts from stored listing locality", () => {
        db.upsertListings(
            [
                {
                    source: "bezrealitky",
                    sourceContract: "graphql:listAdverts",
                    type: "rental",
                    sourceId: "repair-1",
                    district: "Praha 4",
                    disposition: "2+kk",
                    area: 57,
                    price: 21000,
                    pricePerM2: 368,
                    address: "Varšavská, Praha 2 - Vinohrady",
                    link: "https://bezrealitky.cz/repair-1",
                    status: "active",
                    fetchedAt: "2026-04-03T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({
                        locality: "Varšavská, Praha 2 - Vinohrady",
                    }),
                },
            ],
            "Praha 4"
        );

        const result = db.repairListingDistricts();

        expect(result.repaired).toBe(1);
        expect(db.getListings({ district: "Praha 2", type: "rental" })).toHaveLength(1);
        expect(db.getListings({ district: "Praha 4", type: "rental" })).toHaveLength(0);
    });

    test("repairListingDistricts can scope repairs to the refreshed provider snapshot", () => {
        db.upsertListings(
            [
                {
                    source: "bezrealitky",
                    sourceContract: "graphql:listAdverts",
                    type: "rental",
                    sourceId: "repair-scope-1",
                    district: "Praha 4",
                    disposition: "2+kk",
                    area: 57,
                    price: 21000,
                    pricePerM2: 368,
                    address: "Varšavská, Praha 2 - Vinohrady",
                    link: "https://bezrealitky.cz/repair-scope-1",
                    status: "active",
                    fetchedAt: "2026-04-03T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ locality: "Varšavská, Praha 2 - Vinohrady" }),
                },
                {
                    source: "sreality",
                    sourceContract: "sreality-v2",
                    type: "rental",
                    sourceId: "repair-scope-2",
                    district: "Praha 4",
                    disposition: "2+kk",
                    area: 58,
                    price: 23000,
                    pricePerM2: 397,
                    address: "Korunní, Praha 2 - Vinohrady",
                    link: "https://sreality.cz/repair-scope-2",
                    status: "active",
                    fetchedAt: "2026-04-03T00:00:00.000Z",
                    rawJson: SafeJSON.stringify({ locality: "Korunní, Praha 2 - Vinohrady" }),
                },
            ],
            "Praha 4"
        );

        const result = db.repairListingDistricts({ district: "Praha 4", types: ["rental"], sources: ["bezrealitky"] });

        expect(result.repaired).toBe(1);
        expect(db.getListings({ district: "Praha 2", type: "rental", source: "bezrealitky" })).toHaveLength(1);
        expect(db.getListings({ district: "Praha 4", type: "rental", source: "sreality" })).toHaveLength(1);
    });
});

describe("provider health monitoring", () => {
    test("logs provider fetches and returns health summary", () => {
        db.logProviderFetch({
            provider: "reas",
            sourceContract: "reas-catalog",
            district: "Praha 2",
            status: "success",
            listingCount: 42,
            durationMs: 1200,
        });
        db.logProviderFetch({
            provider: "reas",
            sourceContract: "reas-catalog",
            district: "Praha 3",
            status: "success",
            listingCount: 18,
            durationMs: 800,
        });
        db.logProviderFetch({
            provider: "sreality",
            sourceContract: "sreality-v2",
            district: "Praha 2",
            status: "error",
            listingCount: 0,
            errorMessage: "Rate limited",
        });

        const health = db.getProviderHealth(30);
        expect(health).toHaveLength(2);

        const reas = health.find((h) => h.provider === "reas")!;
        expect(reas.totalFetches).toBe(2);
        expect(reas.successCount).toBe(2);
        expect(reas.errorCount).toBe(0);
        expect(reas.successRate).toBe(100);
        expect(reas.avgDurationMs).toBe(1000);
        expect(reas.avgListingCount).toBe(30);

        const sreality = health.find((h) => h.provider === "sreality")!;
        expect(sreality.totalFetches).toBe(1);
        expect(sreality.errorCount).toBe(1);
        expect(sreality.successRate).toBe(0);
        expect(sreality.lastError).toBe("Rate limited");
    });

    test("getRecentFetchLog returns entries in descending order", () => {
        db.logProviderFetch({
            provider: "reas",
            sourceContract: "reas-catalog",
            status: "success",
            listingCount: 10,
        });
        db.logProviderFetch({
            provider: "bezrealitky",
            sourceContract: "graphql:listAdverts",
            status: "empty",
            listingCount: 0,
        });

        const log = db.getRecentFetchLog(10);
        expect(log).toHaveLength(2);
        expect(log[0].provider).toBe("bezrealitky");
        expect(log[0].status).toBe("empty");
        expect(log[1].provider).toBe("reas");
    });
});

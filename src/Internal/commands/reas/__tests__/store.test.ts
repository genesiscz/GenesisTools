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

        const rows = db.getDistrictHistory("Hradec Kralove", "brick");
        expect(rows).toHaveLength(1);
        expect(rows[0].median_price_per_m2).toBe(85000);
        expect(rows[0].comparables_count).toBe(1);
        expect(rows[0].trend_direction).toBe("rising");
        expect(rows[0].yoy_change).toBe(3.5);
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

        const brickRows = db.getDistrictHistory("Hradec Kralove", "brick");
        expect(brickRows).toHaveLength(1);

        const panelRows = db.getDistrictHistory("Hradec Kralove", "panel");
        expect(panelRows).toHaveLength(1);
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
});

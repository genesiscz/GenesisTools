import { describe, expect, test } from "bun:test";
import type { SavedPropertyRow } from "@app/Internal/commands/reas/lib/store";
import type { FullAnalysis } from "@app/Internal/commands/reas/types";
import { buildPropertyCardModel } from "@app/Internal/commands/reas/ui/src/components/watchlist/property-card-model";
import { SafeJSON } from "@app/utils/json";

function makeAnalysis(): FullAnalysis {
    return {
        comparables: {
            pricePerM2: { median: 110000, mean: 112000, p25: 101000, p75: 121000, min: 95000, max: 128000 },
            targetPercentile: 42,
            listings: [
                {
                    _id: "1",
                    formattedAddress: "Praha 4",
                    formattedLocation: "Praha 4",
                    soldPrice: 7400000,
                    price: 7500000,
                    originalPrice: 7600000,
                    disposition: "3+1",
                    utilityArea: 72,
                    displayArea: 72,
                    soldAt: "2026-03-01",
                    firstVisibleAt: "2025-12-01",
                    point: { type: "Point", coordinates: [14.45, 50.05] },
                    cadastralAreaSlug: "praha-4",
                    municipalitySlug: "praha",
                    link: "https://reas.cz/1",
                    pricePerM2: 102777,
                    daysOnMarket: 45,
                    discount: -4.2,
                },
            ],
        },
        trends: {
            periods: [
                { label: "Q3 2025", medianPerM2: 103000, count: 8, change: null },
                { label: "Q4 2025", medianPerM2: 107000, count: 9, change: 3.9 },
                { label: "Q1 2026", medianPerM2: 110000, count: 10, change: 2.8 },
            ],
            yoyChange: 6.2,
            direction: "rising",
        },
        yield: {
            grossYield: 4.8,
            netYield: 3.9,
            paybackYears: 25.7,
            atMarketPrice: { price: 7650000, grossYield: 4.6, netYield: 3.7, paybackYears: 26.8 },
            benchmarks: [{ name: "Bonds", yield: 4.1 }],
        },
        timeOnMarket: { median: 38, mean: 42, min: 7, max: 120, count: 10 },
        discount: {
            avgDiscount: -3.8,
            medianDiscount: -3.5,
            maxDiscount: -8.2,
            noDiscountCount: 2,
            totalCount: 10,
            discounts: [],
        },
        rentalListings: [
            {
                id: "r1",
                source: "sreality",
                sourceContract: "sreality-v2",
                sourceId: "r1",
                type: "rental",
                price: 26000,
                area: 72,
                disposition: "3+1",
                locality: "Praha 4",
                link: "https://sreality.cz/r1",
                labels: [],
            },
        ],
        saleListings: [],
        mfBenchmarks: [],
        target: {
            price: 7990000,
            area: 72,
            disposition: "3+1",
            constructionType: "brick",
            monthlyRent: 26000,
            monthlyCosts: 4500,
            district: "Praha 11",
            districtId: 10,
            srealityDistrictId: 10,
        },
        filters: {
            estateType: "flat",
            constructionType: "brick",
            disposition: "3+1",
            periods: [{ label: "2026", from: new Date("2026-01-01"), to: new Date("2026-12-31") }],
            district: { name: "Praha 11", reasId: 10, srealityId: 10, srealityLocality: "district" },
        },
        investmentScore: {
            overall: 68,
            grade: "B",
            factors: { yieldScore: 62, discountScore: 60, trendScore: 74, marketVelocityScore: 70 },
            reasoning: ["Yield remains above local median", "Momentum is still rising", "Comparable depth is healthy"],
            recommendation: "buy",
        },
        momentum: {
            priceVelocity: 2.8,
            direction: "rising",
            momentum: "accelerating",
            confidence: "high",
            interpretation: "Momentum is still improving",
        },
    };
}

function makeProperty(overrides?: Partial<SavedPropertyRow>): SavedPropertyRow {
    const analysis = makeAnalysis();

    return {
        id: 1,
        name: "Praha 4 test",
        district: "Praha 11",
        construction_type: "brick",
        disposition: "3+1",
        target_price: 7990000,
        target_area: 72,
        monthly_rent: 26000,
        monthly_costs: 4500,
        periods: "2026",
        providers: "reas,sreality",
        listing_url: "https://sreality.cz/1",
        last_score: 68,
        last_grade: "B",
        last_net_yield: 3.9,
        last_gross_yield: 4.8,
        last_median_price_per_m2: 110000,
        score: 68,
        gross_yield: 4.8,
        payback_years: 25.7,
        percentile: 42,
        comparable_count: 1,
        rental_count: 1,
        time_on_market: 38,
        discount_vs_market: -3.5,
        momentum: "rising",
        last_analysis_json: SafeJSON.stringify(analysis),
        mortgage_rate: 4.29,
        mortgage_term: 30,
        down_payment: 1600000,
        loan_amount: 6390000,
        alert_yield_floor: null,
        alert_grade_change: 0,
        last_analyzed_at: "2026-04-02T10:00:00.000Z",
        notes: null,
        created_at: "2026-04-02 10:00:00",
        updated_at: "2026-04-02 10:00:00",
        ...overrides,
    };
}

describe("buildPropertyCardModel", () => {
    test("builds expandable metrics and verdict from stored analysis", () => {
        const model = buildPropertyCardModel(makeProperty());

        expect(model).not.toBeNull();
        expect(model!.recommendation).toBe("buy");
        expect(model!.reasons).toHaveLength(3);
        expect(model!.verdictChecklist).toHaveLength(6);
        expect(model!.metrics).toHaveLength(6);
        expect(model!.yieldBreakdown.netYield).toBe(3.9);
        expect(model!.yieldBreakdown.marketNetYield).toBe(3.7);
        expect(model!.yieldBreakdown.benchmarks).toHaveLength(1);
    });

    test("computes mortgage summary when financing data exists", () => {
        const model = buildPropertyCardModel(makeProperty());

        expect(model).not.toBeNull();
        expect(model!.mortgage).not.toBeNull();
        expect(model!.mortgage!.ltv).toBeCloseTo(79.97, 1);
        expect(model!.mortgage!.monthlyPayment).toBeGreaterThan(30000);
        expect(model!.mortgage!.monthlyCashflow).toBeLessThan(0);
        expect(model!.mortgage!.cashOnCashReturn).toBeLessThan(0);
        expect(model!.mortgage!.breakEvenOccupancy).toBeGreaterThan(100);
        expect(model!.mortgage!.amortization).toHaveLength(6);
    });

    test("returns null when no stored analysis exists", () => {
        expect(buildPropertyCardModel(makeProperty({ last_analysis_json: null }))).toBeNull();
    });

    test("hides the median price metric when comparable evidence is missing", () => {
        const analysis = makeAnalysis();
        analysis.comparables.listings = [];
        analysis.comparables.pricePerM2.median = 0;

        const model = buildPropertyCardModel(
            makeProperty({
                last_analysis_json: SafeJSON.stringify(analysis),
                comparable_count: 0,
                last_median_price_per_m2: 0,
            })
        );

        expect(model).not.toBeNull();
        expect(model?.metrics.find((metric) => metric.label === "CZK/m2")?.value).toBe("-");
        expect(model?.metrics.find((metric) => metric.label === "Comps")?.value).toBe("-");
    });
});

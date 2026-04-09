import type { DistrictComparison } from "./types";

const PRAHA_CONTEXT: Record<
    string,
    { title: string; highlights: string[]; transport: string[]; developments: string[] }
> = {
    "Praha 1": {
        title: "Praha 1 premium historic core",
        highlights: ["Prestige pricing", "Tourism and short-stay pressure", "Tight prime inventory"],
        transport: ["Metro A/B", "Dense tram grid"],
        developments: ["Protected stock limits new supply"],
    },
    "Praha 2": {
        title: "Praha 2 urban core with stable demand",
        highlights: [
            "Strong owner-occupier demand",
            "Established inner-city stock",
            "Premium micro-locations around Vinohrady",
        ],
        transport: ["Metro A/C", "High tram accessibility"],
        developments: ["Renovation-led repricing in older stock"],
    },
    "Praha 3": {
        title: "Praha 3 growth district with spillover demand",
        highlights: [
            "Value relative to core wards",
            "Mixed stock attracts broad demand",
            "Creative-office spillover supports rents",
        ],
        transport: ["Tram backbone", "Metro A edge access"],
        developments: ["Former industrial pockets continue to reposition"],
    },
};

export interface DistrictBarRow {
    district: string;
    medianPricePerM2: number;
    grossYield: number;
    highlight: boolean;
}

export interface DistrictRadarRow {
    metric: string;
    [district: string]: number | string;
}

export interface DistrictContextItem {
    district: string;
    title: string;
    highlights: string[];
    transport: string[];
    developments: string[];
}

function round(value: number) {
    return Math.round(value * 10) / 10;
}

function normalizeHigherBetter(values: number[]) {
    const min = Math.min(...values);
    const max = Math.max(...values);

    return values.map((value) => {
        if (max === min) {
            return 100;
        }

        return round(((value - min) / (max - min)) * 100);
    });
}

function normalizeLowerBetter(values: number[]) {
    const min = Math.min(...values);
    const max = Math.max(...values);

    return values.map((value) => {
        if (max === min) {
            return 100;
        }

        return round(((max - value) / (max - min)) * 100);
    });
}

function getDistrictMarketGrossYield(comparison: DistrictComparison) {
    return comparison.exportData.analysis.yield.atMarketPrice.grossYield;
}

export function buildDistrictPriceBarModel({
    comparisons,
    targetDistrict,
    targetPricePerM2,
}: {
    comparisons: DistrictComparison[];
    targetDistrict?: string;
    targetPricePerM2?: number;
}) {
    const rows = [...comparisons]
        .sort((left, right) => left.summary.medianPricePerM2 - right.summary.medianPricePerM2)
        .map((comparison) => ({
            district: comparison.district,
            medianPricePerM2: comparison.summary.medianPricePerM2,
            grossYield: comparison.summary.grossYield,
            highlight: comparison.district === targetDistrict,
        }));

    const pragueAverage =
        rows.length > 0 ? Math.round(rows.reduce((total, row) => total + row.medianPricePerM2, 0) / rows.length) : null;

    return {
        rows,
        pragueAverage,
        targetPricePerM2: targetPricePerM2 ?? null,
    };
}

export function buildDistrictYieldBarModel({
    comparisons,
    targetDistrict,
}: {
    comparisons: DistrictComparison[];
    targetDistrict?: string;
}) {
    const rows = [...comparisons]
        .sort((left, right) => getDistrictMarketGrossYield(right) - getDistrictMarketGrossYield(left))
        .map((comparison) => ({
            district: comparison.district,
            medianPricePerM2: comparison.summary.medianPricePerM2,
            grossYield: getDistrictMarketGrossYield(comparison),
            highlight: comparison.district === targetDistrict,
        }));

    const benchmarkYield =
        rows.length > 0 ? round(rows.reduce((total, row) => total + row.grossYield, 0) / rows.length) : null;

    return {
        rows,
        benchmarkYield,
    };
}

export function buildDistrictRadarModel({
    comparisons,
    selectedDistricts,
}: {
    comparisons: DistrictComparison[];
    selectedDistricts: string[];
}) {
    const selected = comparisons.filter((comparison) => selectedDistricts.includes(comparison.district)).slice(0, 4);

    if (selected.length === 0) {
        return {
            rows: [] as DistrictRadarRow[],
            series: [] as Array<{ district: string }>,
        };
    }

    const priceScores = normalizeLowerBetter(selected.map((comparison) => comparison.summary.medianPricePerM2));
    const yieldScores = normalizeHigherBetter(selected.map((comparison) => getDistrictMarketGrossYield(comparison)));
    const liquidityScores = normalizeLowerBetter(selected.map((comparison) => comparison.summary.daysOnMarket));
    const discountScores = normalizeHigherBetter(
        selected.map((comparison) => comparison.exportData.analysis.discount.medianDiscount)
    );
    const trendScores = normalizeHigherBetter(
        selected.map((comparison) => comparison.snapshots[comparison.snapshots.length - 1]?.yoyChange ?? 0)
    );
    const volumeScores = normalizeHigherBetter(selected.map((comparison) => comparison.summary.salesCount));

    const metrics = [
        { metric: "Price", values: priceScores },
        { metric: "Yield", values: yieldScores },
        { metric: "Liquidity", values: liquidityScores },
        { metric: "Discount", values: discountScores },
        { metric: "Trend", values: trendScores },
        { metric: "Volume", values: volumeScores },
    ];

    return {
        series: selected.map((comparison) => ({ district: comparison.district })),
        rows: metrics.map((entry) => {
            const row: DistrictRadarRow = { metric: entry.metric };

            for (const [index, comparison] of selected.entries()) {
                row[comparison.district] = entry.values[index] ?? 0;
            }

            return row;
        }),
    };
}

export function buildDistrictContextItems(districts: string[]) {
    return districts.map((district) => {
        const curated = PRAHA_CONTEXT[district];

        if (curated) {
            return {
                district,
                ...curated,
            };
        }

        return {
            district,
            title: `${district} market context`,
            highlights: ["Review liquidity, yields, and active-vs-sold spread for local signal quality"],
            transport: ["Validate rail, metro, and tram access against listing density"],
            developments: ["Track new supply and regeneration projects that can reset pricing"],
        };
    });
}

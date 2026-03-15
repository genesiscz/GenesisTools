import type { ReasListing } from "../types";
import { median } from "./comparables";

export interface TrendPeriod {
    label: string;
    medianPerM2: number;
    count: number;
    change: number | null;
}

export interface TrendsResult {
    periods: TrendPeriod[];
    yoyChange: number | null;
    direction: "rising" | "falling" | "stable";
}

function getQuarterLabel(date: Date): string {
    const quarter = Math.ceil((date.getMonth() + 1) / 3);
    return `Q${quarter} ${date.getFullYear()}`;
}

function getQuarterSortKey(date: Date): number {
    const quarter = Math.ceil((date.getMonth() + 1) / 3);
    return date.getFullYear() * 10 + quarter;
}

export function analyzeTrends(listings: ReasListing[]): TrendsResult {
    const validListings = listings.filter((l) => l.soldAt && l.utilityArea > 0);

    const groups = new Map<string, { sortKey: number; prices: number[] }>();

    for (const listing of validListings) {
        const date = new Date(listing.soldAt);
        const label = getQuarterLabel(date);
        const sortKey = getQuarterSortKey(date);
        const pricePerM2 = listing.soldPrice / listing.utilityArea;

        const existing = groups.get(label);

        if (existing) {
            existing.prices.push(pricePerM2);
        } else {
            groups.set(label, { sortKey, prices: [pricePerM2] });
        }
    }

    const sortedEntries = [...groups.entries()].sort((a, b) => a[1].sortKey - b[1].sortKey);

    const periods: TrendPeriod[] = [];

    for (let i = 0; i < sortedEntries.length; i++) {
        const [label, { prices }] = sortedEntries[i];
        const sorted = [...prices].sort((a, b) => a - b);
        const medianPerM2 = median(sorted);

        let change: number | null = null;

        if (i > 0) {
            const prevMedian = periods[i - 1].medianPerM2;

            if (prevMedian > 0) {
                change = ((medianPerM2 - prevMedian) / prevMedian) * 100;
            }
        }

        periods.push({ label, medianPerM2, count: prices.length, change });
    }

    const yoyChange = computeYoY(periods);
    const direction = determineDirection(periods);

    return { periods, yoyChange, direction };
}

function computeYoY(periods: TrendPeriod[]): number | null {
    if (periods.length < 2) {
        return null;
    }

    const last = periods[periods.length - 1];
    const lastQuarter = last.label.split(" ")[0];
    const lastYear = parseInt(last.label.split(" ")[1], 10);

    const sameQuarterPrevYear = periods.find((p) => {
        const [q, y] = p.label.split(" ");
        return q === lastQuarter && parseInt(y, 10) === lastYear - 1;
    });

    if (sameQuarterPrevYear && sameQuarterPrevYear.medianPerM2 > 0) {
        return ((last.medianPerM2 - sameQuarterPrevYear.medianPerM2) / sameQuarterPrevYear.medianPerM2) * 100;
    }

    const first = periods[0];

    if (first.medianPerM2 > 0) {
        return ((last.medianPerM2 - first.medianPerM2) / first.medianPerM2) * 100;
    }

    return null;
}

function determineDirection(periods: TrendPeriod[]): "rising" | "falling" | "stable" {
    if (periods.length < 2) {
        return "stable";
    }

    const recent = periods.slice(-2);
    const allRising = recent.every((p) => p.change !== null && p.change > 0);

    if (allRising) {
        return "rising";
    }

    const allFalling = recent.every((p) => p.change !== null && p.change < 0);

    if (allFalling) {
        return "falling";
    }

    return "stable";
}

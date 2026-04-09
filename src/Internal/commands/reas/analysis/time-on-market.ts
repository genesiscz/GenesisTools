import { median as computeMedian } from "@app/Internal/commands/reas/analysis/comparables";
import type { ReasListing } from "@app/Internal/commands/reas/types";

export interface TimeOnMarketResult {
    median: number;
    mean: number;
    min: number;
    max: number;
    count: number;
}

export function analyzeTimeOnMarket(listings: ReasListing[]): TimeOnMarketResult {
    const days = listings
        .filter((l) => l.firstVisibleAt && l.soldAt)
        .map((l) => {
            return (new Date(l.soldAt).getTime() - new Date(l.firstVisibleAt).getTime()) / 86_400_000;
        })
        .filter((d) => d > 0);

    if (days.length === 0) {
        return { median: 0, mean: 0, min: 0, max: 0, count: 0 };
    }

    const sorted = [...days].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);

    return {
        median: computeMedian(sorted),
        mean: sum / sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        count: sorted.length,
    };
}

import type { ReasListing, TargetProperty } from "@app/Internal/commands/reas/types";

export function median(sorted: number[]): number {
    if (sorted.length === 0) {
        return 0;
    }

    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }

    return sorted[mid];
}

export function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) {
        return 0;
    }

    if (sorted.length === 1) {
        return sorted[0];
    }

    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) {
        return sorted[lower];
    }

    const fraction = index - lower;
    return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

export interface ComparablesResult {
    pricePerM2: {
        median: number;
        mean: number;
        p25: number;
        p75: number;
        min: number;
        max: number;
    };
    targetPercentile: number;
    listings: Array<ReasListing & { pricePerM2: number; daysOnMarket: number; discount: number }>;
}

export function analyzeComparables(listings: ReasListing[], target: TargetProperty): ComparablesResult {
    const enriched = listings
        .filter((l) => l.utilityArea > 0)
        .map((l) => {
            const pricePerM2 = l.soldPrice / l.utilityArea;
            const soldAtMs = new Date(l.soldAt).getTime();
            const firstVisibleMs = l.firstVisibleAt ? new Date(l.firstVisibleAt).getTime() : NaN;
            const daysOnMarket =
                Number.isFinite(soldAtMs) && Number.isFinite(firstVisibleMs)
                    ? Math.max(0, (soldAtMs - firstVisibleMs) / 86_400_000)
                    : 0;
            const discount = l.originalPrice > 0 ? ((l.soldPrice - l.originalPrice) / l.originalPrice) * 100 : 0;

            return { ...l, pricePerM2, daysOnMarket, discount };
        })
        .sort((a, b) => a.pricePerM2 - b.pricePerM2);

    const prices = enriched.map((l) => l.pricePerM2);
    const sum = prices.reduce((acc, v) => acc + v, 0);

    const targetPricePerM2 = target.area > 0 ? target.price / target.area : 0;
    const targetPercentile = computeTargetPercentile(prices, targetPricePerM2);

    return {
        pricePerM2: {
            median: median(prices),
            mean: prices.length > 0 ? sum / prices.length : 0,
            p25: percentile(prices, 25),
            p75: percentile(prices, 75),
            min: prices.length > 0 ? prices[0] : 0,
            max: prices.length > 0 ? prices[prices.length - 1] : 0,
        },
        targetPercentile,
        listings: enriched,
    };
}

function computeTargetPercentile(sorted: number[], value: number): number {
    if (sorted.length === 0) {
        return 0;
    }

    let low = 0;
    let high = sorted.length;

    while (low < high) {
        const mid = (low + high) >>> 1;

        if (sorted[mid] < value) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    // Midpoint percentile: average of lower and upper bounds for equal values
    let upper = low;

    while (upper < sorted.length && sorted[upper] === value) {
        upper++;
    }

    return ((low + upper) / 2 / sorted.length) * 100;
}

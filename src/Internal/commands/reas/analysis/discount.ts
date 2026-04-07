import { median as computeMedian } from "@app/Internal/commands/reas/analysis/comparables";
import type { ReasListing } from "@app/Internal/commands/reas/types";

export interface DiscountResult {
    avgDiscount: number;
    medianDiscount: number;
    maxDiscount: number;
    noDiscountCount: number;
    totalCount: number;
    discounts: Array<{ listingId: string; discount: number }>;
}

const MAX_DISCOUNT_PERCENT = 50;

export function analyzeDiscount(listings: ReasListing[]): DiscountResult {
    const valid = listings.filter((l) => l.originalPrice > 0 && l.originalPrice !== l.soldPrice);

    const discounts = valid
        .map((l) => ({
            listingId: l._id,
            discount: ((l.soldPrice - l.originalPrice) / l.originalPrice) * 100,
        }))
        .filter((d) => Math.abs(d.discount) <= MAX_DISCOUNT_PERCENT);

    if (discounts.length === 0) {
        return {
            avgDiscount: 0,
            medianDiscount: 0,
            maxDiscount: 0,
            noDiscountCount: listings.filter((l) => l.originalPrice > 0 && l.soldPrice >= l.originalPrice).length,
            totalCount: listings.length,
            discounts: [],
        };
    }

    const values = discounts.map((d) => d.discount).sort((a, b) => a - b);
    const sum = values.reduce((acc, v) => acc + v, 0);

    const noDiscountCount = listings.filter((l) => l.originalPrice > 0 && l.soldPrice >= l.originalPrice).length;

    return {
        avgDiscount: sum / values.length,
        medianDiscount: computeMedian(values),
        maxDiscount: values[0], // Most negative (deepest) discount — values sorted ascending
        noDiscountCount,
        totalCount: listings.length,
        discounts,
    };
}

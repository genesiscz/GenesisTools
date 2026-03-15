import type { ReasListing } from "../types";
import { median as computeMedian } from "./comparables";

export interface DiscountResult {
    avgDiscount: number;
    medianDiscount: number;
    maxDiscount: number;
    noDiscountCount: number;
    totalCount: number;
    discounts: Array<{ listingId: string; discount: number }>;
}

export function analyzeDiscount(listings: ReasListing[]): DiscountResult {
    const valid = listings.filter((l) => l.originalPrice > 0 && l.originalPrice !== l.soldPrice);

    const discounts = valid.map((l) => ({
        listingId: l._id,
        discount: ((l.soldPrice - l.originalPrice) / l.originalPrice) * 100,
    }));

    if (discounts.length === 0) {
        return {
            avgDiscount: 0,
            medianDiscount: 0,
            maxDiscount: 0,
            noDiscountCount: listings.filter((l) => l.soldPrice >= l.originalPrice).length,
            totalCount: listings.length,
            discounts: [],
        };
    }

    const values = discounts.map((d) => d.discount).sort((a, b) => a - b);
    const sum = values.reduce((acc, v) => acc + v, 0);

    const noDiscountCount = discounts.filter((d) => d.discount >= 0).length;

    return {
        avgDiscount: sum / values.length,
        medianDiscount: computeMedian(values),
        maxDiscount: values[0],
        noDiscountCount,
        totalCount: listings.length,
        discounts,
    };
}

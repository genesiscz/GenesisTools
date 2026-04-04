import { median } from "@app/Internal/commands/reas/analysis/comparables";
import type { ReasListing, SaleListing } from "@app/Internal/commands/reas/types";

export interface ActiveVsSoldComparison {
    activeCount: number;
    soldCount: number;
    medianActivePricePerM2: number;
    medianSoldPricePerM2: number;
    askingToSoldRatio: number;
    askingPremiumPct: number;
}

function getPositiveMedian(values: number[]): number {
    const sorted = values.filter((value) => value > 0).sort((left, right) => left - right);
    return median(sorted);
}

export function analyzeActiveVsSold({
    activeListings,
    soldListings,
}: {
    activeListings: SaleListing[];
    soldListings: ReasListing[];
}): ActiveVsSoldComparison | undefined {
    const medianActivePricePerM2 = getPositiveMedian(
        activeListings.map((listing) => listing.pricePerM2 ?? (listing.area ? listing.price / listing.area : 0))
    );
    const medianSoldPricePerM2 = getPositiveMedian(
        soldListings.map(
            (listing) => listing.pricePerM2 ?? (listing.utilityArea ? listing.soldPrice / listing.utilityArea : 0)
        )
    );

    if (medianActivePricePerM2 <= 0 || medianSoldPricePerM2 <= 0) {
        return undefined;
    }

    const askingToSoldRatio = medianActivePricePerM2 / medianSoldPricePerM2;

    return {
        activeCount: activeListings.length,
        soldCount: soldListings.length,
        medianActivePricePerM2,
        medianSoldPricePerM2,
        askingToSoldRatio,
        askingPremiumPct: (askingToSoldRatio - 1) * 100,
    };
}

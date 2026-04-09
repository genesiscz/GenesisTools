import { median } from "@app/Internal/commands/reas/analysis/comparables";
import type { RentalListing } from "@app/Internal/commands/reas/types";

export interface RentEstimation {
    estimatedMonthlyRent: number;
    estimatedRentPerM2: number;
    confidenceRange: { low: number; high: number };
    sampleSize: number;
    method: "disposition-median" | "area-regression" | "district-fallback";
}

export interface DispositionYieldRow {
    disposition: string;
    medianRent: number;
    medianSoldPricePerM2: number;
    grossYieldPct: number;
    sampleRentals: number;
    sampleSold: number;
}

export function estimateRent({
    area,
    disposition,
    rentals,
}: {
    area: number;
    disposition?: string;
    rentals: RentalListing[];
}): RentEstimation | undefined {
    if (rentals.length === 0 || area <= 0) {
        return undefined;
    }

    const matchingDisposition = disposition ? rentals.filter((listing) => listing.disposition === disposition) : [];

    if (matchingDisposition.length >= 3) {
        const rents = matchingDisposition.map((listing) => listing.price).sort((left, right) => left - right);
        const rentPerM2Values = matchingDisposition
            .filter((listing) => (listing.area ?? 0) > 0)
            .map((listing) => listing.price / listing.area!)
            .sort((left, right) => left - right);
        const medianRentPerM2 = rentPerM2Values.length >= 2 ? median(rentPerM2Values) : median(rents) / area;
        const estimated = Math.round(medianRentPerM2 * area);
        const p25 = rents[Math.floor(rents.length * 0.25)];
        const p75 = rents[Math.floor(rents.length * 0.75)];

        return {
            estimatedMonthlyRent: estimated,
            estimatedRentPerM2: Math.round(medianRentPerM2),
            confidenceRange: { low: p25, high: p75 },
            sampleSize: matchingDisposition.length,
            method: "disposition-median",
        };
    }

    const withArea = rentals.filter((listing): listing is RentalListing & { area: number } => (listing.area ?? 0) > 0);

    if (withArea.length >= 5) {
        const rentPerM2Values = withArea
            .map((listing) => listing.price / listing.area)
            .sort((left, right) => left - right);
        const medianRentPerM2 = median(rentPerM2Values);
        const estimated = Math.round(medianRentPerM2 * area);
        const allRents = withArea.map((listing) => listing.price).sort((left, right) => left - right);
        const p25 = allRents[Math.floor(allRents.length * 0.25)];
        const p75 = allRents[Math.floor(allRents.length * 0.75)];

        return {
            estimatedMonthlyRent: estimated,
            estimatedRentPerM2: Math.round(medianRentPerM2),
            confidenceRange: { low: p25, high: p75 },
            sampleSize: withArea.length,
            method: "area-regression",
        };
    }

    const allRents = rentals.map((listing) => listing.price).sort((left, right) => left - right);
    const medianRent = median(allRents);

    return {
        estimatedMonthlyRent: Math.round(medianRent),
        estimatedRentPerM2: Math.round(medianRent / area),
        confidenceRange: {
            low: allRents[Math.floor(allRents.length * 0.25)] ?? medianRent,
            high: allRents[Math.floor(allRents.length * 0.75)] ?? medianRent,
        },
        sampleSize: rentals.length,
        method: "district-fallback",
    };
}

export function computeDispositionYields({
    rentals,
    soldListings,
}: {
    rentals: RentalListing[];
    soldListings: Array<{ disposition?: string; pricePerM2?: number; soldPrice?: number; utilityArea?: number }>;
}): DispositionYieldRow[] {
    const rentalsByDisp = new Map<string, number[]>();
    const soldByDisp = new Map<string, number[]>();

    for (const listing of rentals) {
        if (!listing.disposition || !listing.area || listing.area <= 0) {
            continue;
        }

        const existing = rentalsByDisp.get(listing.disposition) ?? [];
        existing.push(listing.price / listing.area);
        rentalsByDisp.set(listing.disposition, existing);
    }

    for (const listing of soldListings) {
        if (!listing.disposition) {
            continue;
        }

        const ppm2 = listing.pricePerM2 ?? (listing.utilityArea ? listing.soldPrice! / listing.utilityArea : 0);

        if (ppm2 <= 0) {
            continue;
        }

        const existing = soldByDisp.get(listing.disposition) ?? [];
        existing.push(ppm2);
        soldByDisp.set(listing.disposition, existing);
    }

    const rows: DispositionYieldRow[] = [];

    for (const [disposition, rentPerM2Values] of rentalsByDisp) {
        const soldValues = soldByDisp.get(disposition);

        if (!soldValues || soldValues.length === 0) {
            continue;
        }

        const medianRentPerM2 = median(rentPerM2Values.sort((left, right) => left - right));
        const medianSoldPricePerM2 = median(soldValues.sort((left, right) => left - right));
        const annualRentPerM2 = medianRentPerM2 * 12;
        const grossYieldPct = (annualRentPerM2 / medianSoldPricePerM2) * 100;

        rows.push({
            disposition,
            medianRent: Math.round(medianRentPerM2),
            medianSoldPricePerM2: Math.round(medianSoldPricePerM2),
            grossYieldPct: Math.round(grossYieldPct * 100) / 100,
            sampleRentals: rentPerM2Values.length,
            sampleSold: soldValues.length,
        });
    }

    return rows.sort((left, right) => right.grossYieldPct - left.grossYieldPct);
}

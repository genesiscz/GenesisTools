import { median } from "@app/Internal/commands/reas/analysis/comparables";

export interface RentalSource {
    provider: "sreality" | "ereality" | "bezrealitky";
    listings: Array<{ disposition: string; area: number; rent: number; address: string }>;
}

export interface AggregatedRentalStats {
    disposition: string;
    count: number;
    medianRent: number;
    meanRent: number;
    minRent: number;
    maxRent: number;
    rentPerM2: number;
    sources: Record<string, { count: number; median: number }>;
    confidence: "high" | "medium" | "low";
}

interface UnifiedListing {
    disposition: string;
    area: number;
    rent: number;
    address: string;
    provider: string;
}

export function deduplicateListings(sources: RentalSource[]): UnifiedListing[] {
    const all: UnifiedListing[] = [];

    for (const source of sources) {
        for (const listing of source.listings) {
            all.push({ ...listing, provider: source.provider });
        }
    }

    const seen = new Set<string>();

    return all.filter((listing) => {
        // Dedupe key: normalized address + price (±500 CZK tolerance)
        const addrNorm = listing.address.toLowerCase().replace(/\s+/g, " ").trim();
        const priceGroup = Math.round(listing.rent / 500) * 500;
        const areaGroup = listing.area > 0 ? Math.round(listing.area) : 0;
        const key = `${addrNorm}|${listing.disposition}|${areaGroup}|${priceGroup}`;

        if (seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

export function aggregateRentals(sources: RentalSource[]): AggregatedRentalStats[] {
    const deduped = deduplicateListings(sources);

    // Group by disposition
    const groups = new Map<string, UnifiedListing[]>();

    for (const listing of deduped) {
        if (!listing.disposition) {
            continue;
        }

        const existing = groups.get(listing.disposition) ?? [];
        existing.push(listing);
        groups.set(listing.disposition, existing);
    }

    const results: AggregatedRentalStats[] = [];

    for (const [disposition, listings] of groups) {
        const rents = listings.map((l) => l.rent).sort((a, b) => a - b);
        const rentPerM2Values = listings
            .filter((l) => l.area > 0)
            .map((l) => l.rent / l.area)
            .sort((a, b) => a - b);
        const medianRent = median(rents);

        // Per-provider stats
        const providerGroups = new Map<string, number[]>();

        for (const listing of listings) {
            const existing = providerGroups.get(listing.provider) ?? [];
            existing.push(listing.rent);
            providerGroups.set(listing.provider, existing);
        }

        const sourcesMap: Record<string, { count: number; median: number }> = {};

        for (const [provider, provRents] of providerGroups) {
            sourcesMap[provider] = {
                count: provRents.length,
                median: median(provRents.sort((a, b) => a - b)),
            };
        }

        results.push({
            disposition,
            count: listings.length,
            medianRent,
            meanRent: rents.reduce((a, b) => a + b, 0) / rents.length,
            minRent: rents[0],
            maxRent: rents[rents.length - 1],
            rentPerM2: rentPerM2Values.length > 0 ? median(rentPerM2Values) : 0,
            sources: sourcesMap,
            confidence: listings.length >= 10 ? "high" : listings.length >= 5 ? "medium" : "low",
        });
    }

    return results.sort((a, b) => a.disposition.localeCompare(b.disposition));
}

import type { ListingRow, RentEstimate, SavePropertyInput } from "@app/Internal/commands/reas/lib/store";

export interface ImportedPropertyDraft {
    name: string;
    district: string;
    disposition?: string;
    targetPrice: number;
    targetArea: number;
    monthlyRent: number;
    listingUrl: string;
}

export function buildImportedPropertyDraft(options: {
    listing: ListingRow;
    rentEstimate: RentEstimate | null;
}): ImportedPropertyDraft {
    const { listing, rentEstimate } = options;
    const address = listing.address.trim();
    const disposition = listing.disposition ?? undefined;
    const nameParts = [disposition, address].filter((value): value is string => Boolean(value && value.trim()));

    return {
        name: nameParts.join(" · ") || address || `Imported ${listing.type} listing`,
        district: listing.district,
        disposition,
        targetPrice: listing.type === "rental" ? 0 : listing.price,
        targetArea: Math.round(listing.area ?? 0),
        monthlyRent: listing.type === "rental" ? listing.price : Math.round(rentEstimate?.medianRent ?? 0),
        listingUrl: listing.link,
    };
}

export function buildSavedPropertyFromListing(options: {
    listing: ListingRow;
    rentEstimate: RentEstimate | null;
    constructionType: string;
}): SavePropertyInput {
    const draft = buildImportedPropertyDraft(options);

    return {
        name: draft.name,
        district: draft.district,
        constructionType: options.constructionType,
        disposition: draft.disposition,
        targetPrice: draft.targetPrice,
        targetArea: draft.targetArea,
        monthlyRent: draft.monthlyRent,
        monthlyCosts: 0,
        listingUrl: draft.listingUrl,
    };
}

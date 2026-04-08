import { fetchBezrealitkyAdvertDetail } from "@app/Internal/commands/reas/api/bezrealitky-client";
import { buildSavedPropertyFromListing } from "@app/Internal/commands/reas/lib/property-form-defaults";
import { type ListingRow, reasDatabase } from "@app/Internal/commands/reas/lib/store";
import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";

export interface ListingDetailResult {
    listing: ListingRow;
    raw: unknown;
    hydratedDetail: unknown;
    linkedProperty: { id: number; name: string } | null;
}

export async function getListingDetail(listingId: number): Promise<ListingDetailResult | null> {
    const listing = reasDatabase.getListing(listingId);

    if (!listing) {
        return null;
    }

    const linkedProperty = reasDatabase.getPropertyByListingUrl(listing.link);

    let hydratedDetail: unknown = null;

    if (listing.source === "bezrealitky" && listing.status === "active") {
        try {
            hydratedDetail = await fetchBezrealitkyAdvertDetail(listing.source_id);
        } catch (error) {
            logger.warn(
                { error, listingId, source: listing.source, sourceId: listing.source_id },
                "Failed to hydrate Bezrealitky listing detail"
            );
        }
    }

    return {
        listing,
        raw: SafeJSON.parse(listing.raw_json),
        hydratedDetail,
        linkedProperty: linkedProperty ? { id: linkedProperty.id, name: linkedProperty.name } : null,
    };
}

export interface SaveListingToWatchlistResult {
    id: number;
    name: string | null;
    alreadyExists: boolean;
}

export function saveListingToWatchlist(listingId: number, constructionType: string): SaveListingToWatchlistResult {
    const listing = reasDatabase.getListing(listingId);

    if (!listing) {
        throw new Error(`Listing ${listingId} not found`);
    }

    const existingProperty = reasDatabase.getPropertyByListingUrl(listing.link);

    if (existingProperty) {
        return { id: existingProperty.id, name: existingProperty.name, alreadyExists: true };
    }

    const rentEstimate = reasDatabase.estimateMonthlyRent({
        district: listing.district,
        disposition: listing.disposition ?? undefined,
        area: listing.area ?? undefined,
    });

    const id = reasDatabase.saveProperty(buildSavedPropertyFromListing({ listing, rentEstimate, constructionType }));

    const property = reasDatabase.getProperty(id);

    return { id, name: property?.name ?? null, alreadyExists: false };
}

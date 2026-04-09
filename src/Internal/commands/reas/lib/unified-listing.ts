import type { ReasListing, RentalListing, SaleListing, UnifiedListing } from "@app/Internal/commands/reas/types";

export function fromReasListing(listing: ReasListing): UnifiedListing {
    return {
        id: listing._id,
        source: "reas",
        sourceId: listing._id,
        sourceContract: "reas-catalog",
        type: "sold",
        price: listing.soldPrice,
        pricePerM2: listing.pricePerM2 ?? (listing.utilityArea ? listing.soldPrice / listing.utilityArea : undefined),
        address: listing.formattedAddress,
        disposition: listing.disposition ?? undefined,
        area: listing.utilityArea,
        link: listing.link ?? `https://catalog.reas.cz/catalog/listings/${listing._id}`,
        coordinates: listing.point
            ? { lat: listing.point.coordinates[1], lng: listing.point.coordinates[0] }
            : undefined,
        soldAt: listing.soldAt,
        daysOnMarket: listing.daysOnMarket,
        discount:
            listing.originalPrice && listing.soldPrice
                ? ((listing.originalPrice - listing.soldPrice) / listing.originalPrice) * 100
                : undefined,
        originalPrice: listing.originalPrice,
        rawData: listing,
    };
}

export function fromRentalListing(listing: RentalListing): UnifiedListing {
    return {
        id: listing.id,
        source: listing.source,
        sourceId: listing.sourceId,
        sourceContract: listing.sourceContract,
        type: "rental",
        price: listing.price,
        pricePerM2: listing.area ? listing.price / listing.area : undefined,
        address: listing.locality,
        disposition: listing.disposition,
        area: listing.area,
        link: listing.link ?? "",
        coordinates: listing.coordinates,
        description: listing.description,
        originalPrice: listing.originalPrice,
        isDiscounted: listing.isDiscounted,
        uri: listing.uri,
        links: listing.links,
        rawData: listing.rawData,
    };
}

export function fromSaleListing(listing: SaleListing): UnifiedListing {
    return {
        id: listing.id,
        source: listing.source,
        sourceId: listing.sourceId,
        sourceContract: listing.sourceContract,
        type: listing.type,
        price: listing.price,
        pricePerM2: listing.pricePerM2 ?? (listing.area ? listing.price / listing.area : undefined),
        address: listing.address,
        disposition: listing.disposition,
        area: listing.area,
        link: listing.link,
        coordinates: listing.coordinates,
        soldAt: listing.soldAt,
        daysOnMarket: listing.daysOnMarket,
        discount: listing.discount,
        originalPrice: listing.originalPrice,
        isDiscounted: listing.isDiscounted,
        description: listing.description,
        uri: listing.uri,
        links: listing.links,
        rawData: listing.rawData,
    };
}

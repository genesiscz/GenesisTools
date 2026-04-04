import { describe, expect, test } from "bun:test";
import {
    buildImportedPropertyDraft,
    buildSavedPropertyFromListing,
} from "@app/Internal/commands/reas/lib/property-form-defaults";
import type { ListingRow, RentEstimate } from "@app/Internal/commands/reas/lib/store";

function makeListing(overrides?: Partial<ListingRow>): ListingRow {
    return {
        id: 1,
        source: "sreality",
        source_contract: "sreality-v2",
        type: "sale",
        status: "active",
        district: "Praha 2",
        disposition: "2+kk",
        area: 61,
        price: 7_450_000,
        price_per_m2: 122_131,
        address: "Praha 2, Vinohrady",
        link: "https://www.sreality.cz/detail/prodej/byt/praha-2/123",
        source_id: "123",
        fetched_at: "2026-04-02T00:00:00.000Z",
        sold_at: null,
        days_on_market: null,
        discount: null,
        coordinates_lat: null,
        coordinates_lng: null,
        building_type: null,
        description: null,
        raw_json: "{}",
        previous_price: null,
        price_changed_at: null,
        created_at: "2026-04-02 00:00:00",
        updated_at: "2026-04-02 00:00:00",
        ...overrides,
    };
}

describe("buildImportedPropertyDraft", () => {
    test("builds a sale draft with estimated monthly rent", () => {
        const estimate: RentEstimate = {
            medianRent: 24_500,
            medianRentPerM2: 402,
            listingCount: 8,
        };

        const draft = buildImportedPropertyDraft({
            listing: makeListing({ building_type: "panel" }),
            rentEstimate: estimate,
        });

        expect(draft).toEqual({
            name: "2+kk · Praha 2, Vinohrady",
            district: "Praha 2",
            constructionType: "panel",
            disposition: "2+kk",
            targetPrice: 7_450_000,
            targetArea: 61,
            monthlyRent: 24_500,
            listingUrl: "https://www.sreality.cz/detail/prodej/byt/praha-2/123",
        });
    });

    test("builds a rental draft with the listing rent", () => {
        const draft = buildImportedPropertyDraft({
            listing: makeListing({
                type: "rental",
                price: 21_000,
                link: "https://www.sreality.cz/detail/pronajem/byt/praha-2/987",
            }),
            rentEstimate: null,
        });

        expect(draft.targetPrice).toBe(0);
        expect(draft.monthlyRent).toBe(21_000);
        expect(draft.listingUrl).toBe("https://www.sreality.cz/detail/pronajem/byt/praha-2/987");
    });

    test("omits construction type when the cached listing does not know it", () => {
        const draft = buildImportedPropertyDraft({
            listing: makeListing({ building_type: null }),
            rentEstimate: null,
        });

        expect(draft.constructionType).toBeUndefined();
    });

    test("builds a watchlist save payload from a listing draft", () => {
        const input = buildSavedPropertyFromListing({
            listing: makeListing(),
            rentEstimate: {
                medianRent: 24_500,
                medianRentPerM2: 402,
                listingCount: 8,
            },
            constructionType: "brick",
        });

        expect(input).toEqual({
            name: "2+kk · Praha 2, Vinohrady",
            district: "Praha 2",
            constructionType: "brick",
            disposition: "2+kk",
            targetPrice: 7_450_000,
            targetArea: 61,
            monthlyRent: 24_500,
            monthlyCosts: 0,
            listingUrl: "https://www.sreality.cz/detail/prodej/byt/praha-2/123",
        });
    });
});

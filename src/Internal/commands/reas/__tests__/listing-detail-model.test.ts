import { describe, expect, test } from "bun:test";
import {
    extractFirstSeenAt,
    extractImageGallery,
    extractNemoreportLinks,
    extractPoiHighlights,
    getPriceChange,
    mergeImageGallery,
} from "@app/Internal/commands/reas/ui/src/components/listings/listing-detail-model";

describe("listing-detail-model", () => {
    test("extracts first seen timestamp from raw listing payload", () => {
        expect(
            extractFirstSeenAt({
                firstVisibleAt: "2026-03-12T10:15:00.000Z",
            })
        ).toBe("2026-03-12T10:15:00.000Z");
    });

    test("computes price change from original ask to current price", () => {
        expect(getPriceChange({ currentPrice: 90, originalPrice: 100 })).toEqual({
            amount: -10,
            percent: -10,
        });
    });

    test("extracts named poi highlights from bezrealitky poi data", () => {
        expect(
            extractPoiHighlights({
                public_transport: {
                    properties: {
                        osm_tags: {
                            name: "Masná",
                        },
                    },
                },
                school: {
                    name: "ZŠ Revoluční",
                },
            })
        ).toEqual([
            { category: "public_transport", name: "Masná" },
            { category: "school", name: "ZŠ Revoluční" },
        ]);
    });

    test("collects unique report links from nested nemoreport payloads", () => {
        expect(
            extractNemoreportLinks({
                brochureUrl: "https://example.test/brochure",
                nested: {
                    valuation: "https://example.test/value",
                    duplicate: "https://example.test/brochure",
                },
            })
        ).toEqual([
            { label: "brochureUrl", url: "https://example.test/brochure" },
            { label: "valuation", url: "https://example.test/value" },
        ]);
    });

    test("extracts image gallery entries from REAS raw payloads", () => {
        expect(
            extractImageGallery({
                imagesWithMetadata: [
                    {
                        original: "https://example.test/full-1.jpg",
                        preview: "https://example.test/thumb-1.jpg",
                        order: 2,
                    },
                    {
                        original: "https://example.test/full-0.jpg",
                        preview: "https://example.test/thumb-0.jpg",
                        order: 1,
                    },
                ],
            })
        ).toEqual([
            {
                full: "https://example.test/full-0.jpg",
                preview: "https://example.test/thumb-0.jpg",
            },
            {
                full: "https://example.test/full-1.jpg",
                preview: "https://example.test/thumb-1.jpg",
            },
        ]);
    });

    test("prefers existing raw media but appends unique hydrated images", () => {
        expect(
            mergeImageGallery({
                primary: [{ full: "https://example.test/full-0.jpg", preview: "https://example.test/thumb-0.jpg" }],
                secondary: [
                    { full: "https://example.test/full-0.jpg", preview: "https://example.test/thumb-0.jpg" },
                    { full: "https://example.test/full-1.jpg", preview: "https://example.test/thumb-1.jpg" },
                ],
            })
        ).toEqual([
            { full: "https://example.test/full-0.jpg", preview: "https://example.test/thumb-0.jpg" },
            { full: "https://example.test/full-1.jpg", preview: "https://example.test/thumb-1.jpg" },
        ]);
    });
});

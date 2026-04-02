import { describe, expect, test } from "bun:test";
import { SrealityClient } from "@app/Internal/commands/reas/api/SrealityClient";
import { parseSrealityName } from "@app/Internal/commands/reas/api/sreality-client";
import type { ApiClientRequestOptions } from "@app/utils/api/ApiClient";

const TEST_FILTERS = {
    estateType: "flat",
    constructionType: "panel",
    district: {
        name: "Praha 4",
        reasId: 3104,
        srealityId: 10,
        srealityLocality: "region" as const,
    },
    periods: [],
};

describe("parseSrealityName()", () => {
    test("parses standard rental name", () => {
        expect(parseSrealityName("Pronájem bytu 2+kk 54 m²")).toEqual({ disposition: "2+kk", area: 54 });
    });

    test("parses without diacritics", () => {
        expect(parseSrealityName("Pronajem bytu 3+1 68 m²")).toEqual({ disposition: "3+1", area: 68 });
    });

    test("returns undefineds for non-matching input", () => {
        expect(parseSrealityName("Prodej domu 150 m²")).toEqual({});
    });

    test("parses 1+kk", () => {
        expect(parseSrealityName("Pronájem bytu 1+kk 28 m²")).toEqual({ disposition: "1+kk", area: 28 });
    });

    test("parses large area", () => {
        expect(parseSrealityName("Pronájem bytu 4+1 120 m²")).toEqual({ disposition: "4+1", area: 120 });
    });
});

describe("SrealityClient", () => {
    test("fetchRentalListings preserves the legacy rental mapping on the v2 path", async () => {
        const requestedPaths: string[] = [];
        const client = new SrealityClient({
            apiV2: {
                async get<T>(path: string, _options?: ApiClientRequestOptions) {
                    requestedPaths.push(path);

                    return {
                        _embedded: {
                            estates: [
                                {
                                    hash_id: 123,
                                    name: "Pronájem bytu 2+kk 54 m²",
                                    price: 21000,
                                    locality: "Praha 4",
                                    gps: { lat: 50.1, lon: 14.4 },
                                    labels: ["novinka"],
                                    seo: {
                                        category_main_cb: 1,
                                        category_sub_cb: 4,
                                        category_type_cb: 2,
                                        locality: "praha-4",
                                    },
                                },
                            ],
                        },
                        result_size: 1,
                        per_page: 60,
                        page: 1,
                    } as T;
                },
            },
        });

        const listings = await client.fetchRentalListings(TEST_FILTERS, true);

        expect(requestedPaths).toHaveLength(1);
        expect(requestedPaths[0]).toContain("/estates?");
        expect(requestedPaths[0]).toContain("category_type_cb=2");
        expect(listings).toEqual([
            {
                id: "123",
                source: "sreality",
                sourceId: "123",
                sourceContract: "sreality-v2",
                type: "rental",
                hash_id: 123,
                name: "Pronájem bytu 2+kk 54 m²",
                price: 21000,
                locality: "Praha 4",
                gps: { lat: 50.1, lon: 14.4 },
                labels: ["novinka"],
                disposition: "2+kk",
                area: 54,
                link: "https://www.sreality.cz/detail/pronajem/byt/praha-4/123",
            },
        ]);
    });

    test("fetchSaleListings maps v2 sale results into sale listings", async () => {
        const requestedPaths: string[] = [];
        const client = new SrealityClient({
            apiV2: {
                async get<T>(path: string, _options?: ApiClientRequestOptions) {
                    requestedPaths.push(path);

                    return {
                        _embedded: {
                            estates: [
                                {
                                    hash_id: 456,
                                    name: "Prodej bytu 3+1 72 m²",
                                    price: 7990000,
                                    locality: "Praha 4",
                                    gps: { lat: 50.05, lon: 14.45 },
                                    labels: ["po rekonstrukci"],
                                    seo: {
                                        category_main_cb: 1,
                                        category_sub_cb: 7,
                                        category_type_cb: 1,
                                        locality: "praha-4",
                                    },
                                },
                            ],
                        },
                        result_size: 1,
                        per_page: 60,
                        page: 1,
                    } as T;
                },
            },
        });

        const listings = await client.fetchSaleListings(TEST_FILTERS, true);

        expect(requestedPaths).toHaveLength(1);
        expect(requestedPaths[0]).toContain("category_type_cb=1");
        expect(listings).toEqual([
            {
                id: "456",
                source: "sreality",
                sourceId: "456",
                sourceContract: "sreality-v2",
                type: "sale",
                price: 7990000,
                address: "Praha 4",
                disposition: "3+1",
                area: 72,
                pricePerM2: 110972,
                link: "https://www.sreality.cz/detail/prodej/byt/praha-4/456",
                coordinates: { lat: 50.05, lng: 14.45 },
                rawData: {
                    hash_id: 456,
                    name: "Prodej bytu 3+1 72 m²",
                    price: 7990000,
                    locality: "Praha 4",
                    gps: { lat: 50.05, lon: 14.45 },
                    labels: ["po rekonstrukci"],
                    seo: {
                        category_main_cb: 1,
                        category_sub_cb: 7,
                        category_type_cb: 1,
                        locality: "praha-4",
                    },
                },
            },
        ]);
    });

    test("fetchHistogram returns the typed v1 histogram payload", async () => {
        const requestedPaths: string[] = [];
        const client = new SrealityClient({
            apiV1: {
                async get<T>(path: string, _options?: ApiClientRequestOptions) {
                    requestedPaths.push(path);

                    return {
                        result: {
                            histogram: [
                                {
                                    advert_count: 2,
                                    price_from: 10000,
                                    price_to: 12000,
                                },
                            ],
                        },
                        status_code: 200,
                        status_message: "OK",
                    } as T;
                },
            },
        });

        const histogram = await client.fetchHistogram({
            category_main_cb: 1,
            category_type_cb: 2,
            locality_entity_id: 10,
        });

        expect(requestedPaths).toEqual([
            "/estates/filter_page/histogram?category_main_cb=1&category_type_cb=2&locality_entity_id=10",
        ]);
        expect(histogram).toEqual([
            {
                advert_count: 2,
                price_from: 10000,
                price_to: 12000,
            },
        ]);
    });
});

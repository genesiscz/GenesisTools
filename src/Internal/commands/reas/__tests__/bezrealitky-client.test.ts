import { describe, expect, test } from "bun:test";
import {
    BezrealitkyClient,
    extractRegionOsmIds,
    mapBezrealitkyDisposition,
} from "@app/Internal/commands/reas/api/BezrealitkyClient";
import { parseBezrealitkyNextData } from "@app/Internal/commands/reas/api/bezrealitky-client";
import type { AnalysisFilters } from "@app/Internal/commands/reas/types";
import { ApiClient, type ApiClientRequestOptions } from "@app/utils/api/ApiClient";

class FakeGraphqlClient extends ApiClient {
    readonly requests: Array<BodyInit | Record<string, unknown> | unknown[] | null | undefined> = [];

    constructor(private readonly responses: unknown[]) {
        super();
    }

    override async post<T>(
        _path: string,
        body?: BodyInit | Record<string, unknown> | unknown[] | null,
        _options?: ApiClientRequestOptions
    ): Promise<T> {
        this.requests.push(body);

        const response = this.responses.shift();

        if (response === undefined) {
            throw new Error("Missing fake GraphQL response");
        }

        return response as T;
    }
}

class FakeAutocompleteClient extends ApiClient {
    constructor(private readonly response: unknown) {
        super();
    }

    override async get<T>(_path: string, _options?: ApiClientRequestOptions): Promise<T> {
        return this.response as T;
    }
}

const filters: AnalysisFilters = {
    estateType: "flat",
    constructionType: "brick",
    disposition: "2+kk",
    periods: [],
    district: {
        name: "Praha",
        reasId: 3100,
        srealityId: 1,
        srealityLocality: "district",
    },
};

const prahaWardFilters: AnalysisFilters = {
    estateType: "flat",
    constructionType: "brick",
    disposition: "2+kk",
    periods: [],
    district: {
        name: "Praha 4",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
    },
};

describe("mapBezrealitkyDisposition", () => {
    test("maps DISP_3_KK to 3+kk", () => {
        expect(mapBezrealitkyDisposition("DISP_3_KK")).toBe("3+kk");
    });

    test("maps DISP_2_1 to 2+1", () => {
        expect(mapBezrealitkyDisposition("DISP_2_1")).toBe("2+1");
    });

    test("maps DISP_1_KK to 1+kk", () => {
        expect(mapBezrealitkyDisposition("DISP_1_KK")).toBe("1+kk");
    });

    test("maps DISP_4_1 to 4+1", () => {
        expect(mapBezrealitkyDisposition("DISP_4_1")).toBe("4+1");
    });

    test("returns original for unknown disposition", () => {
        expect(mapBezrealitkyDisposition("DISP_OTHER")).toBe("DISP_OTHER");
    });

    test("handles DISP_5_KK", () => {
        expect(mapBezrealitkyDisposition("DISP_5_KK")).toBe("5+kk");
    });
});

describe("extractRegionOsmIds", () => {
    test("builds prefixed OSM ids from autocomplete features", () => {
        const result = extractRegionOsmIds({
            type: "FeatureCollection",
            features: [
                { properties: { osm_type: "R", osm_id: "435541" } },
                { properties: { osm_type: "W", osm_id: 987654 } },
                { properties: { osm_type: "R", osm_id: "435541" } },
            ],
        });

        expect(result).toEqual(["R435541", "W987654"]);
    });
});

describe("BezrealitkyClient", () => {
    test("fetchRentalListings paginates GraphQL results and maps listings", async () => {
        const client = new BezrealitkyClient({
            graphqlClient: new FakeGraphqlClient([
                {
                    data: {
                        listAdverts: {
                            totalCount: 3,
                            list: [
                                {
                                    id: "r1",
                                    uri: "r1-pronajem",
                                    disposition: "DISP_2_KK",
                                    surface: 52,
                                    price: 20000,
                                    charges: 3500,
                                    reserved: false,
                                    gps: { lat: 50.1, lng: 14.4 },
                                    'address({"locale":"CS"})': "Praha 1",
                                    'imageAltText({"locale":"CS"})': "Byt Praha 1",
                                    originalPrice: 21000,
                                    isDiscounted: true,
                                    availableFrom: 1780000000,
                                    links: [{ url: "https://example.test/1", type: "detail" }],
                                },
                                {
                                    id: "r2",
                                    uri: "r2-pronajem",
                                    disposition: "DISP_3_1",
                                    surface: 80,
                                    price: 26000,
                                    charges: 4000,
                                    reserved: false,
                                    gps: { lat: 50.2, lng: 14.5 },
                                    'address({"locale":"CS"})': "Praha 2",
                                    'imageAltText({"locale":"CS"})': "Byt Praha 2",
                                    originalPrice: 26000,
                                    isDiscounted: false,
                                    availableFrom: null,
                                    links: [],
                                },
                            ],
                        },
                    },
                },
                {
                    data: {
                        listAdverts: {
                            totalCount: 3,
                            list: [
                                {
                                    id: "r3",
                                    uri: "r3-pronajem",
                                    disposition: "DISP_2_KK",
                                    surface: 49,
                                    price: 19000,
                                    charges: 3200,
                                    reserved: false,
                                    gps: { lat: 50.3, lng: 14.6 },
                                    'address({"locale":"CS"})': "Praha 3",
                                    'imageAltText({"locale":"CS"})': "Byt Praha 3",
                                    originalPrice: 19500,
                                    isDiscounted: true,
                                    availableFrom: 1781000000,
                                    links: [{ url: "https://example.test/3", type: "detail" }],
                                },
                            ],
                        },
                    },
                },
            ]),
            autocompleteClient: new FakeAutocompleteClient({
                type: "FeatureCollection",
                features: [{ properties: { osm_type: "R", osm_id: "435541" } }],
            }),
            pageSize: 2,
        });

        const result = await client.fetchRentalListings(filters, true);

        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({
            id: "bezrealitky-r1",
            source: "bezrealitky",
            sourceId: "r1",
            sourceContract: "graphql:listAdverts",
            type: "rental",
            price: 20000,
            locality: "Praha 1",
            disposition: "2+kk",
            area: 52,
            charges: 3500,
            originalPrice: 21000,
            isDiscounted: true,
            imageAltText: "Byt Praha 1",
        });
        expect(result[0].coordinates).toEqual({ lat: 50.1, lng: 14.4 });
        expect(result[0].link).toBe("https://www.bezrealitky.cz/nemovitosti-byty-domy/r1-pronajem");
        expect(result[1].sourceId).toBe("r3");
    });

    test("fetchRentalListings drops off-district Praha ward results", async () => {
        const client = new BezrealitkyClient({
            graphqlClient: new FakeGraphqlClient([
                {
                    data: {
                        listAdverts: {
                            totalCount: 2,
                            list: [
                                {
                                    id: "p4-1",
                                    uri: "p4-1-pronajem",
                                    disposition: "DISP_2_KK",
                                    surface: 52,
                                    price: 21000,
                                    charges: 3500,
                                    reserved: false,
                                    gps: { lat: 50.06, lng: 14.43 },
                                    'address({"locale":"CS"})': "Mečislavova, Praha 4 - Nusle",
                                    links: [],
                                },
                                {
                                    id: "p2-1",
                                    uri: "p2-1-pronajem",
                                    disposition: "DISP_2_KK",
                                    surface: 54,
                                    price: 22000,
                                    charges: 3600,
                                    reserved: false,
                                    gps: { lat: 50.08, lng: 14.44 },
                                    'address({"locale":"CS"})': "Varšavská, Praha 2 - Vinohrady",
                                    links: [],
                                },
                            ],
                        },
                    },
                },
            ]),
            autocompleteClient: new FakeAutocompleteClient({
                type: "FeatureCollection",
                features: [{ properties: { osm_type: "R", osm_id: "435541" } }],
            }),
            pageSize: 50,
        });

        const result = await client.fetchRentalListings(prahaWardFilters, true);

        expect(result).toHaveLength(1);
        expect(result[0]?.locality).toContain("Praha 4");
    });

    test("fetchAdvertDetail maps the validated field subset", async () => {
        const graphqlClient = new FakeGraphqlClient([
            {
                data: {
                    advert: {
                        id: "851182",
                        uri: "851182-nabidka-pronajem-bytu-rybna-praha",
                        offerType: "PRONAJEM",
                        price: 92515,
                        charges: 16326,
                        serviceCharges: 0,
                        utilityCharges: 16326,
                        deposit: 107000,
                        availableFrom: 1780524000,
                        originalPrice: 92617,
                        isDiscounted: false,
                        disposition: "DISP_3_1",
                        surface: 86,
                        gps: { lat: 50.0882082, lng: 14.4262296 },
                        'address({"locale":"CS"})': "Rybná, Praha - Staré Město",
                        'imageAltText({"locale":"CS"})': "Pronájem bytu 86 m², Rybná, Praha",
                        'mortgageData({"locale":"CS"})': { rateLow: null, rateHigh: null, years: null, loan: null },
                        links: [{ url: "https://example.test/detail", type: "detail" }],
                        publicImages: [
                            { id: "img-1", order: 2, url: "https://example.test/image-2.jpg" },
                            { id: "img-0", order: 1, url: "https://example.test/image-1.jpg" },
                        ],
                        formattedAds: [
                            { title: "Heating", value: "Central" },
                            { title: "Transport", value: "Metro A", valueHref: "https://example.test/metro" },
                        ],
                        poiData: '{"public_transport":{"properties":{"osm_tags":{"name":"Masná"}}}}',
                        'regionTree({"locale":"CS"})': [
                            { id: "486", name: "Praha", uri: "praha" },
                            { id: "15460", name: "Praha-Staré Město", uri: "praha-stare-mesto" },
                        ],
                        'relatedAdverts({"limit":6})': {
                            list: [
                                {
                                    id: "830720",
                                    uri: "830720-nabidka-pronajem",
                                    offerType: "PRONAJEM",
                                    price: 107960,
                                    charges: 50482,
                                    disposition: "UNDEFINED",
                                    surface: 100,
                                    reserved: false,
                                    gps: { lat: 50.09, lng: 14.42 },
                                    'address({"locale":"CS"})': "U Milosrdných, Praha",
                                    'imageAltText({"locale":"CS"})': "Pronájem bytu 100 m², U Milosrdných, Praha",
                                    originalPrice: null,
                                    isDiscounted: false,
                                    availableFrom: null,
                                    links: [],
                                },
                            ],
                        },
                        nemoreport: {
                            id: "nemo-1",
                            resultUrl: "https://example.test/nemoreport",
                            status: "DONE",
                            message: "ready",
                        },
                    },
                },
            },
        ]);
        const client = new BezrealitkyClient({ graphqlClient });

        const detail = await client.fetchAdvertDetail("851182");

        const requestBody = graphqlClient.requests[0];
        expect(requestBody).toBeTruthy();

        const query = (requestBody as { query?: string }).query;
        expect(query).toContain("nemoreport {");
        expect(query).toContain("resultUrl");
        expect(query).toContain("status");
        expect(query).toContain("publicImages(limit: 12)");
        expect(query).toContain("url(filter: RECORD_MAIN)");
        expect(query).toContain("formattedAds(locale: CS)");

        expect(detail).toMatchObject({
            id: "851182",
            sourceContract: "graphql:advert",
            type: "rental",
            address: "Rybná, Praha - Staré Město",
            disposition: "3+1",
            surface: 86,
            price: 92515,
            charges: 16326,
            serviceCharges: 0,
            utilityCharges: 16326,
            deposit: 107000,
            availableFrom: 1780524000,
            originalPrice: 92617,
            isDiscounted: false,
            imageAltText: "Pronájem bytu 86 m², Rybná, Praha",
            links: [{ url: "https://example.test/detail", type: "detail" }],
            nemoreport: {
                id: "nemo-1",
                resultUrl: "https://example.test/nemoreport",
                status: "DONE",
                message: "ready",
            },
            publicImages: [
                { id: "img-0", order: 1, url: "https://example.test/image-1.jpg" },
                { id: "img-1", order: 2, url: "https://example.test/image-2.jpg" },
            ],
            formattedAds: [
                { title: "Heating", value: "Central", valueHref: null },
                { title: "Transport", value: "Metro A", valueHref: "https://example.test/metro" },
            ],
        });
        expect(detail.poiData).toEqual({
            public_transport: {
                properties: {
                    osm_tags: {
                        name: "Masná",
                    },
                },
            },
        });
        expect(detail.regionTree).toEqual([
            { id: "486", name: "Praha", uri: "praha" },
            { id: "15460", name: "Praha-Staré Město", uri: "praha-stare-mesto" },
        ]);
        expect(detail.relatedAdverts).toHaveLength(1);
        expect(detail.relatedAdverts[0].sourceId).toBe("830720");
    });

    test("fetchAdvertDetail supports current live GraphQL field names", async () => {
        const client = new BezrealitkyClient({
            graphqlClient: new FakeGraphqlClient([
                {
                    data: {
                        advert: {
                            id: "851182",
                            uri: "851182-nabidka-pronajem-bytu-rybna-praha",
                            offerType: "PRONAJEM",
                            price: 92515,
                            charges: 16326,
                            serviceCharges: 0,
                            utilityCharges: 16326,
                            deposit: 107000,
                            availableFrom: 1780524000,
                            originalPrice: 92617,
                            isDiscounted: false,
                            disposition: "UNDEFINED",
                            surface: 86,
                            gps: { lat: 50.0882082, lng: 14.4262296 },
                            address: "Rybná, Praha - Staré Město",
                            imageAltText: "Pronájem bytu 86 m², Rybná, Praha",
                            mortgageData: { rateLow: null, rateHigh: null, years: null, loan: null },
                            links: [],
                            poiData: '{"school":{"properties":{"osm_tags":{"name":"Gymnázium"}}}}',
                            regionTree: [
                                { id: "486", name: "Praha", uri: "praha" },
                                { id: "15460", name: "Praha-Staré Město", uri: "praha-stare-mesto" },
                            ],
                            relatedAdverts: {
                                list: [
                                    {
                                        id: "830720",
                                        uri: "830720-nabidka-pronajem",
                                        offerType: "PRONAJEM",
                                        price: 107960,
                                        charges: 50482,
                                        disposition: "UNDEFINED",
                                        surface: 100,
                                        reserved: false,
                                        gps: { lat: 50.09, lng: 14.42 },
                                        address: "U Milosrdných, Praha",
                                        imageAltText: "Pronájem bytu 100 m², U Milosrdných, Praha",
                                        originalPrice: null,
                                        isDiscounted: false,
                                        availableFrom: null,
                                        links: [],
                                    },
                                ],
                            },
                            nemoreport: {
                                id: "nemo-1",
                                resultUrl: "https://example.test/nemoreport",
                                status: "DONE",
                                message: "ready",
                            },
                        },
                    },
                },
            ]),
        });

        const detail = await client.fetchAdvertDetail("851182");

        expect(detail.address).toBe("Rybná, Praha - Staré Město");
        expect(detail.imageAltText).toBe("Pronájem bytu 86 m², Rybná, Praha");
        expect(detail.regionTree).toEqual([
            { id: "486", name: "Praha", uri: "praha" },
            { id: "15460", name: "Praha-Staré Město", uri: "praha-stare-mesto" },
        ]);
        expect(detail.relatedAdverts).toHaveLength(1);
        expect(detail.relatedAdverts[0].sourceId).toBe("830720");
    });
});

describe("parseBezrealitkyNextData", () => {
    test("extracts adverts from Apollo cache", () => {
        const nextData = {
            props: {
                pageProps: {
                    apolloCache: {
                        "Advert:123": {
                            __typename: "Advert",
                            id: "123",
                            uri: "123-nabidka-pronajem",
                            disposition: "DISP_3_KK",
                            surface: 68,
                            price: 18000,
                            charges: 3000,
                            currency: "CZK",
                            'address({"locale":"CS"})': "Testovací 42, Hradec Králové",
                            gps: { __typename: "GPSPoint", lat: 50.21, lng: 15.83 },
                            reserved: false,
                        },
                        ROOT_QUERY: {
                            __typename: "Query",
                            "listAdverts({})": {
                                __typename: "AdvertList",
                                list: [{ __ref: "Advert:123" }],
                                totalCount: 1,
                            },
                        },
                    },
                },
            },
        };

        const result = parseBezrealitkyNextData(nextData);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("123");
        expect(result[0].disposition).toBe("3+kk");
        expect(result[0].area).toBe(68);
        expect(result[0].price).toBe(18000);
        expect(result[0].charges).toBe(3000);
        expect(result[0].address).toBe("Testovací 42, Hradec Králové");
        expect(result[0].gps.lat).toBe(50.21);
    });

    test("skips reserved adverts", () => {
        const nextData = {
            props: {
                pageProps: {
                    apolloCache: {
                        ROOT_QUERY: {
                            "listAdverts({})": {
                                list: [{ __ref: "Advert:999" }],
                            },
                        },
                        "Advert:999": {
                            __typename: "Advert",
                            id: "999",
                            uri: "999-nabidka",
                            disposition: "DISP_2_KK",
                            surface: 50,
                            price: 15000,
                            charges: 2000,
                            currency: "CZK",
                            'address({"locale":"CS"})': "Reserved 1, Praha",
                            gps: { __typename: "GPSPoint", lat: 50.0, lng: 14.4 },
                            reserved: true,
                        },
                    },
                },
            },
        };

        const result = parseBezrealitkyNextData(nextData);
        expect(result).toHaveLength(0);
    });

    test("returns empty array for missing apolloCache", () => {
        const nextData = { props: { pageProps: {} } };
        const result = parseBezrealitkyNextData(nextData);
        expect(result).toHaveLength(0);
    });
});

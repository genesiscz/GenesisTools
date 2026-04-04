import { describe, expect, test } from "bun:test";
import { ReasClient } from "@app/Internal/commands/reas/api/ReasClient";
import type { ApiClientRequestOptions } from "@app/utils/api/ApiClient";
import { SafeJSON } from "@app/utils/json";

describe("ReasClient", () => {
    test("filters obvious off-ward Prague sold comps before returning cached results", async () => {
        const client = new ReasClient({
            apiClient: {
                async get<T>(_path: string, _options?: ApiClientRequestOptions) {
                    return {
                        success: true,
                        data: [
                            {
                                _id: "keep",
                                formattedAddress: "Mečislavova, Praha 4 - Nusle",
                                formattedLocation: "Praha 4",
                                soldPrice: 8200000,
                                price: 8400000,
                                originalPrice: 8500000,
                                disposition: "2+kk",
                                utilityArea: 64,
                                displayArea: 64,
                                soldAt: "2026-03-01T00:00:00.000Z",
                                firstVisibleAt: "2025-12-01T00:00:00.000Z",
                                point: { type: "Point", coordinates: [14.43, 50.06] },
                                cadastralAreaSlug: "nusle",
                                municipalitySlug: "praha-4",
                                link: "https://reas.cz/keep",
                            },
                            {
                                _id: "drop",
                                formattedAddress: "Varšavská, Praha 2 - Vinohrady",
                                formattedLocation: "Praha 2",
                                soldPrice: 9100000,
                                price: 9300000,
                                originalPrice: 9500000,
                                disposition: "2+kk",
                                utilityArea: 66,
                                displayArea: 66,
                                soldAt: "2026-03-02T00:00:00.000Z",
                                firstVisibleAt: "2025-12-02T00:00:00.000Z",
                                point: { type: "Point", coordinates: [14.44, 50.07] },
                                cadastralAreaSlug: "vinohrady",
                                municipalitySlug: "praha-2",
                                link: "https://reas.cz/drop",
                            },
                        ],
                        page: 1,
                        limit: 20,
                        nextPage: null,
                    } as T;
                },
            },
        });

        const listings = await client.fetchSoldListings(
            {
                estateType: "flat",
                constructionType: "brick",
                district: {
                    name: "Praha 4",
                    reasId: 3100,
                    srealityId: 10,
                    srealityLocality: "region",
                },
                periods: [],
            },
            {
                label: "2026",
                from: new Date("2026-01-01T00:00:00.000Z"),
                to: new Date("2026-12-31T23:59:59.000Z"),
            },
            true
        );

        expect(listings.map((listing) => listing._id)).toEqual(["keep"]);
    });

    test("fetchPointersAndClusters calls the correct endpoint and returns data", async () => {
        const mockData = {
            pointers: [
                {
                    _id: "p1",
                    point: { type: "Point" as const, coordinates: [14.43, 50.06] as [number, number] },
                    geohash: "u2fkb",
                    estatesCount: 3,
                },
            ],
            clusterPointers: [
                {
                    geohash: "u2fk",
                    point: { type: "Point" as const, coordinates: [14.44, 50.07] as [number, number] },
                    actualPoint: { type: "Point" as const, coordinates: [14.44, 50.07] as [number, number] },
                    clusterBounds: [
                        [14.4, 50.0],
                        [14.5, 50.1],
                    ] as [[number, number], [number, number]],
                    amount: 12,
                },
            ],
        };

        let capturedPath = "";
        const client = new ReasClient({
            apiClient: {
                async get<T>(path: string, _options?: ApiClientRequestOptions) {
                    capturedPath = path;
                    return { success: true, data: mockData } as T;
                },
            },
        });

        const result = await client.fetchPointersAndClusters(
            {
                estateType: "flat",
                constructionType: "brick",
                district: { name: "Praha 2", reasId: 5, srealityId: 20, srealityLocality: "district" },
                periods: [],
            },
            { label: "2025", from: new Date("2025-01-01"), to: new Date("2025-12-31") }
        );

        expect(capturedPath).toBe("/listings/pointers-and-clusters");
        expect(result.pointers).toHaveLength(1);
        expect(result.clusterPointers).toHaveLength(1);
        expect(result.pointers[0].estatesCount).toBe(3);
        expect(result.clusterPointers[0].amount).toBe(12);
    });

    test("buildQueryParams includes heatingKind and bounds when set", () => {
        const client = new ReasClient();
        const params = client.buildQueryParams(
            {
                estateType: "flat",
                constructionType: "brick",
                district: { name: "Praha 2", reasId: 5, srealityId: 20, srealityLocality: "district" },
                periods: [],
                heatingKind: ["local", "central"],
                bounds: {
                    southWestLatitude: 50.0,
                    southWestLongitude: 14.3,
                    northEastLatitude: 50.1,
                    northEastLongitude: 14.5,
                },
            },
            { label: "2025", from: new Date("2025-01-01"), to: new Date("2025-12-31") }
        );

        expect(params.get("heatingKind")).toBe(SafeJSON.stringify(["local", "central"]));
        expect(SafeJSON.parse(params.get("bounds")!)).toEqual({
            southWestLatitude: 50.0,
            southWestLongitude: 14.3,
            northEastLatitude: 50.1,
            northEastLongitude: 14.5,
        });
    });
});

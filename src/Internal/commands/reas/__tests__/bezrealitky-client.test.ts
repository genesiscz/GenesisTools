import { describe, expect, test } from "bun:test";
import { mapBezrealitkyDisposition, parseBezrealitkyNextData } from "../api/bezrealitky-client";

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

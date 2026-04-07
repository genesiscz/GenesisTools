/**
 * E2E tests for all external API endpoints used by the REAS module.
 *
 * Run: E2E=1 bun test src/Internal/commands/reas/__tests__/external-api.e2e.test.ts
 *
 * These tests use raw fetch() to verify that each external endpoint is alive
 * and responding without 500/404/400 errors. They do NOT test our client wrappers.
 */
import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@app/utils/json";

const SKIP = !process.env.E2E;

describe.skipIf(SKIP)("External API E2E", () => {
    // ──────────────────────────────────────────────────────────────
    // REAS Catalog — https://catalog.reas.cz/catalog
    // ──────────────────────────────────────────────────────────────
    describe("REAS Catalog", () => {
        const BASE = "https://catalog.reas.cz/catalog";
        const CLIENT_ID = "6988cb437c5b9d2963280369";

        function buildReasParams(): URLSearchParams {
            const params = new URLSearchParams();
            params.set("estateTypes", SafeJSON.stringify(["flat"]));
            params.set("constructionType", SafeJSON.stringify(["brick"]));
            params.set(
                "soldDateRange",
                SafeJSON.stringify({
                    from: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
                    to: new Date().toISOString(),
                })
            );
            params.set("linkedToTransfer", "true");
            params.set("locality", SafeJSON.stringify({ districtId: 3100 }));
            params.set("clientId", CLIENT_ID);
            return params;
        }

        test("GET /listings/count returns 200 with valid count", async () => {
            const url = new URL(`${BASE}/listings/count`);
            url.search = buildReasParams().toString();

            const res = await fetch(url);
            expect(res.status).toBe(200);

            const body = (await res.json()) as { success: boolean; data: { count: number } };
            expect(body.success).toBe(true);
            expect(body.data.count).toBeGreaterThan(0);
        }, 15_000);

        test("GET /listings returns 200 with listing data", async () => {
            const params = buildReasParams();
            params.set("page", "1");
            params.set("limit", "5");

            const url = new URL(`${BASE}/listings`);
            url.search = params.toString();

            const res = await fetch(url);
            expect(res.status).toBe(200);

            const body = (await res.json()) as { success: boolean; data: unknown[] };
            expect(body.success).toBe(true);
            expect(Array.isArray(body.data)).toBe(true);
        }, 15_000);

        test("GET /listings/pointers-and-clusters returns 200", async () => {
            const params = buildReasParams();
            // Endpoint requires a bounds param to avoid 500
            params.set(
                "bounds",
                SafeJSON.stringify({
                    southWestLatitude: 50.0,
                    southWestLongitude: 14.2,
                    northEastLatitude: 50.2,
                    northEastLongitude: 14.7,
                })
            );

            const url = new URL(`${BASE}/listings/pointers-and-clusters`);
            url.search = params.toString();

            const res = await fetch(url);
            expect(res.status).toBe(200);

            const body = (await res.json()) as {
                success: boolean;
                data: { pointers: unknown[]; clusterPointers: unknown[] };
            };
            expect(body.success).toBe(true);
            expect(body.data).toBeDefined();
            expect(Array.isArray(body.data.pointers)).toBe(true);
            expect(Array.isArray(body.data.clusterPointers)).toBe(true);
        }, 15_000);
    });

    // ──────────────────────────────────────────────────────────────
    // Sreality V2 — https://www.sreality.cz/api/cs/v2
    // ──────────────────────────────────────────────────────────────
    describe("Sreality V2", () => {
        const V2_BASE = "https://www.sreality.cz/api/cs/v2";

        test("GET /estates returns 200 for rental listings", async () => {
            const params = new URLSearchParams({
                locality_district_id: "10",
                category_main_cb: "1",
                category_type_cb: "2",
                per_page: "5",
                page: "1",
                tms: String(Date.now()),
            });

            const res = await fetch(`${V2_BASE}/estates?${params}`);
            expect(res.status).toBe(200);

            const body = (await res.json()) as { result_size: number; _embedded?: { estates?: unknown[] } };
            expect(body.result_size).toBeGreaterThanOrEqual(0);
        }, 15_000);

        test("GET /estates returns 200 for sale listings", async () => {
            const params = new URLSearchParams({
                locality_district_id: "10",
                category_main_cb: "1",
                category_type_cb: "1",
                per_page: "5",
                page: "1",
                tms: String(Date.now()),
            });

            const res = await fetch(`${V2_BASE}/estates?${params}`);
            expect(res.status).toBe(200);

            const body = (await res.json()) as { result_size: number; _embedded?: { estates?: unknown[] } };
            expect(body.result_size).toBeGreaterThanOrEqual(0);
        }, 15_000);

        test("GET /suggest returns 200 for locality suggest", async () => {
            const params = new URLSearchParams({
                phrase: "Praha",
                tms: String(Date.now()),
            });

            const res = await fetch(`${V2_BASE}/suggest?${params}`);
            expect(res.status).toBe(200);

            const body = (await res.json()) as { count: number; data?: unknown[] };
            expect(body.count).toBeGreaterThan(0);
            expect(Array.isArray(body.data)).toBe(true);
        }, 15_000);
    });

    // ──────────────────────────────────────────────────────────────
    // Sreality V1 — https://www.sreality.cz/api/v1
    // ──────────────────────────────────────────────────────────────
    describe("Sreality V1", () => {
        const V1_BASE = "https://www.sreality.cz/api/v1";

        test("GET /estates/filter_page/histogram returns 200", async () => {
            const params = new URLSearchParams({
                category_main_cb: "1",
                category_type_cb: "2",
                locality_district_id: "10",
            });

            const res = await fetch(`${V1_BASE}/estates/filter_page/histogram?${params}`);
            expect(res.status).toBe(200);

            const body = (await res.json()) as { result?: { histogram?: unknown[] } };
            expect(body.result).toBeDefined();
        }, 15_000);

        test("GET /estates/search/clusters returns 200", async () => {
            // Clusters endpoint requires bounding box + zoom params
            const params = new URLSearchParams({
                category_main_cb: "1",
                category_type_cb: "2",
                locality_district_id: "10",
                lat_min: "50.0",
                lat_max: "50.2",
                lon_min: "14.2",
                lon_max: "14.7",
                zoom: "12",
            });

            const res = await fetch(`${V1_BASE}/estates/search/clusters?${params}`);
            expect(res.status).toBe(200);

            const body = (await res.json()) as { result?: unknown[]; results?: unknown[]; status_code?: number };
            // API may return "result" or "results" depending on version
            const hasData = body.result !== undefined || body.results !== undefined;
            expect(hasData).toBe(true);
            expect(body.status_code).toBe(200);
        }, 15_000);

        test("GET /localities/geometries returns 200", async () => {
            const params = new URLSearchParams({
                entity_id: "10",
                entity_type: "district",
                no_children: "true",
            });

            const res = await fetch(`${V1_BASE}/localities/geometries?${params}`);
            expect(res.status).toBe(200);

            const body = (await res.json()) as { result?: unknown[] };
            expect(body.result).toBeDefined();
        }, 15_000);
    });

    // ──────────────────────────────────────────────────────────────
    // Bezrealitky Autocomplete — https://autocomplete.bezrealitky.cz
    // ──────────────────────────────────────────────────────────────
    describe("Bezrealitky Autocomplete", () => {
        test("GET /autocomplete returns HTTP 200", async () => {
            const params = new URLSearchParams({
                q: "Praha",
                size: "5",
                address: "0",
                preferredCountry: "cz",
            });

            const res = await fetch(`https://autocomplete.bezrealitky.cz/autocomplete?${params}`);
            expect(res.status).toBe(200);

            // The endpoint may return {"error": "..."} with 200 — that's still a connectivity success
            const body = (await res.json()) as Record<string, unknown>;
            expect(body).toBeDefined();
        }, 15_000);
    });

    // ──────────────────────────────────────────────────────────────
    // Bezrealitky GraphQL — https://api.bezrealitky.cz/graphql/
    // ──────────────────────────────────────────────────────────────
    describe("Bezrealitky GraphQL", () => {
        test("POST /graphql/ ListAdverts returns data or graphql errors (not HTTP errors)", async () => {
            const query = `
                query ListAdverts($limit: Int!, $offset: Int!) {
                    listAdverts(limit: $limit, offset: $offset) {
                        totalCount
                        list {
                            id
                            uri
                            price
                        }
                    }
                }
            `;

            const res = await fetch("https://api.bezrealitky.cz/graphql/", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent":
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)",
                },
                body: SafeJSON.stringify({
                    operationName: "ListAdverts",
                    query,
                    variables: {
                        limit: 3,
                        offset: 0,
                    },
                }),
            });

            expect(res.status).toBe(200);

            const body = (await res.json()) as {
                data?: { listAdverts?: { totalCount: number; list: unknown[] } };
                errors?: unknown[];
            };

            // Either we get data or graphql-level errors — both mean the endpoint is alive
            const isAlive = body.data !== undefined || body.errors !== undefined;
            expect(isAlive).toBe(true);
        }, 15_000);

        test("POST /graphql/ Advert (detail) returns data or graphql errors", async () => {
            const query = `
                query Advert($id: ID!) {
                    advert(id: $id) {
                        id
                        uri
                        offerType
                        price
                    }
                }
            `;

            // Use a plausible ID — the query schema should accept it even if the advert doesn't exist
            const res = await fetch("https://api.bezrealitky.cz/graphql/", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent":
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)",
                },
                body: SafeJSON.stringify({
                    operationName: "Advert",
                    query,
                    variables: { id: "1" },
                }),
            });

            expect(res.status).toBe(200);

            const body = (await res.json()) as {
                data?: { advert?: unknown };
                errors?: unknown[];
            };

            // Schema accepts the query — either returns null advert or graphql-level errors
            const isAlive = body.data !== undefined || body.errors !== undefined;
            expect(isAlive).toBe(true);
        }, 15_000);
    });

    // ──────────────────────────────────────────────────────────────
    // eReality — https://www.ereality.cz
    // ──────────────────────────────────────────────────────────────
    describe("eReality", () => {
        test("GET /pronajem/byty/praha returns 200 with HTML", async () => {
            const res = await fetch("https://www.ereality.cz/pronajem/byty/praha", {
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)",
                },
            });

            expect(res.status).toBe(200);

            const contentType = res.headers.get("content-type") ?? "";
            expect(contentType).toContain("text/html");

            const html = await res.text();
            expect(html.length).toBeGreaterThan(100);
        }, 15_000);
    });

    // ──────────────────────────────────────────────────────────────
    // MF Cenova Mapa — https://mf.gov.cz
    // ──────────────────────────────────────────────────────────────
    describe("MF Cenova Mapa", () => {
        function getLatestMfUrl(now = new Date()): string {
            const month = now.getMonth() + 1;
            const year = now.getFullYear();
            const quarterMonths = [2, 5, 8, 11];
            const pastReleases = quarterMonths.filter((releaseMonth) => releaseMonth <= month);

            let releaseMonth: number;
            let releaseYear: number;

            if (pastReleases.length > 0) {
                releaseMonth = pastReleases[pastReleases.length - 1];
                releaseYear = year;
            } else {
                releaseMonth = 11;
                releaseYear = year - 1;
            }

            const mm = String(releaseMonth).padStart(2, "0");
            return `https://mf.gov.cz/assets/attachments/${releaseYear}-${mm}-15_Cenova-mapa.xlsx`;
        }

        test("GET latest XLSX returns 200 with spreadsheet content-type", async () => {
            const url = getLatestMfUrl();

            const res = await fetch(url);
            expect(res.status).toBe(200);

            const contentType = res.headers.get("content-type") ?? "";
            // XLSX files may come as application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
            // or application/octet-stream depending on server config
            const isValidContentType =
                contentType.includes("spreadsheet") ||
                contentType.includes("octet-stream") ||
                contentType.includes("xlsx");
            expect(isValidContentType).toBe(true);

            // Verify we got a non-trivial payload
            const buffer = await res.arrayBuffer();
            expect(buffer.byteLength).toBeGreaterThan(1000);
        }, 30_000);
    });

    // ──────────────────────────────────────────────────────────────
    // Sreality Suggest (used by address resolver)
    // ──────────────────────────────────────────────────────────────
    describe("Sreality Suggest (address resolver)", () => {
        test("GET /suggest with district query returns suggestions", async () => {
            const params = new URLSearchParams({
                phrase: "Hradec Králové",
                tms: String(Date.now()),
            });

            const res = await fetch(`https://www.sreality.cz/api/cs/v2/suggest?${params}`);
            expect(res.status).toBe(200);

            const body = (await res.json()) as { count: number; data?: Array<{ userData: { municipality: string } }> };
            expect(body.count).toBeGreaterThan(0);
            expect(body.data).toBeDefined();
            expect(body.data!.length).toBeGreaterThan(0);
            expect(body.data![0].userData.municipality).toBeDefined();
        }, 15_000);
    });
});

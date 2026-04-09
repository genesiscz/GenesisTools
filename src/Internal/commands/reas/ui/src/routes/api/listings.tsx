import { fetchListingsIntoCache } from "@app/Internal/commands/reas/lib/analysis-service";
import type { GetListingsOptions } from "@app/Internal/commands/reas/lib/store";
import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, jsonBody } from "../../server/api-utils";

function parseMultiValue(value: string | null): string[] | undefined {
    if (!value) {
        return undefined;
    }

    const normalized = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);

    if (normalized.length === 0) {
        return undefined;
    }

    return normalized;
}

export const Route = createFileRoute("/api/listings")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const page = Number(url.searchParams.get("page") ?? "1");
                const limit = Number(url.searchParams.get("limit") ?? "50");
                const sortByParam = url.searchParams.get("sortBy");
                const sortDirParam = url.searchParams.get("sortDir");
                const sortBy: GetListingsOptions["sortBy"] =
                    sortByParam === "sold_at" ||
                    sortByParam === "price" ||
                    sortByParam === "price_per_m2" ||
                    sortByParam === "area"
                        ? sortByParam
                        : "fetched_at";
                const sortDir: GetListingsOptions["sortDir"] = sortDirParam === "asc" ? "asc" : "desc";

                const query: GetListingsOptions = {
                    type: (url.searchParams.get("type") as "sale" | "rental" | "sold" | null) ?? undefined,
                    district: url.searchParams.get("district") ?? undefined,
                    disposition: url.searchParams.get("disposition") ?? undefined,
                    dispositions: parseMultiValue(url.searchParams.get("dispositions")),
                    source: url.searchParams.get("source") ?? undefined,
                    sources: parseMultiValue(url.searchParams.get("sources")),
                    priceMin: url.searchParams.get("priceMin") ? Number(url.searchParams.get("priceMin")) : undefined,
                    priceMax: url.searchParams.get("priceMax") ? Number(url.searchParams.get("priceMax")) : undefined,
                    areaMin: url.searchParams.get("areaMin") ? Number(url.searchParams.get("areaMin")) : undefined,
                    areaMax: url.searchParams.get("areaMax") ? Number(url.searchParams.get("areaMax")) : undefined,
                    seenFrom: url.searchParams.get("seenFrom") ?? undefined,
                    seenTo: url.searchParams.get("seenTo") ?? undefined,
                    sortBy,
                    sortDir,
                    limit,
                    offset: (Math.max(page, 1) - 1) * limit,
                };

                const total = reasDatabase.getListingsCount(query);
                const listings = reasDatabase.getListings(query);
                const overview = reasDatabase.getListingsOverview();

                return Response.json({
                    listings,
                    overview,
                    page: Math.max(page, 1),
                    limit,
                    total,
                    totalPages: Math.max(Math.ceil(total / limit), 1),
                });
            }),

            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                const type = body.type;
                const district = body.district;
                const constructionType = body.constructionType;

                if (
                    (type !== "sale" && type !== "rental" && type !== "sold") ||
                    typeof district !== "string" ||
                    typeof constructionType !== "string"
                ) {
                    return Response.json(
                        { error: "Missing required fields: type, district, constructionType" },
                        { status: 400 }
                    );
                }

                if (!district.trim()) {
                    return Response.json({ error: "Select a district before fetching listings" }, { status: 400 });
                }

                const result = await fetchListingsIntoCache({
                    type,
                    district,
                    constructionType,
                    disposition: typeof body.disposition === "string" ? body.disposition : undefined,
                    source: typeof body.source === "string" ? body.source : undefined,
                    priceMin: typeof body.priceMin === "string" ? body.priceMin : undefined,
                    priceMax: typeof body.priceMax === "string" ? body.priceMax : undefined,
                    areaMin: typeof body.areaMin === "string" ? body.areaMin : undefined,
                    areaMax: typeof body.areaMax === "string" ? body.areaMax : undefined,
                    refresh: true,
                });

                return Response.json(result);
            }),
        },
    },
});

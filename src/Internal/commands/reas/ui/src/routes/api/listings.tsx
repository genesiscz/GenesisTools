import type { GetListingsOptions } from "@app/Internal/commands/reas/lib/store";
import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";

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
                    source: url.searchParams.get("source") ?? undefined,
                    priceMin: url.searchParams.get("priceMin") ? Number(url.searchParams.get("priceMin")) : undefined,
                    priceMax: url.searchParams.get("priceMax") ? Number(url.searchParams.get("priceMax")) : undefined,
                    areaMin: url.searchParams.get("areaMin") ? Number(url.searchParams.get("areaMin")) : undefined,
                    areaMax: url.searchParams.get("areaMax") ? Number(url.searchParams.get("areaMax")) : undefined,
                    sortBy,
                    sortDir,
                    limit,
                    offset: (Math.max(page, 1) - 1) * limit,
                };

                const total = reasDatabase.getListingsCount(query);
                const listings = reasDatabase.getListings(query);

                return Response.json({
                    listings,
                    page: Math.max(page, 1),
                    limit,
                    total,
                    totalPages: Math.max(Math.ceil(total / limit), 1),
                });
            }),
        },
    },
});

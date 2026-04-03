import { fetchBezrealitkyAdvertDetail } from "@app/Internal/commands/reas/api/bezrealitky-client";
import { buildSavedPropertyFromListing } from "@app/Internal/commands/reas/lib/property-form-defaults";
import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import { createFileRoute } from "@tanstack/react-router";
import { SafeJSON } from "@app/utils/json";
import { apiHandler, jsonBody } from "../../server/api-utils";

export const Route = createFileRoute("/api/listings/$id")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const requestUrl = new URL(request.url);
                const routeId = requestUrl.pathname.split("/").at(-1);
                const listingId = Number(routeId);

                if (Number.isNaN(listingId)) {
                    return Response.json({ error: "Invalid listing id" }, { status: 400 });
                }

                const listing = reasDatabase.getListing(listingId);

                if (!listing) {
                    return Response.json({ error: "Listing not found" }, { status: 404 });
                }

                let hydratedDetail: unknown = null;

                if (listing.source === "bezrealitky" && listing.status === "active") {
                    try {
                        hydratedDetail = await fetchBezrealitkyAdvertDetail(listing.source_id);
                    } catch {
                        hydratedDetail = null;
                    }
                }

                return Response.json({
                    listing,
                    raw: SafeJSON.parse(listing.raw_json),
                    hydratedDetail,
                });
            }),

            POST: apiHandler(async (request) => {
                const requestUrl = new URL(request.url);
                const routeId = requestUrl.pathname.split("/").at(-1);
                const listingId = Number(routeId);

                if (Number.isNaN(listingId)) {
                    return Response.json({ error: "Invalid listing id" }, { status: 400 });
                }

                const listing = reasDatabase.getListing(listingId);

                if (!listing) {
                    return Response.json({ error: "Listing not found" }, { status: 404 });
                }

                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                const constructionType = body.constructionType;

                if (typeof constructionType !== "string" || !constructionType.trim()) {
                    return Response.json({ error: "Missing required field: constructionType" }, { status: 400 });
                }

                const rentEstimate = reasDatabase.estimateMonthlyRent({
                    district: listing.district,
                    disposition: listing.disposition ?? undefined,
                    area: listing.area ?? undefined,
                });

                const id = reasDatabase.saveProperty(
                    buildSavedPropertyFromListing({
                        listing,
                        rentEstimate,
                        constructionType,
                    })
                );

                return Response.json({ id }, { status: 201 });
            }),
        },
    },
});

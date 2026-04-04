import { fetchBezrealitkyAdvertDetail } from "@app/Internal/commands/reas/api/bezrealitky-client";
import { buildSavedPropertyFromListing } from "@app/Internal/commands/reas/lib/property-form-defaults";
import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { createFileRoute } from "@tanstack/react-router";
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

                const linkedProperty = reasDatabase.getPropertyByListingUrl(listing.link);

                let hydratedDetail: unknown = null;

                if (listing.source === "bezrealitky" && listing.status === "active") {
                    try {
                        hydratedDetail = await fetchBezrealitkyAdvertDetail(listing.source_id);
                    } catch (error) {
                        logger.warn(
                            {
                                error,
                                listingId,
                                source: listing.source,
                                sourceId: listing.source_id,
                            },
                            "Failed to hydrate Bezrealitky listing detail"
                        );

                        hydratedDetail = null;
                    }
                }

                return Response.json({
                    listing,
                    raw: SafeJSON.parse(listing.raw_json),
                    hydratedDetail,
                    linkedProperty: linkedProperty
                        ? {
                              id: linkedProperty.id,
                              name: linkedProperty.name,
                          }
                        : null,
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

                const existingProperty = reasDatabase.getPropertyByListingUrl(listing.link);

                if (existingProperty) {
                    return Response.json(
                        {
                            id: existingProperty.id,
                            name: existingProperty.name,
                            alreadyExists: true,
                        },
                        { status: 200 }
                    );
                }

                const id = reasDatabase.saveProperty(
                    buildSavedPropertyFromListing({
                        listing,
                        rentEstimate,
                        constructionType,
                    })
                );

                const property = reasDatabase.getProperty(id);

                return Response.json(
                    {
                        id,
                        name: property?.name ?? null,
                        alreadyExists: false,
                    },
                    { status: 201 }
                );
            }),
        },
    },
});

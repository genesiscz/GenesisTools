import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import { SafeJSON } from "@app/utils/json";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";

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

                return Response.json({
                    listing,
                    raw: SafeJSON.parse(listing.raw_json),
                });
            }),
        },
    },
});

import { getListingDetail, saveListingToWatchlist } from "@app/Internal/commands/reas/lib/listing-service";
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

                const result = await getListingDetail(listingId);

                if (!result) {
                    return Response.json({ error: "Listing not found" }, { status: 404 });
                }

                return Response.json(result);
            }),

            POST: apiHandler(async (request) => {
                const requestUrl = new URL(request.url);
                const routeId = requestUrl.pathname.split("/").at(-1);
                const listingId = Number(routeId);

                if (Number.isNaN(listingId)) {
                    return Response.json({ error: "Invalid listing id" }, { status: 400 });
                }

                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                const constructionType = body.constructionType;

                if (typeof constructionType !== "string" || !constructionType.trim()) {
                    return Response.json({ error: "Missing required field: constructionType" }, { status: 400 });
                }

                try {
                    const result = saveListingToWatchlist(listingId, constructionType);
                    return Response.json(result, { status: result.alreadyExists ? 200 : 201 });
                } catch (error) {
                    if (error instanceof Error && error.message.includes("not found")) {
                        return Response.json({ error: error.message }, { status: 404 });
                    }

                    throw error;
                }
            }),
        },
    },
});

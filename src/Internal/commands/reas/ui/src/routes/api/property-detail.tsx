import { getPropertyDetail } from "@app/Internal/commands/reas/lib/property-service";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";

export const Route = createFileRoute("/api/property-detail")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const idParam = url.searchParams.get("id");

                if (!idParam) {
                    return Response.json({ error: "Missing required parameter: id" }, { status: 400 });
                }

                const id = Number(idParam);

                if (Number.isNaN(id)) {
                    return Response.json({ error: "Invalid id parameter" }, { status: 400 });
                }

                const result = getPropertyDetail(id);

                if (!result) {
                    return Response.json({ error: "Property not found" }, { status: 404 });
                }

                return Response.json(result);
            }),
        },
    },
});

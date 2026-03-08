import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, jsonBody } from "../../server/api-utils";
import { searchAdoWorkItems } from "../../server/settings";

export const Route = createFileRoute("/api/ado-workitems")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                if (typeof body.query !== "string" || body.query.trim() === "") {
                    return Response.json({ error: "Field 'query' must be a non-empty string" }, { status: 400 });
                }

                const result = await searchAdoWorkItems(body.query);
                return Response.json(result);
            }),
        },
    },
});

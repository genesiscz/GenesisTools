import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { searchAdoWorkItems } from "../../server/settings";

export const Route = createFileRoute("/api/ado-workitems")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await request.json();
                const result = await searchAdoWorkItems(body.query as string);
                return Response.json(result);
            }),
        },
    },
});

import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, jsonBody } from "../../server/api-utils";
import { addMapping, getMappings, removeMapping } from "../../server/mappings";

export const Route = createFileRoute("/api/mappings")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const result = await getMappings();
                return Response.json(result);
            }),
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                const result = await addMapping(body);
                return Response.json(result);
            }),
            DELETE: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                if (typeof body.adoWorkItemId !== "number") {
                    return Response.json({ error: "Field 'adoWorkItemId' must be a number" }, { status: 400 });
                }

                const result = await removeMapping(body.adoWorkItemId);
                return Response.json(result);
            }),
        },
    },
});

import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { addMapping, getMappings, removeMapping } from "../../server/mappings";

export const Route = createFileRoute("/api/mappings")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const result = await getMappings();
                return Response.json(result);
            }),
            POST: apiHandler(async (request) => {
                const body = await request.json();
                const result = await addMapping(body);
                return Response.json(result);
            }),
            DELETE: apiHandler(async (request) => {
                const body = await request.json();
                const result = await removeMapping(body.adoWorkItemId as number);
                return Response.json(result);
            }),
        },
    },
});

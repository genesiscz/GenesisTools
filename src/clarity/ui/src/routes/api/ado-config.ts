import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { getAdoConfig } from "../../server/settings";

export const Route = createFileRoute("/api/ado-config")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const result = await getAdoConfig();
                return Response.json(result);
            }),
        },
    },
});

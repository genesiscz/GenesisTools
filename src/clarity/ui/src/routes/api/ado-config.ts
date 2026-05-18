import { apiHandler } from "@app/clarity/ui/src/server/api-utils";
import { getAdoConfig } from "@app/clarity/ui/src/server/settings";
import { createFileRoute } from "@tanstack/react-router";

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

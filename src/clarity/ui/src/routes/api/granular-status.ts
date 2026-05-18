import { apiHandler } from "@app/clarity/ui/src/server/api-utils";
import { getGranularStatus } from "@app/clarity/ui/src/server/settings";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/granular-status")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const result = await getGranularStatus();
                return Response.json(result);
            }),
        },
    },
});

import { apiHandler } from "@app/clarity/ui/src/server/api-utils";
import { getStatus } from "@app/clarity/ui/src/server/settings";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/status")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const result = await getStatus();
                return Response.json(result);
            }),
        },
    },
});
